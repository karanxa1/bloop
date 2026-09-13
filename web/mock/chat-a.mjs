/**
 * Package A mock: turn-by-turn steps (thinking → tool → thinking → tool),
 * a failing tool with error_kind + retries, skill events, citations, an
 * MCP Apps view with a working postMessage bridge, and chat attachments
 * (workspace upload + raw preview).
 *
 * Trigger the steps demo with a chat message containing "steps", "app",
 * "skill" or "timeline". Registered from server.mjs (import + 2 hooks).
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const wantsStepsDemo = (message) => /\b(steps|app|skill|timeline)\b/i.test(String(message ?? ""));

const LONG_ISSUES = Array.from({ length: 60 }, (_, i) =>
  `#${120 + i}  ${["fix flaky ci on main", "composer loses draft", "add dark mode tokens", "mcp oauth refresh", "proof trace scroll jank"][i % 5]}  (opened ${i + 1}d ago)`
).join("\n");

const BOARD = {
  columns: [
    { name: "open", count: 12 },
    { name: "in review", count: 4 },
    { name: "shipped", count: 9 }
  ]
};

// ── tiny MCP Apps view (runs sandboxed at an opaque origin) ─────────
const DEMO_APP_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#262626}
  body{margin:0;padding:12px;background:#fff}
  h1{font-size:13px;margin:0 0 8px;font-weight:700;color:#5c8a2c}
  .cols{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;min-height:58px}
  .col{border:1px solid #e5e5e5;border-left:2px solid #8dc63f;padding:8px}
  .n{font-size:22px;font-weight:700} .l{font-size:11px;color:#737373}
  .row{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  button{border-radius:999px;border:1px solid #d4d4d4;background:#fff;padding:4px 10px;font:600 11px Inter,system-ui;cursor:pointer}
  button:hover{border-color:#8dc63f;color:#5c8a2c}
  pre{font-size:10px;color:#737373;white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto}
</style></head><body>
<h1>status board</h1>
<div class="cols" id="cols"></div>
<div class="row">
  <button id="refresh">refresh (tools/call)</button>
  <button id="ask">ask bloop to summarize</button>
  <button id="link">open docs</button>
  <button id="full">full screen</button>
</div>
<pre id="log">connecting to host…</pre>
<script>
  let seq = 0; const pending = new Map();
  const log = (t) => { document.getElementById("log").textContent = t; };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const render = (board) => {
    const root = document.getElementById("cols");
    root.replaceChildren(...board.columns.map((c) => {
      const col = document.createElement("div"); col.className = "col";
      const n = document.createElement("div"); n.className = "n"; n.textContent = String(c.count);
      const l = document.createElement("div"); l.className = "l"; l.textContent = c.name;
      col.append(n, l); return col;
    }));
    notify("ui/notifications/size-changed", { width: document.body.scrollWidth, height: document.documentElement.scrollHeight });
  };
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result); return;
    }
    if (m.method === "ui/notifications/tool-input") log("tool input: " + JSON.stringify(m.params.arguments));
    if (m.method === "ui/notifications/tool-result") {
      const s = m.params.structuredContent;
      if (s && s.columns) render(s); else { try { render(JSON.parse(m.params.content[0].text)); } catch {} }
    }
    if (m.method === "ui/notifications/host-context-changed") log("display mode: " + m.params.displayMode);
  });
  document.getElementById("refresh").onclick = async () => {
    try { const r = await rpc("tools/call", { name: "get_board", arguments: {} }); render(r.structuredContent); log("refreshed via host bridge"); }
    catch (err) { log("tools/call failed: " + err.message); }
  };
  document.getElementById("ask").onclick = () =>
    rpc("ui/message", { role: "user", content: [{ type: "text", text: "summarize the status board in one line" }] })
      .then(() => log("sent a message to bloop")).catch((err) => log(err.message));
  document.getElementById("link").onclick = () => rpc("ui/open-link", { url: "https://modelcontextprotocol.io" }).catch((err) => log(err.message));
  let full = false;
  document.getElementById("full").onclick = async () => { const r = await rpc("ui/request-display-mode", { mode: full ? "inline" : "fullscreen" }); full = r.mode === "fullscreen"; };
  rpc("ui/initialize", { protocolVersion: "2026-01-26", clientInfo: { name: "status-board", version: "1" }, capabilities: {} })
    .then((r) => { log("host: " + r.hostInfo.name + " · " + r.hostContext.displayMode); notify("ui/notifications/initialized", {}); })
    .catch(() => log("host did not answer ui/initialize"));
</script></body></html>`;

// ── attachments (in-memory) ─────────────────────────────────────────
const uploads = new Map(); // `${conv}|${path}` -> { mime, data }

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function parseMultipart(buf, boundary) {
  const out = [];
  const sep = Buffer.from(`--${boundary}`);
  let start = buf.indexOf(sep);
  while (start !== -1) {
    const next = buf.indexOf(sep, start + sep.length);
    if (next === -1) break;
    const part = buf.subarray(start + sep.length + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd > 0) {
      const head = part.subarray(0, headEnd).toString();
      const name = head.match(/filename="([^"]*)"/);
      const type = head.match(/content-type:\s*([^\r\n]+)/i);
      if (name) out.push({ filename: name[1], mime: type?.[1]?.trim() ?? "application/octet-stream", data: part.subarray(headEnd + 4) });
    }
    start = next;
  }
  return out;
}

/** routes: /files/mcpapp/* · POST /api/mcp/call · workspace upload/raw. Returns true when handled. */
export async function handleChatA(req, res, path, method) {
  if (path.startsWith("/files/mcpapp/")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; sandbox allow-scripts allow-forms"
    });
    res.end(method === "HEAD" ? undefined : DEMO_APP_HTML);
    return true;
  }

  if (path === "/api/mcp/call" && method === "POST") {
    let b = {};
    try { b = JSON.parse((await readRaw(req)).toString() || "{}"); } catch { /* empty */ }
    await sleep(350);
    const board = { columns: BOARD.columns.map((c) => ({ ...c, count: c.count + Math.floor(Math.random() * 4) })) };
    json(res, 200, b.tool === "get_board"
      ? { ok: true, output: JSON.stringify(board), structured: board }
      : { ok: false, output: `unknown tool ${b.tool} on ${b.server}` });
    return true;
  }

  const up = path.match(/^\/api\/workspace\/([^/]+)\/upload$/);
  if (up && method === "POST") {
    const conv = decodeURIComponent(up[1]);
    const boundary = (req.headers["content-type"] ?? "").match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!boundary) return json(res, 400, { error: "multipart body required" }), true;
    const body = await readRaw(req);
    if (body.length > 100 * 1024 * 1024) return json(res, 413, { error: "request too large" }), true;
    const files = parseMultipart(body, boundary[1] ?? boundary[2]);
    if (files.some((f) => f.data.length > 25 * 1024 * 1024)) return json(res, 413, { error: "file over 25 mb" }), true;
    await sleep(200);
    json(res, 200, files.map((f) => {
      const p = `uploads/${f.filename.replace(/^\/+/, "").replace(/\.\.\//g, "")}`;
      uploads.set(`${conv}|${p}`, { mime: f.mime, data: f.data });
      return { path: p, bytes: f.data.length, mime: f.mime };
    }));
    return true;
  }

  const raw = path.match(/^\/api\/workspace\/([^/]+)\/raw$/);
  if (raw && method === "GET") {
    const q = new URL(req.url, "http://x").searchParams.get("path") ?? "";
    const hit = uploads.get(`${decodeURIComponent(raw[1])}|${q}`);
    if (!hit) return json(res, 404, { error: "not found" }), true;
    const image = /^image\/(png|jpeg|webp|gif)$/.test(hit.mime);
    res.writeHead(200, {
      "content-type": hit.mime,
      "x-content-type-options": "nosniff",
      ...(image ? {} : { "content-disposition": `attachment; filename="${q.split("/").pop()}"` })
    });
    res.end(hit.data);
    return true;
  }

  return false;
}

/** streams the full demo turn, persists it, sends done and ends the response */
export async function streamStepsDemo(res, body, convo) {
  const message = String(body.message ?? "");
  const parts = [];
  const text = async (t, ms = 22) => {
    for (const w of t.split(/(?<= )/)) { sse(res, "delta", { text: w }); await sleep(ms); }
  };

  sse(res, "mode", { mode: "default" });
  for (const s of ["github", "dashboard", "legacy-crm"]) sse(res, "server", { name: s, state: "connecting" });
  await sleep(250);
  sse(res, "server", { name: "github", state: "ok", tools: 24 });
  sse(res, "server", { name: "dashboard", state: "ok", tools: 2 });
  sse(res, "server", { name: "legacy-crm", state: "ok", tools: 8 });
  await sleep(150);

  sse(res, "skill", { action: "use", name: "weekly-status" });
  parts.push({ kind: "skill", action: "use", name: "weekly-status" });
  await sleep(200);

  const thought = "the user wants a status board. i'll pull open issues first, then fetch ci runs and the crm account in parallel, and render a board app.";
  for (const w of thought.split(/(?<= )/)) { sse(res, "thinking", { text: w }); await sleep(18); }
  parts.push({ kind: "thinking", text: thought });

  const n1 = "let me look at the open issues first.";
  await text(n1);
  parts.push({ kind: "text", text: n1 });
  sse(res, "tool_call", { id: "tc_a1", name: "github.list_issues", app: "github", args: { repo: "karanxa1/swarm", state: "open" } });
  await sleep(600);
  sse(res, "tool_result", { id: "tc_a1", ok: true, ms: 588, output: LONG_ISSUES });
  parts.push({ kind: "tool", id: "tc_a1", name: "github.list_issues", app: "github", args: { repo: "karanxa1/swarm" }, ok: true, ms: 588, output: LONG_ISSUES });

  const n2 = "12 open. now the ci runs and the crm account, in parallel.";
  await text(n2);
  parts.push({ kind: "text", text: n2 });
  sse(res, "tool_call", { id: "tc_a2", name: "github.list_workflow_runs", app: "github", args: { branch: "main" } });
  sse(res, "tool_call", { id: "tc_a3", name: "legacy-crm.get_account", app: "legacy-crm", args: { account: "acme" } });
  await sleep(900);
  sse(res, "tool_result", { id: "tc_a2", ok: true, ms: 870, output: "run 812: success\nrun 811: failure (flaky test)\nrun 810: success" });
  await sleep(700);
  sse(res, "tool_result", { id: "tc_a3", ok: false, ms: 10040, output: "upstream timed out after 10s", error_kind: "timeout", retries: 2 });
  sse(res, "server", { name: "legacy-crm", state: "degraded", tools: 8 });
  parts.push(
    { kind: "tool", id: "tc_a2", name: "github.list_workflow_runs", app: "github", args: {}, ok: true, ms: 870, output: "run 812: success" },
    { kind: "tool", id: "tc_a3", name: "legacy-crm.get_account", app: "legacy-crm", args: {}, ok: false, ms: 10040, output: "upstream timed out after 10s", error_kind: "timeout", retries: 2 }
  );

  const n3 = "the crm timed out twice — continuing without it and rendering the board.";
  await text(n3);
  parts.push({ kind: "text", text: n3 });
  sse(res, "tool_call", { id: "tc_a4", name: "dashboard.render_board", app: "dashboard", args: { open: 12, review: 4, shipped: 9 } });
  await sleep(500);
  sse(res, "tool_result", { id: "tc_a4", ok: true, ms: 480, output: JSON.stringify(BOARD) });
  const app = { id: "tc_a4", server: "dashboard", tool: "render_board", uri: "ui://dashboard/board", url: "/files/mcpapp/demo.html" };
  sse(res, "mcp_app", app);
  parts.push(
    { kind: "tool", id: "tc_a4", name: "dashboard.render_board", app: "dashboard", args: {}, ok: true, ms: 480, output: JSON.stringify(BOARD) },
    { kind: "mcp_app", ...app }
  );
  await sleep(300);

  sse(res, "skill", { action: "create", name: "status-board" });
  parts.push({ kind: "skill", action: "create", name: "status-board" });
  const items = [
    { url: "https://github.com/karanxa1/swarm/issues", title: "issues · karanxa1/swarm" },
    { url: "https://github.com/karanxa1/swarm/actions", title: "actions · karanxa1/swarm" }
  ];
  sse(res, "sources", { items });
  parts.push({ kind: "sources", items });
  await sleep(150);

  const reply =
    "here's the board:\n\n- **12 open** issues, 4 in review [1]\n- ci on main is green except one flaky run [2]\n- crm data is missing — `legacy-crm` timed out, so account health isn't included\n\ni saved this as the **status-board** skill so next week is one click.";
  await text(reply, 28);
  parts.push({ kind: "text", text: reply });

  if (convo) {
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    convo.messages.push({
      role: "user",
      content: message,
      parts: [...attachments.map((a) => ({ kind: "attachment", ...a })), { kind: "text", text: message }]
    });
    convo.messages.push({ role: "assistant", content: reply, parts });
    convo.updated_at = new Date().toISOString();
    if (convo.title === "new chat") convo.title = message.slice(0, 42) || "new chat";
  }
  sse(res, "done", { conversation_id: body.conversation_id });
  res.end();
}
