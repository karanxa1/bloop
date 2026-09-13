mod agent;
mod azure;
mod config;
mod ledger;
mod mcp;

use config::Config;
use mcp::McpClient;
use serde_json::{json, Value};
use worker::*;

fn cors_headers() -> Headers {
    let h = Headers::new();
    let _ = h.set("access-control-allow-origin", "*");
    let _ = h.set("access-control-allow-methods", "GET, POST, OPTIONS");
    let _ = h.set("access-control-allow-headers", "content-type, authorization");
    h
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    let path = req.path();
    let method = req.method();

    match (method, path.as_str()) {
        (Method::Options, _) => Ok(Response::empty()?.with_headers(cors_headers())),
        (Method::Post, "/api/chat") => chat(req, env).await,
        (Method::Get, "/api/health") => health(env).await,
        (Method::Get, "/api/ledger") => ledger_handler().await,
        _ => serve_assets(req, env).await,
    }
}

async fn chat(mut req: Request, env: Env) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let messages = body
        .get("messages")
        .and_then(|m| m.as_array().cloned())
        .unwrap_or_default();
    let cfg = Config::from_env(&env);
    let run_id = format!("run-{}", js_sys::Date::now() as u64);
    let stream = agent::run(cfg, messages, run_id);

    let headers = cors_headers();
    headers.set("content-type", "text/event-stream; charset=utf-8")?;
    headers.set("cache-control", "no-cache")?;
    headers.set("x-bloop-run", "1")?;
    Response::from_stream(stream).map(|r| r.with_headers(headers))
}

async fn health(env: Env) -> Result<Response> {
    let cfg = Config::from_env(&env);
    let mut servers = Vec::new();
    for s in &cfg.servers {
        let mut c = McpClient::new(&s.name, &s.url, &s.token);
        let (state, tools) = match c.initialize().await {
            Ok(()) => match c.list_tools().await {
                Ok(t) => ("ok", t.len()),
                Err(_) => ("error", 0),
            },
            Err(_) => ("error", 0),
        };
        servers.push(json!({"name": s.name, "state": state, "tools": tools}));
    }
    let resp = Response::from_json(&json!({
        "ok": true,
        "model": cfg.model,
        "servers": servers,
    }))?;
    Ok(resp.with_headers(cors_headers()))
}

async fn ledger_handler() -> Result<Response> {
    let entries = ledger::last_run_entries();
    let resp = Response::from_json(&json!(entries))?;
    Ok(resp.with_headers(cors_headers()))
}

async fn serve_assets(req: Request, env: Env) -> Result<Response> {
    match env.assets("ASSETS") {
        Ok(assets) => assets.fetch_request(req).await.map_err(|e| {
            Error::RustError(format!("assets fetch: {}", e))
        }),
        Err(_) => Response::ok("bloop api"),
    }
}
