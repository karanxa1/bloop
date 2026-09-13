//! Built-in tool registry: user-facing labels, categories and per-user toggles.
use crate::db;
use serde_json::{json, Value};
use worker::*;

pub struct ToolInfo {
    pub name: &'static str,
    pub label: &'static str,
    /// core | web | code | media | memory | agents
    pub category: &'static str,
    pub description: &'static str,
    /// Always on (the agent's proof discipline depends on them).
    pub locked: bool,
}

const fn tool(
    name: &'static str,
    label: &'static str,
    category: &'static str,
    description: &'static str,
    locked: bool,
) -> ToolInfo {
    ToolInfo { name, label, category, description, locked }
}

pub const REGISTRY: &[ToolInfo] = &[
    tool("update_plan", "Plan", "core", "Keeps a live step-by-step plan for multi-step work.", true),
    tool("attest", "Attest", "core", "Records hash-chained proof after verifying an action.", true),
    tool("load_tools", "Tool search", "core", "Finds the right app tool by keyword.", false),
    tool("browse", "Browse", "web", "Reads web pages or takes screenshots in a headless browser.", false),
    tool("browser_handoff", "Browser handoff", "web", "Hands you a live browser for logins and captchas.", false),
    tool("run_code", "Run code", "code", "Runs short Python or JavaScript snippets in a sandbox.", false),
    tool("workspace_write", "Write files", "code", "Creates or overwrites files in the chat's code workspace.", false),
    tool("workspace_read", "Read files", "code", "Reads files from the code workspace.", false),
    tool("workspace_list", "List files", "code", "Lists files in the code workspace.", false),
    tool("workspace_delete", "Delete files", "code", "Deletes files from the code workspace.", false),
    tool("workspace_exec", "Run commands", "code", "Runs shell commands (installs, builds, tests) in the workspace.", false),
    tool("generate_image", "Generate image", "media", "Creates images from a text prompt.", false),
    tool("edit_image", "Edit image", "media", "Edits an existing image with a text prompt.", false),
    tool("remember", "Remember", "memory", "Saves durable facts and preferences about you.", false),
    tool("forget", "Forget", "memory", "Deletes stored memories.", false),
    tool("update_context", "Update context", "memory", "Edits your standing context file.", false),
    tool("save_lesson", "Save lesson", "memory", "Records lessons learned from failures.", false),
    tool("use_skill", "Use skill", "memory", "Loads a saved skill's procedure.", false),
    tool("create_skill", "Create skill", "memory", "Saves a reusable workflow as a skill.", false),
    tool("update_skill", "Update skill", "memory", "Improves an existing skill.", false),
    tool("delegate", "Subagents", "agents", "Runs research or build subagents in parallel.", false),
];

pub fn info(name: &str) -> Option<&'static ToolInfo> {
    REGISTRY.iter().find(|t| t.name == name)
}

pub fn is_enabled(name: &str, disabled: &[String]) -> bool {
    info(name).is_some_and(|t| t.locked) || !disabled.iter().any(|d| d == name)
}

/// Keep only known, unlocked tool names — sorted and deduped.
pub fn normalize_disabled(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = names
        .into_iter()
        .filter(|n| info(n).is_some_and(|t| !t.locked))
        .collect();
    out.sort();
    out.dedup();
    out
}

fn entry_json(t: &ToolInfo, disabled: &[String]) -> Value {
    json!({
        "name": t.name,
        "label": t.label,
        "description": t.description,
        "category": t.category,
        "enabled": is_enabled(t.name, disabled),
        "locked": t.locked,
    })
}

fn err(msg: &str, status: u16) -> Result<Response> {
    Ok(Response::from_json(&json!({"error": msg}))?.with_status(status))
}

/// `/api/tools[...]` — `rest` is the path after `/api/tools`.
pub async fn route(mut req: Request, env: &Env, user_id: &str, rest: &str, method: Method) -> Result<Response> {
    let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    match (method, segs.as_slice()) {
        (Method::Get, []) => {
            let disabled = db::disabled_tools(env, user_id).await?;
            Response::from_json(&REGISTRY.iter().map(|t| entry_json(t, &disabled)).collect::<Vec<_>>())
        }
        (Method::Put, [name]) => {
            let Some(t) = info(name) else {
                return err("unknown tool", 404);
            };
            let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
            let Some(enabled) = body.get("enabled").and_then(|v| v.as_bool()) else {
                return err("enabled (boolean) required", 400);
            };
            if t.locked && !enabled {
                return err("this tool is always on", 400);
            }
            let mut disabled = db::disabled_tools(env, user_id).await?;
            disabled.retain(|d| d != t.name);
            if !enabled {
                disabled.push(t.name.to_string());
            }
            let disabled = normalize_disabled(disabled);
            db::set_disabled_tools(env, user_id, &disabled).await?;
            Response::from_json(&entry_json(t, &disabled))
        }
        _ => err("not found", 404),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_tools_stay_enabled() {
        let disabled = vec!["attest".to_string(), "browse".to_string()];
        assert!(is_enabled("attest", &disabled));
        assert!(!is_enabled("browse", &disabled));
        assert!(is_enabled("run_code", &disabled));
    }

    #[test]
    fn normalize_drops_locked_unknown_and_dupes() {
        let got = normalize_disabled(
            ["browse", "update_plan", "nope", "browse", "delegate"].map(String::from),
        );
        assert_eq!(got, vec!["browse".to_string(), "delegate".to_string()]);
    }

    #[test]
    fn registry_names_are_unique() {
        for t in REGISTRY {
            assert_eq!(REGISTRY.iter().filter(|o| o.name == t.name).count(), 1, "{}", t.name);
        }
    }
}
