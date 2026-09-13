//! Skills: saved, reusable procedures (Claude-skills style progressive
//! disclosure). The system prompt lists only `name — description`; the agent
//! loads a body on demand with `use_skill`.
use crate::db;
use serde_json::{json, Value};
use worker::*;

pub const NAME_MAX: usize = 64;
pub const DESCRIPTION_MAX: usize = 300;
pub const BODY_MAX: usize = 20_000;
/// Skills listed in the system prompt.
pub const PROMPT_LINES_MAX: usize = 40;
/// Body chars returned to the model by use_skill.
pub const USE_BODY_MAX: usize = 8_000;

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Kebab-case: lowercase a-z/0-9 segments joined by single hyphens, 2..=NAME_MAX chars.
pub fn validate_name(name: &str) -> std::result::Result<(), String> {
    let ok = (2..=NAME_MAX).contains(&name.len())
        && name
            .split('-')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid skill name '{}': use kebab-case (a-z, 0-9, single hyphens), 2-{} chars, e.g. weekly-repo-digest",
            clip(name, 80),
            NAME_MAX
        ))
    }
}

pub fn validate(name: &str, description: &str, body: &str) -> std::result::Result<(), String> {
    validate_name(name)?;
    if description.trim().is_empty() || description.len() > DESCRIPTION_MAX {
        return Err(format!("description must be 1-{} chars", DESCRIPTION_MAX));
    }
    if body.trim().is_empty() || body.len() > BODY_MAX {
        return Err(format!("body must be 1-{} chars", BODY_MAX));
    }
    Ok(())
}

/// D1 stores `enabled` as 0/1.
pub fn is_enabled(row: &Value) -> bool {
    match row.get("enabled") {
        Some(Value::Bool(b)) => *b,
        Some(v) => v.as_f64().map_or(true, |n| n != 0.0),
        None => true,
    }
}

pub fn skill_json(row: &Value) -> Value {
    let mut v = row.clone();
    v["enabled"] = json!(is_enabled(row));
    v
}

/// `## skills` system-prompt section listing enabled skills (empty when none).
pub fn prompt_section(rows: &[Value]) -> String {
    let lines: Vec<String> = rows
        .iter()
        .filter(|r| is_enabled(r))
        .take(PROMPT_LINES_MAX)
        .map(|r| {
            let desc = str_at(r, "description").replace('\n', " ");
            format!("- {} — {}", str_at(r, "name"), clip(desc.trim(), 200))
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\n## skills (saved procedures — when a request matches, call use_skill(name) first)\n{}",
        lines.join("\n")
    )
}

// ---------- catalog ----------

pub struct CatalogSkill {
    pub slug: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    pub body: &'static str,
}

pub const CATALOG: &[CatalogSkill] = &[
    CatalogSkill {
        slug: "github-issue-triage",
        name: "GitHub issue triage",
        category: "engineering",
        description: "Triage open GitHub issues in a repo: dedupe, label, prioritize and summarize what needs attention.",
        body: r#"# GitHub issue triage

Goal: turn a repo's open issue list into a prioritized, labeled, deduplicated queue.

1. call update_plan with the steps below.
2. Discover exact tool names: load_tools("github issues list search label comment"). Use only tools it returns.
3. List open issues (newest first, up to 50). For each, read title, body, labels, comment count, age, linked PRs.
4. Classify each issue as bug | feature | question | docs | chore, and severity P0 (outage/data loss/security) | P1 (broken core flow) | P2 (degraded) | P3 (nice to have).
5. Find duplicates: same error text, same component + symptom, or explicit "same as #N". Pick the oldest as canonical.
6. Before ANY write, show the user a table: #, title, type, priority, proposed labels, duplicate-of, one-line reason. Ask for confirmation unless they already said "apply".
7. On confirmation: apply labels, and comment on duplicates "Tracking in #N" (close only if the user asked). After each write, read the issue back and call attest with the issue URL as evidence.
8. Report: counts by priority, the top 5 to fix next with why, stale issues (>90 days, no activity), and the attested changes."#,
    },
    CatalogSkill {
        slug: "pr-review",
        name: "Pull request review",
        category: "engineering",
        description: "Review a GitHub pull request for correctness, security and tests, and post a structured review.",
        body: r#"# Pull request review

Input: a PR URL or owner/repo#number.

1. update_plan. Then load_tools("github pull request diff files review comment") for exact tool names.
2. Read the PR: title, description, base/head, changed files and the full diff. For large PRs, read the files with the most changed lines first.
3. If the change touches an unfamiliar library, check its docs with context7 or deepwiki instead of guessing.
4. Review in this order, citing file:line for every point:
   - Correctness: logic errors, edge cases (empty, null, unicode, concurrency), error handling, off-by-one.
   - Security: injection, authz checks, secrets in code, unsafe deserialization, SSRF.
   - Tests: are the new paths tested? Missing negative cases?
   - Maintainability: naming, duplication, dead code — only if it matters.
5. Optionally verify a suspicion by reproducing it with run_code or in the workspace (workspace_write + workspace_exec).
6. Draft the review: summary verdict (approve / request changes / comment), then Blocking, Should fix, Nits. Show it to the user first unless told to post.
7. Post with the review/comment tool, read it back, attest with the review URL."#,
    },
    CatalogSkill {
        slug: "weekly-repo-digest",
        name: "Weekly repo digest",
        category: "engineering",
        description: "Summarize the last 7 days of a GitHub repo: merged PRs, new issues, releases, contributors and risks.",
        body: r#"# Weekly repo digest

Input: owner/repo (ask if missing) and optional period (default: last 7 days).

1. update_plan. load_tools("github commits pull requests issues releases") for exact tool names.
2. Batch these reads in ONE turn (they run in parallel): merged PRs in the period, issues opened and closed in the period, commits on the default branch, latest releases.
3. Group merged PRs by theme (features, fixes, infra, docs) using titles and labels; link each one.
4. Compute with run_code: counts (PRs merged, issues opened/closed, net open change), top contributors by merged PRs, median PR time-to-merge.
5. Flag risks: P0/P1 or "bug" issues opened this week still open, PRs open >14 days with no review, failing checks on the default branch if visible.
6. Write the digest in markdown: TL;DR (3 bullets) · Shipped · Numbers table · Needs attention · Links. Keep it under 350 words.
7. If the user asks to send it somewhere (Slack, email, an issue), use that app's tool, read back, attest."#,
    },
    CatalogSkill {
        slug: "deep-research-report",
        name: "Deep research report",
        category: "research",
        description: "Research a question across multiple independent sources in parallel and write a cited report.",
        body: r#"# Deep research report

1. Restate the question in one line and list 3-5 sub-questions that together answer it. Put them in update_plan.
2. Launch one delegate(kind:"research") per independent sub-question IN THE SAME TURN so they run in parallel. Each task must be self-contained: the sub-question, what evidence counts, and "return findings with source URLs".
3. While they run nothing else is needed. When results return, check coverage: every key claim needs >=2 independent sources (not two pages quoting each other). For technical topics prefer primary docs via context7 / deepwiki / cf-docs; use browse sparingly for specific pages.
4. Resolve conflicts explicitly: say which source is more authoritative and why (primary > secondary, newer > older, official > blog).
5. Use run_code for any numbers you combine (growth rates, averages, conversions) — never do arithmetic in your head.
6. Write the report: Answer (2-3 sentences) · Key findings (bullets, each with inline [source](url)) · Evidence table if comparing options · Uncertainties / what would change the conclusion · Sources list.
7. If the user wants a file, workspace_write it as reports/<slug>.md and give the path."#,
    },
    CatalogSkill {
        slug: "build-web-app",
        name: "Build a web app",
        category: "build",
        description: "Plan, build in parallel, integrate and test a small web app in the conversation workspace.",
        body: r#"# Build a web app

1. Clarify only what blocks progress (purpose, must-have features); otherwise pick sensible defaults: Node 20, a Vite + vanilla TS or React frontend in web/, a small Hono or Express API in api/ if a backend is needed, SQLite/JSON file storage for demos.
2. update_plan with: scaffold, api, web, integrate, test, report.
3. workspace_list to see what already exists — never clobber user files without saying so.
4. Write a short SPEC.md with workspace_write: features, API routes with request/response shapes, file layout. This is the contract the subagents follow.
5. Launch builders IN ONE TURN so they run in parallel, each owning one directory:
   - delegate(kind:"build", task:"Implement api/ per SPEC.md ... add tests with node --test ... run them until passing")
   - delegate(kind:"build", task:"Implement web/ per SPEC.md ... call the API at /api ... make `npm run build` pass")
   Put the full relevant SPEC content in each task — subagents do not see this chat.
6. Integrate yourself: read both summaries, fix contract mismatches, then workspace_exec the full build and tests (e.g. `cd api && npm install && npm test`, `cd web && npm install && npm run build`). Scripts run as `bash x.sh` / `node x.js` (exec bits are not kept).
7. Iterate on failures: read the error tail, fix the specific file, rerun. Do not stop at "should work".
8. Report: what was built, how to run it, test results (verbatim summary line), files changed, and known gaps."#,
    },
    CatalogSkill {
        slug: "data-analysis-with-code",
        name: "Data analysis with code",
        category: "data",
        description: "Load a dataset, clean it, compute real statistics with code and explain the findings with tables.",
        body: r#"# Data analysis with code

1. Get the data: a URL (browse or workspace_exec `curl -sL ... -o data/raw.csv`), an app tool export, or pasted text (workspace_write data/raw.csv).
2. Profile first with workspace_exec running python: `pip install -q pandas` then a script (workspace_write analysis/profile.py, run `python analysis/profile.py`) printing shape, dtypes, null counts, sample rows, basic describe(). For tiny inputs run_code is fine.
3. State the questions you will answer, in update_plan.
4. Clean explicitly and log each step: parse dates, normalize units/currency, drop or flag duplicates, handle nulls (say which rule you used and how many rows it affected).
5. Compute answers in code only — every number you report must come from printed output. Save scripts under analysis/ so the work is reproducible.
6. Sanity-check: totals add up, percentages sum to ~100, no impossible values; re-run after fixes.
7. Report: headline findings (with the numbers), a small markdown table per question, caveats (sample size, missing data, correlation vs causation), and the script paths to reproduce."#,
    },
    CatalogSkill {
        slug: "landing-page-copy",
        name: "Landing page copy",
        category: "marketing",
        description: "Write conversion-focused landing page copy grounded in the product and its real competitors.",
        body: r#"# Landing page copy

1. Gather inputs: product, target customer, the one action the page should drive. If a product URL exists, browse it (markdown mode) once; check the user's context file for tone and brand rules.
2. Research positioning quickly: delegate(kind:"research") to find 3 competitors' headlines, pricing anchors and top objections (with URLs). Do not copy their wording.
3. Define in one line each: the customer's pain, the promised outcome, why believe it (proof), and the main objection.
4. Write the page in markdown:
   - Hero: headline (<=10 words, outcome-first), subhead (<=25 words, who + how), primary CTA, secondary CTA.
   - Social proof strip (placeholders if none are given — mark them clearly).
   - 3 benefit blocks (title + 2 sentences, benefits not features).
   - How it works in 3 steps.
   - Objection-handling FAQ (4-6 Q&As).
   - Final CTA section.
5. Provide 3 alternative hero headlines with different angles (speed, cost, confidence).
6. Self-edit: cut filler words, remove unverifiable superlatives, keep reading level ~8th grade.
7. If asked, workspace_write it to copy/landing.md or build it as a page with the build-web-app skill."#,
    },
    CatalogSkill {
        slug: "image-brand-kit",
        name: "Image brand kit",
        category: "design",
        description: "Create a consistent set of brand images — logo mark, hero, social card and icons — from one style brief.",
        body: r#"# Image brand kit

1. Write a style brief first and show it: brand name, personality (3 adjectives), palette (3-5 hex colors), style (flat vector / 3D / photographic / illustration), composition rules, what to avoid. Reuse the user's context file if it has brand notes.
2. update_plan with one step per asset.
3. Generate the anchor asset first with generate_image: the logo mark, square 1024x1024, simple shape, the palette only, plain background, no text unless asked (image models misspell text).
4. Derive the rest from the anchor so they stay consistent — prefer edit_image on the anchor URL over fresh generations:
   - hero banner 1536x1024 (brand motif in a scene, space for a headline on one side)
   - social card 1536x1024 (bold motif, high contrast)
   - 3 feature icons 1024x1024 (same stroke weight and palette)
   Every prompt repeats the palette hex codes and style words from the brief.
5. Review each result against the brief; regenerate or edit anything off-palette or off-style (say what you changed).
6. Report a table: asset, URL, size, prompt used — so the user can regenerate variants later."#,
    },
];

// ---------- REST ----------

fn err(msg: &str, status: u16) -> Result<Response> {
    Ok(Response::from_json(&json!({"error": msg}))?.with_status(status))
}

fn db_err(e: Error) -> Result<Response> {
    let s = e.to_string();
    if s.contains("UNIQUE") {
        err("a skill with that name already exists", 409)
    } else {
        err(&s, 500)
    }
}

fn created(res: Result<Value>) -> Result<Response> {
    match res {
        Ok(v) => Response::from_json(&skill_json(&v)),
        Err(e) => db_err(e),
    }
}

/// `/api/skills[...]` — `rest` is the path after `/api/skills`.
pub async fn route(mut req: Request, env: &Env, user_id: &str, rest: &str, method: Method) -> Result<Response> {
    let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    match (method, segs.as_slice()) {
        (Method::Get, []) => {
            let rows = db::list_skills(env, user_id).await?;
            Response::from_json(&rows.iter().map(skill_json).collect::<Vec<_>>())
        }
        (Method::Post, []) => {
            let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
            let (name, description, text) = (
                str_at(&body, "name").trim(),
                str_at(&body, "description").trim(),
                str_at(&body, "body"),
            );
            if let Err(e) = validate(name, description, text) {
                return err(&e, 400);
            }
            let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            created(db::create_skill(env, user_id, name, description, text, "user", enabled).await)
        }
        (Method::Get, ["catalog"]) => {
            let rows = db::list_skills(env, user_id).await?;
            let items: Vec<Value> = CATALOG
                .iter()
                .map(|s| {
                    json!({
                        "slug": s.slug,
                        "name": s.name,
                        "description": s.description,
                        "body": s.body,
                        "category": s.category,
                        "installed": rows.iter().any(|r| str_at(r, "name") == s.slug),
                    })
                })
                .collect();
            Response::from_json(&items)
        }
        (Method::Post, ["catalog", slug, "install"]) => match CATALOG.iter().find(|s| s.slug == *slug) {
            Some(s) => created(db::create_skill(env, user_id, s.slug, s.description, s.body, "catalog", true).await),
            None => err("unknown catalog skill", 404),
        },
        (Method::Put, [id]) => {
            let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
            let field = |k: &str| body.get(k).and_then(|v| v.as_str()).map(str::trim);
            let (name, description, text) = (field("name"), field("description"), body.get("body").and_then(|v| v.as_str()));
            let enabled = body.get("enabled").and_then(|v| v.as_bool());
            let Some(cur) = db::get_skill(env, user_id, id).await? else {
                return err("skill not found", 404);
            };
            if let Err(e) = validate(
                name.unwrap_or(str_at(&cur, "name")),
                description.unwrap_or(str_at(&cur, "description")),
                text.unwrap_or(str_at(&cur, "body")),
            ) {
                return err(&e, 400);
            }
            let id = str_at(&cur, "id");
            if let Err(e) = db::update_skill(env, user_id, id, name, description, text, enabled).await {
                return db_err(e);
            }
            match db::get_skill(env, user_id, id).await? {
                Some(row) => Response::from_json(&skill_json(&row)),
                None => err("skill not found", 404),
            }
        }
        (Method::Delete, [id]) => {
            if db::delete_skill(env, user_id, id).await? {
                Response::from_json(&json!({"ok": true}))
            } else {
                err("skill not found", 404)
            }
        }
        _ => err("not found", 404),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        for n in ["pr-review", "a1", "weekly-repo-digest", "x2-y3"] {
            assert!(validate_name(n).is_ok(), "{n}");
        }
        for n in ["", "a", "PR-review", "pr_review", "-pr", "pr-", "pr--review", "pr review", &"a".repeat(NAME_MAX + 1)] {
            assert!(validate_name(n).is_err(), "{n:?}");
        }
    }

    #[test]
    fn validates_fields() {
        assert!(validate("ok-name", "desc", "body").is_ok());
        assert!(validate("ok-name", " ", "body").is_err());
        assert!(validate("ok-name", "desc", "").is_err());
        assert!(validate("ok-name", &"d".repeat(DESCRIPTION_MAX + 1), "body").is_err());
    }

    #[test]
    fn catalog_is_valid_and_unique() {
        assert!(CATALOG.len() >= 8);
        for s in CATALOG {
            validate(s.slug, s.description, s.body).unwrap();
            assert_eq!(CATALOG.iter().filter(|o| o.slug == s.slug).count(), 1, "{}", s.slug);
        }
    }

    #[test]
    fn prompt_lists_enabled_skills_only_and_caps() {
        let rows = vec![
            json!({"name": "a-skill", "description": "does a\nthing", "enabled": 1}),
            json!({"name": "off-skill", "description": "hidden", "enabled": 0}),
        ];
        let s = prompt_section(&rows);
        assert!(s.contains("- a-skill — does a thing"));
        assert!(!s.contains("off-skill"));
        assert_eq!(prompt_section(&[]), "");
        let many: Vec<Value> = (0..60)
            .map(|i| json!({"name": format!("s{i}"), "description": "d", "enabled": true}))
            .collect();
        assert_eq!(prompt_section(&many).lines().filter(|l| l.starts_with("- ")).count(), PROMPT_LINES_MAX);
    }
}
