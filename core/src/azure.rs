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
/// `extra` params (object or null) are merged into the body; if Azure rejects
/// them with HTTP 400 the request is retried once without them.
pub fn chat_deltas(
    cfg: Config,
    model: String,
    messages: Vec<Value>,
    tools: Vec<Value>,
    extra: Value,
) -> impl Stream<Item = Result<Value>> {
    async_stream::stream! {
        let mut attempts = vec![chat_body(&messages, &tools, true, &extra)];
        if has_extra(&extra) {
            attempts.push(chat_body(&messages, &tools, true, &Value::Null));
        }
        let last = attempts.len() - 1;
        let mut resp = None;
        for (i, body) in attempts.iter().enumerate() {
            let req = match build_request(&cfg, &model, body) {
                Ok(r) => r,
                Err(e) => { yield Err(e); return; }
            };
            let r = match Fetch::Request(req).send().await {
                Ok(r) => r,
                Err(e) => { yield Err(e); return; }
            };
            if r.status_code() == 400 && i < last {
                console_log!("azure rejected extra params {} ({}), retrying", extra, model);
                continue;
            }
            resp = Some(r);
            break;
        }
        let Some(mut resp) = resp else { return; };
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

/// Generate an image via the Azure gpt-image deployment.
/// Returns `(bytes, ext)` where ext is "webp" or "png".
///
/// The 2025-04-01-preview spec only documents `output_format` png|jpeg (and
/// `output_compression` for jpeg); newer gpt-image deployments accept webp, so
/// we ask for webp first and retry once as plain png on HTTP 400.
pub async fn generate_image(cfg: &Config, prompt: &str, size: &str) -> Result<(Vec<u8>, &'static str)> {
    let url = format!(
        "{}/openai/deployments/gpt-image-2.5-flare/images/generations?api-version=2025-04-01-preview",
        cfg.azure_endpoint
    );
    let mut body = json!({
        "prompt": prompt,
        "size": if size.is_empty() { "1024x1024" } else { size },
        "quality": "high",
        "n": 1,
        "output_format": "webp",
        "output_compression": 85,
    });
    let headers = [("api-key", cfg.azure_key.as_str())];
    let (resp, ext) = match post_json(&url, &headers, &body).await {
        Ok(v) => (v, "webp"),
        Err(e) if is_http_400(&e) => {
            console_log!("image webp rejected, retrying as png: {}", e);
            if let Some(o) = body.as_object_mut() {
                o.remove("output_format");
                o.remove("output_compression");
            }
            (post_json(&url, &headers, &body).await?, "png")
        }
        Err(e) => return Err(e),
    };
    let b64 = resp
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("b64_json"))
        .and_then(|b| b.as_str())
        .ok_or_else(|| Error::RustError(format!("image response missing b64_json: {}", &resp.to_string()[..300.min(resp.to_string().len())])))?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map(|bytes| (bytes, ext))
        .map_err(|e| Error::RustError(format!("b64 decode: {}", e)))
}

/// True when an error produced by `post_json` / the chat calls carries HTTP 400.
pub fn is_http_400(e: &Error) -> bool {
    let s = e.to_string();
    s.contains("→ 400:") || s.starts_with("azure 400 ")
}

/// Chat-completions body with optional extra top-level params merged in
/// (e.g. a forced `tool_choice`). `extra` must be a JSON object or null.
fn chat_body(messages: &[Value], tools: &[Value], stream: bool, extra: &Value) -> Value {
    let mut body = json!({ "messages": messages });
    // tool_choice is only valid alongside a non-empty tools list.
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    if stream {
        body["stream"] = json!(true);
    }
    if let (Some(b), Some(x)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            b.insert(k.clone(), v.clone());
        }
    }
    body
}

fn has_extra(extra: &Value) -> bool {
    extra.as_object().is_some_and(|o| !o.is_empty())
}

/// Non-streaming chat-completions call. Returns raw response JSON.
/// If `extra` params are rejected with HTTP 400, retries once without them.
pub async fn chat_once(
    cfg: &Config,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    extra: &Value,
) -> Result<Value> {
    match chat_once_raw(cfg, model, &chat_body(messages, tools, false, extra)).await {
        Err(e) if has_extra(extra) && is_http_400(&e) => {
            console_log!("azure rejected extra params {}, retrying: {}", extra, e);
            chat_once_raw(cfg, model, &chat_body(messages, tools, false, &Value::Null)).await
        }
        r => r,
    }
}

async fn chat_once_raw(cfg: &Config, model: &str, body: &Value) -> Result<Value> {
    let req = build_request(cfg, model, body)?;
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
