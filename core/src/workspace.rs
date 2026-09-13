//! Per-conversation code workspaces, stored in R2 under `ws/<workspace>/<path>`.
use crate::config::Config;
use crate::sandbox;
use serde_json::{json, Value};
use worker::*;

pub const CONTENT_MAX: usize = 1024 * 1024;
pub const PATH_MAX: usize = 256;

/// A workspace failure with the HTTP status it maps to.
#[derive(Debug)]
pub struct WsError {
    pub status: u16,
    pub message: String,
}

impl WsError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        WsError { status, message: message.into() }
    }
}

type WsResult<T> = std::result::Result<T, WsError>;

pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub updated_at: u64,
}

/// A workspace-relative file path: non-empty, ≤ PATH_MAX chars, no leading
/// `/`, no NUL or backslash, and no empty, `.` or `..` segments.
pub fn validate_path(path: &str) -> WsResult<&str> {
    let bad = |m: &str| Err(WsError::new(400, format!("invalid path '{}': {}", path.chars().take(80).collect::<String>(), m)));
    if path.is_empty() {
        return bad("empty");
    }
    if path.chars().count() > PATH_MAX {
        return bad("too long");
    }
    if path.starts_with('/') {
        return bad("must be relative");
    }
    if path.contains('\0') || path.contains('\\') {
        return bad("contains NUL or backslash");
    }
    if path.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return bad("empty, '.' or '..' segment");
    }
    Ok(path)
}

fn key(ws: &str, path: &str) -> String {
    format!("ws/{}/{}", ws, path)
}

fn r2(env: &Env) -> WsResult<Bucket> {
    env.bucket("FILES").map_err(|e| WsError::new(500, format!("r2 bucket: {}", e)))
}

pub async fn write(env: &Env, ws: &str, path: &str, content: &str) -> WsResult<()> {
    let path = validate_path(path)?;
    if content.len() > CONTENT_MAX {
        return Err(WsError::new(413, format!("content too large (max {} bytes)", CONTENT_MAX)));
    }
    r2(env)?
        .put(key(ws, path), content.as_bytes().to_vec())
        .execute()
        .await
        .map(|_| ())
        .map_err(|e| WsError::new(500, format!("r2 put: {}", e)))
}

/// Read a UTF-8 text file (404 if missing, 415 if binary).
pub async fn read_text(env: &Env, ws: &str, path: &str) -> WsResult<String> {
    let path = validate_path(path)?;
    let obj = r2(env)?
        .get(key(ws, path))
        .execute()
        .await
        .map_err(|e| WsError::new(500, format!("r2 get: {}", e)))?
        .ok_or_else(|| WsError::new(404, format!("no such file: {}", path)))?;
    let bytes = match obj.body() {
        Some(b) => b.bytes().await.map_err(|e| WsError::new(500, format!("r2 read: {}", e)))?,
        None => Vec::new(),
    };
    if bytes.contains(&0) {
        return Err(WsError::new(415, format!("{} is binary", path)));
    }
    String::from_utf8(bytes).map_err(|_| WsError::new(415, format!("{} is not UTF-8 text", path)))
}

pub async fn delete(env: &Env, ws: &str, path: &str) -> WsResult<()> {
    let path = validate_path(path)?;
    r2(env)?
        .delete(key(ws, path))
        .await
        .map_err(|e| WsError::new(500, format!("r2 delete: {}", e)))
}

/// List files under `prefix` (may be empty), up to `max`. Returns (entries, truncated).
pub async fn list(env: &Env, ws: &str, prefix: &str, max: usize) -> WsResult<(Vec<Entry>, bool)> {
    let trimmed = prefix.trim_end_matches('/');
    if !trimmed.is_empty() {
        validate_path(trimmed)?;
    }
    let bucket = r2(env)?;
    let root = format!("ws/{}/", ws);
    let mut entries = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut req = bucket
            .list()
            .prefix(format!("{}{}", root, prefix))
            .limit((max - entries.len()).min(1000) as u32);
        if let Some(c) = cursor.take() {
            req = req.cursor(c);
        }
        let page = req
            .execute()
            .await
            .map_err(|e| WsError::new(500, format!("r2 list: {}", e)))?;
        for o in page.objects() {
            entries.push(Entry {
                path: o.key().strip_prefix(&root).unwrap_or_default().to_string(),
                bytes: o.size(),
                updated_at: o.uploaded().as_millis(),
            });
        }
        let more = page.truncated();
        if !more || entries.len() >= max {
            return Ok((entries, more));
        }
        cursor = page.cursor();
        if cursor.is_none() {
            return Ok((entries, false));
        }
    }
}

pub fn entries_json(entries: &[Entry]) -> Value {
    json!(entries
        .iter()
        .map(|e| json!({"path": e.path, "bytes": e.bytes, "updated_at": e.updated_at}))
        .collect::<Vec<_>>())
}

/// Run a shell command in the sandbox against this workspace (it hydrates from
/// R2 and syncs changes back). Returns the sandbox's (status, JSON body).
pub async fn exec(
    env: &Env,
    cfg: &Config,
    ws: &str,
    command: &str,
    timeout_s: Option<u64>,
) -> std::result::Result<(u16, Value), String> {
    let mut body = json!({"workspace": ws, "command": command});
    if let Some(t) = timeout_s {
        body["timeout_s"] = json!(t);
    }
    sandbox::post(env, cfg, "/workspace/exec", &body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_relative_paths() {
        for p in ["a.txt", "src/main.rs", "web/app/.env.example", "x-y_z/ü.md"] {
            assert!(validate_path(p).is_ok(), "{p}");
        }
        assert!(validate_path(&"a".repeat(PATH_MAX)).is_ok());
    }

    #[test]
    fn rejects_unsafe_paths() {
        let long = "a".repeat(PATH_MAX + 1);
        for p in ["", "/etc/passwd", "../x", "a/../b", "a/..", "a//b", "a/", "./a", "a\0b", "a\\b", long.as_str()] {
            let e = validate_path(p).unwrap_err();
            assert_eq!(e.status, 400, "{p:?}");
        }
    }
}
