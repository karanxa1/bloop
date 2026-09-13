use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::*;

/// Minimal JSON-RPC-over-streamable-HTTP MCP client.
pub struct McpClient {
    pub name: String,
    pub url: String,
    pub token: String,
    pub session: Option<String>,
    pub next_id: u64,
}

impl McpClient {
    pub fn new(name: &str, url: &str, token: &str) -> Self {
        McpClient {
            name: name.to_string(),
            url: url.to_string(),
            token: token.to_string(),
            session: None,
            next_id: 1,
        }
    }

    /// POST a JSON-RPC message; returns the parsed response object (with "result" or "error").
    async fn send(&mut self, payload: Value) -> Result<Value> {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        headers.set("accept", "application/json, text/event-stream")?;
        if !self.token.is_empty() {
            headers.set("authorization", &format!("Bearer {}", self.token))?;
        }
        if let Some(s) = &self.session {
            headers.set("mcp-session-id", s)?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post);
        init.with_headers(headers);
        init.with_body(Some(JsValue::from_str(&payload.to_string())));
        let req = Request::new_with_init(&self.url, &init)?;
        let mut resp = Fetch::Request(req).send().await?;
        if let Ok(Some(s)) = resp.headers().get("mcp-session-id") {
            if !s.is_empty() {
                self.session = Some(s);
            }
        }
        let status = resp.status_code();
        let text = resp.text().await.unwrap_or_default();
        parse_mcp_body(status, &text)
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let resp = self.send(payload).await?;
        if let Some(err) = resp.get("error") {
            return Err(Error::RustError(format!(
                "MCP {} {} error: {}",
                self.name, method, err
            )));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn notify(&mut self, method: &str) {
        let payload = json!({"jsonrpc": "2.0", "method": method});
        let _ = self.send(payload).await;
    }

    /// initialize handshake + notifications/initialized.
    pub async fn initialize(&mut self) -> Result<()> {
        let _ = self
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "bloop", "version": "0.1.0"}
                }),
            )
            .await?;
        self.notify("notifications/initialized").await;
        Ok(())
    }

    /// Returns list of MCP tool descriptors.
    pub async fn list_tools(&mut self) -> Result<Vec<Value>> {
        let result = self.rpc("tools/list", json!({})).await?;
        Ok(result
            .get("tools")
            .and_then(|t| t.as_array().cloned())
            .unwrap_or_default())
    }

    /// Calls a tool; returns (ok, text_output).
    pub async fn call_tool(&mut self, tool: &str, args: Value) -> Result<(bool, String)> {
        let result = self
            .rpc("tools/call", json!({"name": tool, "arguments": args}))
            .await?;
        let is_err = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut out = String::new();
        if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
            for part in content {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
            }
        }
        if out.is_empty() {
            out = serde_json::to_string(&result).unwrap_or_default();
        }
        Ok((!is_err, out))
    }
}

/// Parse a streamable-HTTP MCP response body: plain JSON or SSE frames.
fn parse_mcp_body(status: u16, text: &str) -> Result<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        // Notifications legitimately return empty bodies (202).
        return Ok(json!({"result": {}}));
    }
    // Direct JSON
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    // SSE frames: `event: message\ndata: {json}` blocks
    let mut last: Option<Value> = None;
    for line in trimmed.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                last = Some(v);
            }
        }
    }
    if let Some(v) = last {
        return Ok(v);
    }
    Err(Error::RustError(format!(
        "MCP response (status {}) not parseable: {}",
        status,
        &trimmed[..trimmed.len().min(300)]
    )))
}
