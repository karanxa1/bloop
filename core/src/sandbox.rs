//! Calls into the bloop-sandbox worker (code runs, browser, workspaces).
use crate::config::Config;
use serde_json::{json, Value};
use worker::*;

/// POST JSON to the sandbox worker. Prefers the SANDBOX service binding
/// (worker→worker, no public hop — workers.dev hosts can't fetch each other,
/// error 1042); falls back to SANDBOX_URL over plain HTTP for local dev.
/// Returns (status, body JSON); a non-JSON body becomes `{"error": text}`.
pub async fn post(
    env: &Env,
    cfg: &Config,
    path: &str,
    body: &Value,
) -> std::result::Result<(u16, Value), String> {
    let headers = Headers::new();
    let _ = headers.set("content-type", "application/json");
    if !cfg.sandbox_token.is_empty() {
        let _ = headers.set("authorization", &format!("Bearer {}", cfg.sandbox_token));
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.to_string().into()));
    let sent = match env.service("SANDBOX") {
        Ok(f) => {
            let req = Request::new_with_init(&format!("https://sandbox.internal{}", path), &init)
                .map_err(|e| format!("sandbox request: {}", e))?;
            f.fetch_request(req).await
        }
        Err(_) => {
            let base = match &cfg.sandbox_url {
                Some(u) if !u.is_empty() => u,
                _ => return Err("sandbox not configured".into()),
            };
            let req = Request::new_with_init(&format!("{}{}", base, path), &init)
                .map_err(|e| format!("sandbox request: {}", e))?;
            Fetch::Request(req).send().await
        }
    };
    let mut resp = sent.map_err(|e| format!("sandbox fetch failed: {}", e))?;
    let status = resp.status_code();
    let text = resp.text().await.unwrap_or_default();
    let v = serde_json::from_str::<Value>(&text)
        .unwrap_or_else(|_| json!({"error": text.chars().take(300).collect::<String>()}));
    Ok((status, v))
}

/// The sandbox's `error` message, or a generic HTTP status line.
pub fn err_text(status: u16, v: &Value) -> String {
    match v.get("error").and_then(|e| e.as_str()) {
        Some(e) if !e.is_empty() => e.to_string(),
        _ => format!("sandbox HTTP {}", status),
    }
}
