use crate::azure;
use crate::config::Config;
use crate::db;
use crate::ledger;
use crate::mcp::McpClient;
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use worker::*;

const MAX_ITERS: usize = 15;
const MODEL_OUTPUT_MAX: usize = 4000;
const EVENT_OUTPUT_MAX: usize = 800;
/// Tool outputs replayed into model context are capped at this many chars.
const HISTORY_TOOL_MAX: usize = 1500;
/// How many recent messages are replayed verbatim.
const HISTORY_WINDOW: i64 = 40;
/// Regenerate the running summary when this many messages fall outside the window.
const SUMMARY_LAG: i64 = 20;

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

fn sanitize_name(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "server".to_string()
    } else {
        out
    }
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
        json!({
            "type": "function",
            "function": {
                "name": "remember",
                "description": "Store a durable fact or preference about the user (e.g. 'prefers dark mode', 'works at acme'). Use sparingly for things worth recalling in future chats.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"}
                    },
                    "required": ["content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "forget",
                "description": "Delete stored memories whose content matches the query (substring search).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"}
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "update_context",
                "description": "Overwrite the user's context file — standing background and instructions (projects, stack, tone, constraints) shown to you in every chat. Read the current file from your system prompt, merge in the change, and write the FULL new markdown. Only when the user asks, or a durable change is obvious.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "markdown": {"type": "string", "description": "Complete new file content (markdown, max ~4000 chars is used)"}
                    },
                    "required": ["markdown"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "save_lesson",
                "description": "Append one short lesson learned to the user's lessons file so future runs avoid the same mistake — e.g. a tool quirk, a failed approach and what worked instead. One sentence, generalizable, no secrets.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "lesson": {"type": "string"}
                    },
                    "required": ["lesson"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "load_tools",
                "description": "Search all connected app servers' tools by keyword and return the top 10 matching tool schemas. Use when unsure which tool to call.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Space-separated keywords, e.g. 'slack send message'"}
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "generate_image",
                "description": "Generate an image from a text prompt and return a hosted URL that renders in chat.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string"},
                        "size": {"type": "string", "enum": ["1024x1024", "1024x1536", "1536x1024"], "default": "1024x1024"}
                    },
                    "required": ["prompt"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "run_code",
                "description": "Execute a short python or javascript snippet in a sandbox and return its output. Use for computation, parsing, and data munging.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {"type": "string"},
                        "language": {"type": "string", "enum": ["python", "javascript"]}
                    },
                    "required": ["code", "language"]
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

/// Keep the last ~`max` bytes of `s`, starting on a line boundary when possible.
fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    let cut = &s[start..];
    match cut.find('\n') {
        Some(i) if i + 1 < cut.len() => format!("…\n{}", &cut[i + 1..]),
        _ => format!("…{}", cut),
    }
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

fn base_prompt() -> &'static str {
    "You are bloop — a small, extremely competent general agent running on Cloudflare Workers. \
     You take real actions across the user's connected apps via MCP tools and PROVE every step.\n\
     Discipline:\n\
     - PLAN: for multi-step requests call update_plan first; keep steps concrete; mark steps \
     active/done/failed as you go.\n\
     - ACT: use tools to take real actions. If unsure what tools exist, call load_tools with a \
     keyword query to discover the right one.\n\
     - VERIFY: after ANY mutating call (create/update/send/post/delete) you MUST read back the \
     artifact with an independent read call before claiming success; then call attest with \
     claim + concrete evidence (id, url, or excerpt).\n\
     - REPORT: end concise — what was done, what was verified, links/ids, and any failure verbatim.\n\
     Memory: call remember() for durable user facts/preferences; call forget() for stale ones; \
     use remembered facts naturally, never recite the list.\n\
     Files: the user's context file holds standing background — follow it; edit it with \
     update_context only when asked. When you hit a non-obvious failure and find what works, \
     call save_lesson with a one-line takeaway; heed existing lessons.\n\
     Use generate_image when the user wants visuals; run_code for computation or data munging.\n\
     Never claim an action succeeded without verification. Never fabricate tool results. \
     If a tool fails, report the real error and adapt. Be concise; prefer acting over asking. \
     You have many tools across many apps — always pick the minimal set needed."
}

/// Prompt budget for the injected user files.
const CONTEXT_PROMPT_MAX: usize = 4000;
const LESSONS_PROMPT_MAX: usize = 2000;

#[derive(Default)]
struct UserFiles {
    context: String,
    lessons: String,
}

async fn load_user_files(env: &Env, user_id: &str) -> UserFiles {
    let get = |kind: &'static str| async move {
        db::get_user_file(env, user_id, kind)
            .await
            .ok()
            .and_then(|v| v.get("content").and_then(|c| c.as_str()).map(|s| s.to_string()))
            .unwrap_or_default()
    };
    let (context, lessons) = futures::join!(get("context"), get("lessons"));
    UserFiles { context, lessons }
}

fn system_prompt(servers: &[String], memories: &[String], summary: &str, files: &UserFiles) -> String {
    let mut p = base_prompt().to_string();
    p.push_str("\n\n## connected apps\n");
    if servers.is_empty() {
        p.push_str("none connected — only built-in tools are available.");
    } else {
        p.push_str(&servers.join(", "));
        p.push_str("\nTools from a server are named <server>__<tool>.");
    }
    if !summary.is_empty() {
        p.push_str("\n\n## conversation so far (summary)\n");
        p.push_str(summary);
    }
    let context = files.context.trim();
    if !context.is_empty() {
        p.push_str("\n\n## context file (user-maintained)\n");
        p.push_str(&truncate(context, CONTEXT_PROMPT_MAX));
    }
    let lessons = files.lessons.trim();
    if !lessons.is_empty() {
        p.push_str("\n\n## lessons learned (newest last)\n");
        p.push_str(&tail(lessons, LESSONS_PROMPT_MAX));
    }
    if !memories.is_empty() {
        p.push_str("\n\n## what you remember about this user\n");
        for m in memories {
            p.push_str("- ");
            p.push_str(m);
            p.push('\n');
        }
    }
    p
}

/// Replay stored rows (role/content/parts_json) into OpenAI wire messages.
fn replay_messages(stored: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in stored {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if role != "assistant" {
            out.push(json!({"role": "user", "content": content}));
            continue;
        }
        let parts = m
            .get("parts_json")
            .and_then(|p| p.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        if parts.is_empty() {
            out.push(json!({"role": "assistant", "content": content}));
            continue;
        }
        let mut text = String::new();
        let mut i = 0;
        while i < parts.len() {
            match parts[i].get("kind").and_then(|k| k.as_str()) {
                Some("tool") => {
                    let mut j = i;
                    let mut group: Vec<&Value> = Vec::new();
                    while j < parts.len()
                        && parts[j].get("kind").and_then(|k| k.as_str()) == Some("tool")
                    {
                        group.push(&parts[j]);
                        j += 1;
                    }
                    let tcs: Vec<Value> = group
                        .iter()
                        .enumerate()
                        .map(|(k, p)| {
                            let id = p
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| format!("call_{}_{}", i, k));
                            json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": p.get("name").and_then(|v| v.as_str()).unwrap_or("tool"),
                                    "arguments": p.get("args")
                                        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "{}".into()))
                                        .unwrap_or_else(|| "{}".into()),
                                }
                            })
                        })
                        .collect();
                    out.push(json!({
                        "role": "assistant",
                        "content": if text.is_empty() { Value::Null } else { json!(text) },
                        "tool_calls": tcs,
                    }));
                    text = String::new();
                    for (k, p) in group.iter().enumerate() {
                        let id = p
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("call_{}_{}", i, k));
                        let output = p
                            .get("output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": id,
                            "content": truncate(output, HISTORY_TOOL_MAX),
                        }));
                    }
                    i = j;
                }
                Some("image") => {
                    let url = parts[i].get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let prompt = parts[i]
                        .get("prompt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    text.push_str(&format!("\n[generated image: {} ({})]", url, prompt));
                    i += 1;
                }
                Some("text") => {
                    if let Some(t) = parts[i].get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                    i += 1;
                }
                _ => {
                    i += 1;
                }
            }
        }
        if !text.is_empty() {
            out.push(json!({"role": "assistant", "content": text}));
        }
    }
    out
}

/// Regenerate the rolling summary over messages leaving the live window.
async fn regen_summary(
    env: &Env,
    cfg: &Config,
    conv_id: &str,
    old_summary: &str,
    from: i64,
    to: i64,
) {
    if to <= from {
        return;
    }
    let slice = match db::messages_page(env, conv_id, to - from, from).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut transcript = String::new();
    for m in &slice {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("?");
        let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
        transcript.push_str(role);
        transcript.push_str(": ");
        transcript.push_str(&truncate(content, 800));
        transcript.push('\n');
    }
    let msgs = vec![json!({
        "role": "user",
        "content": format!(
            "Summarize this conversation so far, preserving decisions, artifacts, URLs, and user preferences, max 300 words.\n\nPrevious summary:\n{}\n\nNew messages:\n{}",
            if old_summary.is_empty() { "(none)" } else { old_summary },
            transcript
        )
    })];
    match azure::chat_once(cfg, &cfg.model_fallback, &msgs, &[]).await {
        Ok(v) => {
            let summary = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            if !summary.is_empty() {
                let _ = db::update_summary(env, conv_id, &summary, to).await;
            }
        }
        Err(e) => console_log!("summary regen failed: {}", e),
    }
}

/// Everything dispatch needs for built-in tools.
struct Ctx {
    env: Env,
    cfg: Config,
    user_id: String,
    run_id: String,
    /// All connected servers' raw tool schemas: (server_name, [mcp tools]).
    all_tools: Vec<(String, Vec<Value>)>,
}

/// Result of executing one tool call.
struct ToolOutcome {
    app: String,
    ok: bool,
    output: String,
    /// Extra SSE frames built-ins produce (plan / verify / memory / image / code / tools_loaded).
    extra: Vec<(String, Value)>,
    /// Extra persisted parts (e.g. generated images).
    parts: Vec<Value>,
}

fn simple_outcome(app: &str, ok: bool, output: String, extra: Vec<(String, Value)>) -> ToolOutcome {
    ToolOutcome {
        app: app.to_string(),
        ok,
        output,
        extra,
        parts: vec![],
    }
}

/// Keyword-search connected servers' tool schemas; returns top-10 matches.
fn search_tools(all: &[(String, Vec<Value>)], query: &str) -> Vec<Value> {
    let words: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(|w| w.to_string())
        .collect();
    let mut scored: Vec<(usize, Value)> = Vec::new();
    for (server, tools) in all {
        for t in tools {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let hay = format!("{} {} {}", server, name, desc).to_lowercase();
            let score = words.iter().filter(|w| hay.contains(w.as_str())).count();
            if score > 0 {
                scored.push((
                    score,
                    json!({
                        "server": server,
                        "name": name,
                        "call_as": format!("{}__{}", server, name),
                        "description": desc,
                        "parameters": t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type":"object"})),
                    }),
                ));
            }
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(10);
    scored.into_iter().map(|(_, v)| v).collect()
}

async fn run_code(ctx: &Ctx, code: &str, language: &str) -> (bool, String) {
    let body = json!({"code": code, "language": language});

    // Prefer the SANDBOX service binding (worker→worker, no public hop —
    // workers.dev hosts can't fetch each other, error 1042).
    if let Ok(f) = ctx.env.service("SANDBOX") {
        let headers = Headers::new();
        let _ = headers.set("content-type", "application/json");
        if !ctx.cfg.sandbox_token.is_empty() {
            let _ = headers.set("authorization", &format!("Bearer {}", ctx.cfg.sandbox_token));
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.to_string().into()));
        if let Ok(req) = Request::new_with_init("https://sandbox.internal/run", &init) {
            match f.fetch_request(req).await {
                Ok(mut resp) => match resp.json::<Value>().await {
                    Ok(v) => return sandbox_out(&v),
                    Err(e) => return (false, format!("sandbox bad response: {}", e)),
                },
                Err(e) => return (false, format!("sandbox fetch failed: {}", e)),
            }
        }
    }

    // Fallback: plain HTTP (local dev / external sandbox).
    let base = match &ctx.cfg.sandbox_url {
        Some(u) if !u.is_empty() => u.clone(),
        _ => return (false, "sandbox not configured".to_string()),
    };
    let url = format!("{}/run", base);
    let auth = format!("Bearer {}", ctx.cfg.sandbox_token);
    let headers: Vec<(&str, &str)> = if ctx.cfg.sandbox_token.is_empty() {
        vec![]
    } else {
        vec![("authorization", auth.as_str())]
    };
    match azure::post_json(&url, &headers, &body).await {
        Ok(v) => sandbox_out(&v),
        Err(e) => (false, format!("{}", e)),
    }
}

fn sandbox_out(v: &Value) -> (bool, String) {
    let stdout = v.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
    let stderr = v.get("stderr").and_then(|s| s.as_str()).unwrap_or("");
    let exit = v.get("exit_code").and_then(|e| e.as_i64()).unwrap_or(-1);
    let mut out = stdout.to_string();
    if !stderr.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("stderr: ");
        out.push_str(stderr);
    }
    (exit == 0, truncate(&out, 4000))
}

/// Execute one tool call (MCP or built-in).
async fn dispatch(ctx: &Ctx, clients: &mut [McpClient], name: &str, args: &Value) -> ToolOutcome {
    match name.split_once("__") {
        Some((server, tool)) => {
            if let Some(c) = clients.iter_mut().find(|c| c.name == server) {
                match c.call_tool(tool, args.clone()).await {
                    Ok((ok, out)) => simple_outcome(server, ok, out, vec![]),
                    Err(e) => simple_outcome(server, false, format!("{}", e), vec![]),
                }
            } else {
                simple_outcome(
                    server,
                    false,
                    format!("server '{}' not connected", server),
                    vec![],
                )
            }
        }
        None => match name {
            "update_plan" => {
                let steps = args.get("steps").cloned().unwrap_or(json!([]));
                simple_outcome(
                    "bloop",
                    true,
                    "{\"ok\":true}".into(),
                    vec![("plan".into(), json!({"steps": steps}))],
                )
            }
            "attest" => {
                let claim = args.get("claim").and_then(|v| v.as_str()).unwrap_or("");
                let evidence = args.get("evidence").and_then(|v| v.as_str()).unwrap_or("");
                let app = args.get("app").and_then(|v| v.as_str()).unwrap_or("bloop");
                let hash = ledger::attest(&ctx.run_id, claim, evidence, app);
                let data = json!({"claim": claim, "evidence": evidence, "app": app, "hash": hash});
                simple_outcome(
                    app,
                    true,
                    json!({"ok": true, "hash": hash}).to_string(),
                    vec![("verify".into(), data)],
                )
            }
            "remember" => {
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if content.is_empty() {
                    return simple_outcome("bloop", false, "empty content".into(), vec![]);
                }
                match db::add_memory(&ctx.env, &ctx.user_id, content).await {
                    Ok(_) => simple_outcome(
                        "bloop",
                        true,
                        json!({"ok": true}).to_string(),
                        vec![(
                            "memory".into(),
                            json!({"action": "remember", "content": content}),
                        )],
                    ),
                    Err(e) => simple_outcome("bloop", false, format!("{}", e), vec![]),
                }
            }
            "forget" => {
                let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
                match db::forget_memories(&ctx.env, &ctx.user_id, query).await {
                    Ok(n) => simple_outcome(
                        "bloop",
                        true,
                        json!({"ok": true, "deleted": n}).to_string(),
                        vec![(
                            "memory".into(),
                            json!({"action": "forget", "content": query}),
                        )],
                    ),
                    Err(e) => simple_outcome("bloop", false, format!("{}", e), vec![]),
                }
            }
            "update_context" => {
                let md = args.get("markdown").and_then(|v| v.as_str()).unwrap_or("");
                if md.len() > db::FILE_MAX {
                    return simple_outcome("bloop", false, format!("context too large (max {} chars)", db::FILE_MAX), vec![]);
                }
                match db::put_user_file(&ctx.env, &ctx.user_id, "context", md).await {
                    Ok(_) => simple_outcome(
                        "bloop",
                        true,
                        json!({"ok": true, "chars": md.len()}).to_string(),
                        vec![(
                            "file".into(),
                            json!({"kind": "context", "action": "update", "content": truncate(md, 300)}),
                        )],
                    ),
                    Err(e) => simple_outcome("bloop", false, format!("{}", e), vec![]),
                }
            }
            "save_lesson" => {
                let lesson = args.get("lesson").and_then(|v| v.as_str()).unwrap_or("").trim();
                if lesson.is_empty() {
                    return simple_outcome("bloop", false, "empty lesson".into(), vec![]);
                }
                let lesson = truncate(lesson, 500);
                match db::append_lesson(&ctx.env, &ctx.user_id, &lesson).await {
                    Ok(_) => simple_outcome(
                        "bloop",
                        true,
                        json!({"ok": true}).to_string(),
                        vec![(
                            "file".into(),
                            json!({"kind": "lessons", "action": "append", "content": lesson}),
                        )],
                    ),
                    Err(e) => simple_outcome("bloop", false, format!("{}", e), vec![]),
                }
            }
            "load_tools" => {
                let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let found = search_tools(&ctx.all_tools, query);
                let names: Vec<String> = found
                    .iter()
                    .filter_map(|t| {
                        t.get("call_as")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect();
                simple_outcome(
                    "bloop",
                    true,
                    serde_json::to_string(&found).unwrap_or_else(|_| "[]".into()),
                    vec![("tools_loaded".into(), json!({"names": names}))],
                )
            }
            "generate_image" => {
                let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                let size = args
                    .get("size")
                    .and_then(|v| v.as_str())
                    .unwrap_or("1024x1024");
                if prompt.is_empty() {
                    return simple_outcome("bloop", false, "empty prompt".into(), vec![]);
                }
                match azure::generate_image(&ctx.cfg, prompt, size).await {
                    Ok(bytes) => {
                        let key = format!("img/{}.png", crate::crypto::uuid());
                        match ctx.env.bucket("FILES") {
                            Ok(bucket) => match bucket.put(&key, bytes).execute().await {
                                Ok(_) => {
                                    let url = format!("/files/{}", key);
                                    let mut o = simple_outcome(
                                        "bloop",
                                        true,
                                        json!({"url": url, "prompt": prompt}).to_string(),
                                        vec![(
                                            "image".into(),
                                            json!({"url": url, "prompt": prompt}),
                                        )],
                                    );
                                    o.parts.push(json!({
                                        "kind": "image", "url": url, "prompt": prompt
                                    }));
                                    o
                                }
                                Err(e) => {
                                    simple_outcome("bloop", false, format!("r2 put: {}", e), vec![])
                                }
                            },
                            Err(e) => simple_outcome(
                                "bloop",
                                false,
                                format!("r2 bucket: {}", e),
                                vec![],
                            ),
                        }
                    }
                    Err(e) => simple_outcome("bloop", false, format!("{}", e), vec![]),
                }
            }
            "run_code" => {
                let code = args.get("code").and_then(|v| v.as_str()).unwrap_or("");
                let language = args
                    .get("language")
                    .and_then(|v| v.as_str())
                    .unwrap_or("python");
                let (ok, output) = run_code(ctx, code, language).await;
                simple_outcome(
                    "bloop",
                    ok,
                    output.clone(),
                    vec![(
                        "code".into(),
                        json!({"language": language, "source": code, "output": output, "ok": ok}),
                    )],
                )
            }
            other => simple_outcome("bloop", false, format!("unknown tool '{}'", other), vec![]),
        },
    }
}

pub struct RunOpts {
    pub env: Env,
    pub cfg: Config,
    pub run_id: String,
    pub user_id: String,
    pub conversation_id: String,
    /// Persist messages/title to D1 (false for the eval-token caller).
    pub persist: bool,
    pub message: String,
    pub model: String,
}

/// The agentic loop as a stream of SSE frame bytes.
pub fn run(o: RunOpts) -> impl Stream<Item = Result<Vec<u8>>> {
    async_stream::stream! {
        ledger::begin_run(&o.run_id);
        let env = o.env.clone();
        let cfg = o.cfg.clone();

        // --- Conversation context (persisted path only) ---
        let mut summary = String::new();
        let mut history: Vec<Value> = Vec::new();
        if o.persist {
            if let Ok(Some(conv)) = db::get_conversation(&env, &o.user_id, &o.conversation_id).await {
                let total = db::message_count(&env, &o.conversation_id).await.unwrap_or(0);
                let summarized = conv
                    .get("summarized_count")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                summary = conv
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let window_start = (total - HISTORY_WINDOW).max(0);
                if total - summarized > SUMMARY_LAG && window_start > summarized {
                    regen_summary(&env, &cfg, &o.conversation_id, &summary, summarized, window_start).await;
                    if let Ok(Some(c2)) = db::get_conversation(&env, &o.user_id, &o.conversation_id).await {
                        summary = c2.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    }
                }
                if let Ok(page) = db::messages_page(&env, &o.conversation_id, HISTORY_WINDOW, window_start).await {
                    history = replay_messages(&page);
                }
            }
            // Persist the incoming user message.
            let _ = db::add_message(
                &env,
                &o.conversation_id,
                "user",
                &o.message,
                &json!([{"kind": "text", "text": o.message}]),
            )
            .await;
        }

        // --- Memories for the system prompt (max 30, 200 chars each) ---
        let memories: Vec<String> = db::list_memories(&env, &o.user_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                m.get("content")
                    .and_then(|c| c.as_str())
                    .map(|s| truncate(s, 200))
            })
            .take(30)
            .collect();
        let files = load_user_files(&env, &o.user_id).await;

        // --- Connect MCP servers: global env servers + this user's servers ---
        let mut server_cfgs = cfg.servers.clone();
        if let Ok(rows) = db::list_user_servers(&env, &o.user_id).await {
            for r in rows {
                let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let token = r.get("token").and_then(|v| v.as_str()).unwrap_or("");
                if !name.is_empty() && !url.is_empty() {
                    server_cfgs.push(crate::config::McpServerCfg {
                        name: sanitize_name(name),
                        url: url.to_string(),
                        token: token.to_string(),
                    });
                }
            }
        }

        let mut clients: Vec<McpClient> = server_cfgs
            .iter()
            .map(|s| McpClient::new(&s.name, &s.url, &s.token))
            .collect();
        let mut tools = builtin_tools();
        let mut connected: Vec<String> = Vec::new();
        let mut all_tools: Vec<(String, Vec<Value>)> = Vec::new();
        for c in clients.iter_mut() {
            match c.initialize().await {
                Ok(()) => match c.list_tools().await {
                    Ok(tlist) => {
                        console_log!("mcp {} connected: {} tools", c.name, tlist.len());
                        connected.push(c.name.clone());
                        all_tools.push((c.name.clone(), tlist.clone()));
                        for t in &tlist {
                            tools.push(mcp_tool_to_openai(&c.name, t));
                        }
                        record(&o.run_id, "server", &json!({"name": c.name, "state": "ok", "tools": tlist.len()}));
                    }
                    Err(e) => {
                        console_log!("mcp {} tools/list failed: {}", c.name, e);
                        record(&o.run_id, "server", &json!({"name": c.name, "state": "error", "tools": 0}));
                    }
                },
                Err(e) => {
                    console_log!("mcp {} init failed: {}", c.name, e);
                    record(&o.run_id, "server", &json!({"name": c.name, "state": "error", "tools": 0}));
                }
            }
        }

        let ctx = Ctx {
            env: env.clone(),
            cfg: cfg.clone(),
            user_id: o.user_id.clone(),
            run_id: o.run_id.clone(),
            all_tools,
        };

        let mut messages = vec![json!({
            "role": "system",
            "content": system_prompt(&connected, &memories, &summary, &files)
        })];
        messages.extend(history);
        messages.push(json!({"role": "user", "content": o.message}));

        let models = {
            let mut v = vec![o.model.clone()];
            if cfg.model_fallback != o.model && crate::config::model_allowed(&cfg.model_fallback) {
                v.push(cfg.model_fallback.clone());
            }
            v
        };
        let mut iter = 0usize;
        let mut hit_limit = false;
        let mut parts: Vec<Value> = Vec::new();
        let mut final_text = String::new();

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
                    record(&o.run_id, "error", &json!({"message": msg}));
                    yield Ok(sse("error", &json!({"message": msg})));
                    break 'outer;
                }
            };

            if !reply.content.is_empty() {
                parts.push(json!({"kind": "text", "text": reply.content}));
                final_text = reply.content.clone();
            }

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
                record(&o.run_id, "tool_call", &call_ev);
                yield Ok(sse("tool_call", &call_ev));

                let started = now_ms();
                let out = dispatch(&ctx, &mut clients, &call.name, &args).await;
                let ms = (now_ms() - started) as u64;

                // built-in side frames: plan / verify / memory / image / code / tools_loaded
                for (ev, data) in &out.extra {
                    record(&o.run_id, ev, data);
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
                record(&o.run_id, "tool_result", &res_ev);
                yield Ok(sse("tool_result", &res_ev));

                parts.push(json!({
                    "kind": "tool",
                    "id": id,
                    "name": call.name,
                    "app": out.app,
                    "args": args,
                    "ok": out.ok,
                    "ms": ms,
                    "output": truncate(&out.output, MODEL_OUTPUT_MAX),
                }));
                parts.extend(out.parts.clone());

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

        // --- Persist assistant message + auto-title ---
        if o.persist {
            let content = if final_text.is_empty() {
                parts
                    .iter()
                    .filter_map(|p| {
                        if p.get("kind").and_then(|k| k.as_str()) == Some("text") {
                            p.get("text").and_then(|t| t.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                final_text.clone()
            };
            let _ = db::add_message(&env, &o.conversation_id, "assistant", &content, &json!(parts)).await;
            let title: String = o
                .message
                .split_whitespace()
                .take(6)
                .collect::<Vec<_>>()
                .join(" ");
            if !title.is_empty() {
                db::auto_title(&env, &o.conversation_id, &title).await;
            }
            db::touch_conversation(&env, &o.conversation_id).await;
        }

        yield Ok(sse("done", &json!({"conversation_id": o.conversation_id})));
    }
}
