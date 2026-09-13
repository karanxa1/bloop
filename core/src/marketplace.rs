//! MCP server marketplace: curated catalog of verified remote MCP servers and
//! per-user server management (`/api/servers*`). Secrets (tokens, header
//! values, OAuth tokens) are never returned to the client.

use crate::config::{Config, McpServerCfg, Transport};
use crate::mcp::{self, McpClient, McpError, McpErrorKind, ToolInfo};
use crate::{db, netguard, oauth};
use futures::future::join_all;
use serde::Serialize;
use serde_json::{json, Map, Value};
use worker::*;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct CatalogEntry {
    pub slug: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub url: &'static str,
    /// "none" | "bearer" | "headers" | "oauth"
    pub auth: &'static str,
    pub docs_url: &'static str,
    /// Key into the web app's logo map.
    pub logo: &'static str,
    pub featured: bool,
}

#[allow(clippy::too_many_arguments)]
const fn entry(
    slug: &'static str,
    name: &'static str,
    description: &'static str,
    category: &'static str,
    url: &'static str,
    auth: &'static str,
    docs_url: &'static str,
    logo: &'static str,
    featured: bool,
) -> CatalogEntry {
    CatalogEntry { slug, name, description, category, url, auth, docs_url, logo, featured }
}

/// Remote MCP endpoints verified 2026-09-14 with an unauthenticated
/// `initialize` (HTTP 200, or 401 with a Bearer / RFC 9728 challenge).
pub const CATALOG: &[CatalogEntry] = &[
    entry("higgsfield", "Higgsfield", "Generate images and video (Seedance, Kling, Veo, Sora, Nano Banana, Soul) from chat.", "media", "https://mcp.higgsfield.ai/mcp", "oauth", "https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent", "higgsfield", true),
    entry("github", "GitHub", "Repos, issues, pull requests, Actions and code search.", "developer", "https://api.githubcopilot.com/mcp/", "bearer", "https://github.com/github/github-mcp-server", "github", true),
    entry("linear", "Linear", "Find, create and update Linear issues, projects and comments.", "productivity", "https://mcp.linear.app/mcp", "oauth", "https://linear.app/docs/mcp", "linear", true),
    entry("notion", "Notion", "Search, read and edit Notion pages and databases.", "productivity", "https://mcp.notion.com/mcp", "oauth", "https://developers.notion.com/docs/mcp", "notion", true),
    entry("sentry", "Sentry", "Query Sentry issues, errors, traces and releases.", "developer", "https://mcp.sentry.dev/mcp", "oauth", "https://docs.sentry.io/product/sentry-mcp/", "sentry", false),
    entry("stripe", "Stripe", "Customers, payments, invoices and Stripe docs (use a restricted API key).", "payments", "https://mcp.stripe.com", "bearer", "https://docs.stripe.com/mcp", "stripe", false),
    entry("cloudflare-bindings", "Cloudflare Workers Bindings", "Manage Workers, KV, R2, D1 and Hyperdrive resources.", "cloud", "https://bindings.mcp.cloudflare.com/mcp", "oauth", "https://github.com/cloudflare/mcp-server-cloudflare", "cloudflare", false),
    entry("cloudflare-observability", "Cloudflare Observability", "Query Workers logs and analytics to debug deployments.", "cloud", "https://observability.mcp.cloudflare.com/mcp", "oauth", "https://github.com/cloudflare/mcp-server-cloudflare", "cloudflare", false),
    entry("cloudflare-docs", "Cloudflare Docs", "Search up-to-date Cloudflare developer documentation.", "docs", "https://docs.mcp.cloudflare.com/mcp", "none", "https://github.com/cloudflare/mcp-server-cloudflare", "cloudflare", false),
    entry("huggingface", "Hugging Face", "Search models, datasets, Spaces and papers on the Hub.", "ai", "https://huggingface.co/mcp", "none", "https://huggingface.co/settings/mcp", "huggingface", false),
    entry("zapier", "Zapier", "Run actions across 8,000+ apps (Slack, Gmail, Sheets...) via Zapier.", "automation", "https://mcp.zapier.com/api/mcp/mcp", "bearer", "https://zapier.com/mcp", "zapier", false),
    entry("deepwiki", "DeepWiki", "Ask questions about any public GitHub repository.", "docs", "https://mcp.deepwiki.com/mcp", "none", "https://docs.devin.ai/work-with-devin/deepwiki-mcp", "deepwiki", false),
    entry("context7", "Context7", "Up-to-date, version-specific library documentation.", "docs", "https://mcp.context7.com/mcp", "none", "https://github.com/upstash/context7", "context7", false),
    entry("exa", "Exa", "Neural web search, code search and page crawling.", "search", "https://mcp.exa.ai/mcp", "none", "https://docs.exa.ai/reference/exa-mcp", "exa", false),
    entry("tavily", "Tavily", "Real-time web search, extraction and crawling.", "search", "https://mcp.tavily.com/mcp", "oauth", "https://docs.tavily.com/documentation/mcp", "tavily", false),
    entry("atlassian", "Atlassian", "Jira issues and Confluence pages.", "productivity", "https://mcp.atlassian.com/v1/mcp", "oauth", "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/", "atlassian", false),
    entry("figma", "Figma", "Read Figma designs, components and variables.", "design", "https://mcp.figma.com/mcp", "oauth", "https://developers.figma.com/docs/figma-mcp-server/", "figma", false),
    entry("vercel", "Vercel", "Projects, deployments, logs and Vercel docs.", "cloud", "https://mcp.vercel.com", "oauth", "https://vercel.com/docs/mcp/vercel-mcp", "vercel", false),
    entry("supabase", "Supabase", "Manage Supabase projects, SQL, migrations and edge functions.", "data", "https://mcp.supabase.com/mcp", "oauth", "https://supabase.com/docs/guides/getting-started/mcp", "supabase", false),
    entry("neon", "Neon", "Serverless Postgres projects, branches and queries.", "data", "https://mcp.neon.tech/mcp", "oauth", "https://neon.com/docs/ai/neon-mcp-server", "neon", false),
    entry("paypal", "PayPal", "Invoices, orders, subscriptions and disputes.", "payments", "https://mcp.paypal.com/mcp", "oauth", "https://developer.paypal.com/tools/mcp-server/", "paypal", false),
    entry("canva", "Canva", "Create, search and export Canva designs.", "design", "https://mcp.canva.com/mcp", "oauth", "https://www.canva.dev/docs/connect/canva-mcp-server-setup/", "canva", false),
    entry("webflow", "Webflow", "Manage Webflow sites, CMS collections and pages.", "design", "https://mcp.webflow.com/mcp", "oauth", "https://developers.webflow.com/mcp/reference/overview", "webflow", false),
];

pub const AUTH_TYPES: &[&str] = &["none", "bearer", "headers", "oauth"];
const PROBE_LIST_MS: u64 = 5_000;
const PROBE_ADD_MS: u64 = 10_000;
const TOOLS_MS: u64 = 15_000;
const NAME_MAX: usize = 64;
const HEADERS_MAX: usize = 20;
const HEADER_VALUE_MAX: usize = 4096;
const RESERVED_HEADERS: &[&str] = &[
    "host", "content-length", "content-type", "accept", "connection", "transfer-encoding",
    "cookie", "mcp-session-id", "mcp-protocol-version", "last-event-id",
];

fn json_err(msg: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({"error": msg})).map(|r| r.with_status(status))
}

fn put(m: &mut Map<String, Value>, k: &str, v: Value) {
    m.insert(k.to_string(), v);
}

pub fn catalog_entry(slug: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.slug == slug)
}

fn host_of(url: &str) -> Option<String> {
    Url::parse(url).ok()?.host_str().map(|h| h.to_ascii_lowercase())
}

fn same_url(a: &str, b: &str) -> bool {
    a.trim_end_matches('/').eq_ignore_ascii_case(b.trim_end_matches('/'))
}

/// Logo key: catalog slug, else a catalog entry on the same host, else "mcp".
pub fn logo_for(url: &str, slug: Option<&str>) -> String {
    if let Some(e) = slug.and_then(catalog_entry) {
        return e.logo.to_string();
    }
    let host = host_of(url).unwrap_or_default();
    if let Some(e) = CATALOG.iter().find(|e| host_of(e.url).as_deref() == Some(host.as_str())) {
        return e.logo.to_string();
    }
    for (suffix, logo) in [("cloudflare.com", "cloudflare"), ("zapier.com", "zapier"), ("composio.dev", "composio")] {
        if host.ends_with(suffix) {
            return logo.to_string();
        }
    }
    "mcp".to_string()
}

// ---------- masking / validation ----------

/// "••••" plus the last 4 chars for long secrets; never the full value.
pub fn mask_secret(s: &str) -> String {
    let n = s.chars().count();
    if n == 0 {
        String::new()
    } else if n >= 16 {
        let tail: String = s.chars().skip(n - 4).collect();
        format!("••••{}", tail)
    } else {
        "••••".to_string()
    }
}

fn looks_secret(seg: &str) -> bool {
    seg.len() >= 20
        && seg.chars().any(|c| c.is_ascii_digit())
        && seg.chars().any(|c| c.is_ascii_alphabetic())
}

/// Hide query values and token-like path segments (URLs that embed keys).
pub fn mask_url(raw: &str) -> String {
    let Ok(mut u) = Url::parse(raw) else {
        return "***".to_string();
    };
    let segs: Option<Vec<String>> = u.path_segments().map(|s| {
        s.map(|seg| if looks_secret(seg) { "***".to_string() } else { seg.to_string() })
            .collect()
    });
    if let Some(segs) = segs {
        u.set_path(&segs.join("/"));
    }
    if u.query().is_some() {
        let keys: Vec<String> = u.query_pairs().map(|(k, _)| k.into_owned()).collect();
        u.query_pairs_mut()
            .clear()
            .extend_pairs(keys.iter().map(|k| (k.as_str(), "***")));
    }
    u.set_fragment(None);
    u.to_string()
}

pub fn masked_headers(headers: &[(String, String)]) -> Value {
    Value::Object(
        headers
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(mask_secret(v))))
            .collect(),
    )
}

pub fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
        && !RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

/// Parse a `{name: value}` header object from the client.
pub fn parse_headers(v: Option<&Value>) -> std::result::Result<Vec<(String, String)>, String> {
    let obj = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(o)) => o,
        Some(_) => return Err("headers must be an object of string values".into()),
    };
    if obj.len() > HEADERS_MAX {
        return Err(format!("at most {} headers", HEADERS_MAX));
    }
    let mut out = Vec::new();
    for (k, v) in obj {
        let k = k.trim();
        if !valid_header_name(k) {
            return Err(format!("invalid or reserved header name: {}", netguard::snippet(k, 64)));
        }
        let Some(val) = v.as_str() else {
            return Err(format!("header {} must be a string", k));
        };
        if val.len() > HEADER_VALUE_MAX || val.contains('\r') || val.contains('\n') {
            return Err(format!("invalid value for header {}", k));
        }
        out.push((k.to_string(), val.to_string()));
    }
    Ok(out)
}

fn headers_json(h: &[(String, String)]) -> String {
    Value::Object(h.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect()).to_string()
}

fn truthy(v: Option<&Value>, default: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(default),
        Some(Value::String(s)) => s == "1" || s == "true",
        _ => default,
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ---------- rows ----------

#[derive(Debug, Clone)]
pub struct ServerRow {
    pub id: String,
    pub name: String,
    pub url: String,
    pub token: String,
    pub transport: Transport,
    pub auth_type: String,
    pub headers: Vec<(String, String)>,
    pub enabled: bool,
    pub oauth: Value,
    pub catalog_slug: Option<String>,
    pub created_at: String,
}

impl ServerRow {
    /// From a `db::list_user_servers_full` row.
    pub fn from_value(v: &Value) -> ServerRow {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let token = s("token");
        let auth_type = match s("auth_type") {
            a if AUTH_TYPES.contains(&a.as_str()) => a,
            _ if token.is_empty() => "none".to_string(),
            _ => "bearer".to_string(),
        };
        let headers = serde_json::from_str::<Map<String, Value>>(&s("headers_json"))
            .map(|m| {
                m.into_iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        ServerRow {
            id: s("id"),
            name: s("name"),
            url: s("url"),
            transport: Transport::parse(&s("transport")),
            auth_type,
            headers,
            enabled: truthy(v.get("enabled"), true),
            oauth: serde_json::from_str(&s("oauth_json")).unwrap_or(Value::Null),
            catalog_slug: Some(s("catalog_slug")).filter(|x| !x.is_empty()),
            created_at: s("created_at"),
            token,
        }
    }

    pub fn oauth_status(&self) -> Option<&'static str> {
        (self.auth_type == "oauth").then(|| oauth::oauth_status(&self.oauth))
    }

    /// Client-safe JSON (secrets masked).
    pub fn public_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        put(&mut m, "id", json!(self.id));
        put(&mut m, "name", json!(self.name));
        put(&mut m, "url", json!(mask_url(&self.url)));
        put(&mut m, "source", json!("user"));
        put(&mut m, "transport", json!(self.transport.as_str()));
        put(&mut m, "auth_type", json!(self.auth_type));
        put(&mut m, "enabled", json!(self.enabled));
        put(&mut m, "oauth_status", json!(self.oauth_status()));
        put(&mut m, "logo", json!(logo_for(&self.url, self.catalog_slug.as_deref())));
        put(&mut m, "catalog_slug", json!(self.catalog_slug));
        put(&mut m, "has_token", json!(!self.token.is_empty()));
        put(&mut m, "token", json!(mask_secret(&self.token)));
        put(&mut m, "headers", masked_headers(&self.headers));
        put(&mut m, "created_at", json!(self.created_at));
        if self.oauth_status() == Some("required") {
            put(&mut m, "authorize_url", json!(authorize_path(&self.id)));
        }
        m
    }
}

fn authorize_path(id: &str) -> String {
    format!("/api/servers/{}/oauth/start", id)
}

fn apply_probe(m: &mut Map<String, Value>, res: &std::result::Result<Vec<ToolInfo>, McpError>) {
    match res {
        Ok(tools) => {
            put(m, "state", json!("ok"));
            put(m, "tool_count", json!(tools.len()));
        }
        Err(e) => {
            let auth = e.kind() == McpErrorKind::Auth;
            put(m, "state", json!(if auth { "auth_required" } else { "error" }));
            put(m, "tool_count", json!(0));
            put(m, "error", json!(e.to_string()));
            put(m, "error_kind", json!(e.kind().as_str()));
        }
    }
}

fn brief_tools(tools: &[ToolInfo]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| json!({"name": t.name, "description": t.description}))
        .collect()
}

// ---------- config resolution (agent integration) ----------

/// Runtime config for a stored server; refreshes OAuth tokens as needed.
/// `None` when an OAuth server is not (or no longer) connected.
pub async fn server_cfg(env: &Env, row: &ServerRow) -> Option<McpServerCfg> {
    let token = if row.auth_type == "oauth" {
        oauth::fresh_access_token(env, &row.id, &row.oauth).await?
    } else {
        row.token.clone()
    };
    Some(McpServerCfg {
        name: row.name.clone(),
        url: row.url.clone(),
        token,
        headers: row.headers.clone(),
        transport: row.transport,
    })
}

/// Enabled user servers with fresh auth (OAuth refreshed transparently).
/// Names are raw user-provided names — sanitize before prefixing tool names.
pub async fn resolve_user_servers(env: &Env, user_id: &str) -> Vec<McpServerCfg> {
    let rows: Vec<ServerRow> = db::list_user_servers_full(env, user_id)
        .await
        .unwrap_or_default()
        .iter()
        .map(ServerRow::from_value)
        .filter(|r| r.enabled && !r.url.is_empty())
        .collect();
    join_all(rows.iter().map(|r| server_cfg(env, r)))
        .await
        .into_iter()
        .flatten()
        .collect()
}

// ---------- handlers ----------

/// GET /api/servers/catalog
pub async fn catalog(env: &Env, user_id: &str) -> Result<Response> {
    let rows: Vec<ServerRow> = db::list_user_servers_full(env, user_id)
        .await
        .unwrap_or_default()
        .iter()
        .map(ServerRow::from_value)
        .collect();
    let globals = Config::from_env(env).servers;
    let out: Vec<Value> = CATALOG
        .iter()
        .map(|e| {
            let installed = rows
                .iter()
                .any(|r| r.catalog_slug.as_deref() == Some(e.slug) || same_url(&r.url, e.url))
                || globals.iter().any(|g| same_url(&g.url, e.url));
            let mut v = serde_json::to_value(e).unwrap_or_else(|_| json!({}));
            v["installed"] = json!(installed);
            v
        })
        .collect();
    Response::from_json(&out)
}

/// GET /api/servers — global + user servers, probed concurrently (5s each).
pub async fn list(env: &Env, user_id: &str) -> Result<Response> {
    let globals = Config::from_env(env).servers;
    let rows: Vec<ServerRow> = db::list_user_servers_full(env, user_id)
        .await
        .unwrap_or_default()
        .iter()
        .map(ServerRow::from_value)
        .collect();
    let global_futs = globals.iter().map(|s| async move {
        let mut m = Map::new();
        put(&mut m, "id", json!(s.name));
        put(&mut m, "name", json!(s.name));
        put(&mut m, "url", json!(mask_url(&s.url)));
        put(&mut m, "source", json!("global"));
        put(&mut m, "transport", json!(s.transport.as_str()));
        put(&mut m, "auth_type", json!(if s.token.is_empty() { "none" } else { "bearer" }));
        put(&mut m, "enabled", json!(true));
        put(&mut m, "oauth_status", Value::Null);
        let slug = if s.name == "cf-docs" { Some("cloudflare-docs") } else { Some(s.name.as_str()) };
        put(&mut m, "logo", json!(logo_for(&s.url, slug)));
        apply_probe(&mut m, &mcp::probe_cfg(s, PROBE_LIST_MS).await);
        Value::Object(m)
    });
    let user_futs = rows.iter().map(|r| async move {
        let mut m = r.public_json();
        if !r.enabled {
            put(&mut m, "state", json!("disabled"));
            put(&mut m, "tool_count", json!(0));
        } else {
            match server_cfg(env, r).await {
                None => {
                    put(&mut m, "state", json!("auth_required"));
                    put(&mut m, "tool_count", json!(0));
                    put(&mut m, "oauth_status", json!("required"));
                    put(&mut m, "authorize_url", json!(authorize_path(&r.id)));
                }
                Some(cfg) => {
                    let res = mcp::probe_cfg(&cfg, PROBE_LIST_MS).await;
                    if r.auth_type == "oauth" && matches!(&res, Err(e) if e.kind() == McpErrorKind::Auth) {
                        put(&mut m, "oauth_status", json!("required"));
                        put(&mut m, "authorize_url", json!(authorize_path(&r.id)));
                    }
                    apply_probe(&mut m, &res);
                }
            }
        }
        Value::Object(m)
    });
    let (mut out, users) = futures::join!(join_all(global_futs), join_all(user_futs));
    out.extend(users);
    Response::from_json(&out)
}

/// POST /api/servers
pub async fn add(mut req: Request, env: &Env, user_id: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let str_of = |v: Option<&Value>| v.and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let slug = str_of(body.get("catalog_slug"));
    let entry = if slug.is_empty() { None } else { catalog_entry(&slug) };
    if !slug.is_empty() && entry.is_none() {
        return json_err("unknown catalog_slug", 400);
    }
    let mut name = str_of(body.get("name"));
    let mut url = str_of(body.get("url"));
    if let Some(e) = entry {
        if name.is_empty() {
            name = e.name.to_string();
        }
        if url.is_empty() {
            url = e.url.to_string();
        }
    }
    if name.is_empty() || url.is_empty() {
        return json_err("name and url required", 400);
    }
    let name = truncate(&name, NAME_MAX);
    if let Err(e) = netguard::check_outbound_url(&url) {
        return json_err(&format!("invalid url: {}", e), 400);
    }
    let transport = Transport::parse(&str_of(body.get("transport")));
    let auth = body.get("auth").cloned().unwrap_or(Value::Null);
    let token = {
        let t = str_of(auth.get("token"));
        if t.is_empty() { str_of(body.get("token")) } else { t }
    };
    let headers = match parse_headers(auth.get("headers").or_else(|| body.get("headers"))) {
        Ok(h) => h,
        Err(e) => return json_err(&e, 400),
    };
    let auth_type = {
        let t = str_of(auth.get("type"));
        if !t.is_empty() {
            t
        } else if !token.is_empty() {
            "bearer".to_string()
        } else if !headers.is_empty() {
            "headers".to_string()
        } else {
            entry.map(|e| e.auth).filter(|a| *a != "bearer").unwrap_or("none").to_string()
        }
    };
    if !AUTH_TYPES.contains(&auth_type.as_str()) {
        return json_err("auth.type must be none, bearer, headers or oauth", 400);
    }
    let slug_opt = entry.map(|e| e.slug);

    if auth_type == "oauth" {
        let row = db::add_user_server(env, user_id, &name, &url, "").await?;
        let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        db::put_server_config(env, &id, transport.as_str(), "oauth", &headers_json(&headers), slug_opt).await?;
        return Response::from_json(&json!({
            "id": id,
            "name": name,
            "url": mask_url(&url),
            "state": "auth_required",
            "oauth_required": true,
            "authorize_url": authorize_path(&id),
        }));
    }
    if auth_type == "bearer" && token.is_empty() {
        return json_err("auth.token required for bearer auth", 400);
    }
    if auth_type == "headers" && headers.is_empty() {
        return json_err("auth.headers required for headers auth", 400);
    }
    let token = if auth_type == "bearer" { token } else { String::new() };
    let cfg = McpServerCfg {
        name: name.clone(),
        url: url.clone(),
        token: token.clone(),
        headers: headers.clone(),
        transport,
    };
    match mcp::probe_cfg(&cfg, PROBE_ADD_MS).await {
        Ok(tools) => {
            let row = db::add_user_server(env, user_id, &name, &url, &token).await?;
            let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            db::put_server_config(env, &id, transport.as_str(), &auth_type, &headers_json(&headers), slug_opt).await?;
            Response::from_json(&json!({
                "id": id,
                "name": name,
                "url": mask_url(&url),
                "transport": transport.as_str(),
                "auth_type": auth_type,
                "logo": logo_for(&url, slug_opt),
                "state": "ok",
                "tool_count": tools.len(),
                "tools": brief_tools(&tools),
            }))
        }
        Err(e) => Response::from_json(&json!({
            "error": format!("could not connect: {}", e),
            "error_kind": e.kind().as_str(),
            "oauth_available": e.kind() == McpErrorKind::Auth && e.resource_metadata.is_some(),
        }))
        .map(|r| r.with_status(400)),
    }
}

/// `/api/servers/:id[/action]` dispatcher.
pub async fn route(req: Request, env: &Env, user_id: &str, rest: &str, method: Method) -> Result<Response> {
    let rest = rest.trim_matches('/');
    let (id, action) = rest.split_once('/').unwrap_or((rest, ""));
    if id.is_empty() {
        return json_err("not found", 404);
    }
    match (method, action) {
        (Method::Delete, "") => {
            db::delete_user_server(env, user_id, id).await?;
            db::delete_orphan_server_config(env, id).await?;
            Response::from_json(&json!({"ok": true}))
        }
        (Method::Patch, "") => patch(req, env, user_id, id).await,
        (Method::Post, "test") => test(env, user_id, id).await,
        (Method::Get, "tools") => tools(env, user_id, id).await,
        (Method::Get, "resource") => resource(&req, env, user_id, id).await,
        (Method::Get, "oauth/start") => oauth::start(&req, env, user_id, id).await,
        (_, "" | "test" | "tools" | "resource" | "oauth/start") => json_err("method not allowed", 405),
        _ => json_err("not found", 404),
    }
}

/// PATCH /api/servers/:id {enabled?, name?, headers?, token?}
async fn patch(mut req: Request, env: &Env, user_id: &str, id: &str) -> Result<Response> {
    let body: Value = req.json().await.unwrap_or_else(|_| json!({}));
    let Some(v) = db::get_user_server_full(env, user_id, id).await? else {
        return json_err("server not found", 404);
    };
    let row = ServerRow::from_value(&v);
    let name = match body.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(truncate(s.trim(), NAME_MAX)),
        Some(_) => return json_err("name must be a non-empty string", 400),
    };
    let token = match body.get("token") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.trim().to_string()),
        Some(_) => return json_err("token must be a string", 400),
    };
    let headers = match body.get("headers") {
        None | Some(Value::Null) => None,
        Some(h) => match parse_headers(Some(h)) {
            Ok(h) => Some(h),
            Err(e) => return json_err(&e, 400),
        },
    };
    let enabled = match body.get("enabled") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return json_err("enabled must be a boolean", 400),
    };
    let auth_type = if row.auth_type == "oauth" || (token.is_none() && headers.is_none()) {
        None
    } else {
        let t = token.as_deref().unwrap_or(&row.token);
        let h = headers.as_ref().unwrap_or(&row.headers);
        Some(if !t.is_empty() { "bearer" } else if !h.is_empty() { "headers" } else { "none" })
    };
    if name.is_some() || token.is_some() {
        db::update_user_server(env, user_id, id, name.as_deref(), token.as_deref()).await?;
    }
    let hj = headers.as_ref().map(|h| headers_json(h));
    db::update_server_config(env, id, enabled, hj.as_deref(), auth_type).await?;
    match db::get_user_server_full(env, user_id, id).await? {
        Some(v) => Response::from_json(&Value::Object(ServerRow::from_value(&v).public_json())),
        None => json_err("server not found", 404),
    }
}

enum Target {
    Cfg(McpServerCfg),
    NeedsAuth(String),
}

async fn target(env: &Env, user_id: &str, id: &str) -> Result<Option<Target>> {
    if let Some(g) = Config::from_env(env).servers.into_iter().find(|s| s.name == id) {
        return Ok(Some(Target::Cfg(g)));
    }
    let Some(v) = db::get_user_server_full(env, user_id, id).await? else {
        return Ok(None);
    };
    let row = ServerRow::from_value(&v);
    Ok(Some(match server_cfg(env, &row).await {
        Some(c) => Target::Cfg(c),
        None => Target::NeedsAuth(authorize_path(&row.id)),
    }))
}

fn needs_auth_json(authorize_url: &str) -> Value {
    json!({
        "state": "auth_required",
        "tool_count": 0,
        "tools": [],
        "oauth_status": "required",
        "authorize_url": authorize_url,
        "error": "OAuth authorization required",
        "error_kind": "auth",
    })
}

/// POST /api/servers/:id/test
async fn test(env: &Env, user_id: &str, id: &str) -> Result<Response> {
    match target(env, user_id, id).await? {
        None => json_err("server not found", 404),
        Some(Target::NeedsAuth(u)) => Response::from_json(&needs_auth_json(&u)),
        Some(Target::Cfg(cfg)) => {
            let res = mcp::probe_cfg(&cfg, PROBE_ADD_MS).await;
            let mut m = Map::new();
            apply_probe(&mut m, &res);
            put(&mut m, "tools", json!(res.as_ref().map(|t| brief_tools(t)).unwrap_or_default()));
            Response::from_json(&Value::Object(m))
        }
    }
}

/// GET /api/servers/:id/tools — full tool descriptors incl. annotations + UI.
async fn tools(env: &Env, user_id: &str, id: &str) -> Result<Response> {
    match target(env, user_id, id).await? {
        None => json_err("server not found", 404),
        Some(Target::NeedsAuth(u)) => Response::from_json(&needs_auth_json(&u)).map(|r| r.with_status(401)),
        Some(Target::Cfg(cfg)) => match mcp::probe_cfg(&cfg, TOOLS_MS).await {
            Ok(list) => {
                let tools: Vec<Value> = list
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "title": t.title,
                            "description": t.description,
                            "annotations": t.annotations,
                            "read_only": t.read_only,
                            "destructive": t.destructive,
                            "has_ui": t.ui.is_some(),
                            "ui": t.ui,
                            "visibility": t.visibility,
                            "input_schema": t.input_schema,
                            "output_schema": t.output_schema,
                        })
                    })
                    .collect();
                Response::from_json(&json!({"server_id": id, "tool_count": tools.len(), "tools": tools}))
            }
            Err(e) => Response::from_json(&json!({"error": e.to_string(), "error_kind": e.kind().as_str()}))
                .map(|r| r.with_status(502)),
        },
    }
}

/// GET /api/servers/:id/resource?uri=ui://… — MCP Apps UI (or any resource).
async fn resource(req: &Request, env: &Env, user_id: &str, id: &str) -> Result<Response> {
    let uri = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "uri")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    if uri.is_empty() {
        return json_err("uri required", 400);
    }
    match target(env, user_id, id).await? {
        None => json_err("server not found", 404),
        Some(Target::NeedsAuth(u)) => Response::from_json(&needs_auth_json(&u)).map(|r| r.with_status(401)),
        Some(Target::Cfg(cfg)) => {
            let mut c = McpClient::from_cfg(&cfg);
            c.timeout_ms = TOOLS_MS;
            let res = async {
                c.initialize_full().await?;
                c.read_resource(&uri).await
            }
            .await;
            match res {
                Ok((mime, text)) => Response::from_json(&json!({
                    "uri": uri,
                    "mime": mime,
                    "is_app": mime.starts_with("text/html") && mime.contains("mcp-app"),
                    "text": text,
                })),
                Err(e) => Response::from_json(&json!({"error": e.to_string(), "error_kind": e.kind().as_str()}))
                    .map(|r| r.with_status(502)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_is_valid() {
        assert!(CATALOG.len() >= 12);
        let mut slugs = HashSet::new();
        for e in CATALOG {
            assert!(slugs.insert(e.slug), "duplicate slug {}", e.slug);
            assert!(netguard::check_outbound_url(e.url).is_ok(), "bad url {}", e.url);
            assert!(netguard::check_outbound_url(e.docs_url).is_ok(), "bad docs {}", e.docs_url);
            assert!(AUTH_TYPES.contains(&e.auth), "bad auth {}", e.slug);
            assert!(!e.name.is_empty() && !e.description.is_empty() && !e.logo.is_empty());
        }
        let h = catalog_entry("higgsfield").unwrap();
        assert!(h.featured && h.auth == "oauth");
        let v = serde_json::to_value(CATALOG).unwrap();
        assert_eq!(v.as_array().unwrap().len(), CATALOG.len());
        assert_eq!(v[0]["slug"], "higgsfield");
        assert_eq!(logo_for("https://observability.mcp.cloudflare.com/mcp", None), "cloudflare");
        assert_eq!(logo_for("https://example.com/mcp", None), "mcp");
    }

    #[test]
    fn masking_hides_secrets() {
        assert_eq!(mask_secret(""), "");
        assert_eq!(mask_secret("short"), "••••");
        assert_eq!(mask_secret("ghp_abcdefghijklmnop1234"), "••••1234");
        let h = masked_headers(&[("x-api-key".into(), "supersecretvalue-XYZ9".into())]);
        assert!(!h.to_string().contains("supersecret"));
        let m = mask_url("https://mcp.zapier.com/api/mcp/s/abcDEF123456789xyzLONG/mcp?key=sk_live_1&x=2#frag");
        assert_eq!(m, "https://mcp.zapier.com/api/mcp/s/***/mcp?key=***&x=***");
        assert_eq!(mask_url("https://mcp.linear.app/mcp"), "https://mcp.linear.app/mcp");
        assert_eq!(mask_url("https://api.githubcopilot.com/mcp/"), "https://api.githubcopilot.com/mcp/");
    }

    #[test]
    fn header_validation() {
        assert!(parse_headers(Some(&json!({"X-API-Key": "k", "Authorization": "Token t"}))).is_ok());
        assert!(parse_headers(Some(&json!({"Host": "evil"}))).is_err());
        assert!(parse_headers(Some(&json!({"bad name": "v"}))).is_err());
        assert!(parse_headers(Some(&json!({"x": "a\r\nb"}))).is_err());
        assert!(parse_headers(Some(&json!({"x": 1}))).is_err());
        assert!(parse_headers(Some(&json!(["x"]))).is_err());
        assert_eq!(parse_headers(None).unwrap().len(), 0);
    }

    #[test]
    fn row_parsing_and_public_json() {
        let v = json!({
            "id": "s1", "name": "n", "url": "https://mcp.linear.app/mcp", "token": "",
            "transport": "sse", "auth_type": "oauth", "headers_json": "{\"x-k\":\"secretsecretsecret99\"}",
            "enabled": 0.0, "oauth_json": "{\"access_token\":\"at\",\"refresh_token\":\"rt\"}", "catalog_slug": "linear"
        });
        let r = ServerRow::from_value(&v);
        assert!(!r.enabled);
        assert_eq!(r.transport, Transport::Sse);
        assert_eq!(r.oauth_status(), Some("connected"));
        let pj = Value::Object(r.public_json()).to_string();
        assert!(!pj.contains("secretsecret") && !pj.contains("\"at\"") && !pj.contains("\"rt\""));
        assert!(!pj.contains("access_token") && !pj.contains("refresh_token"));
        assert!(pj.contains("\"logo\":\"linear\""));
        let legacy = ServerRow::from_value(&json!({"id": "s2", "name": "x", "url": "https://a.b/mcp", "token": "t"}));
        assert_eq!(legacy.auth_type, "bearer");
        assert!(legacy.enabled);
    }
}
