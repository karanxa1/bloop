mod agent;
mod auth;
mod azure;
mod config;
mod crypto;
mod db;
mod ledger;
mod mcp;

use config::Config;
use serde_json::{json, Value};
use worker::*;

/// Add CORS headers to a response in place (echoing the request Origin so
/// credentialed requests work).
fn with_cors(mut resp: Response, origin: &str) -> Result<Response> {
    let h = resp.headers_mut();
    h.set("access-control-allow-origin", origin)?;
    h.set("access-control-allow-credentials", "true")?;
    h.set(
        "access-control-allow-methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    )?;
    h.set("access-control-allow-headers", "content-type, authorization")?;
    Ok(resp)
}

fn request_origin(req: &Request) -> String {
    req.headers()
        .get("origin")
        .ok()
        .flatten()
        .unwrap_or_else(|| "*".to_string())
}

fn json_err(msg: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({"error": msg})).map(|r| r.with_status(status))
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    let path = req.path();
    let method = req.method();
    let origin = request_origin(&req);

    if method == Method::Options {
        return with_cors(Response::empty()?, &origin);
    }

    let resp = dispatch(req, env, &path, method).await?;
    // Asset responses carry immutable headers — only API responses get CORS.
    if path.starts_with("/api/") || path.starts_with("/files/") {
        with_cors(resp, &origin)
    } else {
        Ok(resp)
    }
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

    match (&method, path) {
        (&Method::Post, "/api/chat") => chat(req, env, user_id, persist).await,
        (&Method::Get, "/api/models") => models_list(),
        (&Method::Get, "/api/memories") => memories_list(&env, user_id).await,
        (&Method::Post, "/api/memories") => memories_add(req, &env, user_id).await,
        (&Method::Get, "/api/servers") => servers_list(&env, user_id).await,
        (&Method::Post, "/api/servers") => servers_add(req, &env, user_id).await,
        (&Method::Get, "/api/ledger") => ledger_handler().await,
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
            if let Some(id) = path.strip_prefix("/api/servers/") {
                if method == Method::Delete {
                    return servers_delete(&env, user_id, id.trim_matches('/')).await;
                }
                return json_err("method not allowed", 405);
            }
            if let Some(key) = path.strip_prefix("/files/") {
                if method == Method::Get {
                    return file_get(&env, key).await;
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
    let run_id = format!("run-{}", js_sys::Date::now() as u64);
    let stream = agent::run(agent::RunOpts {
        env: env.clone(),
        cfg,
        run_id,
        user_id: user_id.to_string(),
        conversation_id: conversation_id.clone(),
        persist,
        message,
        model,
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

// ---------- servers ----------

async fn servers_list(env: &Env, user_id: &str) -> Result<Response> {
    let cfg = Config::from_env(env);
    let mut out: Vec<Value> = Vec::new();
    for s in &cfg.servers {
        let (state, tool_count) = match mcp::probe(&s.name, &s.url, &s.token).await {
            Ok(n) => ("ok", n),
            Err(_) => ("error", 0),
        };
        out.push(json!({
            "id": s.name,
            "name": s.name,
            "url": s.url,
            "source": "global",
            "state": state,
            "tool_count": tool_count,
        }));
    }
    if let Ok(rows) = db::list_user_servers(env, user_id).await {
        for r in rows {
            let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let token = r.get("token").and_then(|v| v.as_str()).unwrap_or("");
            let (state, tool_count) = match mcp::probe(name, url, token).await {
                Ok(n) => ("ok", n),
                Err(_) => ("error", 0),
            };
            out.push(json!({
                "id": r.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "name": name,
                "url": url,
                "source": "user",
                "state": state,
                "tool_count": tool_count,
            }));
        }
    }
    Response::from_json(&json!(out))
}

async fn servers_add(mut req: Request, env: &Env, user_id: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let token = body
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() || url.is_empty() {
        return json_err("name and url required", 400);
    }
    match mcp::probe(&name, &url, &token).await {
        Ok(tool_count) => {
            let row = db::add_user_server(env, user_id, &name, &url, &token).await?;
            Response::from_json(&json!({
                "id": row.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "name": name,
                "url": url,
                "tool_count": tool_count,
            }))
        }
        Err(e) => json_err(&format!("could not connect: {}", e), 400),
    }
}

async fn servers_delete(env: &Env, user_id: &str, id: &str) -> Result<Response> {
    db::delete_user_server(env, user_id, id).await?;
    Response::from_json(&json!({"ok": true}))
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
        _ => "application/octet-stream",
    }
}

async fn file_get(env: &Env, key: &str) -> Result<Response> {
    let bucket = env.bucket("FILES")?;
    let obj = match bucket.get(key).execute().await? {
        Some(o) => o,
        None => return json_err("not found", 404),
    };
    match obj.body() {
        Some(body) => {
            let resp = Response::from_body(body.response_body()?)?;
            let h = Headers::new();
            h.set("content-type", content_type_for(key))?;
            h.set("cache-control", "public, max-age=31536000, immutable")?;
            Ok(resp.with_headers(h))
        }
        None => json_err("not found", 404),
    }
}

// ---------- health / ledger / assets ----------

async fn health(env: Env) -> Result<Response> {
    let cfg = Config::from_env(&env);
    let mut servers = Vec::new();
    for s in &cfg.servers {
        let (state, tools) = match mcp::probe(&s.name, &s.url, &s.token).await {
            Ok(n) => ("ok", n),
            Err(_) => ("error", 0),
        };
        servers.push(json!({"name": s.name, "state": state, "tools": tools}));
    }
    let user_servers = db::count_user_servers(&env).await;
    Response::from_json(&json!({
        "ok": true,
        "model": cfg.model,
        "servers": servers,
        "user_servers": user_servers,
    }))
}

async fn ledger_handler() -> Result<Response> {
    let entries = ledger::last_run_entries();
    Response::from_json(&json!(entries))
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
