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

const IMAGE_DEPLOYMENT: &str = "gpt-image-2.5-flare";
const IMAGE_API_VERSION: &str = "2025-04-01-preview";

fn images_url(cfg: &Config, op: &str) -> String {
    format!(
        "{}/openai/deployments/{}/images/{}?api-version={}",
        cfg.azure_endpoint, IMAGE_DEPLOYMENT, op, IMAGE_API_VERSION
    )
}

fn head(s: &str) -> String {
    s.chars().take(300).collect()
}

/// Decode the first `b64_json` image of an images response.
fn first_image(resp: &Value) -> Result<Vec<u8>> {
    let b64 = resp
        .pointer("/data/0/b64_json")
        .and_then(|b| b.as_str())
        .ok_or_else(|| Error::RustError(format!("image response missing b64_json: {}", head(&resp.to_string()))))?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| Error::RustError(format!("b64 decode: {}", e)))
}

/// Generate a JPEG via the gpt-image deployment; returns `(bytes, "jpg")`.
/// `output_format` accepts only png|jpeg (webp is rejected), and
/// `output_compression` applies to jpeg.
pub async fn generate_image(cfg: &Config, prompt: &str, size: &str) -> Result<(Vec<u8>, &'static str)> {
    let body = json!({
        "prompt": prompt,
        "size": if size.is_empty() { "1024x1024" } else { size },
        "quality": "high",
        "n": 1,
        "output_format": "jpeg",
        "output_compression": 85,
    });
    let resp = post_json(&images_url(cfg, "generations"), &[("api-key", &cfg.azure_key)], &body).await?;
    Ok((first_image(&resp)?, "jpg"))
}

/// MIME type of a PNG or JPEG image — the only inputs images/edits accepts.
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else {
        None
    }
}

/// A multipart/form-data body: text `fields`, then `files` as (field, filename, mime, bytes).
fn multipart_body(boundary: &str, fields: &[(&str, &str)], files: &[(&str, &str, &str, &[u8])]) -> Vec<u8> {
    let mut b = Vec::new();
    for (name, value) in fields {
        b.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    for (name, filename, mime, data) in files {
        b.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
            )
            .as_bytes(),
        );
        b.extend_from_slice(data);
        b.extend_from_slice(b"\r\n");
    }
    b.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    b
}

/// Edit a PNG/JPEG image with a prompt via images/edits (multipart upload);
/// returns `(bytes, "jpg")`.
pub async fn edit_image(cfg: &Config, image: &[u8], prompt: &str, size: &str) -> Result<(Vec<u8>, &'static str)> {
    let mime = image_mime(image)
        .ok_or_else(|| Error::RustError("input image must be PNG or JPEG".into()))?;
    let filename = if mime == "image/png" { "input.png" } else { "input.jpg" };
    let mut fields = vec![
        ("prompt", prompt),
        ("n", "1"),
        ("quality", "high"),
        ("output_format", "jpeg"),
        ("output_compression", "85"),
    ];
    if !size.is_empty() {
        fields.push(("size", size));
    }
    let boundary = format!("bloop{}", crate::crypto::uuid().replace('-', ""));
    let body = multipart_body(&boundary, &fields, &[("image[]", filename, mime, image)]);

    let headers = Headers::new();
    headers.set("content-type", &format!("multipart/form-data; boundary={}", boundary))?;
    headers.set("api-key", &cfg.azure_key)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    let url = images_url(cfg, "edits");
    let mut resp = Fetch::Request(Request::new_with_init(&url, &init)?).send().await?;
    let status = resp.status_code();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(Error::RustError(format!("POST {} → {}: {}", url, status, head(&text))));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| Error::RustError(format!("image edit parse: {} | {}", e, head(&text))))?;
    Ok((first_image(&v)?, "jpg"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_layout() {
        let body = multipart_body("B", &[("prompt", "hi \"x\"")], &[("image[]", "a.png", "image/png", b"\x89PNG")]);
        let expected = b"--B\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nhi \"x\"\r\n\
--B\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n--B--\r\n";
        assert_eq!(body, expected.to_vec());
    }

    #[test]
    fn sniffs_edit_input_formats() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBP"), None);
    }
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
