/**
 * Mock workspace: in-memory FS per conversation, fake exec, and a demo that
 * streams `workspace` events during chat (messages mentioning build/app/file/…).
 * Contract: docs/contracts-v3.md § workspace.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const fsByConv = new Map(); // conv -> Map(path -> {content, binary, size, updated_at})
const fsOf = (conv) => {
  let m = fsByConv.get(conv);
  if (!m) fsByConv.set(conv, (m = new Map()));
  return m;
};
const clean = (p) => String(p ?? "").trim().replace(/^\.?\/+/, "").replace(/\/{2,}/g, "/");
const bad = (p) => !p || p.endsWith("/") || p.split("/").some((s) => s === ".." || s === ".");
const sizeOf = (f) => (f.binary ? f.size : Buffer.byteLength(f.content));
const put = (conv, path, content, binary = false) =>
  fsOf(conv).set(path, { content: binary ? "" : content, binary, size: binary ? content : 0, updated_at: now() });

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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

/** handle /api/workspace/* — returns true when the request was handled */
export async function workspaceRoute(req, res, path, method, url) {
  const m = path.match(/^\/api\/workspace\/([^/]+)\/(files|file|exec)$/);
  if (!m) return false;
  const conv = decodeURIComponent(m[1]);
  const fs = fsOf(conv);
  await sleep(60 + Math.random() * 90);

  if (m[2] === "files" && method === "GET") {
    json(res, 200, [...fs].map(([p, f]) => ({ path: p, bytes: sizeOf(f), updated_at: f.updated_at })));
    return true;
  }
  if (m[2] === "file") {
    if (method === "PUT") {
      const b = await readBody(req);
      const p = clean(b.path);
      if (bad(p) || typeof b.content !== "string") return json(res, 400, { error: "path and content required" }), true;
      put(conv, p, b.content);
      json(res, 200, { ok: true, path: p, bytes: Buffer.byteLength(b.content) });
      return true;
    }
    const p = clean(url.searchParams.get("path"));
    const f = fs.get(p);
    if (!f) return json(res, 404, { error: `no such file: ${p}` }), true;
    if (method === "GET") {
      if (f.binary) json(res, 415, { error: "binary file" });
      else json(res, 200, { path: p, content: f.content });
      return true;
    }
    if (method === "DELETE") {
      fs.delete(p);
      json(res, 200, { ok: true });
      return true;
    }
  }
  if (m[2] === "exec" && method === "POST") {
    const b = await readBody(req);
    json(res, 200, await fakeExec(conv, String(b.command ?? "")));
    return true;
  }
  json(res, 405, { error: `method not allowed: ${method}` });
  return true;
}

async function fakeExec(conv, command) {
  const fs = fsOf(conv);
  const t0 = Date.now();
  const cmd = command.trim();
  const argv = cmd.split(/\s+/);
  let stdout = "";
  let stderr = "";
  let exit_code = 0;
  const changed = [];
  const deleted = [];
  const extra = {};
  await sleep(/^npm/.test(cmd) ? 1300 : 300 + Math.random() * 200);

  if (!cmd) {
    stderr = "empty command";
    exit_code = 2;
  } else if (argv[0] === "ls") {
    const rows = [...fs].sort(([a], [b]) => a.localeCompare(b));
    stdout = argv.includes("-la") || argv.includes("-l")
      ? [`total ${rows.length}`, ...rows.map(([p, f]) => `-rw-r--r--  1 bloop bloop ${String(sizeOf(f)).padStart(6)} Sep 14 12:00 ${p}`)].join("\n")
      : rows.map(([p]) => p).join("  ");
  } else if (cmd === "npm test") {
    if (!fs.has("package.json")) {
      stderr = "npm error code ENOENT\nnpm error could not read package.json";
      exit_code = 254;
    } else {
      stdout = "> starter@0.1.0 test\n> node --test tests/\n\n✔ greets by name (1.2ms)\n✔ counts words (0.4ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0";
      put(conv, "coverage/summary.json", JSON.stringify({ lines: 92.3, branches: 80 }, null, 2) + "\n");
      changed.push("coverage/summary.json");
      extra.skipped = ["node_modules/ (too large to sync)"];
    }
  } else if (/^python3?$/.test(argv[0])) {
    const f = fs.get(clean(argv[1]));
    if (!argv[1] || !f) {
      stderr = `python: can't open file '${argv[1] ?? ""}': [Errno 2] No such file or directory`;
      exit_code = 2;
    } else {
      const prints = [...f.content.matchAll(/print\((?:f?["'])(.*?)["']\)/g)].map((x) => x[1].replace(/\{.*?\}/g, "bloop"));
      stdout = prints.join("\n") || "";
      if (/raise /.test(f.content)) {
        stderr = `Traceback (most recent call last):\n  File "${argv[1]}", line 1, in <module>\nRuntimeError: boom`;
        exit_code = 1;
      }
    }
  } else if (argv[0] === "cat") {
    for (const p of argv.slice(1)) {
      const f = fs.get(clean(p));
      if (!f) { stderr += `cat: ${p}: No such file or directory\n`; exit_code = 1; }
      else stdout += f.binary ? `<binary ${f.size} bytes>\n` : f.content;
    }
  } else if (argv[0] === "touch") {
    for (const p of argv.slice(1).map(clean)) if (!bad(p) && !fs.has(p)) { put(conv, p, ""); changed.push(p); }
  } else if (argv[0] === "rm") {
    for (const p of argv.slice(1).filter((a) => !a.startsWith("-")).map(clean)) {
      if (fs.delete(p)) deleted.push(p);
      else { stderr += `rm: ${p}: No such file or directory\n`; exit_code = 1; }
    }
  } else if (argv[0] === "mv" && argv.length === 3) {
    const [from, to] = [clean(argv[1]), clean(argv[2])];
    const f = fs.get(from);
    if (!f || bad(to)) { stderr = `mv: ${argv[1]}: No such file or directory`; exit_code = 1; }
    else { fs.delete(from); fs.set(to, { ...f, updated_at: now() }); deleted.push(from); changed.push(to); }
  } else if (/^echo\s+.*>\s*\S+$/.test(cmd)) {
    const [, text, file] = cmd.match(/^echo\s+(.*?)\s*>\s*(\S+)$/);
    const p = clean(file);
    put(conv, p, text.replace(/^["']|["']$/g, "") + "\n");
    changed.push(p);
  } else if (argv[0] === "echo") {
    stdout = argv.slice(1).join(" ");
  } else if (cmd === "sync-fail") {
    stdout = "ok";
    extra.sync_error = "sandbox sync timed out after 10s";
  } else {
    stderr = `sh: ${argv[0]}: command not found`;
    exit_code = 127;
  }
  return { stdout, stderr, exit_code, ms: Date.now() - t0, changed, deleted, ...extra };
}

// ── chat demo ────────────────────────────────────────────────────
const README = "# starter\n\nscaffolded by **bloop**.\n\n- `python main.py` — say hi\n- `npm test` — run the tests\n";
const PKG = JSON.stringify({ name: "starter", version: "0.1.0", type: "module", scripts: { test: "node --test tests/" } }, null, 2) + "\n";
const APP_V1 = "export function greet(name: string): string {\n  return `hi, ${name}`;\n}\n";
const APP_V2 = APP_V1 + "\nexport function countWords(text: string): number {\n  return text.split(/\\s+/).filter(Boolean).length;\n}\n";
const PY_V1 = 'def main():\n    print("hello from bloop")\n';
const PY_V2 = PY_V1 + '    print("workspace is live")\n\n\nif __name__ == "__main__":\n    main()\n';
const TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet, countWords } from "../src/app.ts";\n\ntest("greets by name", () => assert.equal(greet("bloop"), "hi, bloop"));\ntest("counts words", () => assert.equal(countWords("a b  c"), 3));\n';
const CSS = ":root {\n  --bloop: #8dc63f;\n}\n\nbody {\n  font-family: system-ui, sans-serif;\n  color: #262626;\n}\n";

export async function workspaceChatDemo(res, conv, message) {
  if (!conv || !/build|app|file|script|workspace|project|scaffold|write/i.test(String(message))) return;
  const emit = (type, data) => !res.writableEnded && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const steps = [
    ["README.md", README],
    ["package.json", PKG],
    ["src/app.ts", APP_V1],
    ["main.py", PY_V1],
    ["src/styles.css", CSS],
    ["assets/logo.png", 48213, true],
    ["src/app.ts", APP_V2],
    ["tests/app.test.ts", TEST],
    ["main.py", PY_V2],
    ["scratch.txt", "temp notes\n"]
  ];
  emit("subagent_start", { id: "sa_ws", task: "scaffold a starter project in the workspace" });
  let i = 0;
  for (const [path, content, binary] of steps) {
    const tid = `tc_ws_${Date.now().toString(36)}_${++i}`;
    emit("tool_call", { id: tid, name: "workspace.write", app: "bloop", args: { path }, parent: "sa_ws" });
    await sleep(450);
    put(conv, path, content, binary);
    emit("workspace", { action: "write", paths: [path] });
    emit("tool_result", { id: tid, ok: true, ms: 440, output: `wrote ${path}`, parent: "sa_ws" });
    await sleep(500);
  }
  fsOf(conv).delete("scratch.txt");
  emit("workspace", { action: "delete", paths: ["scratch.txt"] });
  await sleep(300);
  const tid = `tc_ws_exec_${Date.now().toString(36)}`;
  emit("tool_call", { id: tid, name: "workspace.exec", app: "bloop", args: { command: "python main.py" }, parent: "sa_ws" });
  const r = await fakeExec(conv, "python main.py");
  emit("workspace", { action: "exec", paths: r.changed, command: "python main.py", exit_code: r.exit_code });
  emit("tool_result", { id: tid, ok: r.exit_code === 0, ms: r.ms, output: r.stdout || r.stderr, parent: "sa_ws" });
  emit("subagent_end", { id: "sa_ws", ok: true, summary: "scaffolded **8 files** and ran `python main.py` — open the workspace tab to edit." });
}
