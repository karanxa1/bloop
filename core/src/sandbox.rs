//! Calls into the bloop-sandbox worker (code runs, browser, workspaces).
use crate::config::Config;
use serde_json::{json, Value};
use worker::*;

/// POST JSON to the sandbox worker. Prefers the SANDBOX service binding
/// (worker→worker, no public hop — workers.dev hosts can't fetch each other,
/// error 1042); falls back to SANDBOX_URL over plain HTTP for local dev.
/// Returns (status, body JSON); a non-JSON body becomes `{"error": text}`.
/// Every request carries the caller's `sandbox_id` so tenants get isolated sandboxes.
pub async fn post(
    env: &Env,
    cfg: &Config,
    user_id: &str,
    path: &str,
    body: &Value,
) -> std::result::Result<(u16, Value), String> {
    let mut body = body.clone();
    body["sandbox_id"] = json!(sandbox_id(user_id));
    let body = &body;
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

/// Per-tenant sandbox id: the first 32 hex chars of sha256(user_id)
/// (the eval caller is the user "eval-user").
pub fn sandbox_id(user_id: &str) -> String {
    crate::ledger::sha256_hex(user_id)[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_ids_are_stable_hex_and_distinct() {
        let a = sandbox_id("user-1");
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(a, sandbox_id("user-1"));
        assert_ne!(a, sandbox_id("user-2"));
        assert_eq!(sandbox_id("eval-user"), crate::ledger::sha256_hex("eval-user")[..32]);
    }
}

/// The sandbox's `error` message, or a generic HTTP status line.
pub fn err_text(status: u16, v: &Value) -> String {
    match v.get("error").and_then(|e| e.as_str()) {
        Some(e) if !e.is_empty() => e.to_string(),
        _ => format!("sandbox HTTP {}", status),
    }
}
