mod agent;
mod auth;
mod azure;
mod config;
mod crypto;
mod db;
mod ledger;
pub mod marketplace;
pub mod mcp;
pub mod netguard;
pub mod oauth;
mod sandbox;
mod skills;
mod tools_registry;
mod voice;
mod workspace;

use config::Config;
use serde_json::{json, Value};
use worker::*;

// ---------- CORS + security headers ----------

/// The production app origin. The SPA is same-origin, so CORS only matters for dev.
const APP_ORIGIN: &str = "https://bloop.rough-cell-383c.workers.dev";
/// Vite dev origins, allowed only when the DEV_ORIGINS var is set.
const DEV_ORIGINS: &[&str] = &["http://localhost:5173", "http://localhost:5174"];

const SPA_CSP: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; \
    img-src 'self' data: https://www.google.com; connect-src 'self' wss://agent.deepgram.com; \
    frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'";
/// User content: inert, sandboxed, never scriptable on the app origin.
const FILES_CSP: &str = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
/// MCP app HTML runs scripts, but in an opaque-origin sandbox (no cookies, no same-origin API access).
const MCPAPP_CSP: &str = "sandbox allow-scripts allow-forms";

/// Exact CORS allowlist — never reflect arbitrary origins (or `null`).
fn origin_allowed(origin: &str, dev: bool) -> bool {
    origin == APP_ORIGIN || (dev && DEV_ORIGINS.contains(&origin))
}

/// CORS headers for allowlisted origins only; unknown origins get none, so no credentialed reads.
fn with_cors(mut resp: Response, origin: Option<&str>, dev: bool) -> Result<Response> {
    let h = resp.headers_mut();
    h.set("vary", "Origin")?;
    if let Some(origin) = origin.filter(|o| origin_allowed(o, dev)) {
        h.set("access-control-allow-origin", origin)?;
        h.set("access-control-allow-credentials", "true")?;
        h.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")?;
        h.set("access-control-allow-headers", "content-type, authorization")?;
    }
    Ok(resp)
}

fn is_api_path(path: &str) -> bool {
    path.starts_with("/api/") || path.starts_with("/files/")
}

fn noindex_path(path: &str) -> bool {
    path == "/app" || path.starts_with("/app/") || is_api_path(path)
}

fn csp_for(path: &str) -> &'static str {
    if path.starts_with("/files/") {
        FILES_CSP
    } else if path.starts_with("/api/") {
        API_CSP
    } else {
        SPA_CSP
    }
}

/// Security headers on every response. A CSP a handler already set (MCP app HTML) is kept.
fn with_security_headers(resp: Response, path: &str) -> Result<Response> {
    // Asset-binding responses have immutable headers, so always work on a copy.
    let h = resp.headers().clone();
    h.set("x-content-type-options", "nosniff")?;
    h.set("referrer-policy", "strict-origin-when-cross-origin")?;
    h.set("strict-transport-security", "max-age=31536000")?;
    h.set("permissions-policy", "microphone=(self)")?;
    if !h.has("content-security-policy").unwrap_or(false) {
        h.set("content-security-policy", csp_for(path))?;
    }
    if noindex_path(path) {
        h.set("x-robots-tag", "noindex")?;
    }
    Ok(resp.with_headers(h))
}

fn json_err(msg: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({"error": msg})).map(|r| r.with_status(status))
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    let path = req.path();
    let method = req.method();
    let origin = req.headers().get("origin").ok().flatten();
    let dev = config::env_str(&env, "DEV_ORIGINS").is_some();

    let resp = if method == Method::Options {
        Response::empty()?.with_status(204)
    } else {
        dispatch(req, env, &path, method).await?
    };
    let resp = if is_api_path(&path) {
        with_cors(resp, origin.as_deref(), dev)?
    } else {
        resp
    };
    with_security_headers(resp, &path)
}

async fn dispatch(req: Request, env: Env, path: &str, method: Method) -> Result<Response> {
    // --- Public routes ---
    if path == "/api/health" && method == Method::Get {
        return health(env).await;
    }
    if let Some(sub) = path.strip_prefix("/api/auth/") {
        return match (sub, &method) {
            ("signup", &Method::Post) => auth::signup(req, env).await,
            ("login", &Method::Post) => auth::login(req, env).await,
            ("logout", &Method::Post) => auth::logout(req, env).await,
            ("me", &Method::Get) => auth::me(req, env).await,
            _ => json_err("not found", 404),
        };
    }

    // OAuth client ID metadata document (fetched by MCP authorization servers).
    if path == oauth::CLIENT_METADATA_PATH && method == Method::Get {
        return oauth::client_metadata(&req, &env);
    }

    // --- Auth guard: everything else under /api/* and /files/* requires a session ---
    if path.starts_with("/api/") || path.starts_with("/files/") {
        let caller = auth::caller(&req, &env, path == "/api/chat").await;
        let (user_id, persist) = match caller {
            Some(c) => c,
            None => return json_err("unauthorized", 401),
        };
        return route_authed(req, env, path, method, &user_id, persist).await;
    }

    serve_assets(req, env).await
}

async fn route_authed(
    req: Request,
    env: Env,
    path: &str,
    method: Method,
    user_id: &str,
    persist: bool,
) -> Result<Response> {
    // /api/conversations and /api/conversations/:id
    if path == "/api/conversations" {
        return match method {
            Method::Get => conversations_list(&env, user_id).await,
            Method::Post => conversations_create(req, &env, user_id).await,
            _ => json_err("method not allowed", 405),
        };
    }
    if let Some(id) = path.strip_prefix("/api/conversations/") {
        let id = id.trim_matches('/');
        return match method {
            Method::Get => conversation_get(&env, user_id, id).await,
            Method::Patch => conversation_patch(req, &env, user_id, id).await,
            Method::Delete => conversation_delete(&env, user_id, id).await,
            _ => json_err("method not allowed", 405),
        };
    }

    if let Some(rest) = path.strip_prefix("/api/skills").filter(|r| r.is_empty() || r.starts_with('/')) {
        return skills::route(req, &env, user_id, rest, method).await;
    }
    if let Some(rest) = path.strip_prefix("/api/tools").filter(|r| r.is_empty() || r.starts_with('/')) {
        return tools_registry::route(req, &env, user_id, rest, method).await;
    }
    if let Some(rest) = path.strip_prefix("/api/workspace/") {
        return workspace_route(req, &env, user_id, rest, method).await;
    }
    if let Some(rest) = path.strip_prefix("/api/voice/") {
        return voice::route(req, &env, user_id, &format!("/{}", rest), method).await;
    }

    match (&method, path) {
        (&Method::Post, "/api/chat") => chat(req, env, user_id, persist).await,
        (&Method::Get, "/api/models") => models_list(),
        (&Method::Get, "/api/memories") => memories_list(&env, user_id).await,
        (&Method::Post, "/api/memories") => memories_add(req, &env, user_id).await,
        (&Method::Get, "/api/servers") => marketplace::list(&env, user_id).await,
        (&Method::Post, "/api/servers") => marketplace::add(req, &env, user_id).await,
        (&Method::Get, "/api/servers/catalog") => marketplace::catalog(&env, user_id).await,
        (&Method::Get, "/api/oauth/callback") => oauth::callback(&req, &env, user_id).await,
        (&Method::Get, "/api/ledger") => ledger_handler(user_id).await,
        (&Method::Post, "/api/mcp/call") => agent::mcp_call_route(req, &env, user_id).await,
        _ => {
            if let Some(id) = path.strip_prefix("/api/memories/") {
                if method == Method::Delete {
                    return memories_delete(&env, user_id, id.trim_matches('/')).await;
                }
                return json_err("method not allowed", 405);
            }
            if let Some(kind) = path.strip_prefix("/api/files/") {
                let kind = kind.trim_matches('/');
                if !db::FILE_KINDS.contains(&kind) {
                    return json_err("unknown file kind", 404);
                }
                return match method {
                    Method::Get => Response::from_json(&db::get_user_file(&env, user_id, kind).await?),
                    Method::Put => user_file_put(req, &env, user_id, kind).await,
                    _ => json_err("method not allowed", 405),
                };
            }
            if let Some(rest) = path.strip_prefix("/api/servers/") {
                return marketplace::route(req, &env, user_id, rest, method).await;
            }
            if let Some(key) = path.strip_prefix("/files/") {
                if method == Method::Get {
                    return file_get(&env, user_id, key).await;
                }
                return json_err("method not allowed", 405);
            }
            json_err("not found", 404)
        }
    }
}

// ---------- chat ----------

async fn chat(mut req: Request, env: Env, user_id: &str, persist: bool) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if message.is_empty() {
        return json_err("message required", 400);
    }
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(config::DEFAULT_MODEL)
        .to_string();
    if !config::model_allowed(&model) {
        return json_err("unknown model", 400);
    }
    let mode = match body.get("mode") {
        None | Some(Value::Null) => agent::Mode::Default,
        Some(v) => match v.as_str().and_then(agent::Mode::parse) {
            Some(m) => m,
            None => return json_err("unknown mode", 400),
        },
    };

    let attachments = match agent::parse_attachments(body.get("attachments")) {
        Ok(a) => a,
        Err(e) => return json_err(&e, 400),
    };
    if !persist && !attachments.is_empty() {
        return json_err("attachments are not available for this caller", 400);
    }

    // Resolve or create the conversation.
    let conversation_id = if persist {
        match body.get("conversation_id").and_then(|v| v.as_str()) {
            Some(id) if !id.is_empty() => {
                match db::get_conversation(&env, user_id, id).await? {
                    Some(_) => id.to_string(),
                    None => return json_err("conversation not found", 404),
                }
            }
            _ => {
                let title: String = message
                    .split_whitespace()
                    .take(6)
                    .collect::<Vec<_>>()
                    .join(" ");
                let conv = db::create_conversation(&env, user_id, &title).await?;
                conv.get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            }
        }
    } else {
        // Eval caller: ephemeral id, nothing is persisted.
        crypto::uuid()
    };

    let cfg = Config::from_env(&env);
    let admin = auth::is_admin(&env, &cfg, user_id).await;
    // Random run ids: ledgers are keyed by run, and timestamps collide across users.
    let run_id = format!("run-{}", crypto::uuid());
    let stream = agent::run(agent::RunOpts {
        env: env.clone(),
        cfg,
        run_id,
        user_id: user_id.to_string(),
        conversation_id: conversation_id.clone(),
        persist,
        admin,
        message,
        model,
        mode,
        attachments,
    });

    let headers = Headers::new();
    headers.set("content-type", "text/event-stream; charset=utf-8")?;
    headers.set("cache-control", "no-cache")?;
    headers.set("x-bloop-run", "1")?;
    Response::from_stream(stream).map(|r| r.with_headers(headers))
}

// ---------- conversations ----------

async fn conversations_list(env: &Env, user_id: &str) -> Result<Response> {
    let rows = db::list_conversations(env, user_id).await?;
    Response::from_json(&json!(rows))
}

async fn conversations_create(mut req: Request, env: &Env, user_id: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("new chat");
    let conv = db::create_conversation(env, user_id, title).await?;
    Response::from_json(&conv)
}

async fn conversation_get(env: &Env, user_id: &str, id: &str) -> Result<Response> {
    let conv = match db::get_conversation(env, user_id, id).await? {
        Some(c) => c,
        None => return json_err("conversation not found", 404),
    };
    let total = db::message_count(env, id).await.unwrap_or(0);
    let rows = db::messages_page(env, id, total.max(1), 0)
        .await
        .unwrap_or_default();
    let messages: Vec<Value> = rows
        .iter()
        .map(|m| {
            let parts = m
                .get("parts_json")
                .and_then(|p| p.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(json!([]));
            json!({
                "role": m.get("role").and_then(|v| v.as_str()).unwrap_or("user"),
                "content": m.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                "parts": parts,
            })
        })
        .collect();
    Response::from_json(&json!({
        "id": conv.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "title": conv.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "model": conv.get("model").and_then(|v| v.as_str()).unwrap_or(""),
        "messages": messages,
    }))
}

async fn conversation_patch(mut req: Request, env: &Env, user_id: &str, id: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return json_err("title required", 400);
    }
    if db::rename_conversation(env, user_id, id, &title).await? {
        Response::from_json(&json!({"id": id, "title": title}))
    } else {
        json_err("conversation not found", 404)
    }
}

async fn conversation_delete(env: &Env, user_id: &str, id: &str) -> Result<Response> {
    db::delete_conversation(env, user_id, id).await?;
    Response::from_json(&json!({"ok": true}))
}

// ---------- models ----------

fn models_list() -> Result<Response> {
    let models: Vec<Value> = config::MODELS
        .iter()
        .map(|(id, label)| {
            json!({"id": id, "label": label, "default": *id == config::DEFAULT_MODEL})
        })
        .collect();
    Response::from_json(&json!(models))
}

// ---------- memories ----------

async fn memories_list(env: &Env, user_id: &str) -> Result<Response> {
    let rows = db::list_memories(env, user_id).await?;
    Response::from_json(&json!(rows))
}

async fn memories_add(mut req: Request, env: &Env, user_id: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let content = body
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return json_err("content required", 400);
    }
    let mem = db::add_memory(env, user_id, &content).await?;
    Response::from_json(&mem)
}

async fn memories_delete(env: &Env, user_id: &str, id: &str) -> Result<Response> {
    db::delete_memory(env, user_id, id).await?;
    Response::from_json(&json!({"ok": true}))
}

// ---------- user files ----------

async fn user_file_put(mut req: Request, env: &Env, user_id: &str, kind: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let content = match body.get("content").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return json_err("content required", 400),
    };
    if content.len() > db::FILE_MAX {
        return json_err(&format!("file too large (max {} chars)", db::FILE_MAX), 413);
    }
    db::put_user_file(env, user_id, kind, content).await?;
    Response::from_json(&db::get_user_file(env, user_id, kind).await?)
}

// ---------- servers: see marketplace.rs / oauth.rs ----------

// ---------- workspaces ----------

/// Files listed by the editor per request.
const WORKSPACE_FILES_MAX: usize = 2000;

/// `/api/workspace/:conv/{files,file,exec}` — the conversation must belong to the caller.
async fn workspace_route(
    mut req: Request,
    env: &Env,
    user_id: &str,
    rest: &str,
    method: Method,
) -> Result<Response> {
    let Some((conv, action)) = rest.trim_matches('/').split_once('/') else {
        return json_err("not found", 404);
    };
    if db::get_conversation(env, user_id, conv).await?.is_none() {
        return json_err("conversation not found", 404);
    }
    let query_path = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let ws_err = |e: workspace::WsError| json_err(&e.message, e.status);
    match (method, action) {
        (Method::Get, "files") => match workspace::list(env, conv, "", WORKSPACE_FILES_MAX).await {
            Ok((entries, _)) => Response::from_json(&workspace::entries_json(&entries)),
            Err(e) => ws_err(e),
        },
        (Method::Get, "file") => match workspace::read_text(env, conv, &query_path).await {
            Ok(content) => Response::from_json(&json!({"path": query_path, "content": content})),
            Err(e) => ws_err(e),
        },
        (Method::Put, "file") => {
            let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
            let (Some(path), Some(content)) = (
                body.get("path").and_then(|v| v.as_str()),
                body.get("content").and_then(|v| v.as_str()),
            ) else {
                return json_err("path and content (string) required", 400);
            };
            match workspace::write(env, conv, path, content).await {
                Ok(()) => Response::from_json(&json!({"ok": true})),
                Err(e) => ws_err(e),
            }
        }
        (Method::Delete, "file") => match workspace::delete(env, conv, &query_path).await {
            Ok(()) => Response::from_json(&json!({"ok": true})),
            Err(e) => ws_err(e),
        },
        (Method::Post, "upload") => workspace::upload_route(req, env, conv).await,
        (Method::Get, "raw") => workspace::raw_response(env, conv, &query_path).await,
        (Method::Post, "exec") => {
            let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
            let command = body.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
            if command.is_empty() {
                return json_err("command required", 400);
            }
            let timeout_s = body.get("timeout_s").and_then(|v| v.as_u64());
            if let Err(msg) = db::quota_hit(env, user_id, "workspace_exec").await {
                return json_err(&msg, 429);
            }
            let cfg = Config::from_env(env);
            match workspace::exec(env, &cfg, user_id, conv, command, timeout_s).await {
                Ok((status, v)) => Ok(Response::from_json(&v)?.with_status(status)),
                Err(e) => json_err(&e, 502),
            }
        }
        _ => json_err("not found", 404),
    }
}

// ---------- files (R2) ----------

fn content_type_for(key: &str) -> &'static str {
    match key.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        "html" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serve an R2 object the caller owns (`u/<caller>/{img,shots,mcpapp}/…`). Legacy
/// unscoped `img/`/`shots/` keys are served only when the caller's own messages
/// reference them, so old chats keep their images without re-opening the IDOR.
/// Workspace (`ws/`) files are never served here.
async fn file_get(env: &Env, user_id: &str, key: &str) -> Result<Response> {
    let kind = match workspace::file_access(user_id, key) {
        workspace::FileAccess::Owned(kind) => kind,
        workspace::FileAccess::Legacy
            if db::user_references(env, user_id, &format!("/files/{}", key)).await.unwrap_or(false) =>
        {
            "img"
        }
        _ => return json_err("not found", 404),
    };
    let bucket = env.bucket("FILES")?;
    let obj = match bucket.get(key).execute().await? {
        Some(o) => o,
        None => return json_err("not found", 404),
    };
    let Some(body) = obj.body() else {
        return json_err("not found", 404);
    };
    let resp = Response::from_body(body.response_body()?)?;
    let ext = key.rsplit('.').next().unwrap_or("");
    let h = Headers::new();
    h.set("content-type", content_type_for(key))?;
    h.set("cache-control", "private, max-age=31536000, immutable")?;
    h.set("x-content-type-options", "nosniff")?;
    if kind == "mcpapp" && ext == "html" {
        h.set("content-security-policy", MCPAPP_CSP)?;
    } else {
        h.set("content-security-policy", FILES_CSP)?;
        if matches!(ext, "svg" | "html" | "htm" | "xml" | "xhtml") {
            h.set("content-disposition", "attachment")?;
        }
    }
    Ok(resp.with_headers(h))
}

// ---------- health / ledger / assets ----------

/// Public and cheap: no upstream probes. Server states come from a KV cache
/// that authenticated `/api/servers` calls refresh.
async fn health(env: Env) -> Result<Response> {
    let cached = db::cache_get(&env, db::HEALTH_CACHE_KEY).await;
    let field = |k: &str| cached.as_ref().and_then(|c| c.get(k)).cloned().unwrap_or(Value::Null);
    Response::from_json(&json!({
        "ok": true,
        "servers": match field("servers") { Value::Null => json!([]), v => v },
        "checked_at": field("ts"),
    }))
}

async fn ledger_handler(user_id: &str) -> Result<Response> {
    Response::from_json(&json!(ledger::last_run_entries(user_id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_allowlist_is_exact() {
        assert!(origin_allowed(APP_ORIGIN, false));
        assert!(!origin_allowed("http://localhost:5173", false));
        assert!(origin_allowed("http://localhost:5173", true));
        assert!(origin_allowed("http://localhost:5174", true));
        for bad in [
            "null",
            "",
            "https://evil.rough-cell-383c.workers.dev",
            "https://bloop.rough-cell-383c.workers.dev.evil.com",
            "http://bloop.rough-cell-383c.workers.dev",
            "http://localhost:3000",
        ] {
            assert!(!origin_allowed(bad, true), "{bad}");
        }
    }

    #[test]
    fn csp_and_noindex_by_route() {
        assert_eq!(csp_for("/files/u/x/img/a.jpg"), FILES_CSP);
        assert_eq!(csp_for("/api/chat"), API_CSP);
        assert_eq!(csp_for("/app"), SPA_CSP);
        assert!(SPA_CSP.contains("frame-ancestors 'none'"));
        assert!(noindex_path("/app/c/1") && noindex_path("/api/me") && noindex_path("/files/x"));
        assert!(!noindex_path("/") && !noindex_path("/apple"));
    }
}

async fn serve_assets(req: Request, env: Env) -> Result<Response> {
    // Route marketing page and the chat app from the same asset bundle:
    //   /        → landing/index.html   (public marketing page)
    //   /app*    → index.html           (the chat SPA)
    //   anything else → passthrough to the asset store
    let path = req.path();
    let rewrite = if path == "/" {
        Some("/landing/index.html")
    } else if path == "/app" || path.starts_with("/app/") {
        Some("/index.html")
    } else {
        None
    };

    let assets = match env.assets("ASSETS") {
        Ok(a) => a,
        Err(_) => return Response::ok("bloop api"),
    };

    let req = match rewrite {
        Some(p) => {
            let mut url = req.url()?;
            url.set_path(p);
            // Request::new yields immutable headers; new_with_init gives the
            // assets binding a request it can work with.
            Request::new_with_init(url.as_str(), &RequestInit::new())?
        }
        None => req,
    };

    assets
        .fetch_request(req)
        .await
        .map_err(|e| Error::RustError(format!("assets fetch: {}", e)))
}
