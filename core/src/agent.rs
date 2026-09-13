use crate::azure;
use crate::config::Config;
use crate::ledger;
use crate::mcp::McpClient;
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use worker::*;

const MAX_ITERS: usize = 15;
const MODEL_OUTPUT_MAX: usize = 4000;
const EVENT_OUTPUT_MAX: usize = 800;

fn sse(event: &str, data: &Value) -> Vec<u8> {
    format!("event: {}\ndata: {}\n\n", event, data).into_bytes()
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

fn record(run_id: &str, t: &str, d: &Value) {
    let mut e = d.clone();
    e["type"] = json!(t);
    ledger::record(run_id, e);
}

fn builtin_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "update_plan",
                "description": "Update the step-by-step execution plan. Call this first for multi-step requests and keep statuses current (pending|active|done|failed).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "status": {"type": "string", "enum": ["pending", "active", "done", "failed"]}
                                },
                                "required": ["title", "status"]
                            }
                        }
                    },
                    "required": ["steps"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "attest",
                "description": "Record a hash-chained verification attestation after confirming an action's result via independent read-back.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim": {"type": "string", "description": "What was verified, e.g. 'issue #12 created'"},
                        "evidence": {"type": "string", "description": "Concrete evidence: id, url, or excerpt from the read-back"},
                        "app": {"type": "string", "description": "App/server the evidence came from"}
                    },
                    "required": ["claim", "evidence"]
                }
            }
        }),
    ]
}

fn mcp_tool_to_openai(server: &str, tool: &Value) -> Value {
    let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
    let desc = tool
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("");
    let params = tool
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
    json!({
        "type": "function",
        "function": {
            "name": format!("{}__{}", server, name),
            "description": desc,
            "parameters": params,
        }
    })
}

#[derive(Default)]
struct TcAcc {
    id: String,
    name: String,
    args: String,
}

#[derive(Default)]
struct Reply {
    content: String,
    calls: Vec<TcAcc>,
}

/// Merge one streamed Azure chunk into the reply accumulator; returns new text if any.
fn absorb_chunk(acc: &mut Reply, idx: &mut BTreeMap<u64, TcAcc>, v: &Value) -> Option<String> {
    let choice = v.get("choices").and_then(|c| c.get(0))?;
    let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
    let mut text = None;
    if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
        if !c.is_empty() {
            acc.content.push_str(c);
            text = Some(c.to_string());
        }
    }
    if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            let i = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let entry = idx.entry(i).or_default();
            if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                entry.id.push_str(id);
            }
            if let Some(f) = tc.get("function") {
                if let Some(n) = f.get("name").and_then(|x| x.as_str()) {
                    entry.name.push_str(n);
                }
                if let Some(a) = f.get("arguments").and_then(|x| x.as_str()) {
                    entry.args.push_str(a);
                }
            }
        }
    }
    text
}

fn reply_from_message(msg: &Value) -> Reply {
    let mut r = Reply::default();
    if let Some(c) = msg.get("content").and_then(|c| c.as_str()) {
        r.content = c.to_string();
    }
    if let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            r.calls.push(TcAcc {
                id: tc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                name: tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                args: tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("{}")
                    .to_string(),
            });
        }
    }
    r
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn chunk_str(s: &str, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        cur.push(ch);
        if cur.len() >= n {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn system_prompt(servers: &[String]) -> String {
    let list = if servers.is_empty() {
        "none".to_string()
    } else {
        servers.join(", ")
    };
    format!(
        "You are bloop, a general-purpose agent that takes real actions across external apps. \
         Connected MCP servers: {list}. Tools from a server are named <server>__<tool>. \
         Discipline: 1) PLAN: for multi-step requests call update_plan first and keep statuses current. \
         2) ACT: use tools to take real actions; never fabricate results. \
         3) VERIFY: after ANY action that mutates external state, verify with an independent read-back call, \
         then call attest with claim + concrete evidence (id/url/excerpt). Never claim done without verification. \
         4) REPORT: end with a concise report: what was done, what was verified, links/ids, failures. \
         Keep replies tight."
    )
}

/// Result of executing one tool call.
struct ToolOutcome {
    app: String,
    ok: bool,
    output: String,
    /// Extra SSE frames built-ins produce (plan / verify events).
    extra: Vec<(String, Value)>,
}

/// Execute one tool call (MCP or built-in).
async fn dispatch(clients: &mut [McpClient], name: &str, args: &Value, run_id: &str) -> ToolOutcome {
    match name.split_once("__") {
        Some((server, tool)) => {
            if let Some(c) = clients.iter_mut().find(|c| c.name == server) {
                match c.call_tool(tool, args.clone()).await {
                    Ok((ok, out)) => ToolOutcome {
                        app: server.to_string(),
                        ok,
                        output: out,
                        extra: vec![],
                    },
                    Err(e) => ToolOutcome {
                        app: server.to_string(),
                        ok: false,
                        output: format!("{}", e),
                        extra: vec![],
                    },
                }
            } else {
                ToolOutcome {
                    app: server.to_string(),
                    ok: false,
                    output: format!("server '{}' not connected", server),
                    extra: vec![],
                }
            }
        }
        None => match name {
            "update_plan" => {
                let steps = args.get("steps").cloned().unwrap_or(json!([]));
                let data = json!({"steps": steps});
                ToolOutcome {
                    app: "bloop".into(),
                    ok: true,
                    output: "{\"ok\":true}".into(),
                    extra: vec![("plan".into(), data)],
                }
            }
            "attest" => {
                let claim = args.get("claim").and_then(|v| v.as_str()).unwrap_or("");
                let evidence = args.get("evidence").and_then(|v| v.as_str()).unwrap_or("");
                let app = args.get("app").and_then(|v| v.as_str()).unwrap_or("bloop");
                let hash = ledger::attest(run_id, claim, evidence, app);
                let data = json!({"claim": claim, "evidence": evidence, "app": app, "hash": hash});
                ToolOutcome {
                    app: app.to_string(),
                    ok: true,
                    output: json!({"ok": true, "hash": hash}).to_string(),
                    extra: vec![("verify".into(), data)],
                }
            }
            other => ToolOutcome {
                app: "bloop".into(),
                ok: false,
                output: format!("unknown tool '{}'", other),
                extra: vec![],
            },
        },
    }
}

/// The agentic loop as a stream of SSE frame bytes.
pub fn run(cfg: Config, user_messages: Vec<Value>, run_id: String) -> impl Stream<Item = Result<Vec<u8>>> {
    async_stream::stream! {
        ledger::begin_run(&run_id);

        // --- Connect MCP servers, gather tools ---
        let mut clients: Vec<McpClient> = cfg
            .servers
            .iter()
            .map(|s| McpClient::new(&s.name, &s.url, &s.token))
            .collect();
        let mut tools = builtin_tools();
        let mut connected: Vec<String> = Vec::new();
        for c in clients.iter_mut() {
            match c.initialize().await {
                Ok(()) => match c.list_tools().await {
                    Ok(tlist) => {
                        console_log!("mcp {} connected: {} tools", c.name, tlist.len());
                        connected.push(c.name.clone());
                        for t in &tlist {
                            tools.push(mcp_tool_to_openai(&c.name, t));
                        }
                        record(&run_id, "server", &json!({"name": c.name, "state": "ok", "tools": tlist.len()}));
                    }
                    Err(e) => {
                        console_log!("mcp {} tools/list failed: {}", c.name, e);
                        record(&run_id, "server", &json!({"name": c.name, "state": "error", "tools": 0}));
                    }
                },
                Err(e) => {
                    console_log!("mcp {} init failed: {}", c.name, e);
                    record(&run_id, "server", &json!({"name": c.name, "state": "error", "tools": 0}));
                }
            }
        }

        let mut messages = vec![json!({"role": "system", "content": system_prompt(&connected)})];
        messages.extend(user_messages.into_iter().filter(|m| m.is_object()));

        let models = [cfg.model.clone(), cfg.model_fallback.clone()];
        let mut iter = 0usize;
        let mut hit_limit = false;

        'outer: while iter < MAX_ITERS {
            iter += 1;

            // --- Model call: stream on each model; non-stream fallback per model ---
            let mut reply: Option<Reply> = None;
            let mut last_err = String::from("no models configured");
            'models: for model in &models {
                if model.is_empty() {
                    continue;
                }
                let mut acc = Reply::default();
                let mut idx: BTreeMap<u64, TcAcc> = BTreeMap::new();
                let mut stream_failed = false;
                {
                    let ds = azure::chat_deltas(cfg.clone(), model.clone(), messages.clone(), tools.clone());
                    futures::pin_mut!(ds);
                    while let Some(item) = ds.next().await {
                        match item {
                            Ok(v) => {
                                if let Some(text) = absorb_chunk(&mut acc, &mut idx, &v) {
                                    yield Ok(sse("delta", &json!({"text": text})));
                                }
                            }
                            Err(e) => {
                                console_log!("stream failed ({}): {}", model, e);
                                last_err = format!("{}", e);
                                stream_failed = true;
                                break;
                            }
                        }
                    }
                }
                if !stream_failed {
                    acc.calls = idx.into_values().collect();
                    reply = Some(acc);
                    break 'models;
                }
                // Non-stream fallback (only if nothing was emitted for this attempt).
                if acc.content.is_empty() && idx.is_empty() {
                    match azure::chat_once(&cfg, model, &messages, &tools).await {
                        Ok(v) => {
                            let msg = v
                                .get("choices")
                                .and_then(|c| c.get(0))
                                .and_then(|c| c.get("message"))
                                .cloned()
                                .unwrap_or(Value::Null);
                            let r = reply_from_message(&msg);
                            for chunk in chunk_str(&r.content, 30) {
                                yield Ok(sse("delta", &json!({"text": chunk})));
                            }
                            reply = Some(r);
                            break 'models;
                        }
                        Err(e) => {
                            console_log!("non-stream failed ({}): {}", model, e);
                            last_err = format!("{}", e);
                        }
                    }
                }
            }

            let reply = match reply {
                Some(r) => r,
                None => {
                    let msg = format!("model call failed: {}", last_err);
                    record(&run_id, "error", &json!({"message": msg}));
                    yield Ok(sse("error", &json!({"message": msg})));
                    break 'outer;
                }
            };

            // --- No tool calls → final answer already streamed as deltas ---
            if reply.calls.is_empty() {
                break 'outer;
            }

            // --- Append assistant message with tool_calls ---
            let tcs: Vec<Value> = reply
                .calls
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    json!({
                        "id": if c.id.is_empty() { format!("call_{}", i) } else { c.id.clone() },
                        "type": "function",
                        "function": {"name": c.name, "arguments": c.args}
                    })
                })
                .collect();
            messages.push(json!({
                "role": "assistant",
                "content": if reply.content.is_empty() { Value::Null } else { json!(reply.content) },
                "tool_calls": tcs,
            }));

            // --- Execute each tool call ---
            for (i, call) in reply.calls.iter().enumerate() {
                let id = if call.id.is_empty() { format!("call_{}", i) } else { call.id.clone() };
                let args: Value = serde_json::from_str(&call.args).unwrap_or_else(|_| json!({}));
                let app = call
                    .name
                    .split_once("__")
                    .map(|(s, _)| s.to_string())
                    .unwrap_or_else(|| "bloop".to_string());

                let call_ev = json!({"id": id, "name": call.name, "app": app, "args": args});
                record(&run_id, "tool_call", &call_ev);
                yield Ok(sse("tool_call", &call_ev));

                let started = now_ms();
                let out = dispatch(&mut clients, &call.name, &args, &run_id).await;
                let ms = (now_ms() - started) as u64;

                // built-in side frames: plan / verify
                for (ev, data) in &out.extra {
                    record(&run_id, ev, data);
                    yield Ok(sse(ev, data));
                }

                let res_ev = json!({
                    "id": id,
                    "name": call.name,
                    "app": out.app,
                    "ok": out.ok,
                    "ms": ms,
                    "output": truncate(&out.output, EVENT_OUTPUT_MAX),
                });
                record(&run_id, "tool_result", &res_ev);
                yield Ok(sse("tool_result", &res_ev));

                let model_out = if out.ok {
                    truncate(&out.output, MODEL_OUTPUT_MAX)
                } else {
                    format!("ERROR: {}", truncate(&out.output, MODEL_OUTPUT_MAX))
                };
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": model_out,
                }));
            }
        }

        if iter >= MAX_ITERS {
            hit_limit = true;
        }
        if hit_limit {
            yield Ok(sse("delta", &json!({"text": "\n\n(iteration limit reached)"})));
        }
        yield Ok(sse("done", &json!({})));
    }
}
