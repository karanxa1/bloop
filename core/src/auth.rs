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
        "{}={}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age={}",
        COOKIE_NAME, token, SESSION_MAX_AGE
    )
}

fn clear_cookie() -> String {
    format!("{}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0", COOKIE_NAME)
}

/// Login/signup attempts allowed per IP and per email per window.
const AUTH_LIMIT: u32 = 10;
const AUTH_WINDOW_S: u64 = 600;
const PASSWORD_MAX: usize = 256;

fn client_ip(req: &Request) -> String {
    req.headers()
        .get("cf-connecting-ip")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".into())
}

/// Rate-limit subject for an email: a short hash, so raw emails never land in KV keys.
pub fn email_subject(email: &str) -> String {
    format!("email:{}", &crate::ledger::sha256_hex(&email.trim().to_ascii_lowercase())[..16])
}

/// Count this attempt against the per-IP and per-email windows; false when either is exhausted.
async fn auth_attempt_allowed(env: &Env, scope: &str, ip: &str, email: &str) -> bool {
    let now = (Date::now().as_millis() / 1000) as u64;
    let ip_key = db::rate_key(scope, &format!("ip:{}", ip), now, AUTH_WINDOW_S);
    let email_key = db::rate_key(scope, &email_subject(email), now, AUTH_WINDOW_S);
    let (ip_ok, email_ok) = futures::join!(
        db::rate_hit(env, &ip_key, AUTH_LIMIT, AUTH_WINDOW_S),
        async { email.is_empty() || db::rate_hit(env, &email_key, AUTH_LIMIT, AUTH_WINDOW_S).await },
    );
    ip_ok && email_ok
}

fn too_many() -> Result<Response> {
    json_err("too many attempts — try again in a few minutes", 429)
}

/// Operator-credentialed MCP servers are for admins: the eval caller, or a
/// user whose email is in ADMIN_EMAILS.
pub async fn is_admin(env: &Env, cfg: &config::Config, user_id: &str) -> bool {
    if user_id == EVAL_USER {
        return true;
    }
    if cfg.admin_emails.is_empty() {
        return false;
    }
    match db::user_by_id(env, user_id).await {
        Ok(Some(u)) => cfg.is_admin_email(u.get("email").and_then(|v| v.as_str()).unwrap_or("")),
        _ => false,
    }
}

pub const EVAL_USER: &str = "eval-user";

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
                        return Some((EVAL_USER.to_string(), false));
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
    // Signups are closed unless SIGNUPS_OPEN="true" (var or secret) — flip it
    // in wrangler.toml / `wrangler secret` to reopen. Logins are unaffected.
    if config::env_str(&env, "SIGNUPS_OPEN").as_deref() != Some("true") {
        return json_err("signups are paused right now — please check back later", 403);
    }
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
    if password.len() < 6 || password.len() > PASSWORD_MAX {
        return json_err("password must be 6-256 characters", 400);
    }
    let name = if name.is_empty() {
        email.split('@').next().unwrap_or("user").to_string()
    } else {
        name
    };
    if !auth_attempt_allowed(&env, "signup", &client_ip(&req), &email).await {
        return too_many();
    }

    if db::user_by_email(&env, &email).await?.is_some() {
        // Generic on purpose: don't confirm which emails have accounts.
        return json_err("could not create an account with these details — if you already have one, log in", 400);
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
    if password.len() > PASSWORD_MAX {
        return invalid();
    }
    if !auth_attempt_allowed(&env, "login", &client_ip(&req), &email).await {
        return too_many();
    }
    let user = match db::user_by_email(&env, &email).await? {
        Some(u) => u,
        None => {
            // Same PBKDF2 cost as a real check, so response time doesn't reveal accounts.
            let _ = crypto::pbkdf2_sha256(password.as_bytes(), b"bloop-no-such-user", PBKDF2_ITERS, 32);
            return invalid();
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_subject_is_normalized_and_hashed() {
        let a = email_subject(" Karan@Bloop.dev ");
        assert_eq!(a, email_subject("karan@bloop.dev"));
        assert!(a.starts_with("email:") && a.len() == "email:".len() + 16);
        assert!(!a.contains('@'));
    }

    #[test]
    fn cookie_is_secure_httponly_lax() {
        let c = session_cookie("t");
        for attr in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
            assert!(c.contains(attr), "{attr}");
        }
        assert!(clear_cookie().contains("Secure"));
    }
}
