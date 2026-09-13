use crate::config::Config;
use base64::Engine;
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::*;

fn url_for(cfg: &Config, model: &str) -> String {
    format!(
        "{}/openai/deployments/{}/chat/completions?api-version={}",
        cfg.azure_endpoint, model, cfg.azure_version
    )
}

fn build_request(cfg: &Config, model: &str, body: &Value) -> Result<Request> {
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("api-key", &cfg.azure_key)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(JsValue::from_str(&body.to_string())));
    Request::new_with_init(&url_for(cfg, model), &init)
}

/// Streaming chat-completions call. Yields each parsed `data:` payload (raw Azure chunk JSON).
pub fn chat_deltas(
    cfg: Config,
    model: String,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> impl Stream<Item = Result<Value>> {
    async_stream::stream! {
        let body = json!({
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "stream": true,
        });
        let req = match build_request(&cfg, &model, &body) {
            Ok(r) => r,
            Err(e) => { yield Err(e); return; }
        };
        let mut resp = match Fetch::Request(req).send().await {
            Ok(r) => r,
            Err(e) => { yield Err(e); return; }
        };
        let status = resp.status_code();
        if status >= 400 {
            let t = resp.text().await.unwrap_or_default();
            yield Err(Error::RustError(format!(
                "azure {} ({}): {}",
                status, model, &t[..t.len().min(300)]
            )));
            return;
        }
        let mut bs = match resp.stream() {
            Ok(s) => s,
            Err(e) => { yield Err(e); return; }
        };
        let mut buf = String::new();
        while let Some(chunk) = bs.next().await {
            match chunk {
                Ok(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(pos) = buf.find("\n\n") {
                        let frame: String = buf.drain(..pos + 2).collect();
                        for line in frame.lines() {
                            if let Some(d) = line.strip_prefix("data:") {
                                let d = d.trim();
                                if d == "[DONE]" {
                                    return;
                                }
                                if let Ok(v) = serde_json::from_str::<Value>(d) {
                                    yield Ok(v);
                                }
                            }
                        }
                    }
                }
                Err(e) => { yield Err(e); return; }
            }
        }
    }
}

/// POST a JSON body to `url` with the given headers; returns parsed JSON.
pub async fn post_json(url: &str, headers: &[(&str, &str)], body: &Value) -> Result<Value> {
    let h = Headers::new();
    h.set("content-type", "application/json")?;
    for (k, v) in headers {
        h.set(k, v)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(h);
    init.with_body(Some(JsValue::from_str(&body.to_string())));
    let req = Request::new_with_init(url, &init)?;
    let mut resp = Fetch::Request(req).send().await?;
    let status = resp.status_code();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(Error::RustError(format!(
            "POST {} → {}: {}",
            url,
            status,
            &text[..text.len().min(300)]
        )));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|e| Error::RustError(format!("parse {}: {} | {}", url, e, &text[..text.len().min(300)])))
}

/// Generate an image via the Azure gpt-image deployment; returns raw PNG bytes.
pub async fn generate_image(cfg: &Config, prompt: &str, size: &str) -> Result<Vec<u8>> {
    let url = format!(
        "{}/openai/deployments/gpt-image-2.5-flare/images/generations?api-version=2025-04-01-preview",
        cfg.azure_endpoint
    );
    let body = json!({
        "prompt": prompt,
        "size": if size.is_empty() { "1024x1024" } else { size },
        "quality": "high",
        "n": 1,
    });
    let resp = post_json(&url, &[("api-key", &cfg.azure_key)], &body).await?;
    let b64 = resp
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("b64_json"))
        .and_then(|b| b.as_str())
        .ok_or_else(|| Error::RustError(format!("image response missing b64_json: {}", &resp.to_string()[..300.min(resp.to_string().len())])))?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| Error::RustError(format!("b64 decode: {}", e)))
}

/// Non-streaming chat-completions call. Returns raw response JSON.
pub async fn chat_once(
    cfg: &Config,
    model: &str,
    messages: &[Value],
    tools: &[Value],
) -> Result<Value> {
    let body = json!({
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
    });
    let req = build_request(cfg, model, &body)?;
    let mut resp = Fetch::Request(req).send().await?;
    let status = resp.status_code();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(Error::RustError(format!(
            "azure {} ({}): {}",
            status,
            model,
            &text[..text.len().min(300)]
        )));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|e| Error::RustError(format!("azure parse: {} | {}", e, &text[..text.len().min(300)])))
}
