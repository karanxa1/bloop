//! Voice concierge: Deepgram managed Voice Agent (STT → LLM → TTS over one WebSocket).
//!
//! Two connection paths, both session-cookie auth only (never the eval token):
//! - `GET  /api/voice/ws`    — primary. Same-origin WebSocket relay: the worker dials
//!   Deepgram with the API key server-side, sends the server-built `Settings` itself,
//!   then relays audio + an allowlist of client JSON messages. CSP needs only `'self'`.
//! - `POST /api/voice/token` — optional fast path. Short-lived grant token + Settings so
//!   the browser can dial Deepgram directly. 501 when the key can't mint grants
//!   (client falls back to the relay).
//!
//! Model ids verified against developers.deepgram.com/docs/voice-agent-llm-models,
//! /docs/voice-agent-tts-models, /docs/configure-voice-agent and Cartesia's model list
//! (docs.cartesia.ai/build-with-cartesia/tts-models/latest); live `SettingsApplied` checked.
use crate::config;
use futures::StreamExt;
use serde_json::{json, Value};
use worker::*;

/// Deepgram agent endpoint (https scheme: Workers upgrade via fetch).
const UPSTREAM_HTTPS: &str = "https://agent.deepgram.com/v1/agent/converse";
pub const UPSTREAM_WSS: &str = "wss://agent.deepgram.com/v1/agent/converse";
const GRANT_URL: &str = "https://api.deepgram.com/v1/auth/grant";

pub const INPUT_RATE: u32 = 16_000;
pub const OUTPUT_RATE: u32 = 24_000;
const LISTEN_MODEL: &str = "flux-general-en"; // Flux (listen v2): conversational STT with end-of-turn detection
const THINK_MODEL: &str = "claude-sonnet-5"; // strongest Anthropic model on Deepgram's managed list
const SPEAK_MODEL: &str = "sonic-3.6"; // Cartesia's latest Sonic
const SPEAK_VOICE: &str = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"; // Cartesia "Skylar" (en-US)

const TOKEN_TTL_SECS: u64 = 30;
/// Token + ws requests per user per minute (a connect costs up to two).
const RATE_PER_MIN: u64 = 20;
const SESSION_CAP_MS: f64 = 15.0 * 60.0 * 1000.0;
/// How often a relay re-checks it is still the user's newest session.
const OWNER_CHECK_MS: f64 = 30_000.0;
const ACTIVE_TTL_SECS: u64 = 16 * 60;
const MAX_CLIENT_TEXT: usize = 16_000;
const MAX_CLIENT_AUDIO: usize = 64_000;
/// Client → Deepgram JSON message types the relay forwards; everything else is dropped
/// (the client can never send Settings/UpdatePrompt/UpdateThink and swap models or prompt).
const CLIENT_ALLOWED: &[&str] = &["KeepAlive", "FunctionCallResponse", "InjectAgentMessage"];

const PROMPT: &str = "You are bloop's voice concierge. bloop is an AI agent that does real work for the user: it browses and researches the web, runs code in a sandbox, uses connected apps and tools, and verifies its claims.

How you talk:
- Your words are spoken aloud. Keep every reply to one or two short, natural sentences.
- No markdown, lists, emoji or code. Never read URLs, ids or file paths character by character; say \"a link\" or name the site.
- Be warm and direct. Ask one brief clarifying question only when a request is genuinely ambiguous.

How you act:
- For anything actionable (research, look something up, build, write, calculate, check, send, compare, summarize a page) call run_bloop_task. Don't try to answer those from memory.
- The prompt you pass must be precise and self-contained: resolve pronouns and references from the conversation (\"it\", \"that one\", \"the second option\") into explicit details, and include every constraint the user mentioned.
- Before a task that may take a while, say a very brief acknowledgement like \"on it\" in the same turn as the call.
- Use mode \"think\" for tricky reasoning and \"deep\" only for multi-step research the user explicitly wants to be thorough; otherwise omit mode.
- When a result comes back, summarize the outcome conversationally in one or two sentences and mention that the details are in the chat.
- If the result says the task is still running, tell the user it's underway and that you'll let them know when it's done.
- Never claim more than the returned result says. If it failed or was incomplete, say so honestly and offer to retry.
- Small talk and questions about what you can do don't need a task.";

/// The full Deepgram `Settings` message. Lives server-side so models + prompt never
/// ship in the client bundle and can't be overridden by the client.
pub fn settings() -> Value {
    json!({
        "type": "Settings",
        "tags": ["bloop", "voice-concierge"],
        "audio": {
            "input": { "encoding": "linear16", "sample_rate": INPUT_RATE },
            "output": { "encoding": "linear16", "sample_rate": OUTPUT_RATE, "container": "none" }
        },
        "agent": {
            "language": "en",
            "listen": {
                "provider": { "type": "deepgram", "version": "v2", "model": LISTEN_MODEL }
            },
            "think": {
                "provider": { "type": "anthropic", "model": THINK_MODEL },
                "prompt": PROMPT,
                "functions": [{
                    "name": "run_bloop_task",
                    "description": "Run a task with the bloop agent (web research, browsing, code, connected apps, writing). Its progress streams into the user's chat. Returns a short result summary with counts of tool calls, verifications and errors, or a note that it is still running.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "prompt": {
                                "type": "string",
                                "description": "Precise, self-contained instruction for bloop, with all references resolved and every constraint the user gave."
                            },
                            "mode": {
                                "type": "string",
                                "enum": ["default", "think", "deep"],
                                "description": "Reasoning depth. Omit for normal tasks."
                            }
                        },
                        "required": ["prompt"]
                    }
                }]
            },
            "speak": {
                "provider": {
                    "type": "cartesia",
                    "model_id": SPEAK_MODEL,
                    "voice": { "mode": "id", "id": SPEAK_VOICE },
                    "language": "en"
                }
            },
            "greeting": "hey, it's bloop. what should we get done?"
        }
    })
}

fn json_err(msg: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({ "error": msg })).map(|r| r.with_status(status))
}

/// `/api/voice/*` — `rest` is the path after `/api/voice`.
pub async fn route(req: Request, env: &Env, user_id: &str, rest: &str, method: Method) -> Result<Response> {
    if user_id == "eval-user" {
        return json_err("voice requires a signed-in session", 403);
    }
    match (method, rest.trim_end_matches('/')) {
        (Method::Post, "/token") => token(env, user_id).await,
        (Method::Get, "/ws") => relay_start(req, env, user_id).await,
        (_, "/token") | (_, "/ws") => json_err("method not allowed", 405),
        _ => json_err("not found", 404),
    }
}

/// Fixed-window per-user limit in KV. Fails open if KV is unavailable.
async fn rate_ok(env: &Env, user_id: &str) -> bool {
    let Ok(kv) = env.kv("SESSIONS") else { return true };
    let minute = (js_sys::Date::now() / 60_000.0) as u64;
    let key = format!("voice:rl:{}:{}", user_id, minute);
    let n: u64 = kv.get(&key).text().await.ok().flatten().and_then(|s| s.parse().ok()).unwrap_or(0);
    if n >= RATE_PER_MIN {
        return false;
    }
    if let Ok(put) = kv.put(&key, (n + 1).to_string()) {
        let _ = put.expiration_ttl(120).execute().await;
    }
    true
}

async fn token(env: &Env, user_id: &str) -> Result<Response> {
    let Some(key) = config::env_str(env, "DEEPGRAM_API_KEY") else {
        return json_err("voice not configured", 503);
    };
    if !rate_ok(env, user_id).await {
        return json_err("too many voice requests — try again in a minute", 429);
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    let headers = Headers::new();
    headers.set("authorization", &format!("Token {}", key))?;
    headers.set("content-type", "application/json")?;
    init.with_headers(headers);
    init.with_body(Some(json!({ "ttl_seconds": TOKEN_TTL_SECS }).to_string().into()));
    let mut resp = match Fetch::Request(Request::new_with_init(GRANT_URL, &init)?).send().await {
        Ok(r) => r,
        Err(_) => return json_err("voice upstream unreachable", 502),
    };
    let status = resp.status_code();
    if status == 401 || status == 403 {
        // key lacks grant permission — the same-origin relay still works
        return Response::from_json(&json!({ "error": "token grant unavailable", "fallback": "relay" }))
            .map(|r| r.with_status(501));
    }
    if !(200..300).contains(&status) {
        return json_err(&format!("voice upstream error ({})", status), 502);
    }
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let Some(access_token) = body.get("access_token").and_then(|v| v.as_str()) else {
        return json_err("voice upstream error (no token)", 502);
    };
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(TOKEN_TTL_SECS);
    Response::from_json(&json!({
        "access_token": access_token,
        "expires_in": expires_in,
        "ws_url": UPSTREAM_WSS,
        "settings": settings(),
    }))
}

/// Browser upgrades must come from this origin (or a Vite dev origin when DEV_ORIGINS is set).
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

fn active_key(user_id: &str) -> String {
    format!("voice:active:{}", user_id)
}

async fn relay_start(req: Request, env: &Env, user_id: &str) -> Result<Response> {
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
    // Cross-site WebSocket hijacking guard: upgrades carry cookies, CORS doesn't apply.
    if !origin_ok(&req, env) {
        return json_err("forbidden origin", 403);
    }
    let Some(key) = config::env_str(env, "DEEPGRAM_API_KEY") else {
        return json_err("voice not configured", 503);
    };
    if !rate_ok(env, user_id).await {
        return json_err("too many voice requests — try again in a minute", 429);
    }

    // Dial Deepgram first so failures surface as HTTP errors, not a dead socket.
    let mut up_req = Request::new(UPSTREAM_HTTPS, Method::Get)?;
    up_req.headers_mut()?.set("upgrade", "websocket")?;
    up_req.headers_mut()?.set("authorization", &format!("Token {}", key))?;
    let up_resp = match Fetch::Request(up_req).send().await {
        Ok(r) => r,
        Err(_) => return json_err("voice upstream unreachable", 502),
    };
    let up_status = up_resp.status_code();
    let Some(upstream) = up_resp.websocket() else {
        return json_err(&format!("voice upstream refused ({})", up_status), 502);
    };
    upstream.as_ref().set_binary_type(web_sys::BinaryType::Arraybuffer);
    upstream.accept()?;

    // Newest session wins: older relays for this user notice and close themselves.
    let nonce = crate::crypto::hex_encode(&crate::crypto::random_bytes(12));
    if let Ok(kv) = env.kv("SESSIONS") {
        if let Ok(put) = kv.put(&active_key(user_id), nonce.as_str()) {
            let _ = put.expiration_ttl(ACTIVE_TTL_SECS).execute().await;
        }
    }

    let pair = WebSocketPair::new()?;
    let server = pair.server;
    // The runtime defaults binaryType to "blob"; Uint8Array::new(blob) is empty,
    // so every binary audio frame would silently drop. Force arraybuffer.
    server.as_ref().set_binary_type(web_sys::BinaryType::Arraybuffer);
    server.accept()?;
    wasm_bindgen_futures::spawn_local(relay(env.clone(), user_id.to_string(), nonce, server, upstream));
    Response::from_websocket(pair.client)
}

enum Side {
    Client,
    Upstream,
}

/// Close codes a peer may send: 1000 or application range 3000–4999.
fn sendable_code(code: u16) -> u16 {
    if code == 1000 || (3000..=4999).contains(&code) {
        code
    } else {
        1000
    }
}

fn client_json_allowed(text: &str) -> bool {
    if text.len() > MAX_CLIENT_TEXT {
        return false;
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| CLIENT_ALLOWED.contains(&t)))
        .unwrap_or(false)
}

async fn relay(env: Env, user_id: String, nonce: String, client: WebSocket, upstream: WebSocket) {
    let (Ok(c_events), Ok(u_events)) = (client.events(), upstream.events()) else {
        let _ = client.close(Some(1011), Some("voice relay failed"));
        let _ = upstream.close(Some(1000), Some("relay failed"));
        return;
    };
    // Listeners are attached — now configure the agent (server-side Settings only).
    if upstream.send_with_str(settings().to_string()).is_err() {
        let _ = client.close(Some(1011), Some("voice relay failed"));
        let _ = upstream.close(Some(1000), Some("relay failed"));
        return;
    }

    let mut merged = Box::pin(futures::stream::select(
        c_events.map(|e| (Side::Client, e)),
        u_events.map(|e| (Side::Upstream, e)),
    ));
    let started = js_sys::Date::now();
    let mut next_owner_check = started + OWNER_CHECK_MS;

    while let Some((side, event)) = merged.next().await {
        let now = js_sys::Date::now();
        if now - started > SESSION_CAP_MS {
            let _ = client.close(Some(4001), Some("voice session time limit reached"));
            let _ = upstream.close(Some(1000), Some("session cap"));
            break;
        }
        if now >= next_owner_check {
            next_owner_check = now + OWNER_CHECK_MS;
            if let Ok(kv) = env.kv("SESSIONS") {
                if let Ok(Some(owner)) = kv.get(&active_key(&user_id)).text().await {
                    if owner != nonce {
                        let _ = client.close(Some(4002), Some("voice session opened elsewhere"));
                        let _ = upstream.close(Some(1000), Some("superseded"));
                        return; // the newer session owns the key — leave it
                    }
                }
            }
        }
        match (side, event) {
            (Side::Client, Ok(WebsocketEvent::Message(msg))) => {
                if let Some(text) = msg.text() {
                    if client_json_allowed(&text) {
                        let _ = upstream.send_with_str(text);
                    }
                } else if let Some(bytes) = msg.bytes() {
                    if bytes.len() <= MAX_CLIENT_AUDIO {
                        let _ = upstream.send_with_bytes(bytes);
                    }
                }
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
                let _ = client.close(Some(sendable_code(ev.code())), Some("voice agent closed"));
                break;
            }
            (_, Err(_)) => {
                let _ = client.close(Some(1011), Some("voice relay error"));
                let _ = upstream.close(Some(1000), Some("relay error"));
                break;
            }
        }
    }

    // Release the active marker if it is still ours.
    if let Ok(kv) = env.kv("SESSIONS") {
        let key = active_key(&user_id);
        if let Ok(Some(owner)) = kv.get(&key).text().await {
            if owner == nonce {
                let _ = kv.delete(&key).await;
            }
        }
    }
}
