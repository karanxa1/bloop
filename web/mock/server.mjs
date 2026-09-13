/**
 * Dev mock for the bloop API contract — run alongside `vite dev`.
 *   node mock/server.mjs   (listens on :8787, override with PORT)
 * Vite proxies /api and /files to it.
 *
 * Auth: cookie `bloop_session`. Seed user: demo@bloop.do / blob123.
 * Invite codes: any non-empty value except "invalid".
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hero = readFileSync(join(ROOT, "public/assets/hero.webp"));

// ── state ────────────────────────────────────────────────────────
let n = 0;
const id = (p) => `${p}_${(++n).toString(36)}${Date.now().toString(36).slice(-4)}`;

const users = new Map(); // email -> {id,email,name,password}
users.set("demo@bloop.do", {
  id: "u_demo",
  email: "demo@bloop.do",
  name: "demo blob",
  password: "blob123"
});
const sessions = new Map(); // token -> userId
const conversations = new Map(); // id -> {id,title,model,updated_at,messages[]}
const memories = [
  { id: "mem_1", content: "prefers terse answers with bullet points", created_at: new Date(Date.now() - 86400e3).toISOString() }
];
const servers = [
  { id: "srv_gh", name: "github", url: "https://mcp.github.example/sse", source: "global", state: "ok", tool_count: 24 },
  { id: "srv_dw", name: "deepwiki", url: "https://mcp.deepwiki.example/sse", source: "global", state: "ok", tool_count: 3 },
  { id: "srv_err", name: "legacy-crm", url: "https://mcp.crm.example/sse", source: "global", state: "error", tool_count: 8 }
];
const models = [
  { id: "gpt-5.6-terra", label: "terra · strongest", default: false },
  { id: "gpt-5.6-sol", label: "sol · balanced", default: true },
  { id: "gpt-5.6-luna", label: "luna · fastest", default: false },
  { id: "gpt-5.5", label: "gpt-5.5 · legacy", default: false }
];

// ── helpers ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function authedUser(req) {
  const t = cookies(req).bloop_session;
  const uid = t && sessions.get(t);
  if (!uid) return null;
  for (const u of users.values()) if (u.id === uid) return u;
  return null;
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── chat stream ──────────────────────────────────────────────────
async function streamChat(req, res, body, user) {
  const convo = conversations.get(body.conversation_id);
  const message = String(body.message ?? "");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  const lower = message.toLowerCase();
  const wantsImage = /image|picture|draw|paint|blob/.test(lower);
  const wantsCode = /python|code|fibonacci|run|compute|plot/.test(lower);
  const wantsRemember = /remember/.test(lower);
  const wantsForget = /forget/.test(lower);
  const mode = ["default", "think", "deep"].includes(body.mode) ? body.mode : "default";
  const wantsDeep = mode === "deep" || /research|deep/.test(lower);
  const wantsHandoff = /login|log in|browser|handoff/.test(lower);
  const persistedParts = [];

  sse(res, "mode", { mode });
  for (const s of ["github", "deepwiki", "legacy-crm"]) sse(res, "server", { name: s, state: "connecting" });
  await sleep(300);
  sse(res, "server", { name: "github", state: "connected", tools: 24 });
  await sleep(180);
  sse(res, "server", { name: "deepwiki", state: "connected", tools: 3 });
  await sleep(160);
  sse(res, "server", { name: "legacy-crm", state: "error" });
  await sleep(150);

  sse(res, "tools_loaded", { names: ["github.list_repos", "github.create_issue", "memory.remember", "image.generate", "python.run"] });
  await sleep(250);

  sse(res, "plan", {
    steps: [
      { title: "load tools and context", status: "done" },
      { title: "do the thing", status: "active" },
      { title: "verify and report", status: "pending" }
    ]
  });
  await sleep(250);

  if (wantsRemember) {
    const content = message.replace(/^.*?remember( that)?/i, "").trim() || message;
    const mem = { id: id("mem"), content, created_at: new Date().toISOString() };
    memories.unshift(mem);
    sse(res, "memory", { action: "remember", content });
    await sleep(200);
  }
  if (wantsForget) {
    const gone = memories.shift();
    sse(res, "memory", { action: "forget", content: gone?.content ?? "nothing to forget" });
    await sleep(200);
  }

  if (wantsHandoff) {
    sse(res, "handoff", { url: "https://github.com/login", reason: "github needs you to sign in (2fa) before i can open your private repos.", session_id: "bs_demo" });
    persistedParts.push({ kind: "handoff", url: "https://github.com/login", reason: "github needs you to sign in (2fa) before i can open your private repos." });
    await sleep(200);
  }

  if (wantsDeep) {
    // two parallel direct calls, then a delegated subagent that streams text
    sse(res, "tool_call", { id: "tc_p1", name: "web.search", app: "bloop", args: { q: message.slice(0, 40) } });
    sse(res, "tool_call", { id: "tc_p2", name: "deepwiki.ask", app: "deepwiki", args: { repo: "karanxa1/swarm" } });
    await sleep(700);
    sse(res, "tool_result", { id: "tc_p1", ok: true, ms: 690, output: "5 results" });
    await sleep(250);
    sse(res, "tool_result", { id: "tc_p2", ok: false, ms: 940, output: "rate limited" });
    sse(res, "tool_call", { id: "tc_del", name: "delegate", app: "bloop", args: { task: "compare the top 3 sources" } });
    sse(res, "subagent_start", { id: "sa_1", task: "compare the top 3 sources and extract pricing" });
    await sleep(250);
    for (const w of "reading the three pages side by side… ".split(" ")) { sse(res, "subagent_delta", { id: "sa_1", text: w + " " }); await sleep(40); }
    sse(res, "tool_call", { id: "tc_s1", name: "browser.open", app: "bloop", args: { url: "https://example.com/pricing" }, parent: "sa_1" });
    sse(res, "tool_call", { id: "tc_s2", name: "browser.open", app: "bloop", args: { url: "https://vercel.com/pricing" }, parent: "sa_1" });
    await sleep(900);
    sse(res, "tool_result", { id: "tc_s1", ok: true, ms: 880, output: "pricing: $0 / $20 / custom", parent: "sa_1" });
    sse(res, "tool_result", { id: "tc_s2", ok: true, ms: 905, output: "hobby / pro / enterprise", parent: "sa_1" });
    const items = [
      { url: "https://example.com/pricing", title: "example pricing" },
      { url: "https://vercel.com/pricing", title: "vercel — pricing" },
      { url: "https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API", title: "view transition api — mdn" }
    ];
    sse(res, "sources", { items: items.slice(0, 2) });
    await sleep(300);
    sse(res, "sources", { items });
    sse(res, "subagent_end", { id: "sa_1", ok: true, summary: "all three offer a **free tier**; paid plans start at $20/mo." });
    sse(res, "tool_result", { id: "tc_del", ok: true, ms: 1900, output: "subagent finished" });
    persistedParts.push(
      { kind: "tool", id: "tc_p1", name: "web.search", app: "bloop", args: {}, ok: true, ms: 690, output: "5 results" },
      { kind: "tool", id: "tc_del", name: "delegate", app: "bloop", args: {}, ok: true, ms: 1900, output: "subagent finished" },
      { kind: "subagent", id: "sa_1", task: "compare the top 3 sources and extract pricing", ok: true, summary: "all three offer a **free tier**; paid plans start at $20/mo.", tools: [
        { id: "tc_s1", name: "browser.open", app: "bloop", args: { url: "https://example.com/pricing" }, ok: true, ms: 880, output: "pricing" },
        { id: "tc_s2", name: "browser.open", app: "bloop", args: {}, ok: true, ms: 905, output: "plans" }
      ] },
      { kind: "sources", items }
    );
    await sleep(200);
  }

  sse(res, "tool_call", { id: "tc_1", name: "github.list_repos", app: "github", args: { per_page: 5 } });
  await sleep(400);
  sse(res, "tool_result", { id: "tc_1", ok: true, ms: 412, output: "bloop-evals\nswarm\nlanding-copy" });
  sse(res, "delta", { text: "on it — " });
  await sleep(200);

  if (wantsCode) {
    sse(res, "code", {
      language: "python",
      source: "a, b = 0, 1\nout = []\nfor _ in range(20):\n    out.append(a)\n    a, b = b, a + b\nprint(out)",
      output: "[0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181]",
      ok: true
    });
    await sleep(300);
  }

  if (wantsImage) {
    sse(res, "image", { url: "/files/demo-image", prompt: message.slice(0, 80) });
    await sleep(300);
  }

  sse(res, "tool_call", { id: "tc_2", name: "github.create_issue", app: "github", args: { repo: "bloop-evals", title: "demo issue" } });
  await sleep(450);
  sse(res, "tool_result", { id: "tc_2", ok: true, ms: 640, output: "created #42 in karanxa1/bloop-evals" });
  sse(res, "plan", {
    steps: [
      { title: "load tools and context", status: "done" },
      { title: "do the thing", status: "done" },
      { title: "verify and report", status: "active" }
    ]
  });
  await sleep(250);

  sse(res, "verify", {
    claim: "issue #42 exists in karanxa1/bloop-evals",
    evidence: "GET /repos/karanxa1/bloop-evals/issues/42 → 200",
    app: "github",
    hash: "9f2a41c8d3e7b105"
  });
  await sleep(200);

  const reply =
    "done. here's the receipt:\n\n- listed your repos via **github**\n- filed the issue and **verified it by replay**\n\nanything else?";
  for (const chunk of reply.split(" ")) {
    sse(res, "delta", { text: chunk + " " });
    await sleep(30);
  }

  // persist
  if (convo) {
    convo.messages.push({ role: "user", content: message });
    convo.messages.push({
      role: "assistant",
      content: reply,
      parts: [...persistedParts, { kind: "text", text: reply }]
    });
    convo.updated_at = new Date().toISOString();
    if (convo.title === "new chat") convo.title = message.slice(0, 42) || "new chat";
    convo.model = body.model ?? convo.model;
  }

  sse(res, "plan", {
    steps: [
      { title: "load tools and context", status: "done" },
      { title: "do the thing", status: "done" },
      { title: "verify and report", status: "done" }
    ]
  });
  sse(res, "done", { conversation_id: body.conversation_id });
  res.end();
}

// ── router ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === "/api/health") {
      return send(res, 200, { ok: true, model: "gpt-5.6-sol", servers });
    }

    // files — serve the hero image as the demo artifact
    if (path.startsWith("/files/")) {
      res.writeHead(200, { "content-type": "image/webp" });
      return res.end(hero);
    }

    // ── auth ──
    if (path === "/api/auth/me") {
      const u = authedUser(req);
      if (!u) return send(res, 401, { error: "not signed in" });
      return send(res, 200, { id: u.id, email: u.email, name: u.name });
    }
    if (path === "/api/auth/signup" && method === "POST") {
      const b = await readBody(req);
      if (!b.invite_code || b.invite_code === "invalid")
        return send(res, 403, { error: "invalid invite code" });
      if (users.has(b.email)) return send(res, 409, { error: "email already registered" });
      const u = { id: id("u"), email: b.email, name: b.name || b.email, password: b.password };
      users.set(u.email, u);
      const t = id("sess");
      sessions.set(t, u.id);
      return send(res, 201, { id: u.id, email: u.email, name: u.name }, { "set-cookie": `bloop_session=${t}; Path=/; HttpOnly` });
    }
    if (path === "/api/auth/login" && method === "POST") {
      const b = await readBody(req);
      const u = users.get(b.email);
      if (!u || u.password !== b.password) return send(res, 401, { error: "wrong email or password" });
      const t = id("sess");
      sessions.set(t, u.id);
      return send(res, 200, { id: u.id, email: u.email, name: u.name }, { "set-cookie": `bloop_session=${t}; Path=/; HttpOnly` });
    }
    if (path === "/api/auth/logout" && method === "POST") {
      const t = cookies(req).bloop_session;
      if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, { "set-cookie": "bloop_session=; Path=/; Max-Age=0" });
    }

    // everything below requires auth
    const u = authedUser(req);
    if (!u) return send(res, 401, { error: "not signed in" });

    // ── conversations ──
    if (path === "/api/conversations" && method === "GET") {
      const list = [...conversations.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(({ messages, ...c }) => c);
      return send(res, 200, list);
    }
    if (path === "/api/conversations" && method === "POST") {
      const c = {
        id: id("cv"),
        title: "new chat",
        model: "gpt-5.6-sol",
        updated_at: new Date().toISOString(),
        messages: []
      };
      conversations.set(c.id, c);
      return send(res, 200, { id: c.id, title: c.title });
    }
    const cm = path.match(/^\/api\/conversations\/([^/]+)$/);
    if (cm) {
      const c = conversations.get(cm[1]);
      if (!c) return send(res, 404, { error: "not found" });
      if (method === "GET") return send(res, 200, c);
      if (method === "PATCH") {
        const b = await readBody(req);
        if (b.title) c.title = b.title;
        c.updated_at = new Date().toISOString();
        return send(res, 200, { id: c.id, title: c.title });
      }
      if (method === "DELETE") {
        conversations.delete(cm[1]);
        return send(res, 200, { ok: true });
      }
    }

    // ── chat ──
    if (path === "/api/chat" && method === "POST") {
      const b = await readBody(req);
      return streamChat(req, res, b, u);
    }

    // ── models ──
    if (path === "/api/models") return send(res, 200, models);

    // ── memories ──
    if (path === "/api/memories" && method === "GET") return send(res, 200, memories);
    if (path === "/api/memories" && method === "POST") {
      const b = await readBody(req);
      const m = { id: id("mem"), content: b.content, created_at: new Date().toISOString() };
      memories.unshift(m);
      return send(res, 200, m);
    }
    const mm = path.match(/^\/api\/memories\/([^/]+)$/);
    if (mm && method === "DELETE") {
      const i = memories.findIndex((m) => m.id === mm[1]);
      if (i >= 0) memories.splice(i, 1);
      return send(res, 200, { ok: true });
    }

    // ── servers ──
    if (path === "/api/servers" && method === "GET") return send(res, 200, servers);
    if (path === "/api/servers" && method === "POST") {
      const b = await readBody(req);
      if (!b.name || !b.url || !/^https?:\/\//.test(b.url))
        return send(res, 400, { error: "name and a valid url are required" });
      const s = {
        id: id("srv"),
        name: b.name,
        url: b.url,
        source: "user",
        state: "ok",
        tool_count: Math.floor(Math.random() * 12) + 1
      };
      servers.push(s);
      return send(res, 200, s);
    }
    const sm = path.match(/^\/api\/servers\/([^/]+)$/);
    if (sm && method === "DELETE") {
      const i = servers.findIndex((s) => s.id === sm[1]);
      if (i >= 0) servers.splice(i, 1);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`bloop mock api on http://localhost:${PORT}`);
});
