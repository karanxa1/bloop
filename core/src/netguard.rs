//! Outbound request guard for user-supplied URLs (MCP servers, OAuth
//! metadata / authorize / token endpoints): https-only public hostnames,
//! manual redirect re-validation, capped response bodies, sanitized snippets.

use futures::StreamExt;
use worker::*;

pub const MAX_REDIRECTS: usize = 3;
/// Default cap for JSON/metadata bodies.
pub const SMALL_BODY_CAP: usize = 256 * 1024;
/// Cap for MCP responses (tool results may carry base64 images).
pub const MCP_BODY_CAP: usize = 8 * 1024 * 1024;

/// Validate an outbound URL: https, no userinfo, hostname (not an IP
/// literal), not localhost / *.localhost / *.local / *.internal / dotless.
pub fn check_outbound_url(raw: &str) -> std::result::Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("invalid url: {}", e))?;
    if url.scheme() != "https" {
        return Err("url must use https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("url must not contain credentials".into());
    }
    let host = match url.host_str() {
        Some(h) if !h.is_empty() => h.trim_end_matches('.').to_ascii_lowercase(),
        _ => return Err("url has no host".into()),
    };
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return Err("ip-literal hosts are not allowed".into());
    }
    if !host.contains('.') {
        return Err("host must be a public domain name".into());
    }
    // Numeric-looking hosts that `url` did not classify as IPs (e.g. "1.2.3").
    if host.split('.').all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_digit() || c == 'x')) {
        return Err("ip-literal hosts are not allowed".into());
    }
    const BLOCKED_SUFFIXES: &[&str] = &[".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];
    if host == "localhost" || BLOCKED_SUFFIXES.iter().any(|s| host.ends_with(s)) {
        return Err("private hostnames are not allowed".into());
    }
    Ok(url)
}

/// Short, single-line, control-char-free excerpt of an upstream body.
pub fn snippet(s: &str, max_chars: usize) -> String {
    let cleaned: String = s
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max_chars)
        .collect();
    if s.trim().chars().count() > max_chars {
        format!("{}…", cleaned)
    } else {
        cleaned
    }
}

/// Fetch with https/host validation on every hop; redirects followed
/// manually (max 3). `authorization` is dropped on cross-origin hops.
pub async fn fetch_guarded(
    url: &str,
    method: Method,
    headers: &Headers,
    body: Option<&str>,
) -> std::result::Result<Response, String> {
    let mut current = check_outbound_url(url)?;
    let mut method = method;
    let mut body = body.map(|b| b.to_string());
    let mut hdrs: Vec<(String, String)> = headers.entries().collect();
    for hop in 0..=MAX_REDIRECTS {
        let h = Headers::new();
        for (k, v) in &hdrs {
            h.set(k, v).map_err(|e| e.to_string())?;
        }
        let mut init = RequestInit::new();
        init.with_method(method.clone());
        init.with_headers(h);
        init.with_redirect(RequestRedirect::Manual);
        if let Some(b) = &body {
            init.with_body(Some(wasm_bindgen::JsValue::from_str(b)));
        }
        let req = Request::new_with_init(current.as_str(), &init).map_err(|e| e.to_string())?;
        let resp = Fetch::Request(req).send().await.map_err(|e| format!("network error: {}", e))?;
        let status = resp.status_code();
        if !(300..400).contains(&status) || status == 304 {
            return Ok(resp);
        }
        if hop == MAX_REDIRECTS {
            return Err("too many redirects".into());
        }
        let loc = resp
            .headers()
            .get("location")
            .ok()
            .flatten()
            .ok_or_else(|| format!("redirect {} without location", status))?;
        let next = current.join(&loc).map_err(|e| format!("bad redirect: {}", e))?;
        let next = check_outbound_url(next.as_str())?;
        if next.origin() != current.origin() {
            hdrs.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
        }
        if matches!(status, 301 | 302 | 303) && method != Method::Get {
            method = Method::Get;
            body = None;
            hdrs.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
        }
        current = next;
    }
    Err("too many redirects".into())
}

/// Read a response body as bytes, failing past `cap` bytes.
pub async fn read_bytes_capped(resp: &mut Response, cap: usize) -> std::result::Result<Vec<u8>, String> {
    if let Ok(Some(len)) = resp.headers().get("content-length") {
        if len.trim().parse::<usize>().map(|n| n > cap).unwrap_or(false) {
            return Err(format!("response too large (> {} bytes)", cap));
        }
    }
    let mut stream = match resp.stream() {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("body read: {}", e))?;
        if buf.len() + chunk.len() > cap {
            return Err(format!("response too large (> {} bytes)", cap));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// Read a response body as (lossy UTF-8) text, failing past `cap` bytes.
pub async fn read_text_capped(resp: &mut Response, cap: usize) -> std::result::Result<String, String> {
    read_bytes_capped(resp, cap)
        .await
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_https() {
        assert!(check_outbound_url("https://mcp.higgsfield.ai/mcp").is_ok());
        assert!(check_outbound_url("https://api.githubcopilot.com/mcp/").is_ok());
        assert!(check_outbound_url("https://example.com:8443/x?y=1").is_ok());
    }

    #[test]
    fn rejects_unsafe() {
        for u in [
            "http://mcp.example.com/mcp",
            "https://localhost/mcp",
            "https://foo.localhost/",
            "https://printer.local/",
            "https://metadata.google.internal/",
            "https://intranet/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://10.0.0.1:8080/",
            "https://0x7f000001/",
            "https://user:pw@example.com/",
            "ftp://example.com/",
            "not a url",
        ] {
            assert!(check_outbound_url(u).is_err(), "should reject {}", u);
        }
    }

    #[test]
    fn snippet_is_bounded_and_clean() {
        assert_eq!(snippet("  a\nb\tc  ", 10), "a b c");
        assert_eq!(snippet("ééééé", 3), "ééé…");
    }
}
