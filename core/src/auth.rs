use crate::config;
use crate::crypto;
use crate::db;
use serde_json::{json, Value};
use worker::*;

const COOKIE_NAME: &str = "bloop_session";
const PBKDF2_ITERS: u32 = 100_000;
const SESSION_MAX_AGE: u64 = 7 * 24 * 3600;

/// Extract the session token from the Cookie header.
pub fn session_token(req: &Request) -> Option<String> {
    let hdr = req.headers().get("cookie").ok().flatten()?;
    for part in hdr.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{}=", COOKIE_NAME)) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn session_cookie(token: &str) -> String {
    format!(
        "{}={}; HttpOnly; Path=/; SameSite=Lax; Max-Age={}",
        COOKIE_NAME, token, SESSION_MAX_AGE
    )
}

fn clear_cookie() -> String {
    format!("{}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0", COOKIE_NAME)
}

fn hash_password(password: &str, salt: &[u8]) -> String {
    crypto::hex_encode(&crypto::pbkdf2_sha256(
        password.as_bytes(),
        salt,
        PBKDF2_ITERS,
        32,
    ))
}

/// Resolve the caller: Ok(Some((user_id, persist))) or Ok(None) if unauthenticated.
/// `/api/chat` additionally accepts `Authorization: Bearer <EVAL_TOKEN>` → ("eval-user", false).
pub async fn caller(req: &Request, env: &Env, allow_eval: bool) -> Option<(String, bool)> {
    if allow_eval {
        if let Some(eval) = config::env_str(env, "EVAL_TOKEN") {
            if let Ok(Some(auth)) = req.headers().get("authorization") {
                if let Some(tok) = auth.strip_prefix("Bearer ") {
                    if crypto::ct_eq(tok.trim().as_bytes(), eval.as_bytes()) {
                        return Some(("eval-user".to_string(), false));
                    }
                }
            }
        }
    }
    if let Some(token) = session_token(req) {
        if let Some(user_id) = db::session_user(env, &token).await {
            return Some((user_id, true));
        }
    }
    None
}

pub async fn signup(mut req: Request, env: Env) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if email.is_empty() || !email.contains('@') {
        return json_err("invalid email", 400);
    }
    if password.len() < 6 {
        return json_err("password must be at least 6 characters", 400);
    }
    let name = if name.is_empty() {
        email.split('@').next().unwrap_or("user").to_string()
    } else {
        name
    };

    if db::user_by_email(&env, &email).await?.is_some() {
        return json_err("email already registered", 409);
    }

    let salt = crypto::random_bytes(16);
    let pw_hash = hash_password(&password, &salt);
    let user = db::create_user(&env, &email, &name, &pw_hash, &crypto::hex_encode(&salt)).await?;
    let token = db::create_session(&env, &user["id"].as_str().unwrap_or_default()).await?;

    let mut resp = Response::from_json(&user)?.with_status(201);
    resp.headers_mut()
        .set("set-cookie", &session_cookie(&token))?;
    Ok(resp)
}

pub async fn login(mut req: Request, env: Env) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let invalid = || json_err("invalid credentials", 401);
    let user = match db::user_by_email(&env, &email).await? {
        Some(u) => u,
        None => return invalid(),
    };
    let salt = match user
        .get("salt")
        .and_then(|v| v.as_str())
        .and_then(crypto::hex_decode)
    {
        Some(s) => s,
        None => return invalid(),
    };
    let expected = user
        .get("pw_hash")
        .and_then(|v| v.as_str())
        .and_then(crypto::hex_decode)
        .unwrap_or_default();
    let actual = crypto::pbkdf2_sha256(password.as_bytes(), &salt, PBKDF2_ITERS, 32);
    if !crypto::ct_eq(&actual, &expected) {
        return invalid();
    }

    let user_id = user.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let token = db::create_session(&env, user_id).await?;
    let mut resp = Response::from_json(&json!({
        "id": user_id,
        "email": user.get("email").and_then(|v| v.as_str()).unwrap_or(""),
        "name": user.get("name").and_then(|v| v.as_str()).unwrap_or(""),
    }))?;
    resp.headers_mut()
        .set("set-cookie", &session_cookie(&token))?;
    Ok(resp)
}

pub async fn logout(req: Request, env: Env) -> Result<Response> {
    if let Some(token) = session_token(&req) {
        db::delete_session(&env, &token).await;
    }
    let mut resp = Response::from_json(&json!({"ok": true}))?;
    resp.headers_mut().set("set-cookie", &clear_cookie())?;
    Ok(resp)
}

pub async fn me(req: Request, env: Env) -> Result<Response> {
    let token = match session_token(&req) {
        Some(t) => t,
        None => return json_err("unauthorized", 401),
    };
    let user_id = match db::session_user(&env, &token).await {
        Some(u) => u,
        None => return json_err("unauthorized", 401),
    };
    match db::user_by_id(&env, &user_id).await? {
        Some(u) => Response::from_json(&json!({
            "id": u.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "email": u.get("email").and_then(|v| v.as_str()).unwrap_or(""),
            "name": u.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        })),
        None => json_err("unauthorized", 401),
    }
}

fn json_err(msg: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({"error": msg})).map(|r| r.with_status(status))
}
