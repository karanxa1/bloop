//! MCP client over Streamable HTTP (spec 2025-06-18 / 2025-11-25) with a
//! legacy HTTP+SSE (2024-11-05) fallback, retries, timeouts, typed errors and
//! MCP Apps (`io.modelcontextprotocol/ui`) awareness.
//!
//! Legacy SSE limits (Workers): the GET event stream is held open by the
//! client for its own lifetime only (one request / agent run). Responses are
//! read off that stream after each POST; server-initiated requests
//! (sampling, elicitation) and notifications are skipped. A new client opens
//! a new SSE session.

use crate::config::{McpServerCfg, Transport};
use crate::netguard;
use futures::future::{self, Either};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::time::Duration;
use worker::*;

pub const LATEST_PROTOCOL: &str = "2025-11-25";
pub const SUPPORTED_PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
pub const UI_EXTENSION: &str = "io.modelcontextprotocol/ui";
pub const UI_MIME: &str = "text/html;profile=mcp-app";

pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const INIT_TIMEOUT_MS: u64 = 8_000;
const MAX_RETRY_AFTER_MS: u64 = 5_000;
const BACKOFF_MS: u64 = 400;

// ---------- errors ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpErrorKind {
    Timeout,
    Transient,
    Auth,
    Protocol,
    Tool,
}

impl McpErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            McpErrorKind::Timeout => "timeout",
            McpErrorKind::Transient => "transient",
            McpErrorKind::Auth => "auth",
            McpErrorKind::Protocol => "protocol",
            McpErrorKind::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone)]
pub struct McpError {
    pub kind: McpErrorKind,
    pub message: String,
    pub status: Option<u16>,
    /// RFC 9728 `resource_metadata` URL from a 401/403 `WWW-Authenticate`.
    pub resource_metadata: Option<String>,
    /// `scope` from the `WWW-Authenticate` challenge.
    pub scope: Option<String>,
    pub retry_after_ms: Option<u64>,
}

impl McpError {
    pub fn new(kind: McpErrorKind, message: impl Into<String>) -> Self {
        McpError {
            kind,
            message: message.into(),
            status: None,
            resource_metadata: None,
            scope: None,
            retry_after_ms: None,
        }
    }
    pub fn kind(&self) -> McpErrorKind {
        self.kind
    }
    fn with_status(mut self, s: u16) -> Self {
        self.status = Some(s);
        self
    }
    /// 404 on a request that carried a session id → session expired.
    fn session_expired(&self) -> bool {
        self.status == Some(404) && self.message.starts_with("session expired")
    }
}

impl fmt::Display for McpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(s) = self.status {
            write!(f, " (HTTP {})", s)?;
        }
        Ok(())
    }
}

impl std::error::Error for McpError {}

impl From<McpError> for Error {
    fn from(e: McpError) -> Self {
        Error::RustError(e.to_string())
    }
}

/// Map a non-2xx HTTP status to an error kind.
pub fn classify_status(status: u16) -> McpErrorKind {
    match status {
        401 | 403 => McpErrorKind::Auth,
        408 => McpErrorKind::Timeout,
        429 | 502 | 503 | 504 => McpErrorKind::Transient,
        _ => McpErrorKind::Protocol,
    }
}

/// Parsed `WWW-Authenticate` challenge parameters (Bearer preferred).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct WwwAuthenticate {
    pub scheme: String,
    pub params: HashMap<String, String>,
}

impl WwwAuthenticate {
    pub fn resource_metadata(&self) -> Option<&str> {
        self.params.get("resource_metadata").map(|s| s.as_str())
    }
    pub fn scope(&self) -> Option<&str> {
        self.params.get("scope").map(|s| s.as_str())
    }
}

/// Parse an RFC 7235 `WWW-Authenticate` header. Handles quoted/unquoted
/// values, missing spaces after commas and multiple challenges (returns the
/// Bearer challenge if present, else the first).
pub fn parse_www_authenticate(header: &str) -> WwwAuthenticate {
    let chars: Vec<char> = header.chars().collect();
    let mut i = 0;
    let mut challenges: Vec<WwwAuthenticate> = Vec::new();
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == ',') {
            i += 1;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' && chars[i] != ',' {
            i += 1;
        }
        if start == i {
            i += 1;
            continue;
        }
        let token: String = chars[start..i].iter().collect();
        let mut j = i;
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        if j < chars.len() && chars[j] == '=' {
            // key=value
            i = j + 1;
            while i < chars.len() && chars[i] == ' ' {
                i += 1;
            }
            let mut value = String::new();
            if i < chars.len() && chars[i] == '"' {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    value.push(chars[i]);
                    i += 1;
                }
                i += 1;
            } else {
                while i < chars.len() && chars[i] != ',' && !chars[i].is_whitespace() {
                    value.push(chars[i]);
                    i += 1;
                }
            }
            if challenges.is_empty() {
                challenges.push(WwwAuthenticate::default());
            }
            challenges
                .last_mut()
                .unwrap()
                .params
                .insert(token.to_ascii_lowercase(), value);
        } else {
            challenges.push(WwwAuthenticate {
                scheme: token,
                params: HashMap::new(),
            });
        }
    }
    let bearer = challenges
        .iter()
        .position(|c| c.scheme.eq_ignore_ascii_case("bearer"));
    match bearer {
        Some(ix) => challenges.swap_remove(ix),
        None => challenges.into_iter().next().unwrap_or_default(),
    }
}

// ---------- tool / call types ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UiRef {
    pub uri: String,
    pub mime: String,
}

/// MCP Apps: `_meta.ui.resourceUri` (current) or `_meta["ui/resourceUri"]` (deprecated).
pub fn ui_from_meta(meta: Option<&Value>) -> Option<UiRef> {
    let meta = meta?;
    let uri = meta
        .get("ui")
        .and_then(|u| u.get("resourceUri"))
        .or_else(|| meta.get("ui/resourceUri"))
        .and_then(|v| v.as_str())?;
    if uri.is_empty() {
        return None;
    }
    Some(UiRef {
        uri: uri.to_string(),
        mime: UI_MIME.to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub annotations: Value,
    pub read_only: bool,
    pub destructive: bool,
    pub ui: Option<UiRef>,
    /// MCP Apps `_meta.ui.visibility` (default ["model","app"]).
    pub visibility: Vec<String>,
    pub meta: Value,
}

impl ToolInfo {
    pub fn from_value(t: &Value) -> ToolInfo {
        let s = |k: &str| t.get(k).and_then(|v| v.as_str()).map(|v| v.to_string());
        let annotations = t.get("annotations").cloned().unwrap_or(Value::Null);
        let hint = |k: &str| annotations.get(k).and_then(|v| v.as_bool());
        let meta = t.get("_meta").cloned().unwrap_or(Value::Null);
        let visibility = meta
            .get("ui")
            .and_then(|u| u.get("visibility"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_else(|| vec!["model".to_string(), "app".to_string()]);
        let read_only = hint("readOnlyHint").unwrap_or(false);
        ToolInfo {
            name: s("name").unwrap_or_default(),
            title: s("title").or_else(|| {
                annotations
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            }),
            description: s("description").unwrap_or_default(),
            input_schema: t.get("inputSchema").cloned().unwrap_or(json!({"type": "object"})),
            output_schema: t.get("outputSchema").cloned(),
            ui: ui_from_meta(t.get("_meta")),
            // spec default for destructiveHint is true unless read-only
            destructive: hint("destructiveHint").unwrap_or(!read_only) && !read_only,
            read_only,
            annotations,
            visibility,
            meta,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ToolCallOutcome {
    pub ok: bool,
    pub text: String,
    pub structured: Option<Value>,
    pub ui: Option<UiRef>,
    /// (mime, base64) image content parts.
    pub images: Vec<(String, String)>,
}

/// Convert a `tools/call` result into an outcome (tool meta used as UI fallback).
pub fn outcome_from_result(result: &Value, tool_meta: Option<&Value>) -> ToolCallOutcome {
    let is_err = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut texts: Vec<String> = Vec::new();
    let mut images = Vec::new();
    if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
        for part in content {
            let str_at = |k: &str| part.get(k).and_then(|v| v.as_str());
            match str_at("type") {
                Some("text") => {
                    if let Some(t) = str_at("text") {
                        texts.push(t.to_string());
                    }
                }
                Some("image") => {
                    if let (Some(m), Some(d)) = (str_at("mimeType"), str_at("data")) {
                        images.push((m.to_string(), d.to_string()));
                    }
                }
                Some("resource") => {
                    if let Some(t) = part
                        .get("resource")
                        .and_then(|r| r.get("text"))
                        .and_then(|v| v.as_str())
                    {
                        texts.push(t.to_string());
                    }
                }
                Some("resource_link") => {
                    if let Some(u) = str_at("uri") {
                        texts.push(format!("[resource] {}", u));
                    }
                }
                _ => {}
            }
        }
    }
    let structured = result
        .get("structuredContent")
        .filter(|v| !v.is_null())
        .cloned();
    let mut text = texts.join("\n");
    if text.is_empty() {
        text = match &structured {
            Some(s) => s.to_string(),
            None if images.is_empty() => serde_json::to_string(result).unwrap_or_default(),
            None => String::new(),
        };
    }
    ToolCallOutcome {
        ok: !is_err,
        text,
        structured,
        ui: ui_from_meta(result.get("_meta")).or_else(|| ui_from_meta(tool_meta)),
        images,
    }
}

// ---------- probe ----------

/// Connect to a server (initialize + tools/list) with a 5s timeout.
/// Returns the tool count on success.
pub async fn probe(name: &str, url: &str, token: &str) -> Result<usize> {
    let cfg = McpServerCfg::new(name, url, token);
    probe_cfg(&cfg, 5_000)
        .await
        .map(|t| t.len())
        .map_err(Error::from)
}

/// initialize + tools/list for a full config, bounded by `timeout_ms` overall.
pub async fn probe_cfg(cfg: &McpServerCfg, timeout_ms: u64) -> std::result::Result<Vec<ToolInfo>, McpError> {
    let mut c = McpClient::from_cfg(cfg);
    with_timeout(timeout_ms, async {
        c.initialize_full().await?;
        c.list_tools_full().await
    })
    .await
}

async fn with_timeout<T>(
    ms: u64,
    fut: impl std::future::Future<Output = std::result::Result<T, McpError>>,
) -> std::result::Result<T, McpError> {
    let delay = Delay::from(Duration::from_millis(ms));
    futures::pin_mut!(fut);
    futures::pin_mut!(delay);
    match future::select(fut, delay).await {
        Either::Left((res, _)) => res,
        Either::Right(_) => Err(McpError::new(
            McpErrorKind::Timeout,
            format!("timed out after {}ms", ms),
        )),
    }
}

/// netguard failure → typed error (network errors are retryable).
fn guard_err(name: &str, m: String) -> McpError {
    let kind = if m.starts_with("network error") {
        McpErrorKind::Transient
    } else {
        McpErrorKind::Protocol
    };
    McpError::new(kind, format!("MCP {}: {}", name, m))
}

async fn sleep_ms(ms: u64) {
    Delay::from(Duration::from_millis(ms)).await;
}

// ---------- client ----------

/// Legacy HTTP+SSE session: open GET stream + POST endpoint.
struct SseConn {
    stream: ByteStream,
    buf: String,
    endpoint: String,
}

impl SseConn {
    /// Next complete SSE event as (event, data).
    async fn next_event(&mut self) -> std::result::Result<(String, String), McpError> {
        loop {
            if let Some(ix) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..ix + 2).collect();
                let (mut event, mut data) = (String::from("message"), Vec::new());
                for line in block.lines() {
                    if let Some(v) = line.strip_prefix("event:") {
                        event = v.trim().to_string();
                    } else if let Some(v) = line.strip_prefix("data:") {
                        data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
                    }
                }
                if data.is_empty() {
                    continue;
                }
                return Ok((event, data.join("\n")));
            }
            match self.stream.next().await {
                Some(Ok(chunk)) => {
                    self.buf
                        .push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
                }
                Some(Err(e)) => {
                    return Err(McpError::new(McpErrorKind::Transient, format!("sse stream: {}", e)))
                }
                None => {
                    return Err(McpError::new(McpErrorKind::Transient, "sse stream closed"))
                }
            }
        }
    }
}

/// JSON-RPC MCP client (streamable HTTP, legacy SSE fallback).
pub struct McpClient {
    pub name: String,
    pub url: String,
    pub token: String,
    pub headers: Vec<(String, String)>,
    pub transport: Transport,
    pub session: Option<String>,
    pub next_id: u64,
    /// Negotiated protocol version (set after initialize).
    pub protocol_version: Option<String>,
    pub server_info: Value,
    pub server_capabilities: Value,
    pub timeout_ms: u64,
    /// Tool name → `_meta` from the last tools/list.
    pub tool_meta: HashMap<String, Value>,
    sse: Option<SseConn>,
    initialized: bool,
}

impl McpClient {
    pub fn new(name: &str, url: &str, token: &str) -> Self {
        Self::from_cfg(&McpServerCfg::new(name, url, token))
    }

    pub fn from_cfg(cfg: &McpServerCfg) -> Self {
        McpClient {
            name: cfg.name.clone(),
            url: cfg.url.clone(),
            token: cfg.token.clone(),
            headers: cfg.headers.clone(),
            transport: cfg.transport,
            session: None,
            next_id: 1,
            protocol_version: None,
            server_info: Value::Null,
            server_capabilities: Value::Null,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            tool_meta: HashMap::new(),
            sse: None,
            initialized: false,
        }
    }

    fn base_headers(&self, accept: &str) -> Result<Headers> {
        let h = Headers::new();
        h.set("accept", accept)?;
        for (k, v) in &self.headers {
            let _ = h.set(k, v);
        }
        if !self.token.is_empty() {
            h.set("authorization", &format!("Bearer {}", self.token))?;
        }
        Ok(h)
    }

    fn http_error(&self, status: u16, resp: &Response, body: &str) -> McpError {
        let kind = classify_status(status);
        let snippet = netguard::snippet(body, 200);
        let mut e = McpError::new(
            kind,
            format!("MCP {} HTTP {}: {}", self.name, status, snippet),
        )
        .with_status(status);
        if kind == McpErrorKind::Auth {
            if let Ok(Some(h)) = resp.headers().get("www-authenticate") {
                let w = parse_www_authenticate(&h);
                e.resource_metadata = w.resource_metadata().map(String::from);
                e.scope = w.scope().map(String::from);
            }
            e.message = format!("MCP {} requires authorization (HTTP {})", self.name, status);
        }
        if status == 429 || status == 503 {
            e.retry_after_ms = resp
                .headers()
                .get("retry-after")
                .ok()
                .flatten()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|s| s * 1000);
        }
        e
    }

    /// POST one JSON-RPC message over streamable HTTP.
    async fn post_streamable(
        &mut self,
        payload: &Value,
        id: Option<u64>,
    ) -> std::result::Result<Value, McpError> {
        let map = |e: Error| McpError::new(McpErrorKind::Transient, format!("MCP {} network: {}", self.name, e));
        let headers = self
            .base_headers("application/json, text/event-stream")
            .map_err(map)?;
        headers.set("content-type", "application/json").map_err(map)?;
        if let Some(s) = &self.session {
            headers.set("mcp-session-id", s).map_err(map)?;
        }
        if let Some(v) = &self.protocol_version {
            headers.set("mcp-protocol-version", v).map_err(map)?;
        }
        let body = payload.to_string();
        let url = self.url.clone();
        let mut resp = netguard::fetch_guarded(&url, Method::Post, &headers, Some(&body))
            .await
            .map_err(|m| guard_err(&self.name, m))?;
        if let Ok(Some(s)) = resp.headers().get("mcp-session-id") {
            if !s.is_empty() {
                self.session = Some(s);
            }
        }
        let status = resp.status_code();
        let text = netguard::read_text_capped(&mut resp, netguard::MCP_BODY_CAP)
            .await
            .map_err(|m| McpError::new(McpErrorKind::Protocol, format!("MCP {}: {}", self.name, m)))?;
        if status == 404 && self.session.is_some() && self.initialized {
            self.session = None;
            return Err(McpError::new(McpErrorKind::Protocol, "session expired").with_status(404));
        }
        if !(200..300).contains(&status) {
            return Err(self.http_error(status, &resp, &text));
        }
        parse_mcp_body_for(status, &text, id)
            .map_err(|m| McpError::new(McpErrorKind::Protocol, format!("MCP {}: {}", self.name, m)))
    }

    /// Open the legacy SSE stream and wait for the `endpoint` event.
    async fn open_sse(&mut self) -> std::result::Result<(), McpError> {
        let map = |e: Error| McpError::new(McpErrorKind::Transient, format!("MCP {} sse: {}", self.name, e));
        let headers = self.base_headers("text/event-stream").map_err(map)?;
        let url = self.url.clone();
        let mut resp = netguard::fetch_guarded(&url, Method::Get, &headers, None)
            .await
            .map_err(|m| guard_err(&self.name, m))?;
        let status = resp.status_code();
        if !(200..300).contains(&status) {
            let text = netguard::read_text_capped(&mut resp, netguard::SMALL_BODY_CAP)
                .await
                .unwrap_or_default();
            return Err(self.http_error(status, &resp, &text));
        }
        let stream = resp.stream().map_err(map)?;
        let mut conn = SseConn {
            stream,
            buf: String::new(),
            endpoint: String::new(),
        };
        loop {
            let (event, data) = conn.next_event().await?;
            if event == "endpoint" {
                let base = Url::parse(&self.url).map_err(|e| {
                    McpError::new(McpErrorKind::Protocol, format!("bad url: {}", e))
                })?;
                conn.endpoint = base
                    .join(data.trim())
                    .map_err(|e| McpError::new(McpErrorKind::Protocol, format!("bad endpoint: {}", e)))?
                    .to_string();
                break;
            }
        }
        self.sse = Some(conn);
        Ok(())
    }

    /// POST to the legacy endpoint, then read the matching response off the stream.
    async fn post_sse(&mut self, payload: &Value, id: Option<u64>) -> std::result::Result<Value, McpError> {
        if self.sse.is_none() {
            self.open_sse().await?;
        }
        let map = |e: Error| McpError::new(McpErrorKind::Transient, format!("MCP {} sse post: {}", self.name, e));
        let headers = self.base_headers("application/json, text/event-stream").map_err(map)?;
        headers.set("content-type", "application/json").map_err(map)?;
        let endpoint = self.sse.as_ref().map(|c| c.endpoint.clone()).unwrap_or_default();
        let body = payload.to_string();
        let mut resp = netguard::fetch_guarded(&endpoint, Method::Post, &headers, Some(&body))
            .await
            .map_err(|m| guard_err(&self.name, m))?;
        let status = resp.status_code();
        let text = netguard::read_text_capped(&mut resp, netguard::MCP_BODY_CAP)
            .await
            .map_err(|m| McpError::new(McpErrorKind::Protocol, format!("MCP {}: {}", self.name, m)))?;
        if !(200..300).contains(&status) {
            if status == 404 {
                self.sse = None; // session gone; reopen next time
            }
            return Err(self.http_error(status, &resp, &text));
        }
        let Some(id) = id else {
            return Ok(json!({"result": {}}));
        };
        // Some servers answer inline despite the legacy transport.
        if let Ok(v) = parse_mcp_body_for(status, &text, Some(id)) {
            if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                return Ok(v);
            }
        }
        let conn = self.sse.as_mut().unwrap();
        loop {
            let (event, data) = conn.next_event().await?;
            if event != "message" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v.get("id").and_then(|x| x.as_u64()) == Some(id)
                    && (v.get("result").is_some() || v.get("error").is_some())
                {
                    return Ok(v);
                }
            }
        }
    }

    async fn send_once(
        &mut self,
        payload: &Value,
        id: Option<u64>,
        timeout_ms: u64,
    ) -> std::result::Result<Value, McpError> {
        let use_sse = self.transport == Transport::Sse;
        let name = self.name.clone();
        let fut = async {
            if use_sse {
                self.post_sse(payload, id).await
            } else {
                self.post_streamable(payload, id).await
            }
        };
        with_timeout(timeout_ms, fut)
            .await
            .map_err(|mut e| {
                if e.kind == McpErrorKind::Timeout {
                    e.message = format!("MCP {} timed out after {}ms", name, timeout_ms);
                }
                e
            })
    }

    /// Send with one retry on transient failures.
    async fn send(&mut self, payload: Value, id: Option<u64>, timeout_ms: u64) -> std::result::Result<Value, McpError> {
        match self.send_once(&payload, id, timeout_ms).await {
            Err(e) if e.kind == McpErrorKind::Transient => {
                let wait = e.retry_after_ms.map(|m| m.min(MAX_RETRY_AFTER_MS)).unwrap_or(BACKOFF_MS);
                sleep_ms(wait).await;
                self.send_once(&payload, id, timeout_ms).await
            }
            other => other,
        }
    }

    async fn rpc_with(&mut self, method: &str, params: Value, timeout_ms: u64) -> std::result::Result<Value, McpError> {
        let mut reinit = false;
        loop {
            let id = self.next_id;
            self.next_id += 1;
            let payload = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
            // tools/call may be non-idempotent: never auto-retry it.
            let sent = if method == "tools/call" {
                self.send_once(&payload, Some(id), timeout_ms).await
            } else {
                self.send(payload, Some(id), timeout_ms).await
            };
            match sent {
                Err(e) if e.session_expired() && !reinit && method != "initialize" => {
                    reinit = true;
                    self.initialized = false;
                    self.initialize_full().await?;
                }
                Err(e) => return Err(e),
                Ok(resp) => {
                    if let Some(err) = resp.get("error") {
                        let kind = if method == "tools/call" {
                            McpErrorKind::Tool
                        } else {
                            McpErrorKind::Protocol
                        };
                        let msg = err.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| err.to_string());
                        return Err(McpError::new(kind, format!("MCP {} {} error: {}", self.name, method, msg)));
                    }
                    return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    async fn notify(&mut self, method: &str) {
        let payload = json!({"jsonrpc": "2.0", "method": method});
        let t = self.timeout_ms.min(INIT_TIMEOUT_MS);
        let _ = self.send_once(&payload, None, t).await;
    }

    async fn initialize_inner(&mut self) -> std::result::Result<(), McpError> {
        self.session = None;
        self.protocol_version = None;
        let params = json!({
            "protocolVersion": LATEST_PROTOCOL,
            "capabilities": {
                "extensions": { UI_EXTENSION: { "mimeTypes": [UI_MIME] } }
            },
            "clientInfo": {"name": "bloop", "version": env!("CARGO_PKG_VERSION")}
        });
        let result = match self.rpc_with("initialize", params.clone(), INIT_TIMEOUT_MS).await {
            Err(e)
                if self.transport == Transport::Auto
                    && matches!(e.status, Some(404) | Some(405)) =>
            {
                self.transport = Transport::Sse;
                self.rpc_with("initialize", params, INIT_TIMEOUT_MS).await?
            }
            Err(e) => return Err(e),
            Ok(r) => {
                if self.transport == Transport::Auto {
                    self.transport = Transport::StreamableHttp;
                }
                r
            }
        };
        let version = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("2025-03-26");
        if !SUPPORTED_PROTOCOLS.contains(&version) {
            return Err(McpError::new(
                McpErrorKind::Protocol,
                format!("MCP {} unsupported protocol version {}", self.name, version),
            ));
        }
        self.protocol_version = Some(version.to_string());
        self.server_info = result.get("serverInfo").cloned().unwrap_or(Value::Null);
        self.server_capabilities = result.get("capabilities").cloned().unwrap_or(Value::Null);
        self.initialized = true;
        self.notify("notifications/initialized").await;
        Ok(())
    }

    /// initialize handshake (8s) + notifications/initialized.
    pub async fn initialize(&mut self) -> Result<()> {
        self.initialize_full().await.map_err(Error::from)
    }

    /// Like `initialize` with a typed error.
    pub fn initialize_full(&mut self) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::result::Result<(), McpError>> + '_>> {
        // boxed: initialize ↔ rpc_with (re-init on session expiry) recurse
        Box::pin(self.initialize_inner())
    }

    /// Raw tool descriptors (includes `_meta`, annotations, outputSchema).
    pub async fn list_tools(&mut self) -> Result<Vec<Value>> {
        self.list_tools_raw().await.map_err(Error::from)
    }

    async fn list_tools_raw(&mut self) -> std::result::Result<Vec<Value>, McpError> {
        let mut out: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &cursor {
                Some(c) => json!({"cursor": c}),
                None => json!({}),
            };
            let t = self.timeout_ms;
            let result = self.rpc_with("tools/list", params, t).await?;
            if let Some(arr) = result.get("tools").and_then(|t| t.as_array()) {
                out.extend(arr.iter().cloned());
            }
            cursor = result
                .get("nextCursor")
                .and_then(|c| c.as_str())
                .filter(|c| !c.is_empty())
                .map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        self.tool_meta = out
            .iter()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?.to_string();
                Some((name, t.get("_meta").cloned().unwrap_or(Value::Null)))
            })
            .collect();
        Ok(out)
    }

    /// Parsed tool list (annotations, outputSchema, MCP Apps UI refs).
    pub async fn list_tools_full(&mut self) -> std::result::Result<Vec<ToolInfo>, McpError> {
        Ok(self.list_tools_raw().await?.iter().map(ToolInfo::from_value).collect())
    }

    /// Calls a tool; returns (ok, text_output).
    pub async fn call_tool(&mut self, tool: &str, args: Value) -> Result<(bool, String)> {
        match self.call_tool_full(tool, args).await {
            Ok(o) => Ok((o.ok, o.text)),
            Err(e) => Err(e.into()),
        }
    }

    /// Calls a tool keeping structured content, images and UI refs.
    pub async fn call_tool_full(&mut self, tool: &str, args: Value) -> std::result::Result<ToolCallOutcome, McpError> {
        let t = self.timeout_ms;
        let result = self
            .rpc_with("tools/call", json!({"name": tool, "arguments": args}), t)
            .await?;
        Ok(outcome_from_result(&result, self.tool_meta.get(tool)))
    }

    /// `resources/read` → (mimeType, text). Text-typed blobs are decoded;
    /// binary blobs are returned base64-encoded.
    pub async fn read_resource(&mut self, uri: &str) -> std::result::Result<(String, String), McpError> {
        let t = self.timeout_ms;
        let result = self.rpc_with("resources/read", json!({"uri": uri}), t).await?;
        resource_from_result(&result).ok_or_else(|| {
            McpError::new(McpErrorKind::Protocol, format!("MCP {} resource {} has no contents", self.name, uri))
        })
    }
}

pub fn resource_from_result(result: &Value) -> Option<(String, String)> {
    use base64::Engine;
    let c = result.get("contents")?.as_array()?.first()?;
    let mime = c
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or("text/plain")
        .to_string();
    if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
        return Some((mime, t.to_string()));
    }
    let blob = c.get("blob").and_then(|v| v.as_str())?;
    if mime.starts_with("text/") || mime.contains("json") || mime.contains("xml") {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(blob) {
            return Some((mime, String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
    Some((mime, blob.to_string()))
}

/// Parse a streamable-HTTP MCP response body: plain JSON or SSE frames.
/// With `id`, prefers the frame answering that request.
pub fn parse_mcp_body_for(status: u16, text: &str, id: Option<u64>) -> std::result::Result<Value, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        // Notifications legitimately return empty bodies (202).
        return Ok(json!({"result": {}}));
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    let mut last: Option<Value> = None;
    let mut data_buf: Vec<&str> = Vec::new();
    let mut frames: Vec<Value> = Vec::new();
    for line in trimmed.lines().chain(std::iter::once("")) {
        let line = line.trim_end_matches('\r');
        if let Some(d) = line.strip_prefix("data:") {
            data_buf.push(d.strip_prefix(' ').unwrap_or(d));
        } else if line.is_empty() && !data_buf.is_empty() {
            if let Ok(v) = serde_json::from_str::<Value>(&data_buf.join("\n")) {
                frames.push(v);
            }
            data_buf.clear();
        }
    }
    for v in frames {
        let is_response = v.get("result").is_some() || v.get("error").is_some();
        if let Some(want) = id {
            if is_response && v.get("id").and_then(|x| x.as_u64()) == Some(want) {
                return Ok(v);
            }
        }
        if is_response || last.is_none() {
            last = Some(v);
        }
    }
    last.ok_or_else(|| {
        format!(
            "response (status {}) not parseable: {}",
            status,
            &trimmed[..trimmed.len().min(300)]
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn www_authenticate_variants() {
        let w = parse_www_authenticate(
            r#"Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token""#,
        );
        assert_eq!(w.scheme, "Bearer");
        assert_eq!(
            w.resource_metadata(),
            Some("https://mcp.linear.app/.well-known/oauth-protected-resource/mcp")
        );
        let w = parse_www_authenticate("Bearer resource_metadata=https://mcp.stripe.com/.well-known/oauth-protected-resource");
        assert_eq!(w.resource_metadata(), Some("https://mcp.stripe.com/.well-known/oauth-protected-resource"));
        let w = parse_www_authenticate(r#"Bearer resource_metadata="https://x/y",scope="mcp:connect",authorization_uri="https://a""#);
        assert_eq!(w.scope(), Some("mcp:connect"));
        assert_eq!(w.params.get("authorization_uri").map(|s| s.as_str()), Some("https://a"));
        let w = parse_www_authenticate(r#"Basic realm="x", Bearer scope="a b", error="insufficient_scope""#);
        assert_eq!(w.scheme, "Bearer");
        assert_eq!(w.scope(), Some("a b"));
        assert_eq!(w.params.get("realm"), None);
    }

    #[test]
    fn status_classification() {
        assert_eq!(classify_status(401), McpErrorKind::Auth);
        assert_eq!(classify_status(403), McpErrorKind::Auth);
        assert_eq!(classify_status(429), McpErrorKind::Transient);
        assert_eq!(classify_status(503), McpErrorKind::Transient);
        assert_eq!(classify_status(504), McpErrorKind::Transient);
        assert_eq!(classify_status(400), McpErrorKind::Protocol);
        assert_eq!(classify_status(500), McpErrorKind::Protocol);
        assert_eq!(classify_status(408), McpErrorKind::Timeout);
        let e = McpError::new(McpErrorKind::Auth, "needs auth").with_status(401);
        assert_eq!(e.to_string(), "needs auth (HTTP 401)");
        assert_eq!(e.kind().as_str(), "auth");
    }

    #[test]
    fn sse_body_prefers_matching_id() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        let v = parse_mcp_body_for(200, body, Some(7)).unwrap();
        assert_eq!(v["result"]["ok"], true);
    }

    #[test]
    fn outcome_parts_and_ui() {
        let tool_meta = json!({"ui": {"resourceUri": "ui://widget/chart.html"}});
        let r = json!({
            "content": [
                {"type": "text", "text": "a"},
                {"type": "image", "mimeType": "image/png", "data": "AAAA"},
                {"type": "text", "text": "b"}
            ],
            "structuredContent": {"n": 1}
        });
        let o = outcome_from_result(&r, Some(&tool_meta));
        assert!(o.ok);
        assert_eq!(o.text, "a\nb");
        assert_eq!(o.images, vec![("image/png".to_string(), "AAAA".to_string())]);
        assert_eq!(o.structured, Some(json!({"n": 1})));
        assert_eq!(o.ui.unwrap().uri, "ui://widget/chart.html");
        let legacy = json!({"ui/resourceUri": "ui://old"});
        assert_eq!(ui_from_meta(Some(&legacy)).unwrap().uri, "ui://old");
        let o = outcome_from_result(&json!({"isError": true, "structuredContent": {"e": 1}}), None);
        assert!(!o.ok);
        assert_eq!(o.text, "{\"e\":1}");
    }

    #[test]
    fn tool_info_hints() {
        let t = ToolInfo::from_value(&json!({
            "name": "q", "description": "d",
            "annotations": {"readOnlyHint": true},
            "_meta": {"ui": {"resourceUri": "ui://x", "visibility": ["app"]}}
        }));
        assert!(t.read_only && !t.destructive);
        assert_eq!(t.visibility, vec!["app"]);
        assert!(t.ui.is_some());
    }

    #[test]
    fn resource_blob_decode() {
        let r = json!({"contents": [{"uri": "ui://x", "mimeType": UI_MIME, "blob": "PGI+aGk8L2I+"}]});
        assert_eq!(resource_from_result(&r).unwrap(), (UI_MIME.to_string(), "<b>hi</b>".to_string()));
    }
}
