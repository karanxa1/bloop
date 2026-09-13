//! Live browser view relay: `GET /api/browser/view?session=<id>` upgrades to a
//! WebSocket and pipes it to the sandbox worker's `/browser/view` endpoint over
//! the SANDBOX service binding. Same-origin upgrades only, session-cookie auth
//! (enforced by the /api/* guard upstream), and a client→upstream allowlist so
//! the browser can only send input events — never arbitrary CDP.
use crate::config::{self, Config};
use crate::sandbox;
use futures::StreamExt;
use serde_json::{json, Value};
use worker::*;

/// Client → sandbox message types the relay forwards.
const ALLOWED: &[&str] = &["mouse", "wheel", "key", "text", "nav"];
const MAX_CLIENT_TEXT: usize = 8_192;
/// Frames are binary on the way down; text control frames only go up.
const SESSION_ID_RE_MAX: usize = 128;

fn json_err(msg: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({ "error": msg })).map(|r| r.with_status(status))
}

/// Browser upgrades must come from this origin (or a Vite dev origin in dev).
fn origin_ok(req: &Request, env: &Env) -> bool {
    let Some(origin) = req.headers().get("origin").ok().flatten() else {
        return true; // non-browser client; still needs a session cookie
    };
    if let Ok(url) = req.url() {
        let own = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
        let own_port = url.port().map(|p| format!("{}:{}", own, p));
        if origin == own || own_port.as_deref() == Some(origin.as_str()) {
            return true;
        }
    }
    config::env_str(env, "DEV_ORIGINS").is_some()
        && (origin == "http://localhost:5173" || origin == "http://localhost:5174")
}

fn client_allowed(text: &str) -> bool {
    if text.len() > MAX_CLIENT_TEXT {
        return false;
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("t").and_then(|t| t.as_str()).map(|t| ALLOWED.contains(&t)))
        .unwrap_or(false)
}

/// `GET /api/browser/view?session=<browser session id>`
pub async fn view(req: Request, env: &Env, user_id: &str) -> Result<Response> {
    let is_upgrade = req
        .headers()
        .get("upgrade")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    if !is_upgrade {
        return json_err("expected websocket upgrade", 426);
    }
    if !origin_ok(&req, env) {
        return json_err("forbidden origin", 403);
    }
    let url = req.url()?;
    let session = url
        .query_pairs()
        .find(|(k, _)| k == "session")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    if session.is_empty()
        || session.len() > SESSION_ID_RE_MAX
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return json_err("invalid session", 400);
    }
    let cfg = Config::from_env(env);
    if cfg.sandbox_token.is_empty() {
        return json_err("browser view not configured", 503);
    }

    // Dial the sandbox first so failures surface as HTTP errors, not a dead socket.
    let path = format!(
        "/browser/view?sandbox_id={}&session_id={}",
        sandbox::sandbox_id(user_id),
        session
    );
    let mut up_req = Request::new(&format!("https://sandbox.internal{}", path), Method::Get)?;
    up_req.headers_mut()?.set("upgrade", "websocket")?;
    up_req
        .headers_mut()?
        .set("authorization", &format!("Bearer {}", cfg.sandbox_token))?;
    let up_resp = match env.service("SANDBOX") {
        Ok(f) => match f.fetch_request(up_req).await {
            Ok(r) => r,
            Err(e) => return json_err(&format!("sandbox unreachable ({})", e), 502),
        },
        Err(_) => return json_err("sandbox not configured", 503),
    };
    let up_status = up_resp.status_code();
    if up_status != 101 {
        let mut resp = up_resp;
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| body.chars().take(160).collect());
        return json_err(&format!("live view unavailable: {}", detail), 502);
    }
    let upstream = match up_resp.websocket() {
        Some(ws) => ws,
        None => return json_err("live view unavailable (no socket)", 502),
    };
    upstream.accept()?;

    let pair = WebSocketPair::new()?;
    let server = pair.server;
    server.accept()?;
    wasm_bindgen_futures::spawn_local(relay(server, upstream));
    Response::from_websocket(pair.client)
}

async fn relay(client: WebSocket, upstream: WebSocket) {
    let (Ok(c_events), Ok(u_events)) = (client.events(), upstream.events()) else {
        let _ = client.close(Some(1011), Some("browser view relay failed"));
        let _ = upstream.close(Some(1000), Some("relay failed"));
        return;
    };
    enum Side {
        Client,
        Upstream,
    }
    let mut merged = Box::pin(futures::stream::select(
        c_events.map(|e| (Side::Client, e)),
        u_events.map(|e| (Side::Upstream, e)),
    ));
    while let Some((side, event)) = merged.next().await {
        match (side, event) {
            (Side::Client, Ok(WebsocketEvent::Message(msg))) => {
                if let Some(text) = msg.text() {
                    if client_allowed(&text) {
                        let _ = upstream.send_with_str(text);
                    }
                }
                // client binary frames are dropped — input goes up as JSON only
            }
            (Side::Upstream, Ok(WebsocketEvent::Message(msg))) => {
                if let Some(text) = msg.text() {
                    let _ = client.send_with_str(text);
                } else if let Some(bytes) = msg.bytes() {
                    let _ = client.send_with_bytes(bytes);
                }
            }
            (Side::Client, Ok(WebsocketEvent::Close(_))) => {
                let _ = upstream.close(Some(1000), Some("client closed"));
                break;
            }
            (Side::Upstream, Ok(WebsocketEvent::Close(ev))) => {
                let code = if ev.code() == 1000 || (3000..=4999).contains(&ev.code()) {
                    ev.code()
                } else {
                    1000
                };
                let _ = client.close(Some(code), Some("live view closed"));
                break;
            }
            (_, Err(_)) => {
                let _ = client.close(Some(1011), Some("browser view relay error"));
                let _ = upstream.close(Some(1000), Some("relay error"));
                break;
            }
        }
    }
}
