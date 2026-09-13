use crate::crypto;
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::*;

fn js(s: &str) -> JsValue {
    JsValue::from_str(s)
}

// ---------- sessions (KV) ----------

const SESSION_TTL_SECS: u64 = 7 * 24 * 3600;

/// Create a session for `user_id`; returns the session token.
pub async fn create_session(env: &Env, user_id: &str) -> Result<String> {
    let kv = env.kv("SESSIONS")?;
    let token = crypto::hex_encode(&crypto::random_bytes(32));
    kv.put(&format!("sess:{}", token), user_id)?
        .expiration_ttl(SESSION_TTL_SECS)
        .execute()
        .await
        .map_err(|e| Error::RustError(format!("kv put: {}", e)))?;
    Ok(token)
}

/// Resolve a session token to a user_id.
pub async fn session_user(env: &Env, token: &str) -> Option<String> {
    let kv = env.kv("SESSIONS").ok()?;
    kv.get(&format!("sess:{}", token))
        .text()
        .await
        .ok()
        .flatten()
}

pub async fn delete_session(env: &Env, token: &str) {
    if let Ok(kv) = env.kv("SESSIONS") {
        let _ = kv.delete(&format!("sess:{}", token)).await;
    }
}

// ---------- rate limits / quotas / cache (KV) ----------

/// KV key for a fixed-window counter: `rl:<scope>:<subject>:<window index>`.
pub fn rate_key(scope: &str, subject: &str, now_s: u64, window_s: u64) -> String {
    format!("rl:{}:{}:{}", scope, subject, now_s / window_s.max(1))
}

/// Count one hit on a fixed-window KV counter; returns false once `limit` is
/// reached. KV is eventually consistent, so this is a soft limit. Fails open
/// if KV is unavailable.
pub async fn rate_hit(env: &Env, key: &str, limit: u32, window_s: u64) -> bool {
    let Ok(kv) = env.kv("SESSIONS") else {
        return true;
    };
    let n: u32 = kv
        .get(key)
        .text()
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if n >= limit {
        return false;
    }
    if let Ok(put) = kv.put(key, (n + 1).to_string()) {
        let _ = put.expiration_ttl(window_s.max(60) + 60).execute().await;
    }
    true
}

/// Hourly per-user quota for costly sandbox tools: (quota name, calls per hour).
pub fn quota_for(tool: &str) -> Option<(&'static str, u32)> {
    match tool {
        "run_code" => Some(("run_code", 120)),
        "browse" | "browser_handoff" => Some(("browse", 60)),
        "workspace_exec" => Some(("exec", 60)),
        _ => None,
    }
}

/// Count one use of `tool` against `user_id`'s hourly quota. Err carries the
/// user-facing message when the quota is exhausted.
pub async fn quota_hit(env: &Env, user_id: &str, tool: &str) -> std::result::Result<(), String> {
    let Some((name, limit)) = quota_for(tool) else {
        return Ok(());
    };
    let now = Date::now().as_millis() / 1000;
    if rate_hit(env, &rate_key(&format!("quota:{}", name), user_id, now, 3600), limit, 3600).await {
        Ok(())
    } else {
        Err(format!("hourly {} quota reached ({} per hour) — try again later", name, limit))
    }
}

pub async fn cache_get(env: &Env, key: &str) -> Option<Value> {
    let kv = env.kv("SESSIONS").ok()?;
    kv.get(key).json::<Value>().await.ok().flatten()
}

pub async fn cache_put(env: &Env, key: &str, value: &Value, ttl_s: u64) {
    if let Ok(kv) = env.kv("SESSIONS") {
        if let Ok(put) = kv.put(key, value.to_string()) {
            let _ = put.expiration_ttl(ttl_s.max(60)).execute().await;
        }
    }
}

/// KV key for public-server states shown by the unauthenticated /api/health.
pub const HEALTH_CACHE_KEY: &str = "cache:health:servers";

/// Record public server states for /api/health, writing at most once a minute.
pub async fn refresh_health_cache(env: &Env, states: Vec<Value>) {
    if states.is_empty() {
        return;
    }
    let now = Date::now().as_millis();
    let fresh = cache_get(env, HEALTH_CACHE_KEY)
        .await
        .and_then(|c| c.get("ts").and_then(|t| t.as_u64()))
        .is_some_and(|ts| now.saturating_sub(ts) < 60_000);
    if !fresh {
        cache_put(env, HEALTH_CACHE_KEY, &json!({"ts": now, "servers": states}), 3600).await;
    }
}

// ---------- users ----------

pub async fn user_by_email(env: &Env, email: &str) -> Result<Option<Value>> {
    let db = env.d1("DB")?;
    let res = db
        .prepare("SELECT id, email, name, pw_hash, salt FROM users WHERE email = ?1")
        .bind(&[js(email)])?
        .first::<Value>(None)
        .await?;
    Ok(res)
}

pub async fn user_by_id(env: &Env, id: &str) -> Result<Option<Value>> {
    let db = env.d1("DB")?;
    db.prepare("SELECT id, email, name FROM users WHERE id = ?1")
        .bind(&[js(id)])?
        .first::<Value>(None)
        .await
}

pub async fn create_user(env: &Env, email: &str, name: &str, pw_hash: &str, salt: &str) -> Result<Value> {
    let db = env.d1("DB")?;
    let id = crypto::uuid();
    db.prepare("INSERT INTO users (id, email, name, pw_hash, salt) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(&[js(&id), js(email), js(name), js(pw_hash), js(salt)])?
        .run()
        .await?;
    Ok(json!({"id": id, "email": email, "name": name}))
}

// ---------- conversations ----------

pub async fn list_conversations(env: &Env, user_id: &str) -> Result<Vec<Value>> {
    let db = env.d1("DB")?;
    let res = db
        .prepare(
            "SELECT id, title, model, updated_at FROM conversations \
             WHERE user_id = ?1 ORDER BY updated_at DESC",
        )
        .bind(&[js(user_id)])?
        .all()
        .await?;
    res.results::<Value>()
}

pub async fn create_conversation(env: &Env, user_id: &str, title: &str) -> Result<Value> {
    let db = env.d1("DB")?;
    let id = crypto::uuid();
    db.prepare("INSERT INTO conversations (id, user_id, title) VALUES (?1, ?2, ?3)")
        .bind(&[js(&id), js(user_id), js(title)])?
        .run()
        .await?;
    Ok(json!({"id": id, "title": title}))
}

/// Fetch a conversation row scoped to a user.
pub async fn get_conversation(env: &Env, user_id: &str, id: &str) -> Result<Option<Value>> {
    let db = env.d1("DB")?;
    db.prepare(
        "SELECT id, title, model, summary, summarized_count, created_at, updated_at \
         FROM conversations WHERE id = ?1 AND user_id = ?2",
    )
    .bind(&[js(id), js(user_id)])?
    .first::<Value>(None)
    .await
}

/// Rows changed by a write.
fn changed(res: &D1Result) -> bool {
    res.meta().ok().flatten().and_then(|m| m.changes).unwrap_or(0) > 0
}

// ---------- skills ----------

const SKILL_COLS: &str = "id, name, description, body, source, enabled, created_at, updated_at";

pub async fn list_skills(env: &Env, user_id: &str) -> Result<Vec<Value>> {
    let db = env.d1("DB")?;
    db.prepare(format!("SELECT {SKILL_COLS} FROM skills WHERE user_id = ?1 ORDER BY name"))
        .bind(&[js(user_id)])?
        .all()
        .await?
        .results::<Value>()
}

/// A skill looked up by id or name.
pub async fn get_skill(env: &Env, user_id: &str, key: &str) -> Result<Option<Value>> {
    let db = env.d1("DB")?;
    db.prepare(format!(
        "SELECT {SKILL_COLS} FROM skills WHERE user_id = ?1 AND (id = ?2 OR name = ?2)"
    ))
    .bind(&[js(user_id), js(key)])?
    .first::<Value>(None)
    .await
}

pub async fn create_skill(
    env: &Env,
    user_id: &str,
    name: &str,
    description: &str,
    body: &str,
    source: &str,
    enabled: bool,
) -> Result<Value> {
    let db = env.d1("DB")?;
    let id = crypto::uuid();
    db.prepare(
        "INSERT INTO skills (id, user_id, name, description, body, source, enabled) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&[
        js(&id),
        js(user_id),
        js(name),
        js(description),
        js(body),
        js(source),
        JsValue::from_f64(if enabled { 1.0 } else { 0.0 }),
    ])?
    .run()
    .await?;
    Ok(json!({"id": id, "name": name, "description": description, "body": body, "source": source, "enabled": enabled}))
}

/// Patch a skill by id; `None` fields stay unchanged. Returns whether a row changed.
pub async fn update_skill(
    env: &Env,
    user_id: &str,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    body: Option<&str>,
    enabled: Option<bool>,
) -> Result<bool> {
    let db = env.d1("DB")?;
    let opt = |v: Option<&str>| v.map(js).unwrap_or(JsValue::NULL);
    let res = db
        .prepare(
            "UPDATE skills SET name = COALESCE(?3, name), description = COALESCE(?4, description), \
             body = COALESCE(?5, body), enabled = COALESCE(?6, enabled), updated_at = datetime('now') \
             WHERE id = ?1 AND user_id = ?2",
        )
        .bind(&[
            js(id),
            js(user_id),
            opt(name),
            opt(description),
            opt(body),
            enabled.map_or(JsValue::NULL, |b| JsValue::from_f64(if b { 1.0 } else { 0.0 })),
        ])?
        .run()
        .await?;
    Ok(changed(&res))
}

pub async fn delete_skill(env: &Env, user_id: &str, id: &str) -> Result<bool> {
    let db = env.d1("DB")?;
    let res = db
        .prepare("DELETE FROM skills WHERE id = ?1 AND user_id = ?2")
        .bind(&[js(id), js(user_id)])?
        .run()
        .await?;
    Ok(changed(&res))
}

// ---------- user settings ----------

pub async fn disabled_tools(env: &Env, user_id: &str) -> Result<Vec<String>> {
    let db = env.d1("DB")?;
    let row = db
        .prepare("SELECT disabled_tools_json FROM user_settings WHERE user_id = ?1")
        .bind(&[js(user_id)])?
        .first::<Value>(None)
        .await?;
    Ok(row
        .as_ref()
        .and_then(|r| r.get("disabled_tools_json"))
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_default())
}

pub async fn set_disabled_tools(env: &Env, user_id: &str, names: &[String]) -> Result<()> {
    let db = env.d1("DB")?;
    let list = serde_json::to_string(names).unwrap_or_else(|_| "[]".into());
    db.prepare(
        "INSERT INTO user_settings (user_id, disabled_tools_json, updated_at) VALUES (?1, ?2, datetime('now')) \
         ON CONFLICT(user_id) DO UPDATE SET disabled_tools_json = excluded.disabled_tools_json, updated_at = excluded.updated_at",
    )
    .bind(&[js(user_id), js(&list)])?
    .run()
    .await?;
    Ok(())
}

/// Whether any message in the user's own conversations contains `needle`
/// (used to authorize legacy, unscoped `/files/` keys).
pub async fn user_references(env: &Env, user_id: &str, needle: &str) -> Result<bool> {
    let db = env.d1("DB")?;
    let row = db
        .prepare(
            "SELECT 1 AS hit FROM messages m JOIN conversations c ON c.id = m.conversation_id \
             WHERE c.user_id = ?1 AND instr(m.parts_json, ?2) > 0 LIMIT 1",
        )
        .bind(&[js(user_id), js(needle)])?
        .first::<Value>(None)
        .await?;
    Ok(row.is_some())
}

pub async fn rename_conversation(env: &Env, user_id: &str, id: &str, title: &str) -> Result<bool> {
    let db = env.d1("DB")?;
    let res = db
        .prepare(
            "UPDATE conversations SET title = ?1, updated_at = datetime('now') \
             WHERE id = ?2 AND user_id = ?3",
        )
        .bind(&[js(title), js(id), js(user_id)])?
        .run()
        .await?;
    Ok(res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0)
        > 0)
}

pub async fn delete_conversation(env: &Env, user_id: &str, id: &str) -> Result<()> {
    let db = env.d1("DB")?;
    let _ = db
        .prepare("DELETE FROM messages WHERE conversation_id = ?1")
        .bind(&[js(id)])?
        .run()
        .await;
    db.prepare("DELETE FROM conversations WHERE id = ?1 AND user_id = ?2")
        .bind(&[js(id), js(user_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn touch_conversation(env: &Env, id: &str) {
    if let Ok(db) = env.d1("DB") {
        if let Ok(stmt) = db
            .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1")
            .bind(&[js(id)])
        {
            let _ = stmt.run().await;
        }
    }
}

/// Set title only if it is still 'new chat'.
pub async fn auto_title(env: &Env, id: &str, title: &str) {
    if let Ok(db) = env.d1("DB") {
        if let Ok(stmt) = db
            .prepare("UPDATE conversations SET title = ?1 WHERE id = ?2 AND title = 'new chat'")
            .bind(&[js(title), js(id)])
        {
            let _ = stmt.run().await;
        }
    }
}

// ---------- messages ----------

pub async fn message_count(env: &Env, conversation_id: &str) -> Result<i64> {
    let db = env.d1("DB")?;
    let n: Option<i64> = db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?1")
        .bind(&[js(conversation_id)])?
        .first(Some("c"))
        .await?;
    Ok(n.unwrap_or(0))
}

/// Fetch `limit` messages starting at `offset` (oldest→newest).
pub async fn messages_page(
    env: &Env,
    conversation_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>> {
    let db = env.d1("DB")?;
    let res = db
        .prepare(
            "SELECT role, content, parts_json, created_at FROM messages \
             WHERE conversation_id = ?1 ORDER BY id LIMIT ?2 OFFSET ?3",
        )
        .bind(&[
            js(conversation_id),
            JsValue::from_f64(limit as f64),
            JsValue::from_f64(offset as f64),
        ])?
        .all()
        .await?;
    res.results::<Value>()
}

pub async fn add_message(env: &Env, conversation_id: &str, role: &str, content: &str, parts: &Value) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare("INSERT INTO messages (conversation_id, role, content, parts_json) VALUES (?1, ?2, ?3, ?4)")
        .bind(&[
            js(conversation_id),
            js(role),
            js(content),
            js(&serde_json::to_string(parts).unwrap_or_else(|_| "[]".into())),
        ])?
        .run()
        .await?;
    Ok(())
}

pub async fn update_summary(env: &Env, conversation_id: &str, summary: &str, summarized_count: i64) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare("UPDATE conversations SET summary = ?1, summarized_count = ?2 WHERE id = ?3")
        .bind(&[
            js(summary),
            JsValue::from_f64(summarized_count as f64),
            js(conversation_id),
        ])?
        .run()
        .await?;
    Ok(())
}

// ---------- memories ----------

pub async fn list_memories(env: &Env, user_id: &str) -> Result<Vec<Value>> {
    let db = env.d1("DB")?;
    let res = db
        .prepare("SELECT id, content, created_at FROM memories WHERE user_id = ?1 ORDER BY created_at DESC")
        .bind(&[js(user_id)])?
        .all()
        .await?;
    res.results::<Value>()
}

pub async fn add_memory(env: &Env, user_id: &str, content: &str) -> Result<Value> {
    let db = env.d1("DB")?;
    let id = crypto::uuid();
    db.prepare("INSERT INTO memories (id, user_id, content) VALUES (?1, ?2, ?3)")
        .bind(&[js(&id), js(user_id), js(content)])?
        .run()
        .await?;
    Ok(json!({"id": id, "content": content}))
}

pub async fn delete_memory(env: &Env, user_id: &str, id: &str) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare("DELETE FROM memories WHERE id = ?1 AND user_id = ?2")
        .bind(&[js(id), js(user_id)])?
        .run()
        .await?;
    Ok(())
}

/// Delete memories whose content matches `%query%`; returns rows removed.
pub async fn forget_memories(env: &Env, user_id: &str, query: &str) -> Result<usize> {
    let db = env.d1("DB")?;
    let res = db
        .prepare("DELETE FROM memories WHERE user_id = ?1 AND content LIKE ?2")
        .bind(&[js(user_id), js(&format!("%{}%", query))])?
        .run()
        .await?;
    Ok(res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0))
}

// ---------- user files (context / lessons) ----------

pub const FILE_KINDS: &[&str] = &["context", "lessons"];
/// Hard cap on a stored file; lessons drop their oldest lines past this.
pub const FILE_MAX: usize = 20_000;

pub async fn get_user_file(env: &Env, user_id: &str, kind: &str) -> Result<Value> {
    let db = env.d1("DB")?;
    let row = db
        .prepare("SELECT content, updated_at FROM user_files WHERE user_id = ?1 AND kind = ?2")
        .bind(&[js(user_id), js(kind)])?
        .first::<Value>(None)
        .await?;
    Ok(json!({
        "kind": kind,
        "content": row.as_ref().and_then(|r| r.get("content")).and_then(|v| v.as_str()).unwrap_or(""),
        "updated_at": row.as_ref().and_then(|r| r.get("updated_at")).cloned().unwrap_or(Value::Null),
    }))
}

pub async fn put_user_file(env: &Env, user_id: &str, kind: &str, content: &str) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare(
        "INSERT INTO user_files (user_id, kind, content, updated_at) VALUES (?1, ?2, ?3, datetime('now')) \
         ON CONFLICT(user_id, kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
    )
    .bind(&[js(user_id), js(kind), js(content)])?
    .run()
    .await?;
    Ok(())
}

/// Append `- lesson` to the lessons file, trimming the oldest lines past FILE_MAX.
pub async fn append_lesson(env: &Env, user_id: &str, lesson: &str) -> Result<()> {
    let cur = get_user_file(env, user_id, "lessons").await?;
    let mut content = cur
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_end()
        .to_string();
    if !content.is_empty() {
        content.push('\n');
    }
    content.push_str("- ");
    content.push_str(&lesson.replace('\n', " "));
    while content.len() > FILE_MAX {
        match content.find('\n') {
            Some(i) => {
                content.drain(..=i);
            }
            None => break,
        }
    }
    put_user_file(env, user_id, "lessons", &content).await
}

// ---------- servers ----------


pub async fn add_user_server(env: &Env, user_id: &str, name: &str, url: &str, token: &str) -> Result<Value> {
    let db = env.d1("DB")?;
    let id = crypto::uuid();
    db.prepare("INSERT INTO servers (id, user_id, name, url, token) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(&[js(&id), js(user_id), js(name), js(url), js(token)])?
        .run()
        .await?;
    Ok(json!({"id": id, "name": name, "url": url}))
}

pub async fn delete_user_server(env: &Env, user_id: &str, id: &str) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare("DELETE FROM servers WHERE id = ?1 AND user_id = ?2")
        .bind(&[js(id), js(user_id)])?
        .run()
        .await?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_keys_bucket_by_window() {
        assert_eq!(rate_key("login", "ip:1.2.3.4", 1_200, 600), "rl:login:ip:1.2.3.4:2");
        assert_eq!(rate_key("login", "ip:1.2.3.4", 1_799, 600), rate_key("login", "ip:1.2.3.4", 1_200, 600));
        assert_ne!(rate_key("login", "ip:1.2.3.4", 1_800, 600), rate_key("login", "ip:1.2.3.4", 1_200, 600));
        assert_ne!(rate_key("login", "a", 0, 600), rate_key("signup", "a", 0, 600));
        assert_eq!(rate_key("x", "y", 5, 0), "rl:x:y:5");
    }

    #[test]
    fn quotas_cover_costly_tools_only() {
        assert_eq!(quota_for("workspace_exec"), Some(("exec", 60)));
        assert_eq!(quota_for("browser_handoff").map(|q| q.0), Some("browse"));
        assert!(quota_for("run_code").is_some());
        assert!(quota_for("remember").is_none());
    }
}

// ---------- server configs / oauth clients (marketplace) ----------

const SERVER_FULL_SELECT: &str = "SELECT s.id, s.name, s.url, s.token, s.created_at, \
     COALESCE(c.transport, 'auto') AS transport, \
     COALESCE(c.auth_type, CASE WHEN s.token = '' THEN 'none' ELSE 'bearer' END) AS auth_type, \
     COALESCE(c.headers_json, '{}') AS headers_json, \
     COALESCE(c.enabled, 1) AS enabled, \
     COALESCE(c.oauth_json, '{}') AS oauth_json, \
     COALESCE(c.catalog_slug, '') AS catalog_slug \
     FROM servers s LEFT JOIN server_configs c ON c.server_id = s.id";

fn opt_js(v: Option<&str>) -> JsValue {
    v.map(js).unwrap_or(JsValue::NULL)
}

/// User servers joined with their config (defaults for legacy rows).
pub async fn list_user_servers_full(env: &Env, user_id: &str) -> Result<Vec<Value>> {
    let db = env.d1("DB")?;
    let sql = format!("{} WHERE s.user_id = ?1 ORDER BY s.created_at", SERVER_FULL_SELECT);
    db.prepare(&sql).bind(&[js(user_id)])?.all().await?.results::<Value>()
}

pub async fn get_user_server_full(env: &Env, user_id: &str, id: &str) -> Result<Option<Value>> {
    let db = env.d1("DB")?;
    let sql = format!("{} WHERE s.user_id = ?1 AND s.id = ?2", SERVER_FULL_SELECT);
    db.prepare(&sql).bind(&[js(user_id), js(id)])?.first::<Value>(None).await
}

pub async fn put_server_config(
    env: &Env,
    server_id: &str,
    transport: &str,
    auth_type: &str,
    headers_json: &str,
    catalog_slug: Option<&str>,
) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare(
        "INSERT INTO server_configs (server_id, transport, auth_type, headers_json, catalog_slug) \
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(server_id) DO UPDATE SET transport = excluded.transport, \
         auth_type = excluded.auth_type, headers_json = excluded.headers_json, \
         catalog_slug = excluded.catalog_slug, updated_at = datetime('now')",
    )
    .bind(&[js(server_id), js(transport), js(auth_type), js(headers_json), opt_js(catalog_slug)])?
    .run()
    .await?;
    Ok(())
}

/// Create a default config row for a legacy server (no-op if present / server missing).
async fn ensure_server_config(env: &Env, server_id: &str) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare(
        "INSERT INTO server_configs (server_id, auth_type) \
         SELECT id, CASE WHEN token = '' THEN 'none' ELSE 'bearer' END FROM servers WHERE id = ?1 \
         ON CONFLICT(server_id) DO NOTHING",
    )
    .bind(&[js(server_id)])?
    .run()
    .await?;
    Ok(())
}

pub async fn update_user_server(env: &Env, user_id: &str, id: &str, name: Option<&str>, token: Option<&str>) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare("UPDATE servers SET name = COALESCE(?1, name), token = COALESCE(?2, token) WHERE id = ?3 AND user_id = ?4")
        .bind(&[opt_js(name), opt_js(token), js(id), js(user_id)])?
        .run()
        .await?;
    Ok(())
}

/// Caller must have verified ownership of `server_id`.
pub async fn update_server_config(
    env: &Env,
    server_id: &str,
    enabled: Option<bool>,
    headers_json: Option<&str>,
    auth_type: Option<&str>,
) -> Result<()> {
    ensure_server_config(env, server_id).await?;
    let db = env.d1("DB")?;
    let enabled = enabled
        .map(|b| JsValue::from_f64(if b { 1.0 } else { 0.0 }))
        .unwrap_or(JsValue::NULL);
    db.prepare(
        "UPDATE server_configs SET enabled = COALESCE(?1, enabled), headers_json = COALESCE(?2, headers_json), \
         auth_type = COALESCE(?3, auth_type), updated_at = datetime('now') WHERE server_id = ?4",
    )
    .bind(&[enabled, opt_js(headers_json), opt_js(auth_type), js(server_id)])?
    .run()
    .await?;
    Ok(())
}

/// Store OAuth tokens (JSON) and mark the server as OAuth-authenticated.
pub async fn set_server_oauth(env: &Env, server_id: &str, oauth_json: &str) -> Result<()> {
    ensure_server_config(env, server_id).await?;
    let db = env.d1("DB")?;
    db.prepare("UPDATE server_configs SET oauth_json = ?1, auth_type = 'oauth', updated_at = datetime('now') WHERE server_id = ?2")
        .bind(&[js(oauth_json), js(server_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn delete_orphan_server_config(env: &Env, server_id: &str) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare("DELETE FROM server_configs WHERE server_id = ?1 AND NOT EXISTS (SELECT 1 FROM servers WHERE id = ?1)")
        .bind(&[js(server_id)])?
        .run()
        .await?;
    Ok(())
}

/// Stored OAuth JSON for a server (internal: refresh-lock re-read).
pub async fn get_server_oauth(env: &Env, server_id: &str) -> Result<Option<String>> {
    let db = env.d1("DB")?;
    db.prepare("SELECT oauth_json FROM server_configs WHERE server_id = ?1")
        .bind(&[js(server_id)])?
        .first::<String>(Some("oauth_json"))
        .await
}

pub async fn get_oauth_client(env: &Env, auth_server: &str, redirect_uri: &str) -> Result<Option<Value>> {
    let db = env.d1("DB")?;
    db.prepare("SELECT client_id, client_secret, registration_json FROM oauth_clients WHERE auth_server = ?1 AND redirect_uri = ?2")
        .bind(&[js(auth_server), js(redirect_uri)])?
        .first::<Value>(None)
        .await
}

pub async fn put_oauth_client(
    env: &Env,
    auth_server: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: &str,
    registration_json: &str,
) -> Result<()> {
    let db = env.d1("DB")?;
    db.prepare(
        "INSERT OR REPLACE INTO oauth_clients (auth_server, redirect_uri, client_id, client_secret, registration_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&[js(auth_server), js(redirect_uri), js(client_id), js(client_secret), js(registration_json)])?
    .run()
    .await?;
    Ok(())
}
