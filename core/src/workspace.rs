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

// ---------- uploads / raw bytes ----------

pub const UPLOAD_FILE_MAX: usize = 25 * 1024 * 1024;
pub const UPLOAD_FILES_MAX: usize = 200;
pub const UPLOAD_REQUEST_MAX: usize = 100 * 1024 * 1024;
/// Largest image sent to the model as vision input.
pub const VISION_IMAGE_MAX: usize = 5 * 1024 * 1024;

fn json_error(msg: &str, status: u16) -> Result<Response> {
    Ok(Response::from_json(&json!({"error": msg}))?.with_status(status))
}

/// Workspace path for an uploaded file name (folder uploads carry `dir/sub/file`).
pub fn upload_path(filename: &str) -> WsResult<String> {
    let name = filename.trim().trim_start_matches("./");
    let path = format!("uploads/{}", name);
    validate_path(&path)?;
    Ok(path)
}

/// MIME from magic bytes — never from the client. Valid UTF-8 without NULs is text.
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'%', b'P', b'D', b'F', ..] => "application/pdf",
        [b'P', b'K', 3, 4, ..] => "application/zip",
        _ => {
            let head = &bytes[..bytes.len().min(8192)];
            // A multi-byte char cut at the 8 KiB boundary is still text.
            let utf8 = std::str::from_utf8(head).map_or_else(|e| e.error_len().is_none(), |_| true);
            if !head.contains(&0) && utf8 {
                "text/plain; charset=utf-8"
            } else {
                "application/octet-stream"
            }
        }
    }
}

/// Image formats the model accepts as vision input.
pub fn is_vision_mime(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

pub async fn write_bytes(env: &Env, ws: &str, path: &str, bytes: Vec<u8>) -> WsResult<()> {
    let path = validate_path(path)?;
    r2(env)?
        .put(key(ws, path), bytes)
        .execute()
        .await
        .map(|_| ())
        .map_err(|e| WsError::new(500, format!("r2 put: {}", e)))
}

/// Raw bytes of a workspace file (404 if missing, 413 past `cap`).
pub async fn read_bytes(env: &Env, ws: &str, path: &str, cap: usize) -> WsResult<Vec<u8>> {
    let path = validate_path(path)?;
    let obj = r2(env)?
        .get(key(ws, path))
        .execute()
        .await
        .map_err(|e| WsError::new(500, format!("r2 get: {}", e)))?
        .ok_or_else(|| WsError::new(404, format!("no such file: {}", path)))?;
    if obj.size() as usize > cap {
        return Err(WsError::new(413, format!("{} is larger than {} MB", path, cap / (1024 * 1024))));
    }
    match obj.body() {
        Some(b) => b.bytes().await.map_err(|e| WsError::new(500, format!("r2 read: {}", e))),
        None => Ok(Vec::new()),
    }
}

/// `POST /api/workspace/:conv/upload` — multipart `file` fields whose filenames are
/// relative paths, stored under `uploads/`. The caller has checked conversation ownership.
pub async fn upload_route(mut req: Request, env: &Env, ws: &str) -> Result<Response> {
    let declared = req
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .and_then(|l| l.trim().parse::<usize>().ok());
    if declared.is_some_and(|n| n > UPLOAD_REQUEST_MAX + 1024 * 1024) {
        return json_error("upload too large (max 100 MB per request)", 413);
    }
    let Ok(form) = req.form_data().await else {
        return json_error("expected multipart/form-data with file fields", 400);
    };
    let files: Vec<File> = form
        .get_all("file")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| match e {
            FormEntry::File(f) => Some(f),
            FormEntry::Field(_) => None,
        })
        .collect();
    if files.is_empty() {
        return json_error("no file fields", 400);
    }
    if files.len() > UPLOAD_FILES_MAX {
        return json_error(&format!("too many files (max {})", UPLOAD_FILES_MAX), 413);
    }
    // Validate every file before writing any.
    let mut planned = Vec::with_capacity(files.len());
    let mut total = 0usize;
    for f in files {
        if f.size() > UPLOAD_FILE_MAX {
            return json_error(&format!("{} is larger than 25 MB", f.name()), 413);
        }
        total += f.size();
        if total > UPLOAD_REQUEST_MAX {
            return json_error("upload too large (max 100 MB per request)", 413);
        }
        match upload_path(&f.name()) {
            Ok(path) => planned.push((path, f)),
            Err(e) => return json_error(&e.message, e.status),
        }
    }
    let mut out = Vec::with_capacity(planned.len());
    for (path, f) in planned {
        let bytes = f.bytes().await?;
        let (n, mime) = (bytes.len(), sniff_mime(&bytes));
        if let Err(e) = write_bytes(env, ws, &path, bytes).await {
            return json_error(&e.message, e.status);
        }
        out.push(json!({"path": path, "bytes": n, "mime": mime}));
    }
    Response::from_json(&out)
}

/// Filename for Content-Disposition: the basename with only safe characters.
pub fn disposition_filename(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or("file");
    let clean: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    if clean.trim_matches('.').is_empty() { "file".into() } else { clean }
}

/// `GET /api/workspace/:conv/raw?path=` — images inline, everything else as a download.
pub async fn raw_response(env: &Env, ws: &str, path: &str) -> Result<Response> {
    let bytes = match read_bytes(env, ws, path, UPLOAD_FILE_MAX).await {
        Ok(b) => b,
        Err(e) => return json_error(&e.message, e.status),
    };
    let mime = sniff_mime(&bytes);
    let h = Headers::new();
    h.set("x-content-type-options", "nosniff")?;
    h.set("cache-control", "private, no-store")?;
    if is_vision_mime(mime) {
        h.set("content-type", mime)?;
    } else {
        h.set("content-type", "application/octet-stream")?;
        h.set(
            "content-disposition",
            &format!("attachment; filename=\"{}\"", disposition_filename(path)),
        )?;
    }
    Ok(Response::from_bytes(bytes)?.with_headers(h))
}

/// Run a shell command in the sandbox against this workspace (it hydrates from
/// R2 and syncs changes back). Returns the sandbox's (status, JSON body).
pub async fn exec(
    env: &Env,
    cfg: &Config,
    user_id: &str,
    ws: &str,
    command: &str,
    timeout_s: Option<u64>,
) -> std::result::Result<(u16, Value), String> {
    let mut body = json!({"workspace": ws, "command": command});
    if let Some(t) = timeout_s {
        body["timeout_s"] = json!(t);
    }
    sandbox::post(env, cfg, user_id, "/workspace/exec", &body).await
}

// ---------- /files keys ----------

/// Object kinds a user may fetch through `/files/`.
pub const FILE_KINDS: &[&str] = &["img", "shots", "mcpapp"];

/// A fresh owner-scoped R2 key: `u/<user_id>/<kind>/<uuid>.<ext>`.
pub fn user_file_key(user_id: &str, kind: &str, ext: &str) -> String {
    format!("u/{}/{}/{}.{}", user_id, kind, crate::crypto::uuid(), ext)
}

#[derive(Debug, PartialEq, Eq)]
pub enum FileAccess {
    /// The caller's own object of this kind.
    Owned(&'static str),
    /// Pre-scoping `img/<uuid>.<ext>` or `shots/…` key: serve only if the
    /// caller's own messages reference it.
    Legacy,
    Denied,
}

/// Decide whether `caller` may read R2 `key` via `/files/`. Workspace (`ws/`)
/// and other users' objects are never served here.
pub fn file_access(caller: &str, key: &str) -> FileAccess {
    if caller.is_empty() || key.contains('\\') || key.contains('\0') {
        return FileAccess::Denied;
    }
    let segs: Vec<&str> = key.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return FileAccess::Denied;
    }
    match segs.as_slice() {
        ["u", owner, kind, _name] if *owner == caller => FILE_KINDS
            .iter()
            .find(|k| **k == *kind)
            .map_or(FileAccess::Denied, |k| FileAccess::Owned(k)),
        ["img" | "shots", name] if is_legacy_name(name) => FileAccess::Legacy,
        _ => FileAccess::Denied,
    }
}

/// `<uuid>.<png|jpg|webp>` as written before keys were owner-scoped.
fn is_legacy_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 36
        && stem.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        && matches!(ext, "png" | "jpg" | "webp")
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
    fn sniffs_mime_from_bytes() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nxx"), "image/png");
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_mime(b"GIF89a"), "image/gif");
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(sniff_mime(b"%PDF-1.7"), "application/pdf");
        assert_eq!(sniff_mime("name,qty\nü,1\n".as_bytes()), "text/plain; charset=utf-8");
        assert_eq!(sniff_mime(b"<svg onload=alert(1)>"), "text/plain; charset=utf-8");
        assert_eq!(sniff_mime(&[0, 1, 2, 0xFE]), "application/octet-stream");
        assert!(is_vision_mime("image/webp") && !is_vision_mime("text/plain; charset=utf-8"));
    }

    #[test]
    fn upload_paths_and_filenames() {
        assert_eq!(upload_path("dir/sub/a.csv").unwrap(), "uploads/dir/sub/a.csv");
        assert_eq!(upload_path("./a.png").unwrap(), "uploads/a.png");
        for bad in ["../x", "a/../../b", "", "/etc/passwd", "a//b"] {
            assert!(upload_path(bad).is_err(), "{bad:?}");
        }
        assert_eq!(disposition_filename("uploads/dir/my \"file\".txt"), "my__file_.txt");
        assert_eq!(disposition_filename("uploads/.."), "file");
    }

    #[test]
    fn files_are_scoped_to_their_owner() {
        let uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(file_access("u1", "u/u1/img/a.jpg"), FileAccess::Owned("img"));
        assert_eq!(file_access("u1", "u/u1/mcpapp/abc.html"), FileAccess::Owned("mcpapp"));
        assert_eq!(file_access("u2", "u/u1/img/a.jpg"), FileAccess::Denied);
        assert_eq!(file_access("u1", "u/u1/other/a.jpg"), FileAccess::Denied);
        assert_eq!(file_access("u1", "u/u1/img/../../u2/img/a.jpg"), FileAccess::Denied);
        assert_eq!(file_access("u1", "u/u1/img/x/y.jpg"), FileAccess::Denied);
        assert_eq!(file_access("u1", "ws/conv/secret.env"), FileAccess::Denied);
        assert_eq!(file_access("u1", &format!("img/{uuid}.png")), FileAccess::Legacy);
        assert_eq!(file_access("u1", &format!("shots/{uuid}.webp")), FileAccess::Legacy);
        assert_eq!(file_access("u1", "img/evil.svg"), FileAccess::Denied);
        assert_eq!(file_access("", "u//img/a.jpg"), FileAccess::Denied);
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
