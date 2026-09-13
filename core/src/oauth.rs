//! OAuth 2.1 for remote MCP servers (MCP authorization spec 2025-06-18 /
//! 2025-11-25): RFC 9728 protected-resource metadata (from the 401
//! `WWW-Authenticate` or well-known URIs) → RFC 8414 / OIDC discovery →
//! RFC 7591 dynamic client registration (cached per auth server in D1) or a
//! client ID metadata document → PKCE S256 + RFC 8707 `resource` → token
//! exchange, stored in `server_configs.oauth_json`, refreshed on use.
//!
//! Limits: refresh is not serialized across concurrent runs (a rotating
//! refresh token may be consumed twice → user re-authorizes). Pre-registered
//! clients (e.g. GitHub OAuth apps) are not supported; use bearer tokens.

use crate::mcp::{parse_www_authenticate, LATEST_PROTOCOL};
use crate::{config, crypto, db, netguard};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use worker::*;

const STATE_TTL_SECS: u64 = 600;
const REFRESH_SKEW_MS: f64 = 60_000.0;
pub const CALLBACK_PATH: &str = "/api/oauth/callback";
pub const CLIENT_METADATA_PATH: &str = "/api/oauth/client.json";
const CLIENT_NAME: &str = "bloop";

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// RFC 7636 S256 code challenge.
pub fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// RFC 8707 canonical resource URI: no fragment, no trailing slash on a bare origin.
pub fn canonical_resource(server_url: &str) -> Option<String> {
    let mut u = Url::parse(server_url).ok()?;
    u.set_fragment(None);
    let mut s = u.to_string();
    if u.path() == "/" && u.query().is_none() {
        s.pop();
    }
    Some(s)
}

fn origin_of(url: &str) -> Option<String> {
    Url::parse(url).ok().map(|u| u.origin().ascii_serialization())
}

/// RFC 9728 well-known candidates: path-inserted, then root.
pub fn protected_resource_metadata_urls(server_url: &str) -> Vec<String> {
    let Ok(u) = Url::parse(server_url) else {
        return Vec::new();
    };
    let origin = u.origin().ascii_serialization();
    let path = u.path().trim_end_matches('/');
    let mut v = Vec::new();
    if !path.is_empty() {
        v.push(format!("{}/.well-known/oauth-protected-resource{}", origin, path));
    }
    v.push(format!("{}/.well-known/oauth-protected-resource", origin));
    v
}

/// RFC 8414 / OIDC discovery candidates in MCP 2025-11-25 priority order.
pub fn auth_server_metadata_urls(issuer: &str) -> Vec<String> {
    let Ok(u) = Url::parse(issuer) else {
        return Vec::new();
    };
    let origin = u.origin().ascii_serialization();
    let path = u.path().trim_end_matches('/');
    if path.is_empty() {
        vec![
            format!("{}/.well-known/oauth-authorization-server", origin),
            format!("{}/.well-known/openid-configuration", origin),
        ]
    } else {
        vec![
            format!("{}/.well-known/oauth-authorization-server{}", origin, path),
            format!("{}/.well-known/openid-configuration{}", origin, path),
            format!("{}{}/.well-known/openid-configuration", origin, path),
        ]
    }
}

/// application/x-www-form-urlencoded body / query string.
pub fn form_encode(pairs: &[(&str, &str)]) -> String {
    let mut u = Url::parse("https://x.invalid/").expect("static url");
    u.query_pairs_mut().extend_pairs(pairs.iter().copied());
    u.query().unwrap_or("").to_string()
}

#[derive(Debug, Clone, Default)]
pub struct Discovery {
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub cimd_supported: bool,
    pub scope: Option<String>,
}

async fn fetch_json(url: &str) -> std::result::Result<Value, String> {
    let h = Headers::new();
    h.set("accept", "application/json").map_err(|e| e.to_string())?;
    let mut resp = netguard::fetch_guarded(url, Method::Get, &h, None).await?;
    let status = resp.status_code();
    let text = netguard::read_text_capped(&mut resp, netguard::SMALL_BODY_CAP).await?;
    if !(200..300).contains(&status) {
        return Err(format!("{} returned HTTP {}", url, status));
    }
    serde_json::from_str(&text).map_err(|_| format!("{} did not return JSON", url))
}

/// Discover the authorization server for an MCP server URL.
pub async fn discover(server_url: &str) -> std::result::Result<Discovery, String> {
    netguard::check_outbound_url(server_url)?;
    // 1. Unauthenticated initialize → 401 challenge with resource_metadata/scope.
    let h = Headers::new();
    let _ = h.set("content-type", "application/json");
    let _ = h.set("accept", "application/json, text/event-stream");
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": LATEST_PROTOCOL, "capabilities": {}, "clientInfo": {"name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION")}}
    })
    .to_string();
    let (mut resource_metadata, mut scope) = (None, None);
    if let Ok(resp) = netguard::fetch_guarded(server_url, Method::Post, &h, Some(&body)).await {
        if matches!(resp.status_code(), 401 | 403) {
            if let Ok(Some(w)) = resp.headers().get("www-authenticate") {
                let p = parse_www_authenticate(&w);
                resource_metadata = p.resource_metadata().map(String::from);
                scope = p.scope().map(String::from);
            }
        }
    }
    // 2. Protected resource metadata.
    let mut candidates: Vec<String> = resource_metadata.into_iter().collect();
    candidates.extend(protected_resource_metadata_urls(server_url));
    let mut prm: Option<Value> = None;
    for c in candidates {
        if let Ok(v) = fetch_json(&c).await {
            if v.get("authorization_servers").and_then(|a| a.as_array()).map_or(false, |a| !a.is_empty()) {
                prm = Some(v);
                break;
            }
        }
    }
    let default_resource = canonical_resource(server_url).ok_or("invalid server url")?;
    let server_origin = origin_of(server_url).unwrap_or_default();
    let (issuer, resource) = match &prm {
        Some(p) => {
            let issuer = p["authorization_servers"][0].as_str().unwrap_or("").to_string();
            let resource = p
                .get("resource")
                .and_then(|r| r.as_str())
                .filter(|r| origin_of(r).as_deref() == Some(server_origin.as_str()))
                .map(String::from)
                .unwrap_or(default_resource);
            if scope.is_none() {
                scope = p
                    .get("scopes_supported")
                    .and_then(|s| s.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
                    .filter(|s| !s.is_empty());
            }
            (issuer, resource)
        }
        // 2025-03-26 fallback: the MCP server origin is the auth server.
        None => (server_origin, default_resource),
    };
    netguard::check_outbound_url(&issuer).map_err(|e| format!("authorization server: {}", e))?;
    // 3. Authorization server metadata.
    let mut meta: Option<Value> = None;
    for c in auth_server_metadata_urls(&issuer) {
        if let Ok(v) = fetch_json(&c).await {
            if v.get("authorization_endpoint").is_some() && v.get("token_endpoint").is_some() {
                meta = Some(v);
                break;
            }
        }
    }
    let meta = meta.ok_or_else(|| format!("no OAuth metadata found for {}", issuer))?;
    let s = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(String::from);
    let authorization_endpoint = s("authorization_endpoint").unwrap_or_default();
    let token_endpoint = s("token_endpoint").unwrap_or_default();
    netguard::check_outbound_url(&authorization_endpoint).map_err(|e| format!("authorization_endpoint: {}", e))?;
    netguard::check_outbound_url(&token_endpoint).map_err(|e| format!("token_endpoint: {}", e))?;
    let pkce = meta
        .get("code_challenge_methods_supported")
        .and_then(|m| m.as_array())
        .map_or(false, |a| a.iter().any(|x| x.as_str() == Some("S256")));
    if !pkce {
        return Err("authorization server does not advertise PKCE S256".into());
    }
    Ok(Discovery {
        resource,
        issuer,
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: s("registration_endpoint").filter(|r| netguard::check_outbound_url(r).is_ok()),
        cimd_supported: meta.get("client_id_metadata_document_supported").and_then(|v| v.as_bool()).unwrap_or(false),
        scope,
    })
}

struct OAuthClient {
    client_id: String,
    client_secret: String,
    auth_method: String,
}

/// Cached DCR client → fresh DCR → client ID metadata document.
async fn ensure_client(env: &Env, disc: &Discovery, redirect_uri: &str, origin: &str) -> std::result::Result<OAuthClient, String> {
    if let Ok(Some(row)) = db::get_oauth_client(env, &disc.issuer, redirect_uri).await {
        let s = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let reg: Value = serde_json::from_str(&s("registration_json")).unwrap_or(Value::Null);
        let secret = s("client_secret");
        return Ok(OAuthClient {
            client_id: s("client_id"),
            auth_method: reg
                .get("token_endpoint_auth_method")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| if secret.is_empty() { "none".into() } else { "client_secret_basic".into() }),
            client_secret: secret,
        });
    }
    if let Some(reg_url) = &disc.registration_endpoint {
        let mut req_body = json!({
            "client_name": CLIENT_NAME,
            "client_uri": origin,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        });
        if let Some(sc) = &disc.scope {
            req_body["scope"] = json!(sc);
        }
        let h = Headers::new();
        let _ = h.set("content-type", "application/json");
        let _ = h.set("accept", "application/json");
        let mut resp = netguard::fetch_guarded(reg_url, Method::Post, &h, Some(&req_body.to_string())).await?;
        let status = resp.status_code();
        let text = netguard::read_text_capped(&mut resp, netguard::SMALL_BODY_CAP).await?;
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let client_id = v.get("client_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if !(200..300).contains(&status) || client_id.is_empty() {
            let msg = v
                .get("error_description")
                .or_else(|| v.get("error"))
                .and_then(|x| x.as_str())
                .map(String::from)
                .unwrap_or_else(|| netguard::snippet(&text, 120));
            return Err(format!("client registration failed (HTTP {}): {}", status, netguard::snippet(&msg, 160)));
        }
        let secret = v.get("client_secret").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let auth_method = v
            .get("token_endpoint_auth_method")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| if secret.is_empty() { "none".into() } else { "client_secret_basic".into() });
        let reg_json = json!({"token_endpoint_auth_method": auth_method}).to_string();
        db::put_oauth_client(env, &disc.issuer, redirect_uri, &client_id, &secret, &reg_json)
            .await
            .map_err(|e| format!("store client: {}", e))?;
        return Ok(OAuthClient { client_id, client_secret: secret, auth_method });
    }
    if disc.cimd_supported {
        return Ok(OAuthClient {
            client_id: format!("{}{}", origin, CLIENT_METADATA_PATH),
            client_secret: String::new(),
            auth_method: "none".into(),
        });
    }
    Err("authorization server supports neither dynamic client registration nor client ID metadata documents".into())
}

pub fn app_origin(env: &Env, req: &Request) -> String {
    if let Some(o) = config::env_str(env, "APP_ORIGIN") {
        return o.trim_end_matches('/').to_string();
    }
    req.url().map(|u| u.origin().ascii_serialization()).unwrap_or_default()
}

fn redirect(location: &str) -> Result<Response> {
    let mut r = Response::empty()?.with_status(302);
    r.headers_mut().set("location", location)?;
    r.headers_mut().set("cache-control", "no-store")?;
    Ok(r)
}

fn app_error(server_id: &str, msg: &str) -> Result<Response> {
    let m = netguard::snippet(msg, 160);
    redirect(&format!("/app?{}", form_encode(&[("oauth_error", &m), ("server", server_id)])))
}

pub fn build_authorize_url(
    disc: &Discovery,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> std::result::Result<String, String> {
    let mut u = Url::parse(&disc.authorization_endpoint).map_err(|e| e.to_string())?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", &disc.resource);
        if let Some(s) = disc.scope.as_deref().filter(|s| !s.is_empty()) {
            q.append_pair("scope", s);
        }
    }
    Ok(u.to_string())
}

/// GET /api/servers/:id/oauth/start → 302 to the authorization server
/// (or `{authorize_url}` when called with `Accept: application/json`).
pub async fn start(req: &Request, env: &Env, user_id: &str, server_id: &str) -> Result<Response> {
    let wants_json = req
        .headers()
        .get("accept")
        .ok()
        .flatten()
        .map_or(false, |a| a.contains("application/json"));
    let fail = |msg: String| -> Result<Response> {
        if wants_json {
            Response::from_json(&json!({"error": netguard::snippet(&msg, 200), "error_kind": "auth"})).map(|r| r.with_status(400))
        } else {
            app_error(server_id, &msg)
        }
    };
    let Some(row) = db::get_user_server_full(env, user_id, server_id).await? else {
        return fail("server not found".into());
    };
    let server_url = row.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let origin = app_origin(env, req);
    let redirect_uri = format!("{}{}", origin, CALLBACK_PATH);
    let disc = match discover(&server_url).await {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let client = match ensure_client(env, &disc, &redirect_uri, &origin).await {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let verifier = b64url(&crypto::random_bytes(32));
    let state = b64url(&crypto::random_bytes(24));
    let authorize_url = match build_authorize_url(&disc, &client.client_id, &redirect_uri, &pkce_challenge(&verifier), &state) {
        Ok(u) => u,
        Err(e) => return fail(e),
    };
    let pending = json!({
        "user_id": user_id,
        "server_id": server_id,
        "verifier": verifier,
        "redirect_uri": redirect_uri,
        "client_id": client.client_id,
        "client_secret": client.client_secret,
        "auth_method": client.auth_method,
        "token_endpoint": disc.token_endpoint,
        "resource": disc.resource,
        "issuer": disc.issuer,
        "scope": disc.scope,
    })
    .to_string();
    env.kv("SESSIONS")?
        .put(&format!("oauth:{}", state), pending.as_str())?
        .expiration_ttl(STATE_TTL_SECS)
        .execute()
        .await
        .map_err(|e| Error::RustError(format!("kv put: {}", e)))?;
    if wants_json {
        return Response::from_json(&json!({"authorize_url": authorize_url}));
    }
    redirect(&authorize_url)
}

/// GET /api/oauth/callback?code&state (session cookie) → 302 /app?connected=<id>
pub async fn callback(req: &Request, env: &Env, user_id: &str) -> Result<Response> {
    let q: HashMap<String, String> = req.url()?.query_pairs().into_owned().collect();
    let Some(state) = q.get("state").filter(|s| !s.is_empty()) else {
        return app_error("", "missing state");
    };
    let kv = env.kv("SESSIONS")?;
    let key = format!("oauth:{}", state);
    let pending: Value = match kv
        .get(&key)
        .text()
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return app_error("", "authorization expired, please try again"),
    };
    let _ = kv.delete(&key).await;
    let ps = |k: &str| pending.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let server_id = ps("server_id");
    if ps("user_id") != user_id {
        return app_error(&server_id, "authorization was started by a different session");
    }
    if let Some(err) = q.get("error") {
        let desc = q.get("error_description").cloned().unwrap_or_default();
        return app_error(&server_id, &format!("{} {}", err, desc));
    }
    let Some(code) = q.get("code").filter(|c| !c.is_empty()) else {
        return app_error(&server_id, "missing authorization code");
    };
    let (redirect_uri, client_id, verifier, resource) = (ps("redirect_uri"), ps("client_id"), ps("verifier"), ps("resource"));
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", resource.as_str()),
    ];
    let tok = match token_request(&pending, &form).await {
        Ok(t) => t,
        Err(e) => return app_error(&server_id, &e),
    };
    let record = oauth_record(&tok, &pending, js_sys::Date::now(), None);
    db::set_server_oauth(env, &server_id, &record.to_string()).await?;
    redirect(&format!("/app?{}", form_encode(&[("connected", &server_id)])))
}

fn form_component(s: &str) -> String {
    form_encode(&[("a", s)]).trim_start_matches("a=").to_string()
}

/// POST to the token endpoint with client auth per the registered method.
async fn token_request(ctx: &Value, form: &[(&str, &str)]) -> std::result::Result<Value, String> {
    let s = |k: &str| ctx.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let (endpoint, client_id, secret, method) = (s("token_endpoint"), s("client_id"), s("client_secret"), s("auth_method"));
    let h = Headers::new();
    h.set("content-type", "application/x-www-form-urlencoded").map_err(|e| e.to_string())?;
    h.set("accept", "application/json").map_err(|e| e.to_string())?;
    let mut pairs: Vec<(&str, &str)> = form.iter().copied().filter(|(_, v)| !v.is_empty()).collect();
    if !secret.is_empty() {
        if method == "client_secret_post" {
            pairs.push(("client_secret", secret));
        } else {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", form_component(client_id), form_component(secret)));
            h.set("authorization", &format!("Basic {}", basic)).map_err(|e| e.to_string())?;
        }
    }
    let body = form_encode(&pairs);
    let mut resp = netguard::fetch_guarded(endpoint, Method::Post, &h, Some(&body)).await?;
    let status = resp.status_code();
    let text = netguard::read_text_capped(&mut resp, netguard::SMALL_BODY_CAP).await?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let msg = v
            .get("error_description")
            .or_else(|| v.get("error"))
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| netguard::snippet(&text, 120));
        return Err(format!("token endpoint HTTP {}: {}", status, netguard::snippet(&msg, 160)));
    }
    if v.get("access_token").and_then(|x| x.as_str()).map_or(true, |t| t.is_empty()) {
        return Err("token response missing access_token".into());
    }
    Ok(v)
}

/// Stored OAuth record (`server_configs.oauth_json`); `ctx` carries client/endpoint info.
pub fn oauth_record(tok: &Value, ctx: &Value, now_ms: f64, prev_refresh: Option<&str>) -> Value {
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    let expires_in = tok
        .get("expires_in")
        .and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())));
    json!({
        "access_token": s(tok, "access_token"),
        "refresh_token": s(tok, "refresh_token").or_else(|| prev_refresh.map(String::from)),
        "token_type": s(tok, "token_type").unwrap_or_else(|| "Bearer".into()),
        "scope": s(tok, "scope").or_else(|| s(ctx, "scope")),
        "expires_at": expires_in.map(|e| now_ms + e * 1000.0),
        "token_endpoint": s(ctx, "token_endpoint"),
        "client_id": s(ctx, "client_id"),
        "client_secret": s(ctx, "client_secret"),
        "auth_method": s(ctx, "auth_method"),
        "resource": s(ctx, "resource"),
        "issuer": s(ctx, "issuer"),
        "updated_at": now_ms,
    })
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty())
}

pub fn needs_refresh(oauth: &Value, now_ms: f64) -> bool {
    str_field(oauth, "access_token").is_none()
        || oauth
            .get("expires_at")
            .and_then(|e| e.as_f64())
            .map_or(false, |e| e - REFRESH_SKEW_MS <= now_ms)
}

/// "connected" when a usable (or refreshable) token exists, else "required".
pub fn oauth_status(oauth: &Value) -> &'static str {
    let has_access = str_field(oauth, "access_token").is_some();
    let has_refresh = str_field(oauth, "refresh_token").is_some();
    let expired = oauth
        .get("expires_at")
        .and_then(|e| e.as_f64())
        .map_or(false, |e| e <= now_ms_safe());
    if has_access && (!expired || has_refresh) {
        "connected"
    } else {
        "required"
    }
}

#[cfg(target_arch = "wasm32")]
fn now_ms_safe() -> f64 {
    js_sys::Date::now()
}
#[cfg(not(target_arch = "wasm32"))]
fn now_ms_safe() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Access token for a stored OAuth record, refreshing (and persisting) when
/// expired. `None` → re-authorization required.
pub async fn fresh_access_token(env: &Env, server_id: &str, oauth: &Value) -> Option<String> {
    let now = now_ms_safe();
    if !needs_refresh(oauth, now) {
        return str_field(oauth, "access_token").map(String::from);
    }
    str_field(oauth, "refresh_token")?;
    // Best-effort KV lock so concurrent runs don't burn a rotating refresh token.
    let kv = env.kv("SESSIONS").ok();
    let lock_key = format!("oauth-refresh:{}", server_id);
    if let Some(kv) = &kv {
        if kv.get(&lock_key).text().await.ok().flatten().is_some() {
            for _ in 0..6 {
                Delay::from(std::time::Duration::from_millis(500)).await;
                if let Some(stored) = stored_oauth(env, server_id).await {
                    if !needs_refresh(&stored, now_ms_safe()) {
                        return str_field(&stored, "access_token").map(String::from);
                    }
                }
            }
            return None;
        }
        // KV's minimum TTL is 60s; the lock is deleted as soon as refresh ends.
        if let Ok(put) = kv.put(&lock_key, "1") {
            let _ = put.expiration_ttl(60).execute().await;
        }
    }
    let result = refresh_now(env, server_id, oauth, now).await;
    if let Some(kv) = &kv {
        let _ = kv.delete(&lock_key).await;
    }
    result
}

async fn stored_oauth(env: &Env, server_id: &str) -> Option<Value> {
    let s = db::get_server_oauth(env, server_id).await.ok().flatten()?;
    serde_json::from_str(&s).ok()
}

async fn refresh_now(env: &Env, server_id: &str, oauth: &Value, now: f64) -> Option<String> {
    let refresh = str_field(oauth, "refresh_token")?;
    let client_id = str_field(oauth, "client_id").unwrap_or("");
    let resource = str_field(oauth, "resource").unwrap_or("");
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client_id),
        ("resource", resource),
    ];
    let tok = token_request(oauth, &form).await.ok()?;
    let record = oauth_record(&tok, oauth, now, Some(refresh));
    let _ = db::set_server_oauth(env, server_id, &record.to_string()).await;
    str_field(&record, "access_token").map(String::from)
}

/// GET /api/oauth/client.json — public client ID metadata document.
pub fn client_metadata(req: &Request, env: &Env) -> Result<Response> {
    let origin = app_origin(env, req);
    Response::from_json(&json!({
        "client_id": format!("{}{}", origin, CLIENT_METADATA_PATH),
        "client_name": CLIENT_NAME,
        "client_uri": origin,
        "redirect_uris": [format!("{}{}", origin, CALLBACK_PATH)],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc7636_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn discovery_urls() {
        assert_eq!(canonical_resource("https://MCP.Stripe.com/").unwrap(), "https://mcp.stripe.com");
        assert_eq!(canonical_resource("https://mcp.higgsfield.ai/mcp#x").unwrap(), "https://mcp.higgsfield.ai/mcp");
        assert_eq!(
            protected_resource_metadata_urls("https://mcp.linear.app/mcp"),
            vec![
                "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
                "https://mcp.linear.app/.well-known/oauth-protected-resource"
            ]
        );
        assert_eq!(protected_resource_metadata_urls("https://mcp.vercel.com").len(), 1);
        assert_eq!(
            auth_server_metadata_urls("https://auth.example.com/tenant1"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
                "https://auth.example.com/.well-known/openid-configuration/tenant1",
                "https://auth.example.com/tenant1/.well-known/openid-configuration"
            ]
        );
        assert_eq!(auth_server_metadata_urls("https://clerk.higgsfield.ai")[0], "https://clerk.higgsfield.ai/.well-known/oauth-authorization-server");
    }

    #[test]
    fn authorize_url_has_pkce_and_resource() {
        let d = Discovery {
            resource: "https://mcp.higgsfield.ai/mcp".into(),
            authorization_endpoint: "https://clerk.higgsfield.ai/oauth/authorize".into(),
            scope: Some("openid email offline_access".into()),
            ..Default::default()
        };
        let u = build_authorize_url(&d, "cid", "https://app.example.com/api/oauth/callback", "chal", "st").unwrap();
        assert!(u.contains("code_challenge_method=S256"));
        assert!(u.contains("resource=https%3A%2F%2Fmcp.higgsfield.ai%2Fmcp"));
        assert!(u.contains("scope=openid+email+offline_access"));
        assert!(u.contains("state=st"));
        assert_eq!(form_encode(&[("a", "b c&d")]), "a=b+c%26d");
    }

    #[test]
    fn token_record_and_refresh() {
        let ctx = json!({"token_endpoint": "https://a/token", "client_id": "c", "resource": "https://r", "scope": "s"});
        let rec = oauth_record(&json!({"access_token": "at", "expires_in": 3600}), &ctx, 1000.0, Some("old_rt"));
        assert_eq!(rec["refresh_token"], "old_rt");
        assert_eq!(rec["expires_at"], 3_601_000.0);
        assert_eq!(rec["scope"], "s");
        assert!(!needs_refresh(&rec, 1000.0));
        assert!(needs_refresh(&rec, 3_550_000.0));
        assert!(needs_refresh(&json!({}), 0.0));
        assert_eq!(oauth_status(&json!({})), "required");
        assert_eq!(oauth_status(&json!({"access_token": "a", "expires_at": 1.0})), "required");
        assert_eq!(oauth_status(&json!({"access_token": "a", "expires_at": 1.0, "refresh_token": "r"})), "connected");
    }
}
