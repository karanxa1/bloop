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

// ---------- servers ----------

pub async fn list_user_servers(env: &Env, user_id: &str) -> Result<Vec<Value>> {
    let db = env.d1("DB")?;
    let res = db
        .prepare("SELECT id, name, url, token, created_at FROM servers WHERE user_id = ?1 ORDER BY created_at")
        .bind(&[js(user_id)])?
        .all()
        .await?;
    res.results::<Value>()
}

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

pub async fn count_user_servers(env: &Env) -> i64 {
    if let Ok(db) = env.d1("DB") {
        if let Ok(n) = db
            .prepare("SELECT COUNT(*) AS c FROM servers")
            .first::<i64>(Some("c"))
            .await
        {
            return n.unwrap_or(0);
        }
    }
    0
}
