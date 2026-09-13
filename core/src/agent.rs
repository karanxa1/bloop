use crate::azure;
use crate::config::{Config, McpServerCfg};
use crate::db;
use crate::ledger;
use crate::mcp::McpClient;
use crate::workspace;
use base64::Engine;
use futures::channel::mpsc;
use futures::future::{self, Either, LocalBoxFuture};
use futures::stream::{Stream, StreamExt};
use futures::FutureExt;
use std::time::Duration;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use worker::*;

const MAX_ITERS: usize = 15;
const DEEP_MAX_ITERS: usize = 25;
const SUB_MAX_ITERS: usize = 8;
const BUILD_MAX_ITERS: usize = 12;
/// Model-context cap for tools whose output is code or build logs.
const CODE_OUTPUT_MAX: usize = 12_000;
/// Files returned by workspace_list.
const WORKSPACE_LIST_MAX: usize = 300;
/// Cap on the cumulative deep-mode source list.
const SOURCES_MAX: usize = 20;
/// Links appended to a browse result for the model.
const BROWSE_LINKS_MAX: usize = 15;
/// MCP servers whose outputs are mined for source URLs in deep mode.
const DOC_SERVERS: &[&str] = &["deepwiki", "context7", "cf-docs"];
/// Substrings that mark an MCP tool as mutating (subagents are read-only).
const MUTATING_WORDS: &[&str] = &[
    "create", "update", "delete", "send", "post", "comment", "merge", "close", "add", "remove",
    "set", "write", "invite", "reply", "assign", "label", "move",
];

/// Run mode chosen per chat request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Default,
    Think,
    Deep,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "default" => Some(Mode::Default),
            "think" => Some(Mode::Think),
            "deep" => Some(Mode::Deep),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Mode::Default => "default",
            Mode::Think => "think",
            Mode::Deep => "deep",
        }
    }

    fn max_iters(self) -> usize {
        match self {
            Mode::Deep => DEEP_MAX_ITERS,
            _ => MAX_ITERS,
        }
    }

    fn addendum(self) -> &'static str {
        match self {
            Mode::Default => "",
            Mode::Think => {
                "\n\n## mode: think\nReason step by step. Plan before acting: lay out the plan with \
                 update_plan first, consider alternatives and failure modes, then execute and keep \
                 the plan current."
            }
            Mode::Deep => {
                "\n\n## mode: deep research\nResearch iteratively: search, read, refine, repeat. \
                 Consult at least 2 independent sources and cross-check claims. Use browse to read \
                 pages and delegate to run independent research threads in parallel. Cite source \
                 URLs inline next to the claims they support."
            }
        }
    }
}
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
        json!({
            "type": "function",
            "function": {
                "name": "browse",
                "description": "Open a web page in a real headless browser and return its title, URL, readable markdown and top links (mode 'markdown', default) or a screenshot shown in chat (mode 'screenshot'). Pass session_id to reuse a browser session, e.g. after a user handoff.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "mode": {"type": "string", "enum": ["markdown", "screenshot"], "default": "markdown"},
                        "session_id": {"type": "string"}
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "browser_handoff",
                "description": "Hand a live browser session to the user for steps only they can do (logging in, captchas, 2FA, payment confirmation). Returns a session_id; then wait for the user to reply 'done' before continuing with browse(..., session_id).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string", "description": "Short explanation shown to the user, e.g. 'log in to your bank'"},
                        "url": {"type": "string", "description": "Page to open for the user"}
                    },
                    "required": ["reason"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "delegate",
                "description": "Spawn a subagent for one self-contained task; it streams its work and returns a concise summary. kind 'research' (default): read-only — browse, run code, read-only app tools; returns findings with URLs/ids. kind 'build': research tools plus the shared code workspace — writes files, runs and tests them until passing, returns the files changed. Call several in one turn to run them in parallel (give parallel build subagents distinct directories). Never for writes to external apps.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {"type": "string", "description": "Self-contained task with all needed context (for build: the directory to work in)"},
                        "kind": {"type": "string", "enum": ["research", "build"], "default": "research"},
                        "tools_hint": {"type": "string", "description": "Optional: tools or sites likely useful"}
                    },
                    "required": ["task"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "workspace_write",
                "description": "Create or overwrite a text file in this conversation's code workspace (max 1 MB).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Relative path, e.g. 'app/src/index.ts'"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "workspace_read",
                "description": "Read a text file from the code workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "workspace_list",
                "description": "List workspace files (path and size), optionally under a directory prefix.",
                "parameters": {
                    "type": "object",
                    "properties": {"prefix": {"type": "string", "description": "e.g. 'app/'"}}
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "workspace_delete",
                "description": "Delete a file from the code workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "workspace_exec",
                "description": "Run a shell command in a sandbox container with the workspace as the working directory (install deps, build, run tests). File changes sync back to the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "e.g. 'cd app && npm install && npm test'"},
                        "timeout_s": {"type": "integer", "description": "Optional timeout in seconds"}
                    },
                    "required": ["command"]
                }
            }
        }),
    ]
}

/// Built-in tools every subagent may use.
const SUB_BUILTINS: &[&str] = &["run_code", "browse", "load_tools"];
/// Extra built-ins for build subagents.
const WORKSPACE_TOOLS: &[&str] = &[
    "workspace_write",
    "workspace_read",
    "workspace_list",
    "workspace_delete",
    "workspace_exec",
];

/// The subagent a tool call runs inside of.
#[derive(Clone, Copy)]
struct Parent<'a> {
    id: &'a str,
    build: bool,
}

impl Parent<'_> {
    fn allows(&self, tool: &str) -> bool {
        SUB_BUILTINS.contains(&tool) || (self.build && WORKSPACE_TOOLS.contains(&tool))
    }
}

fn tool_name(schema: &Value) -> &str {
    schema
        .pointer("/function/name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

/// True when an MCP tool name looks like it mutates state.
fn is_mutating(tool: &str) -> bool {
    let t = tool.to_ascii_lowercase();
    MUTATING_WORDS.iter().any(|w| t.contains(w))
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
     Web: use browse to read web pages (markdown by default; screenshot when layout matters). \
     Use browser_handoff ONLY for logins, captchas or other steps only the user can do — then stop \
     and wait for the user to say done. Use delegate for independent read-only research threads; \
     several delegates in one turn run in parallel. Independent tool calls in one turn run \
     concurrently, so batch them.\n\
     Building: this conversation has a persistent code workspace (workspace_write/read/list/\
     delete, workspace_exec runs shell commands in it). For requests to build, implement or \
     create an app or code: plan with update_plan, split the work into delegate(kind:\"build\") \
     subtasks that each own an explicit directory (e.g. api/, web/), then integrate, run and \
     test the result yourself with workspace_exec.\n\
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

fn system_prompt(
    servers: &[String],
    memories: &[String],
    summary: &str,
    files: &UserFiles,
    mode: Mode,
) -> String {
    let mut p = base_prompt().to_string();
    p.push_str(mode.addendum());
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
    match azure::chat_once(cfg, &cfg.model_fallback, &msgs, &[], &Value::Null).await {
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

/// One SSE frame: (event, data).
type Frame = (String, Value);

/// A deep-mode source: (url, optional title).
type Source = (String, Option<String>);

/// Per-server MCP connect budget (initialize + tools/list).
const CONNECT_TIMEOUT_MS: u64 = 4000;

const SUBAGENT_PROMPT: &str = "You are a bloop research subagent working on ONE delegated task. \
     Use read-only app tools, load_tools, run_code and browse to find the answer. You cannot make \
     changes anywhere — never attempt writes. Prefer MCP doc tools (deepwiki, context7, cf-docs) and \
     app tools over browse: browse is slow (~6s) and rate-limited, so use it sparingly. Batch \
     independent tool calls in one turn. Be fast and concise: stop as soon as you have enough. \
     Finish with a short summary of findings including the concrete URLs, ids and figures that \
     support them, and say plainly what you could not find.";

const BUILD_PROMPT: &str = "You are a bloop build subagent implementing ONE delegated task in a \
     shared code workspace. Write files with workspace_write, inspect with workspace_list and \
     workspace_read, and install, build, run and test with workspace_exec (file exec bits are not \
     kept, so run scripts as `bash x.sh` / `node x.js`; commands on one workspace run one at a \
     time). Iterate until the code \
     runs and its tests pass. Stay inside the directory your task assigns — other subagents may be \
     working in sibling directories at the same time. Never modify external apps. For documentation \
     prefer MCP doc tools (context7, deepwiki, cf-docs) over browse, which is slow and rate-limited. \
     Batch independent tool calls in one turn. Finish with a concise summary: what you built, every \
     file you changed, how to run it, and the test results.";

/// Sends frames to the client stream as they happen and records them in the run ledger.
#[derive(Clone)]
struct Emitter {
    run_id: String,
    tx: mpsc::UnboundedSender<Frame>,
}

impl Emitter {
    /// Send a frame without recording it (text deltas, done).
    fn send(&self, ev: &str, data: Value) {
        let _ = self.tx.unbounded_send((ev.to_string(), data));
    }

    /// Record a frame in the ledger and send it.
    fn emit(&self, ev: &str, data: Value) {
        record(&self.run_id, ev, &data);
        self.send(ev, data);
    }

    /// Like `emit`, tagging the frame with `parent` when it comes from a subagent.
    fn emit_in(&self, parent: Option<&str>, ev: &str, mut data: Value) {
        if let Some(p) = parent {
            data["parent"] = json!(p);
        }
        self.emit(ev, data);
    }
}

/// Everything tool execution needs.
struct Ctx {
    env: Env,
    cfg: Config,
    user_id: String,
    run_id: String,
    /// Models to try in order (primary, then fallback).
    models: Vec<String>,
    /// All connected servers' raw tool schemas: (server_name, [mcp tools]).
    all_tools: Vec<(String, Vec<Value>)>,
    /// Connected servers' configs, so subagents can open their own sessions.
    servers: Vec<McpServerCfg>,
    /// Code workspace id (conversation id, or run id when not persisted).
    workspace: String,
    /// Single-flight gate for sandbox browser calls, shared with subagents:
    /// the browser plan allows few concurrent sessions and slow launches.
    browser: futures::lock::Mutex<()>,
    out: Emitter,
}

/// Result of executing one tool call.
struct ToolOutcome {
    app: String,
    ok: bool,
    output: String,
    /// Extra SSE frames built-ins produce (plan / verify / memory / image / code / handoff / ...).
    extra: Vec<(String, Value)>,
    /// Extra persisted parts (e.g. images, subagent transcripts).
    parts: Vec<Value>,
    /// Pages this call actually read (browse), for deep-mode citations.
    sources: Vec<Source>,
}

fn simple_outcome(app: &str, ok: bool, output: String, extra: Vec<(String, Value)>) -> ToolOutcome {
    ToolOutcome {
        app: app.to_string(),
        ok,
        output,
        extra,
        parts: vec![],
        sources: vec![],
    }
}

fn fail(msg: impl Into<String>) -> ToolOutcome {
    simple_outcome("bloop", false, msg.into(), vec![])
}

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// One tool call from a model turn, with parsed args.
struct Call {
    id: String,
    name: String,
    args: Value,
    /// Arguments exactly as the model sent them (echoed back in history).
    raw_args: String,
}

impl Call {
    /// Build calls from a reply; `fallback_id` names calls the model left without an id.
    fn from_reply(reply: &Reply, fallback_id: impl Fn(usize) -> String) -> Vec<Call> {
        reply
            .calls
            .iter()
            .enumerate()
            .map(|(i, c)| Call {
                id: if c.id.is_empty() { fallback_id(i) } else { c.id.clone() },
                name: c.name.clone(),
                args: serde_json::from_str(&c.args).unwrap_or_else(|_| json!({})),
                raw_args: c.args.clone(),
            })
            .collect()
    }

    /// (server, tool) for MCP calls named `<server>__<tool>`.
    fn mcp(&self) -> Option<(&str, &str)> {
        self.name.split_once("__")
    }

    fn app(&self) -> &str {
        self.mcp().map(|(s, _)| s).unwrap_or("bloop")
    }
}

fn assistant_tool_message(content: &str, calls: &[Call]) -> Value {
    let tcs: Vec<Value> = calls
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": c.raw_args}
            })
        })
        .collect();
    json!({
        "role": "assistant",
        "content": if content.is_empty() { Value::Null } else { json!(content) },
        "tool_calls": tcs,
    })
}

/// How much of a tool's output the model sees.
fn model_cap(tool: &str) -> usize {
    match tool {
        "workspace_read" | "workspace_list" | "workspace_exec" => CODE_OUTPUT_MAX,
        _ => MODEL_OUTPUT_MAX,
    }
}

fn tool_message(call: &Call, out: &ToolOutcome) -> Value {
    let body = truncate(&out.output, model_cap(&call.name));
    json!({
        "role": "tool",
        "tool_call_id": call.id,
        "content": if out.ok { body } else { format!("ERROR: {}", body) },
    })
}

/// `{id, name, app, args, ok, ms, output}` for persisted parts and subagent transcripts.
fn tool_record(c: &Call, out: &ToolOutcome, ms: u64, max: usize) -> Value {
    json!({
        "id": c.id,
        "name": c.name,
        "app": out.app,
        "args": c.args,
        "ok": out.ok,
        "ms": ms,
        "output": truncate(&out.output, max),
    })
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

async fn with_timeout<T>(fut: impl std::future::Future<Output = Result<T>>, ms: u64) -> Result<T> {
    let delay = Delay::from(Duration::from_millis(ms));
    futures::pin_mut!(fut);
    futures::pin_mut!(delay);
    match future::select(fut, delay).await {
        Either::Left((r, _)) => r,
        Either::Right(_) => Err(Error::RustError(format!("timed out after {}ms", ms))),
    }
}

// ---------- sandbox ----------

async fn sandbox_post(ctx: &Ctx, path: &str, body: &Value) -> std::result::Result<(u16, Value), String> {
    crate::sandbox::post(&ctx.env, &ctx.cfg, path, body).await
}

use crate::sandbox::err_text as sandbox_err;

/// Model-facing message for a failed sandbox browser call.
fn browser_err(what: &str, status: u16, v: &Value) -> String {
    let detail = sandbox_err(status, v);
    match status {
        404 => format!("{what} failed: browser session not found or expired ({detail}). Retry without session_id or start a new handoff."),
        429 => format!("{what} failed: browser rate limit hit ({detail}). Do NOT retry right away — use doc/app tools instead, or wait and make far fewer browse calls."),
        502 => format!("{what} failed: the page could not be loaded ({detail}). Check the URL or use another source."),
        504 => format!("{what} failed: the page timed out ({detail}). Try another source."),
        _ => format!("{what} failed: {detail}"),
    }
}

async fn run_code(ctx: &Ctx, code: &str, language: &str) -> (bool, String) {
    match sandbox_post(ctx, "/run", &json!({"code": code, "language": language})).await {
        Ok((status, v)) if status >= 400 && v.get("stdout").is_none() => (false, sandbox_err(status, &v)),
        Ok((_, v)) => sandbox_out(&v),
        Err(e) => (false, e),
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

/// Store bytes in R2 under `key`; returns the `/files/...` URL.
async fn store_file(ctx: &Ctx, key: &str, bytes: Vec<u8>) -> std::result::Result<String, String> {
    let bucket = ctx.env.bucket("FILES").map_err(|e| format!("r2 bucket: {}", e))?;
    bucket
        .put(key, bytes)
        .execute()
        .await
        .map_err(|e| format!("r2 put: {}", e))?;
    Ok(format!("/files/{}", key))
}

/// Outcome for an image shown in chat: `image` frame + persisted image part.
fn image_outcome(url: &str, prompt: &str, output: String) -> ToolOutcome {
    let mut o = simple_outcome(
        "bloop",
        true,
        output,
        vec![("image".into(), json!({"url": url, "prompt": prompt}))],
    );
    o.parts.push(json!({"kind": "image", "url": url, "prompt": prompt}));
    o
}

/// "webp" when the declared format or the bytes say so, else "png".
fn image_ext(declared: &str, bytes: &[u8]) -> &'static str {
    let sniffed_webp = bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
    if declared == "webp" || (declared.is_empty() && sniffed_webp) {
        "webp"
    } else {
        "png"
    }
}

/// Model-facing text for a browse result: title, url, markdown and top links, within `max` bytes.
fn browse_output(v: &Value, max: usize) -> String {
    let mut text = format!("# {}\nURL: {}\n", str_at(v, "title"), str_at(v, "url"));
    let mut links = String::new();
    for l in v
        .get("links")
        .and_then(|l| l.as_array())
        .into_iter()
        .flatten()
        .filter(|l| !str_at(l, "href").is_empty())
        .take(BROWSE_LINKS_MAX)
    {
        links.push_str(&format!(
            "- [{}]({})\n",
            truncate(str_at(l, "text").trim(), 80),
            truncate(str_at(l, "href"), 200)
        ));
    }
    if !links.is_empty() {
        links.insert_str(0, "\nLinks:\n");
    }
    let md = str_at(v, "markdown").trim();
    if !md.is_empty() {
        let budget = max.saturating_sub(text.len() + links.len() + 8);
        text.push('\n');
        text.push_str(&truncate(md, budget));
        text.push('\n');
    }
    text.push_str(&links);
    truncate(&text, max)
}

async fn browse(ctx: &Ctx, args: &Value) -> ToolOutcome {
    let url = str_at(args, "url").trim();
    if url.is_empty() {
        return fail("url required");
    }
    let mode = if str_at(args, "mode") == "screenshot" { "screenshot" } else { "markdown" };
    let mut body = json!({"url": url, "mode": mode});
    let session_id = str_at(args, "session_id");
    if !session_id.is_empty() {
        body["session_id"] = json!(session_id);
    }
    let fetched = {
        let _slot = ctx.browser.lock().await;
        sandbox_post(ctx, "/browser/fetch", &body).await
    };
    let v = match fetched {
        Ok((status, v)) if status < 400 && v.get("error").is_none() => v,
        Ok((status, v)) => return fail(browser_err("browse", status, &v)),
        Err(e) => return fail(e),
    };
    let final_url = match str_at(&v, "url") {
        "" => url,
        u => u,
    };
    let title = str_at(&v, "title");
    // Leave room for the screenshot line so truncation never drops it.
    let mut output = browse_output(&v, MODEL_OUTPUT_MAX - 200);
    let mut o = match str_at(&v, "screenshot") {
        "" => simple_outcome("bloop", true, output, vec![]),
        b64 => {
            let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
                Ok(b) => b,
                Err(e) => return fail(format!("screenshot decode: {}", e)),
            };
            let key = format!(
                "shots/{}.{}",
                crate::crypto::uuid(),
                image_ext(str_at(&v, "format"), &bytes)
            );
            match store_file(ctx, &key, bytes).await {
                Ok(shot) => {
                    output.push_str(&format!("\nScreenshot (shown to the user): {}", shot));
                    image_outcome(&shot, &format!("screenshot of {}", final_url), output)
                }
                Err(e) => return fail(e),
            }
        }
    };
    o.sources.push((final_url.to_string(), (!title.is_empty()).then(|| title.to_string())));
    o
}

async fn browser_handoff(ctx: &Ctx, args: &Value) -> ToolOutcome {
    let reason = str_at(args, "reason").trim();
    if reason.is_empty() {
        return fail("reason required");
    }
    let mut body = json!({});
    if !str_at(args, "url").is_empty() {
        body["url"] = json!(str_at(args, "url"));
    }
    let _slot = ctx.browser.lock().await;
    let session_id = match sandbox_post(ctx, "/browser/session", &body).await {
        Ok((s, v)) if s < 400 && !str_at(&v, "session_id").is_empty() => str_at(&v, "session_id").to_string(),
        Ok((s, v)) => return fail(browser_err("opening a browser session", s, &v)),
        Err(e) => return fail(e),
    };
    let res = sandbox_post(ctx, "/browser/handoff", &json!({"session_id": session_id})).await;
    match res {
        Ok((s, v)) if s < 400 && !str_at(&v, "url").is_empty() => {
            let url = str_at(&v, "url");
            simple_outcome(
                "bloop",
                true,
                format!(
                    "Handoff started (session_id={sid}). The user now has a live browser window for: {reason}. \
                     STOP now: briefly tell the user what to do in that window and wait for them to reply \"done\". \
                     Only then continue with browse(url, session_id=\"{sid}\") to pick up in the same session.",
                    sid = session_id,
                    reason = reason
                ),
                vec![(
                    "handoff".into(),
                    json!({"url": url, "reason": reason, "session_id": session_id}),
                )],
            )
        }
        other => {
            let _ = sandbox_post(ctx, "/browser/close", &json!({"session_id": session_id})).await;
            match other {
                Ok((501, v)) => fail(format!(
                    "Live browser handoff is not available on this deployment ({}). Ask the user to do this step themselves and tell you when it is done.",
                    sandbox_err(501, &v)
                )),
                Ok((s, v)) => fail(browser_err("handoff", s, &v)),
                Err(e) => fail(e),
            }
        }
    }
}

// ---------- workspace ----------

/// Paths carried by one `workspace` frame (the editor re-lists beyond this).
const WORKSPACE_EVENT_PATHS_MAX: usize = 500;

fn workspace_event(action: &str, paths: &[&str], extra: Value) -> (String, Value) {
    let mut data = json!({"action": action, "paths": &paths[..paths.len().min(WORKSPACE_EVENT_PATHS_MAX)]});
    if let (Some(d), Some(x)) = (data.as_object_mut(), extra.as_object()) {
        d.extend(x.clone());
    }
    ("workspace".into(), data)
}

fn str_list<'a>(v: &'a Value, key: &str) -> Vec<&'a str> {
    v.get(key)
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| p.as_str())
        .collect()
}

/// workspace_* built-ins: files go straight to R2, exec goes to the sandbox.
async fn workspace_tool(ctx: &Ctx, name: &str, args: &Value) -> ToolOutcome {
    let (env, ws) = (&ctx.env, ctx.workspace.as_str());
    let path = str_at(args, "path");
    let ok = |output: String, extra| simple_outcome("bloop", true, output, extra);
    match name {
        "workspace_write" => {
            let content = str_at(args, "content");
            match workspace::write(env, ws, path, content).await {
                Ok(()) => ok(
                    json!({"ok": true, "path": path, "bytes": content.len()}).to_string(),
                    vec![workspace_event("write", &[path], Value::Null)],
                ),
                Err(e) => fail(e.message),
            }
        }
        "workspace_read" => match workspace::read_text(env, ws, path).await {
            Ok(text) if text.len() > CODE_OUTPUT_MAX => ok(
                format!(
                    "{}\n(truncated: file is {} bytes)",
                    truncate(&text, CODE_OUTPUT_MAX - 64),
                    text.len()
                ),
                vec![],
            ),
            Ok(text) => ok(text, vec![]),
            Err(e) => fail(e.message),
        },
        "workspace_list" => {
            match workspace::list(env, ws, str_at(args, "prefix"), WORKSPACE_LIST_MAX).await {
                Ok((entries, truncated)) => {
                    let mut s: String = entries
                        .iter()
                        .map(|e| format!("{}\t{} bytes\n", e.path, e.bytes))
                        .collect();
                    if entries.is_empty() {
                        s.push_str("(no files)");
                    }
                    if truncated {
                        s.push_str(&format!("(first {} shown; narrow with prefix)", WORKSPACE_LIST_MAX));
                    }
                    ok(s, vec![])
                }
                Err(e) => fail(e.message),
            }
        }
        "workspace_delete" => match workspace::delete(env, ws, path).await {
            Ok(()) => ok(
                json!({"ok": true, "path": path}).to_string(),
                vec![workspace_event("delete", &[path], Value::Null)],
            ),
            Err(e) => fail(e.message),
        },
        _ => workspace_exec(ctx, args).await,
    }
}

async fn workspace_exec(ctx: &Ctx, args: &Value) -> ToolOutcome {
    let command = str_at(args, "command").trim();
    if command.is_empty() {
        return fail("command required");
    }
    let timeout_s = args.get("timeout_s").and_then(|v| v.as_u64());
    let v = match workspace::exec(&ctx.env, &ctx.cfg, &ctx.workspace, command, timeout_s).await {
        Ok((status, v)) if status < 400 && v.get("exit_code").is_some() => v,
        Ok((409, v)) => {
            return fail(format!(
                "workspace_exec failed: the workspace is busy with another long-running command ({}). Retry later.",
                sandbox_err(409, &v)
            ))
        }
        Ok((status, v)) => return fail(format!("workspace_exec failed: {}", sandbox_err(status, &v))),
        Err(e) => return fail(e),
    };
    let exit = v.get("exit_code").and_then(|e| e.as_i64()).unwrap_or(-1);
    let (changed, deleted) = (str_list(&v, "changed"), str_list(&v, "deleted"));
    let mut out = format!(
        "exit_code: {} ({} ms)\n",
        exit,
        v.get("ms").and_then(|m| m.as_u64()).unwrap_or(0)
    );
    for key in ["stdout", "stderr"] {
        let s = str_at(&v, key);
        if !s.is_empty() {
            // Keep the end: errors and test summaries come last.
            out.push_str(&format!("{}:\n{}\n", key, tail(s, CODE_OUTPUT_MAX / 2 - 200)));
        }
    }
    for (label, list) in [("changed", &changed), ("deleted", &deleted)] {
        if !list.is_empty() {
            let shown = list.iter().take(50).copied().collect::<Vec<_>>().join(", ");
            out.push_str(&format!("{} ({}): {}\n", label, list.len(), shown));
        }
    }
    let skipped = str_list(&v, "skipped");
    if !skipped.is_empty() {
        out.push_str(&format!(
            "WARNING: {} large file(s) were not synced to the workspace: {}\n",
            skipped.len(),
            skipped.iter().take(20).copied().collect::<Vec<_>>().join(", ")
        ));
    }
    if !str_at(&v, "sync_error").is_empty() {
        out.push_str(&format!(
            "WARNING: syncing changes back to the workspace failed: {}\n",
            str_at(&v, "sync_error")
        ));
    }
    let paths: Vec<&str> = changed.iter().chain(&deleted).copied().collect();
    simple_outcome(
        "bloop",
        exit == 0,
        out,
        vec![workspace_event(
            "exec",
            &paths,
            json!({"command": command, "exit_code": exit}),
        )],
    )
}

// ---------- deep-mode sources ----------

/// http(s) URLs in free text, in order, without trailing punctuation.
fn extract_urls(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("http") {
        let cand = &rest[pos..];
        let scheme = if cand.starts_with("https://") {
            8
        } else if cand.starts_with("http://") {
            7
        } else {
            rest = &cand[4..];
            continue;
        };
        let end = cand
            .find(|c: char| c.is_whitespace() || "\"'<>()[]{}`|\\^".contains(c))
            .unwrap_or(cand.len());
        let url = cand[..end].trim_end_matches(|c: char| ".,;:!?*_~".contains(c));
        if url.len() > scheme && url[scheme..].contains('.') {
            out.push(url.to_string());
        }
        rest = &cand[end.max(scheme)..];
    }
    out
}

/// Merge sources into the cumulative list (dedupe by URL, cap SOURCES_MAX).
/// Returns true when the list changed.
fn merge_sources(list: &mut Vec<Source>, new: &[Source]) -> bool {
    let mut changed = false;
    for (url, title) in new {
        let key = url.trim_end_matches('/');
        match list.iter().position(|(u, _)| u.trim_end_matches('/') == key) {
            Some(i) => {
                if list[i].1.is_none() && title.is_some() {
                    list[i].1 = title.clone();
                    changed = true;
                }
            }
            None if list.len() < SOURCES_MAX => {
                list.push((url.clone(), title.clone()));
                changed = true;
            }
            None => {}
        }
    }
    changed
}

fn sources_json(list: &[Source]) -> Value {
    json!(list
        .iter()
        .map(|(url, title)| match title {
            Some(t) => json!({"url": url, "title": t}),
            None => json!({"url": url}),
        })
        .collect::<Vec<_>>())
}

/// Sources a finished call contributes: pages it read, plus URLs cited in
/// doc-server and delegate outputs.
fn call_sources(call: &Call, out: &ToolOutcome) -> Vec<Source> {
    let mut s = out.sources.clone();
    if out.ok && (call.name == "delegate" || DOC_SERVERS.contains(&call.app())) {
        s.extend(extract_urls(&out.output).into_iter().map(|u| (u, None)));
    }
    s
}

// ---------- tool execution ----------

async fn call_mcp(client: &mut McpClient, tool: &str, args: &Value) -> ToolOutcome {
    match client.call_tool(tool, args.clone()).await {
        Ok((ok, out)) => simple_outcome(&client.name, ok, out, vec![]),
        Err(e) => simple_outcome(&client.name, false, format!("{}", e), vec![]),
    }
}

/// Execute one model turn's tool calls. Every `tool_call` frame goes out first;
/// calls then run concurrently — calls to the same MCP server stay sequential
/// on its shared session — and side frames + `tool_result` follow in index
/// order. Returns (outcome, ms) per call, in index order. `parent` is the
/// subagent id when running inside one.
async fn run_batch(
    ctx: &Ctx,
    clients: &mut [McpClient],
    calls: &[Call],
    parent: Option<Parent<'_>>,
) -> Vec<(ToolOutcome, u64)> {
    let tag = parent.map(|p| p.id);
    for c in calls {
        ctx.out.emit_in(
            tag,
            "tool_call",
            json!({"id": c.id, "name": c.name, "app": c.app(), "args": c.args}),
        );
    }

    let timed = |t0: f64| (now_ms() - t0) as u64;
    let mut claimed = vec![false; calls.len()];
    let mut groups: Vec<LocalBoxFuture<'_, Vec<(usize, ToolOutcome, u64)>>> = Vec::new();
    for client in clients.iter_mut() {
        let idxs: Vec<usize> = calls
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.mcp().is_some_and(|(server, tool)| {
                    server == client.name && !(parent.is_some() && is_mutating(tool))
                })
            })
            .map(|(i, _)| i)
            .collect();
        if idxs.is_empty() {
            continue;
        }
        for &i in &idxs {
            claimed[i] = true;
        }
        groups.push(Box::pin(async move {
            let mut done = Vec::with_capacity(idxs.len());
            for i in idxs {
                let (_, tool) = calls[i].mcp().unwrap_or_default();
                let t0 = now_ms();
                let out = call_mcp(client, tool, &calls[i].args).await;
                done.push((i, out, timed(t0)));
            }
            done
        }));
    }
    for (i, c) in calls.iter().enumerate().filter(|(i, _)| !claimed[*i]) {
        groups.push(Box::pin(async move {
            let t0 = now_ms();
            let out = dispatch(ctx, c, parent).await;
            vec![(i, out, timed(t0))]
        }));
    }

    let mut done: Vec<(usize, ToolOutcome, u64)> =
        future::join_all(groups).await.into_iter().flatten().collect();
    done.sort_by_key(|(i, _, _)| *i);

    done.into_iter()
        .map(|(i, out, ms)| {
            let c = &calls[i];
            for (ev, data) in &out.extra {
                ctx.out.emit_in(tag, ev, data.clone());
            }
            let mut res = tool_record(c, &out, ms, EVENT_OUTPUT_MAX);
            if let Some(o) = res.as_object_mut() {
                o.remove("args");
            }
            ctx.out.emit_in(tag, "tool_result", res);
            (out, ms)
        })
        .collect()
}

/// Execute a built-in tool (or reject an MCP call no session claimed).
async fn dispatch(ctx: &Ctx, call: &Call, parent: Option<Parent<'_>>) -> ToolOutcome {
    let args = &call.args;
    if let Some((server, tool)) = call.mcp() {
        let msg = if parent.is_some() && is_mutating(tool) {
            format!("'{}' looks like a write; subagents are read-only", call.name)
        } else {
            format!("server '{}' not connected", server)
        };
        return simple_outcome(server, false, msg, vec![]);
    }
    if parent.is_some_and(|p| !p.allows(&call.name)) {
        return fail(format!("'{}' is not available to subagents", call.name));
    }
    match call.name.as_str() {
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
            let claim = str_at(args, "claim");
            let evidence = str_at(args, "evidence");
            let app = match str_at(args, "app") {
                "" => "bloop",
                a => a,
            };
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
            let content = str_at(args, "content");
            if content.is_empty() {
                return fail("empty content");
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
                Err(e) => fail(e.to_string()),
            }
        }
        "forget" => {
            let query = str_at(args, "query");
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
                Err(e) => fail(e.to_string()),
            }
        }
        "update_context" => {
            let md = str_at(args, "markdown");
            if md.len() > db::FILE_MAX {
                return fail(format!("context too large (max {} chars)", db::FILE_MAX));
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
                Err(e) => fail(e.to_string()),
            }
        }
        "save_lesson" => {
            let lesson = str_at(args, "lesson").trim();
            if lesson.is_empty() {
                return fail("empty lesson");
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
                Err(e) => fail(e.to_string()),
            }
        }
        "load_tools" => {
            let mut found = search_tools(&ctx.all_tools, str_at(args, "query"));
            if parent.is_some() {
                found.retain(|t| !is_mutating(str_at(t, "name")));
            }
            let names: Vec<&str> = found.iter().map(|t| str_at(t, "call_as")).collect();
            let loaded = json!({"names": names});
            simple_outcome(
                "bloop",
                true,
                serde_json::to_string(&found).unwrap_or_else(|_| "[]".into()),
                vec![("tools_loaded".into(), loaded)],
            )
        }
        "generate_image" => {
            let prompt = str_at(args, "prompt");
            let size = match str_at(args, "size") {
                "" => "1024x1024",
                s => s,
            };
            if prompt.is_empty() {
                return fail("empty prompt");
            }
            let (bytes, ext) = match azure::generate_image(&ctx.cfg, prompt, size).await {
                Ok(x) => x,
                Err(e) => return fail(e.to_string()),
            };
            let key = format!("img/{}.{}", crate::crypto::uuid(), ext);
            match store_file(ctx, &key, bytes).await {
                Ok(url) => image_outcome(&url, prompt, json!({"url": url, "prompt": prompt}).to_string()),
                Err(e) => fail(e),
            }
        }
        "run_code" => {
            let code = str_at(args, "code");
            let language = match str_at(args, "language") {
                "" => "python",
                l => l,
            };
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
        name if WORKSPACE_TOOLS.contains(&name) => workspace_tool(ctx, name, args).await,
        "browse" => browse(ctx, args).await,
        "browser_handoff" => browser_handoff(ctx, args).await,
        // A subagent never reaches here: SUB_BUILTINS excludes delegate.
        "delegate" => run_subagent(ctx, call).await,
        other => fail(format!("unknown tool '{}'", other)),
    }
}

// ---------- model ----------

/// One model turn: stream from each model in order; if a stream fails before
/// producing anything, try a non-stream call on that model. Text goes to `on_text`.
async fn model_turn(
    ctx: &Ctx,
    messages: &[Value],
    tools: &[Value],
    extra: &Value,
    on_text: &dyn Fn(&str),
) -> std::result::Result<Reply, String> {
    let mut last_err = String::from("no models configured");
    for model in ctx.models.iter().filter(|m| !m.is_empty()) {
        let mut acc = Reply::default();
        let mut idx: BTreeMap<u64, TcAcc> = BTreeMap::new();
        let mut stream_failed = false;
        {
            let ds = azure::chat_deltas(
                ctx.cfg.clone(),
                model.clone(),
                messages.to_vec(),
                tools.to_vec(),
                extra.clone(),
            );
            futures::pin_mut!(ds);
            while let Some(item) = ds.next().await {
                match item {
                    Ok(v) => {
                        if let Some(text) = absorb_chunk(&mut acc, &mut idx, &v) {
                            on_text(&text);
                        }
                    }
                    Err(e) => {
                        console_log!("stream failed ({}): {}", model, e);
                        last_err = e.to_string();
                        stream_failed = true;
                        break;
                    }
                }
            }
        }
        if !stream_failed {
            acc.calls = idx.into_values().collect();
            return Ok(acc);
        }
        // Non-stream fallback (only if nothing was emitted for this attempt).
        if acc.content.is_empty() && idx.is_empty() {
            match azure::chat_once(&ctx.cfg, model, messages, tools, extra).await {
                Ok(v) => {
                    let msg = v.pointer("/choices/0/message").cloned().unwrap_or(Value::Null);
                    let r = reply_from_message(&msg);
                    for chunk in chunk_str(&r.content, 30) {
                        on_text(&chunk);
                    }
                    return Ok(r);
                }
                Err(e) => {
                    console_log!("non-stream failed ({}): {}", model, e);
                    last_err = e.to_string();
                }
            }
        }
    }
    Err(last_err)
}

// ---------- subagents ----------

fn subagent_tools(ctx: &Ctx, me: Parent<'_>) -> Vec<Value> {
    let mut tools: Vec<Value> = builtin_tools()
        .into_iter()
        .filter(|t| me.allows(tool_name(t)))
        .collect();
    for (server, list) in &ctx.all_tools {
        tools.extend(
            list.iter()
                .filter(|t| !is_mutating(str_at(t, "name")))
                .map(|t| mcp_tool_to_openai(server, t)),
        );
    }
    tools
}

/// Lazily open a subagent's own MCP sessions for the servers `calls` touch.
async fn connect_needed(clients: &mut [McpClient], ready: &mut [bool], calls: &[Call]) {
    let pending = clients
        .iter_mut()
        .zip(ready.iter_mut())
        .filter(|(c, r)| !**r && calls.iter().any(|x| x.app() == c.name))
        .map(|(c, r)| async move {
            *r = true;
            if let Err(e) = with_timeout(c.initialize(), CONNECT_TIMEOUT_MS).await {
                console_log!("subagent mcp {} init failed: {}", c.name, e);
            }
        });
    future::join_all(pending).await;
}

/// Run a read-only research subagent for a `delegate` call. Its frames stream
/// live (tagged with `parent`); the parent model sees only the summary.
/// Boxed because it recurses through `run_batch` → `dispatch`.
fn run_subagent<'a>(ctx: &'a Ctx, call: &'a Call) -> LocalBoxFuture<'a, ToolOutcome> {
    Box::pin(async move {
        let id = call.id.as_str();
        let task = str_at(&call.args, "task").trim();
        if task.is_empty() {
            return fail("task required");
        }
        let build = str_at(&call.args, "kind") == "build";
        let kind = if build { "build" } else { "research" };
        let me = Parent { id, build };
        ctx.out.emit("subagent_start", json!({"id": id, "task": task, "kind": kind}));

        let tools = subagent_tools(ctx, me);
        let mut prompt = task.to_string();
        let hint = str_at(&call.args, "tools_hint").trim();
        if !hint.is_empty() {
            prompt.push_str("\n\nHint — likely useful tools: ");
            prompt.push_str(hint);
        }
        let mut messages = vec![
            json!({"role": "system", "content": if build { BUILD_PROMPT } else { SUBAGENT_PROMPT }}),
            json!({"role": "user", "content": prompt}),
        ];
        let mut clients: Vec<McpClient> = ctx
            .servers
            .iter()
            .map(|s| McpClient::new(&s.name, &s.url, &s.token))
            .collect();
        let mut ready = vec![false; clients.len()];
        let mut records = Vec::new();
        let mut parts = Vec::new();
        let mut sources = Vec::new();
        let on_text = |t: &str| ctx.out.send("subagent_delta", json!({"id": id, "text": t}));

        let mut result = None;
        let max_iters = if build { BUILD_MAX_ITERS } else { SUB_MAX_ITERS };
        for iter in 0..max_iters {
            let reply = match model_turn(ctx, &messages, &tools, &Value::Null, &on_text).await {
                Ok(r) => r,
                Err(e) => {
                    result = Some(Err(e));
                    break;
                }
            };
            if reply.calls.is_empty() {
                result = Some(Ok(reply.content));
                break;
            }
            let calls = Call::from_reply(&reply, |i| format!("{}_{}_{}", id, iter, i));
            messages.push(assistant_tool_message(&reply.content, &calls));
            connect_needed(&mut clients, &mut ready, &calls).await;
            let done = run_batch(ctx, &mut clients, &calls, Some(me)).await;
            for (c, (out, ms)) in calls.iter().zip(done) {
                records.push(tool_record(c, &out, ms, EVENT_OUTPUT_MAX));
                merge_sources(&mut sources, &call_sources(c, &out));
                messages.push(tool_message(c, &out));
                parts.extend(out.parts);
            }
        }
        let result = match result {
            Some(r) => r,
            None => {
                // Out of iterations: one last tool-free turn to write up findings.
                messages.push(json!({
                    "role": "user",
                    "content": "Step limit reached. Summarize your findings so far now."
                }));
                model_turn(ctx, &messages, &[], &Value::Null, &on_text)
                    .await
                    .map(|r| r.content)
            }
        };
        let (ok, summary) = match result {
            Ok(s) if !s.trim().is_empty() => (true, s),
            Ok(_) => (false, "subagent returned no findings".to_string()),
            Err(e) => (false, format!("subagent failed: {}", e)),
        };
        let summary = truncate(&summary, MODEL_OUTPUT_MAX);
        ctx.out.emit(
            "subagent_end",
            json!({"id": id, "ok": ok, "summary": summary}),
        );

        let mut o = simple_outcome("bloop", ok, summary.clone(), vec![]);
        o.parts.push(json!({
            "kind": "subagent",
            "id": id,
            "task": task,
            "subagent_kind": kind,
            "ok": ok,
            "summary": summary,
            "tools": records,
        }));
        o.parts.extend(parts);
        o.sources = sources;
        o
    })
}

// ---------- run ----------

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
    pub mode: Mode,
}

/// Prior conversation state loaded before the first model call.
#[derive(Default)]
struct History {
    summary: String,
    summarized: i64,
    messages: Vec<Value>,
}

async fn load_history(o: &RunOpts) -> History {
    let mut h = History::default();
    if !o.persist {
        return h;
    }
    let (conv, total) = futures::join!(
        db::get_conversation(&o.env, &o.user_id, &o.conversation_id),
        db::message_count(&o.env, &o.conversation_id),
    );
    let Ok(Some(conv)) = conv else {
        return h;
    };
    h.summary = str_at(&conv, "summary").to_string();
    h.summarized = conv.get("summarized_count").and_then(|v| v.as_i64()).unwrap_or(0);
    let window_start = (total.unwrap_or(0) - HISTORY_WINDOW).max(0);
    if let Ok(page) = db::messages_page(&o.env, &o.conversation_id, HISTORY_WINDOW, window_start).await {
        h.messages = replay_messages(&page);
    }
    h
}

/// Memories for the system prompt (max 30, 200 chars each).
async fn load_memories(env: &Env, user_id: &str) -> Vec<String> {
    db::list_memories(env, user_id)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()).map(|s| truncate(s, 200)))
        .take(30)
        .collect()
}

#[derive(Default)]
struct Connected {
    clients: Vec<McpClient>,
    servers: Vec<McpServerCfg>,
    all_tools: Vec<(String, Vec<Value>)>,
}

/// Connect global env servers + this user's servers concurrently, each with a
/// timeout, emitting a `server` frame as each one settles.
async fn connect_servers(o: &RunOpts, out: &Emitter) -> Connected {
    let mut cfgs = o.cfg.servers.clone();
    if let Ok(rows) = db::list_user_servers(&o.env, &o.user_id).await {
        for r in rows {
            let (name, url) = (str_at(&r, "name"), str_at(&r, "url"));
            if !name.is_empty() && !url.is_empty() {
                cfgs.push(McpServerCfg {
                    name: sanitize_name(name),
                    url: url.to_string(),
                    token: str_at(&r, "token").to_string(),
                });
            }
        }
    }
    let mut clients: Vec<McpClient> = cfgs
        .iter()
        .map(|s| McpClient::new(&s.name, &s.url, &s.token))
        .collect();
    let results = future::join_all(clients.iter_mut().map(|c| async move {
        let res = with_timeout(
            async {
                c.initialize().await?;
                c.list_tools().await
            },
            CONNECT_TIMEOUT_MS,
        )
        .await;
        match &res {
            Ok(tools) => {
                console_log!("mcp {} connected: {} tools", c.name, tools.len());
                out.emit("server", json!({"name": c.name, "state": "ok", "tools": tools.len()}));
            }
            Err(e) => {
                console_log!("mcp {} connect failed: {}", c.name, e);
                out.emit("server", json!({"name": c.name, "state": "error", "tools": 0}));
            }
        }
        res.ok()
    }))
    .await;

    let mut conn = Connected::default();
    for ((client, cfg), tools) in clients.into_iter().zip(cfgs).zip(results) {
        if let Some(tools) = tools {
            conn.all_tools.push((client.name.clone(), tools));
            conn.clients.push(client);
            conn.servers.push(cfg);
        }
    }
    conn
}

/// Persist the assistant message, title and timestamp, then refresh the rolling
/// summary if enough messages have fallen out of the live window (done at the
/// end of the run so it never delays the first token).
async fn persist_assistant(o: &RunOpts, history: &History, parts: &[Value], final_text: &str) {
    let content = if final_text.is_empty() {
        parts
            .iter()
            .filter(|p| str_at(p, "kind") == "text")
            .map(|p| str_at(p, "text"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        final_text.to_string()
    };
    let env = &o.env;
    let _ = db::add_message(env, &o.conversation_id, "assistant", &content, &json!(parts)).await;
    let title: String = o.message.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
    let summarize = async {
        let total = db::message_count(env, &o.conversation_id).await.unwrap_or(0);
        let window_start = (total - HISTORY_WINDOW).max(0);
        if total - history.summarized > SUMMARY_LAG && window_start > history.summarized {
            regen_summary(env, &o.cfg, &o.conversation_id, &history.summary, history.summarized, window_start).await;
        }
    };
    futures::join!(
        async {
            if !title.is_empty() {
                db::auto_title(env, &o.conversation_id, &title).await;
            }
        },
        db::touch_conversation(env, &o.conversation_id),
        summarize,
    );
}

/// The agentic loop as a stream of SSE frame bytes. All work happens in
/// `drive`, which pushes frames into a channel the moment they occur.
pub fn run(o: RunOpts) -> impl Stream<Item = Result<Vec<u8>>> {
    let (tx, rx) = mpsc::unbounded::<Frame>();
    let driver = drive(o, tx)
        .into_stream()
        .filter_map(|()| future::ready(None::<Frame>));
    futures::stream::select(rx, driver).map(|(ev, data)| Ok(sse(&ev, &data)))
}

async fn drive(o: RunOpts, tx: mpsc::UnboundedSender<Frame>) {
    ledger::begin_run(&o.run_id);
    let out = Emitter { run_id: o.run_id.clone(), tx };
    out.emit("mode", json!({"mode": o.mode.as_str()}));

    // --- Setup, all concurrent. The user message is persisted after history
    // is read so it isn't replayed twice. ---
    let (history, memories, files, conn) = futures::join!(
        async {
            let h = load_history(&o).await;
            if o.persist {
                let parts = json!([{"kind": "text", "text": o.message}]);
                let _ = db::add_message(&o.env, &o.conversation_id, "user", &o.message, &parts).await;
            }
            h
        },
        load_memories(&o.env, &o.user_id),
        load_user_files(&o.env, &o.user_id),
        connect_servers(&o, &out),
    );

    let mut clients = conn.clients;
    let mut tools = builtin_tools();
    for (server, list) in &conn.all_tools {
        tools.extend(list.iter().map(|t| mcp_tool_to_openai(server, t)));
    }
    let connected: Vec<String> = conn.all_tools.iter().map(|(n, _)| n.clone()).collect();
    let mut models = vec![o.model.clone()];
    if o.cfg.model_fallback != o.model && crate::config::model_allowed(&o.cfg.model_fallback) {
        models.push(o.cfg.model_fallback.clone());
    }
    let ctx = Ctx {
        env: o.env.clone(),
        cfg: o.cfg.clone(),
        user_id: o.user_id.clone(),
        run_id: o.run_id.clone(),
        models,
        all_tools: conn.all_tools,
        servers: conn.servers,
        workspace: if o.persist { o.conversation_id.clone() } else { o.run_id.clone() },
        browser: futures::lock::Mutex::new(()),
        out,
    };

    let mut messages = vec![json!({
        "role": "system",
        "content": system_prompt(&connected, &memories, &history.summary, &files, o.mode)
    })];
    messages.extend(history.messages.iter().cloned());
    messages.push(json!({"role": "user", "content": o.message}));

    let on_text = |t: &str| ctx.out.send("delta", json!({"text": t}));
    let mut parts: Vec<Value> = Vec::new();
    let mut final_text = String::new();
    let mut sources: Vec<Source> = Vec::new();
    let mut hit_limit = true;

    for iter in 1..=o.mode.max_iters() {
        // Think mode: force a plan on the first turn (retried without on 400).
        let extra = if iter == 1 && o.mode == Mode::Think {
            json!({"tool_choice": {"type": "function", "function": {"name": "update_plan"}}})
        } else {
            Value::Null
        };
        let reply = match model_turn(&ctx, &messages, &tools, &extra, &on_text).await {
            Ok(r) => r,
            Err(e) => {
                ctx.out.emit("error", json!({"message": format!("model call failed: {}", e)}));
                hit_limit = false;
                break;
            }
        };
        if !reply.content.is_empty() {
            parts.push(json!({"kind": "text", "text": reply.content}));
            final_text = reply.content.clone();
        }
        // No tool calls → final answer already streamed as deltas.
        if reply.calls.is_empty() {
            hit_limit = false;
            break;
        }

        let calls = Call::from_reply(&reply, |i| format!("call_{}", i));
        messages.push(assistant_tool_message(&reply.content, &calls));
        let done = run_batch(&ctx, &mut clients, &calls, None).await;

        // Tool parts of a batch stay contiguous (replay groups them); extra parts follow.
        let mut extra_parts = Vec::new();
        let mut sources_changed = false;
        for (c, (out, ms)) in calls.iter().zip(done) {
            let mut part = tool_record(c, &out, ms, MODEL_OUTPUT_MAX);
            part["kind"] = json!("tool");
            parts.push(part);
            if o.mode == Mode::Deep {
                sources_changed |= merge_sources(&mut sources, &call_sources(c, &out));
            }
            messages.push(tool_message(c, &out));
            extra_parts.extend(out.parts);
        }
        parts.extend(extra_parts);
        if sources_changed {
            ctx.out.emit("sources", json!({"items": sources_json(&sources)}));
        }
    }

    if hit_limit {
        ctx.out.send("delta", json!({"text": "\n\n(iteration limit reached)"}));
    }
    if !sources.is_empty() {
        parts.push(json!({"kind": "sources", "items": sources_json(&sources)}));
    }
    if o.persist {
        persist_assistant(&o, &history, &parts, &final_text).await;
    }
    ctx.out.send("done", json!({"conversation_id": o.conversation_id}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_urls_without_trailing_punctuation() {
        let text = "See https://a.com/x. Also [doc](http://b.org/y?z=1), \"https://c.io/\" and http:// nope, httpfoo";
        assert_eq!(
            extract_urls(text),
            vec!["https://a.com/x", "http://b.org/y?z=1", "https://c.io/"]
        );
        assert!(extract_urls("no links here").is_empty());
    }

    #[test]
    fn merges_sources_dedupes_fills_titles_and_caps() {
        let mut list: Vec<Source> = vec![];
        assert!(merge_sources(&mut list, &[("https://a.com/".into(), None)]));
        assert!(!merge_sources(&mut list, &[("https://a.com".into(), None)]));
        assert!(merge_sources(&mut list, &[("https://a.com".into(), Some("A".into()))]));
        assert_eq!(list, vec![("https://a.com/".to_string(), Some("A".to_string()))]);
        let many: Vec<Source> = (0..30).map(|i| (format!("https://s{}.com", i), None)).collect();
        merge_sources(&mut list, &many);
        assert_eq!(list.len(), SOURCES_MAX);
        assert_eq!(sources_json(&list[..1]), json!([{"url": "https://a.com/", "title": "A"}]));
    }

    #[test]
    fn mutating_filter() {
        for t in ["create_issue", "UpdatePage", "send_message", "add_labels", "merge_pull_request"] {
            assert!(is_mutating(t), "{t}");
        }
        for t in ["get_issue", "search_code", "read_wiki_contents", "list_repos", "query-docs"] {
            assert!(!is_mutating(t), "{t}");
        }
    }

    #[test]
    fn replay_ignores_subagent_and_sources_parts() {
        let parts = json!([
            {"kind": "text", "text": "looking"},
            {"kind": "tool", "id": "c1", "name": "delegate", "args": {"task": "x"}, "output": "found"},
            {"kind": "tool", "id": "c2", "name": "browse", "args": {"url": "u"}, "output": "page"},
            {"kind": "subagent", "id": "c1", "task": "x", "ok": true, "summary": "found", "tools": []},
            {"kind": "sources", "items": [{"url": "https://a.com"}]},
            {"kind": "text", "text": "done"}
        ]);
        let stored = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "done", "parts_json": parts.to_string()}),
        ];
        let out = replay_messages(&stored);
        assert_eq!(out.len(), 5);
        assert_eq!(out[1]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(out[1]["content"], "looking");
        assert_eq!(out[2]["tool_call_id"], "c1");
        assert_eq!(out[3]["tool_call_id"], "c2");
        assert_eq!(out[4], json!({"role": "assistant", "content": "done"}));
    }

    #[test]
    fn browse_output_keeps_links_within_budget() {
        let v = json!({
            "title": "T", "url": "https://x.com",
            "markdown": "m".repeat(10_000),
            "links": [{"text": "one", "href": "https://x.com/1"}, {"text": "skip", "href": ""}]
        });
        let s = browse_output(&v, 1000);
        assert!(s.len() <= 1000 + "…".len());
        assert!(s.starts_with("# T\nURL: https://x.com\n"));
        assert!(s.contains("- [one](https://x.com/1)"));
        assert!(!s.contains("skip"));
    }

    #[test]
    fn modes_parse() {
        assert_eq!(Mode::parse("deep"), Some(Mode::Deep));
        assert_eq!(Mode::parse("think").map(Mode::max_iters), Some(MAX_ITERS));
        assert_eq!(Mode::Deep.max_iters(), DEEP_MAX_ITERS);
        assert_eq!(Mode::parse("turbo"), None);
    }

    #[test]
    fn image_ext_sniffs_webp() {
        assert_eq!(image_ext("", b"RIFF\0\0\0\0WEBPVP8 "), "webp");
        assert_eq!(image_ext("", b"\x89PNG\r\n\x1a\n...."), "png");
        assert_eq!(image_ext("png", b"RIFF\0\0\0\0WEBPVP8 "), "png");
    }
}
