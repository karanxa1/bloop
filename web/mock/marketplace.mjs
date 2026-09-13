/**
 * Marketplace mock — skills · built-in tools · mcp servers (docs/contracts-v3.md).
 * Registered from server.mjs with a single `import "./marketplace.mjs";`.
 * It hooks `request` events on every http.Server and answers its own routes
 * before the base router sees them (so it overrides the legacy /api/servers routes).
 *
 * Demo switches for custom servers:
 *   url contains "timeout" → timeout · "fail" → transient error · "flaky" → degraded
 *   token "bad" / any header value "bad" → auth error
 *   PUT /api/tools/speech.transcribe always 503s (exercises optimistic rollback)
 */
import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => sleep(base + Math.floor(Math.random() * 220));
const now = () => new Date().toISOString();
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
let seq = 0;
const nid = (p) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

// ── mcp catalog ──────────────────────────────────────────────────
const CATALOG = [
  { slug: "higgsfield", name: "higgsfield", description: "generate 4k images and 15s videos with 30+ models — soul characters, cinematic camera moves, history browsing.", category: "media", url: "https://mcp.higgsfield.ai/mcp", auth: "oauth", docs_url: "https://higgsfield.ai/mcp", logo: "higgsfield", featured: true },
  { slug: "github", name: "github", description: "issues, pull requests, code search and actions across your repos.", category: "dev tools", url: "https://api.githubcopilot.com/mcp/", auth: "bearer", docs_url: "https://github.com/github/github-mcp-server", logo: "github", featured: true },
  { slug: "linear", name: "linear", description: "create, triage and update issues, projects and cycles.", category: "productivity", url: "https://mcp.linear.app/mcp", auth: "oauth", docs_url: "https://linear.app/docs/mcp", logo: "linear", featured: true },
  { slug: "notion", name: "notion", description: "search, read and write pages and databases in your workspace.", category: "productivity", url: "https://mcp.notion.com/mcp", auth: "oauth", docs_url: "https://developers.notion.com/docs/mcp", logo: "notion", featured: false },
  { slug: "deepwiki", name: "deepwiki", description: "ask questions about any public github repo's architecture and docs.", category: "dev tools", url: "https://mcp.deepwiki.com/mcp", auth: "none", docs_url: "https://docs.devin.ai/work-with-devin/deepwiki-mcp", logo: "deepwiki", featured: false },
  { slug: "context7", name: "context7", description: "up-to-date, version-specific library docs and code examples.", category: "dev tools", url: "https://mcp.context7.com/mcp", auth: "headers", docs_url: "https://github.com/upstash/context7", logo: "context7", featured: true },
  { slug: "huggingface", name: "hugging face", description: "search models, datasets, spaces and papers on the hub.", category: "data", url: "https://huggingface.co/mcp", auth: "bearer", docs_url: "https://huggingface.co/settings/mcp", logo: "huggingface", featured: false },
  { slug: "sentry", name: "sentry", description: "investigate errors, traces and releases; ask seer for root causes.", category: "dev tools", url: "https://mcp.sentry.dev/mcp", auth: "oauth", docs_url: "https://docs.sentry.io/product/sentry-mcp/", logo: "sentry", featured: false },
  { slug: "cloudflare-docs", name: "cloudflare docs", description: "search cloudflare developer documentation — workers, r2, d1 and more.", category: "dev tools", url: "https://docs.mcp.cloudflare.com/mcp", auth: "none", docs_url: "https://github.com/cloudflare/mcp-server-cloudflare", logo: "cloudflare", featured: false },
  { slug: "figma", name: "figma", description: "pull frames, components and design tokens into code.", category: "design", url: "https://mcp.figma.com/mcp", auth: "oauth", docs_url: "https://help.figma.com/hc/en-us/articles/32132100833559", logo: "figma", featured: false },
  { slug: "zapier", name: "zapier", description: "trigger actions in 8,000+ apps — slack, gmail, sheets and beyond.", category: "productivity", url: "https://mcp.zapier.com/api/mcp/mcp", auth: "bearer", docs_url: "https://zapier.com/mcp", logo: "zapier", featured: false },
  { slug: "exa", name: "exa", description: "neural web search, crawling and company research built for agents.", category: "search", url: "https://mcp.exa.ai/mcp", auth: "headers", docs_url: "https://docs.exa.ai/reference/exa-mcp", logo: "exa", featured: false },
  { slug: "atlassian", name: "atlassian", description: "jira issues and confluence pages — search, summarise, create.", category: "productivity", url: "https://mcp.atlassian.com/v1/sse", auth: "oauth", docs_url: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/", logo: "jira", featured: false },
  { slug: "stripe", name: "stripe", description: "look up customers, payments and subscriptions; draft refunds.", category: "data", url: "https://mcp.stripe.com", auth: "bearer", docs_url: "https://docs.stripe.com/mcp", logo: "stripe", featured: false }
];

const T = (name, description, annotations, has_ui = false) => ({ name, description, annotations, has_ui });
const RO = { readOnlyHint: true, openWorldHint: true };
const TOOLSETS = {
  higgsfield: [
    T("generate_image", "text or reference → image, up to 4k", { openWorldHint: true }, true),
    T("generate_video", "image or prompt → video clip up to 15s with camera motion", { openWorldHint: true }, true),
    T("train_soul_character", "train a consistent character from 10–20 photos", { openWorldHint: true }),
    T("list_models", "available image + video models and their credit cost", RO),
    T("get_generation", "status and output urls for a generation job", RO),
    T("browse_history", "your recent generations", RO, true)
  ],
  github: [
    T("search_code", "search code across repositories", RO),
    T("list_issues", "list issues with filters", RO),
    T("create_issue", "open a new issue", { openWorldHint: true }),
    T("create_pull_request", "open a pull request", { openWorldHint: true }),
    T("merge_pull_request", "merge a pull request", { destructiveHint: true, openWorldHint: true }),
    T("get_file_contents", "read a file at a ref", RO)
  ],
  linear: [
    T("list_issues", "list issues assigned or filtered", RO),
    T("create_issue", "create an issue in a team", {}),
    T("update_issue", "change state, assignee, priority", { idempotentHint: true }),
    T("list_projects", "projects and their progress", RO)
  ],
  deepwiki: [
    T("read_wiki_structure", "topics for a repo's generated wiki", RO),
    T("read_wiki_contents", "full wiki pages for a repo", RO),
    T("ask_question", "ask anything about a repo", RO)
  ],
  context7: [
    T("resolve-library-id", "match a package name to a context7 library id", RO),
    T("query-docs", "fetch focused docs for a library + topic", RO)
  ],
  crm: [
    T("find_contact", "search contacts by name or email", RO),
    T("update_deal", "move a deal between stages", { idempotentHint: true }),
    T("delete_contact", "permanently delete a contact", { destructiveHint: true })
  ]
};
const toolsFor = (slug, name) =>
  TOOLSETS[slug] ?? [
    T("search", `search ${name}`, RO),
    T("get", `fetch a ${name} record by id`, RO),
    T("create", `create a ${name} record`, {}),
    T("dashboard", `interactive ${name} overview`, RO, true)
  ];

// ── installed servers ────────────────────────────────────────────
const servers = [
  { id: "srv_gh", name: "github", url: "https://api.githubcopilot.com/mcp/", source: "global", state: "ok", transport: "streamable-http", auth_type: "bearer", enabled: true, oauth_status: null, logo: "github", catalog_slug: "github", secret: { token: "ghp_demo" }, tools: toolsFor("github") },
  { id: "srv_dw", name: "deepwiki", url: "https://mcp.deepwiki.com/mcp", source: "global", state: "ok", transport: "streamable-http", auth_type: "none", enabled: true, oauth_status: null, logo: "deepwiki", catalog_slug: "deepwiki", secret: {}, tools: toolsFor("deepwiki") },
  { id: "srv_crm", name: "legacy-crm", url: "https://mcp.crm.example.com/sse", source: "user", state: "error", transport: "sse", auth_type: "headers", enabled: true, oauth_status: null, catalog_slug: null, secret: { headers: { "x-api-key": "bad" } }, tools: TOOLSETS.crm, error: "401 unauthorized — the server rejected x-api-key", error_kind: "auth" }
];

const pub = (s) => ({
  id: s.id, name: s.name, url: s.url, source: s.source, state: s.state,
  tool_count: s.state === "error" && s.oauth_status === "required" ? 0 : s.tools.length,
  transport: s.transport, auth_type: s.auth_type, enabled: s.enabled,
  oauth_status: s.oauth_status, ...(s.logo ? { logo: s.logo } : {}), ...(s.error ? { error: s.error } : {})
});
const summaries = (tools) => tools.map(({ name, description }) => ({ name, description }));

function probe(s) {
  if (s.auth_type === "oauth" && s.oauth_status !== "connected")
    return { state: "error", error: "authorization required — connect with oauth", error_kind: "auth" };
  if (/timeout/i.test(s.url)) return { state: "error", error: "no response after 10s", error_kind: "timeout" };
  if (/fail/i.test(s.url)) return { state: "error", error: "connection refused (ECONNREFUSED)", error_kind: "transient" };
  if (s.secret.token === "bad" || Object.values(s.secret.headers ?? {}).includes("bad"))
    return { state: "error", error: "401 unauthorized — credentials rejected", error_kind: "auth" };
  if (/flaky/i.test(s.url)) return { state: "degraded", error: "circuit breaker open after 3 failures", error_kind: "circuit_open" };
  return { state: "ok" };
}
function applyProbe(s) {
  const p = probe(s);
  s.state = p.state;
  s.error = p.error;
  s.error_kind = p.error_kind;
  return p;
}

// ── built-in tools ───────────────────────────────────────────────
const tools = [
  { name: "plan", label: "plan", description: "break work into steps and track progress", category: "core", enabled: true, locked: true },
  { name: "verify", label: "verify by replay", description: "re-run reads to prove claims before answering", category: "core", enabled: true, locked: true },
  { name: "ask_user", label: "ask you", description: "pause and ask a clarifying question", category: "core", enabled: true, locked: false },
  { name: "web.search", label: "web search", description: "search the live web with citations", category: "web", enabled: true, locked: false },
  { name: "web.fetch", label: "fetch page", description: "read a url as clean markdown", category: "web", enabled: true, locked: false },
  { name: "browser.open", label: "browser", description: "drive a real browser; hands off to you for logins", category: "web", enabled: false, locked: false },
  { name: "python.run", label: "python", description: "run python in a sandbox with numpy + pandas", category: "code", enabled: true, locked: false },
  { name: "workspace.exec", label: "shell", description: "run commands in the chat's workspace", category: "code", enabled: true, locked: false },
  { name: "workspace.files", label: "workspace files", description: "read, write and delete workspace files", category: "code", enabled: true, locked: false },
  { name: "image.generate", label: "image generation", description: "create images from a prompt", category: "media", enabled: true, locked: false },
  { name: "image.edit", label: "image editing", description: "inpaint, restyle or extend an image", category: "media", enabled: false, locked: false },
  { name: "speech.transcribe", label: "transcription", description: "turn audio files into text", category: "media", enabled: false, locked: false },
  { name: "memory.remember", label: "remember", description: "save durable facts about you", category: "memory", enabled: true, locked: false },
  { name: "memory.search", label: "recall", description: "look up saved memories", category: "memory", enabled: true, locked: true },
  { name: "delegate", label: "subagents", description: "spin up focused subagents in parallel", category: "agents", enabled: true, locked: false },
  { name: "skills.create", label: "write skills", description: "let bloop save reusable workflows as skills", category: "agents", enabled: true, locked: false }
];

// ── skills ───────────────────────────────────────────────────────
const md = (title, when, steps, extra = "") =>
  `# ${title}\n\n## when to use\n${when.map((w) => `- ${w}`).join("\n")}\n\n## steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n${extra}`;

const SKILL_CATALOG = [
  { slug: "brand-voice", name: "brand-voice", category: "writing", description: "rewrite copy in a consistent, lowercase, friendly brand voice.", body: md("brand voice", ["drafting marketing copy", "reviewing ui strings"], ["read the style notes in context", "rewrite in short sentences, lowercase", "flag claims that need a source"], "\n> keep it warm, never cute.\n") },
  { slug: "code-review", name: "code-review", category: "code", description: "review a diff for bugs first, then clarity, with file:line references.", body: md("code review", ["a pr link or diff is shared"], ["fetch the diff", "list correctness bugs with `file:line`", "suggest simplifications", "end with a ship / fix-first verdict"]) },
  { slug: "meeting-notes", name: "meeting-notes", category: "productivity", description: "turn a transcript into decisions, owners and next steps.", body: md("meeting notes", ["a transcript or recording is provided"], ["extract decisions", "assign owners + dates", "draft the follow-up message"]) },
  { slug: "research-brief", name: "research-brief", category: "research", description: "multi-source brief with verified citations and a confidence score.", body: md("research brief", ["open-ended questions needing sources"], ["search 5+ sources in parallel", "verify every number by replay", "write a 200-word brief with citations"]) },
  { slug: "sql-analyst", name: "sql-analyst", category: "data", description: "answer data questions with checked sql and a small chart.", body: md("sql analyst", ["a question about a connected database"], ["inspect the schema", "write + dry-run the query", "sanity-check row counts", "plot the result"]) },
  { slug: "changelog", name: "changelog", category: "code", description: "draft release notes from merged prs, grouped by impact.", body: md("changelog", ["cutting a release"], ["list merged prs since the last tag", "group into features / fixes / chores", "write user-facing notes"]) },
  { slug: "email-triage", name: "email-triage", category: "productivity", description: "sort an inbox into reply, delegate, archive — with drafted replies.", body: md("email triage", ["the inbox is overflowing"], ["fetch unread threads", "bucket by action", "draft replies for the reply bucket"]) },
  { slug: "cinematic-prompts", name: "cinematic-prompts", category: "media", description: "write shot-by-shot prompts for higgsfield video generations.", body: md("cinematic prompts", ["making a video with higgsfield"], ["pick a camera move per shot", "describe subject, light, lens", "keep each shot under 15s"]) },
  { slug: "bug-repro", name: "bug-repro", category: "code", description: "reproduce a reported bug in the workspace before proposing a fix.", body: md("bug repro", ["a bug report arrives"], ["write a failing test", "bisect if needed", "only then propose the fix"]) }
];

const skills = [
  { id: "sk_weekly", name: "weekly-update", description: "roll up a week of github + linear activity into a crisp status post.", body: md("weekly update", ["friday afternoons", "someone asks what shipped"], ["list merged prs and closed issues", "group by project", "write 5 bullets max"]), source: "user", enabled: true, updated_at: ago(30), catalog_slug: null },
  { id: "sk_pdf", name: "pdf-tables-to-csv", description: "pull tables out of pdfs into csv and check row counts against each page.", body: md("pdf tables to csv", ["a pdf with tables is attached"], ["extract tables per page with python", "compare row counts to the page", "save csvs to the workspace"], "\n_created by bloop after the q3 invoices chat._\n"), source: "agent", enabled: true, updated_at: ago(3), catalog_slug: null },
  { id: "sk_voice", name: "brand-voice", description: SKILL_CATALOG[0].description, body: SKILL_CATALOG[0].body, source: "catalog", enabled: false, updated_at: ago(120), catalog_slug: "brand-voice" }
];

// ── http helpers ─────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
    });
  });
}
const hasSession = (req) => /(?:^|;\s*)bloop_session=[^;\s]+/.test(req.headers.cookie ?? "");
const cleanHeaders = (h) =>
  Object.fromEntries(Object.entries(h && typeof h === "object" ? h : {}).filter(([k, v]) => /^[A-Za-z0-9_.-]+$/.test(k) && typeof v === "string"));

// ── routes ───────────────────────────────────────────────────────
async function handle(req, res, path, method) {
  if (!hasSession(req)) return send(res, 401, { error: "not signed in" });

  // skills
  if (path === "/api/skills/catalog" && method === "GET") {
    await jitter(250);
    return send(res, 200, SKILL_CATALOG.map((c) => ({ ...c, installed: skills.some((s) => s.catalog_slug === c.slug) })));
  }
  const sci = path.match(/^\/api\/skills\/catalog\/([^/]+)\/install$/);
  if (sci && method === "POST") {
    await jitter(400);
    const c = SKILL_CATALOG.find((x) => x.slug === decodeURIComponent(sci[1]));
    if (!c) return send(res, 404, { error: "no such skill" });
    if (skills.some((s) => s.catalog_slug === c.slug)) return send(res, 409, { error: "already installed" });
    const s = { id: nid("sk"), name: c.name, description: c.description, body: c.body, source: "catalog", enabled: true, updated_at: now(), catalog_slug: c.slug };
    skills.unshift(s);
    return send(res, 200, s);
  }
  if (path === "/api/skills" && method === "GET") {
    await jitter(300);
    return send(res, 200, skills);
  }
  if (path === "/api/skills" && method === "POST") {
    const b = await readBody(req);
    await jitter(350);
    if (!b.name?.trim() || !b.description?.trim() || !b.body?.trim()) return send(res, 400, { error: "name, description and body are required" });
    if (skills.some((s) => s.name === b.name.trim())) return send(res, 409, { error: `a skill named “${b.name.trim()}” already exists` });
    const s = { id: nid("sk"), name: b.name.trim(), description: b.description.trim(), body: b.body, source: "user", enabled: true, updated_at: now(), catalog_slug: null };
    skills.unshift(s);
    return send(res, 200, s);
  }
  const sk = path.match(/^\/api\/skills\/([^/]+)$/);
  if (sk) {
    const i = skills.findIndex((s) => s.id === decodeURIComponent(sk[1]));
    if (i < 0) return send(res, 404, { error: "skill not found" });
    if (method === "PUT") {
      const b = await readBody(req);
      await jitter(300);
      for (const k of ["name", "description", "body"]) if (typeof b[k] === "string") skills[i][k] = k === "body" ? b[k] : b[k].trim();
      if (typeof b.enabled === "boolean") skills[i].enabled = b.enabled;
      skills[i].updated_at = now();
      return send(res, 200, skills[i]);
    }
    if (method === "DELETE") {
      await jitter(250);
      skills.splice(i, 1);
      return send(res, 200, { ok: true });
    }
  }

  // built-in tools
  if (path === "/api/tools" && method === "GET") {
    await jitter(250);
    return send(res, 200, tools);
  }
  const tm = path.match(/^\/api\/tools\/([^/]+)$/);
  if (tm && method === "PUT") {
    const b = await readBody(req);
    await jitter(350);
    const t = tools.find((x) => x.name === decodeURIComponent(tm[1]));
    if (!t) return send(res, 404, { error: "tool not found" });
    if (t.locked) return send(res, 403, { error: `${t.label} is required and can't be turned off` });
    if (t.name === "speech.transcribe") return send(res, 503, { error: "transcription is temporarily unavailable" });
    t.enabled = !!b.enabled;
    return send(res, 200, t);
  }

  // mcp servers
  if (path === "/api/servers/catalog" && method === "GET") {
    await jitter(300);
    return send(res, 200, CATALOG.map((c) => ({ ...c, installed: servers.some((s) => s.catalog_slug === c.slug) })));
  }
  if (path === "/api/servers" && method === "GET") {
    await jitter(250);
    return send(res, 200, servers.map(pub));
  }
  if (path === "/api/servers" && method === "POST") {
    const b = await readBody(req);
    await jitter(600);
    const cat = b.catalog_slug ? CATALOG.find((c) => c.slug === b.catalog_slug) : null;
    if (b.catalog_slug && !cat) return send(res, 404, { error: "unknown catalog app" });
    if (cat && servers.some((s) => s.catalog_slug === cat.slug)) return send(res, 409, { error: `${cat.name} is already installed` });
    const name = String(b.name ?? cat?.name ?? "").trim();
    const url = String(b.url ?? cat?.url ?? "").trim();
    if (!name) return send(res, 400, { error: "name is required" });
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) return send(res, 400, { error: "url must be a valid https:// address" });
    const transport = ["auto", "streamable-http", "sse"].includes(b.transport) ? b.transport : "auto";
    const authType = cat?.auth ?? (["none", "bearer", "headers", "oauth"].includes(b.auth?.type) ? b.auth.type : "none");
    const secret = {};
    if (authType === "bearer") {
      if (!b.auth?.token?.trim()) return send(res, 400, { error: "a token is required" });
      secret.token = b.auth.token.trim();
    }
    if (authType === "headers") {
      secret.headers = cleanHeaders(b.auth?.headers);
      if (!Object.keys(secret.headers).length) return send(res, 400, { error: "add at least one header" });
    }
    const s = {
      id: nid("srv"), name, url, source: "user", state: "ok",
      transport: transport === "auto" ? (url.endsWith("/sse") ? "sse" : "streamable-http") : transport,
      auth_type: authType, enabled: true, oauth_status: authType === "oauth" ? "required" : null,
      logo: cat?.logo, catalog_slug: cat?.slug ?? null, secret, tools: toolsFor(cat?.slug, name)
    };
    applyProbe(s);
    servers.push(s);
    if (authType === "oauth")
      return send(res, 200, { id: s.id, oauth_required: true, authorize_url: `/api/servers/${s.id}/oauth/start` });
    return send(res, 200, { id: s.id, name: s.name, url: s.url, state: s.state, tool_count: s.state === "error" ? 0 : s.tools.length, tools: s.state === "error" ? [] : summaries(s.tools), ...(s.error ? { error: s.error, error_kind: s.error_kind } : {}) });
  }
  const so = path.match(/^\/api\/servers\/([^/]+)\/oauth\/start$/);
  if (so && method === "GET") {
    const s = servers.find((x) => x.id === decodeURIComponent(so[1]));
    if (!s) return send(res, 404, { error: "server not found" });
    await sleep(500); // pretend the provider consent screen happened
    s.oauth_status = "connected";
    applyProbe(s);
    res.writeHead(302, { location: `/app?connected=${encodeURIComponent(s.id)}` });
    return res.end();
  }
  const st = path.match(/^\/api\/servers\/([^/]+)\/(test|tools)$/);
  if (st) {
    const s = servers.find((x) => x.id === decodeURIComponent(st[1]));
    if (!s) return send(res, 404, { error: "server not found" });
    if (st[2] === "test" && method === "POST") {
      await jitter(900);
      const p = applyProbe(s);
      const ok = p.state !== "error";
      return send(res, 200, { state: s.state, tool_count: ok ? s.tools.length : 0, tools: ok ? summaries(s.tools) : [], ...(p.error ? { error: p.error, error_kind: p.error_kind } : {}) });
    }
    if (st[2] === "tools" && method === "GET") {
      await jitter(350);
      if (s.oauth_status === "required") return send(res, 409, { error: "connect with oauth to list tools" });
      return send(res, 200, s.tools);
    }
  }
  const sm = path.match(/^\/api\/servers\/([^/]+)$/);
  if (sm) {
    const i = servers.findIndex((x) => x.id === decodeURIComponent(sm[1]));
    if (i < 0) return send(res, 404, { error: "server not found" });
    const s = servers[i];
    if (method === "PATCH") {
      const b = await readBody(req);
      await jitter(350);
      if (typeof b.enabled === "boolean") s.enabled = b.enabled;
      if (s.source === "global" && (b.name || b.headers || b.token)) return send(res, 403, { error: "built-in servers can only be toggled" });
      if (typeof b.name === "string" && b.name.trim()) s.name = b.name.trim();
      let reprobe = false;
      if (typeof b.token === "string" && b.token.trim()) { s.secret.token = b.token.trim(); reprobe = true; }
      if (b.headers && typeof b.headers === "object") { s.secret.headers = { ...(s.secret.headers ?? {}), ...cleanHeaders(b.headers) }; reprobe = true; }
      if (reprobe) applyProbe(s);
      return send(res, 200, pub(s));
    }
    if (method === "DELETE") {
      await jitter(300);
      if (s.source === "global") return send(res, 403, { error: "built-in servers can't be removed" });
      servers.splice(i, 1);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: `no route: ${method} ${path}` });
}

const OWNED = /^\/api\/(skills|tools|servers)(\/|$)/;
const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "request") {
    const [req, res] = args;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (OWNED.test(path)) {
      handle(req, res, path, req.method).catch((e) => send(res, 500, { error: String(e) }));
      return true;
    }
  }
  return origEmit.call(this, event, ...args);
};
