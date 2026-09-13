# bloop — handoff to Claude Code

Production-grade multi-app AI agent for the Multi-App AI Agent Hackathon. Everything below is verified against the live deployment.

## Live state

| | |
|---|---|
| App | https://bloop.rough-cell-383c.workers.dev — landing at `/`, app at `/app` |
| Repo | https://github.com/karanxa1/bloop (public, `main`) |
| Test login | `karan@bloop.dev` / `testpass123` |
| Eval suite | **6/6 pass** on prod — `BLOOP_API=https://bloop.rough-cell-383c.workers.dev EVAL_TOKEN=<see core/.dev.vars> node evals/run.mjs` |
| Playwright | 13/13 checks — script at `/tmp/bloop-check/check-v3.mjs` |

## Architecture

```
/        → landing (web/public/landing, copied at build time from landing/)
/app     → React SPA (web/)
/api/*   → Rust/WASM worker (core/) — auth-guarded
/files/* → R2-served generated images, auth-guarded
sandbox  → separate worker bloop-sandbox (@cloudflare/sandbox containers)
           reached via SANDBOX service binding (not public HTTP)
```

- **Backend**: `core/` Rust workers-rs. All state in **D1** (`bloop-db`, id `4553b829-…`), sessions in **KV** (`SESSIONS`), files in **R2** (`FILES`), sandbox via **service binding** (`SANDBOX`).
- **Models**: Azure OpenAI, gpt-5.6 family only — `gpt-5.6-terra` (primary), `gpt-5.6-sol` (fallback + summary regen), `gpt-5.6-luna`. Endpoint `https://callmissed-resource.cognitiveservices.azure.com`, api-version `2025-04-01-preview`.
- **MCP servers**: github (47 tools), deepwiki, context7, cf-docs — plus per-user servers from D1 `servers` table. Optional env servers: `ZAPIER_MCP_URL`, `COMPOSIO_MCP_URL`, `EXTRA_MCP_*`.

## API surface (all under `core/src/lib.rs`)

```
GET  /api/health                        public
POST /api/auth/signup|login|logout      public (signup needs INVITE_CODE)
GET  /api/auth/me
POST /api/chat                          SSE; accepts session cookie OR Bearer $EVAL_TOKEN (non-persistent eval caller)
GET/POST      /api/conversations        + GET/PATCH/DELETE /api/conversations/:id
GET/POST      /api/memories             + DELETE /api/memories/:id
GET/POST      /api/servers              + DELETE /api/servers/:id
GET  /api/models                        → [{id,label}] from config::MODELS
GET  /api/ledger                        hash-chained attestation ledger
GET  /files/:key                        R2 object, auth-guarded
```

## SSE event contract (`POST /api/chat` body: `{message, conversation_id?, model?}`)

```
delta         {text}                        streamed answer text
plan          {steps:[{title,status}]}      update_plan built-in
tool_call     {id,name,app,args}            call started
tool_result   {id,name,app,ok,ms,output}    call finished (output truncated 800ch)
verify        {claim,evidence,app,hash}     attest built-in → ledger
memory        {action:"remember"|"forget", content}
image         {url:"/files/img/…", prompt}  generate_image built-in (also persisted as message part)
code          {language,source,output,ok}   run_code built-in
tools_loaded  {names:[…]}                   load_tools built-in
server        {name,state,tools}            MCP connect result (per run)
error         {message}
done          {}
```

Persisted assistant messages store `parts_json`: array of `{kind:"text"|"tool"|"image"|"code", …}` — `replay_messages()` in agent.rs re-folds these into OpenAI wire messages.

## Key files

| file | what |
|---|---|
| `core/src/agent.rs` | agentic loop, built-in tool dispatch, system prompt, history replay, summary regen |
| `core/src/lib.rs` | routing, auth guard, asset serving, `/` → `/landing/index.html` rewrite |
| `core/src/azure.rs` | `chat_deltas` (SSE stream), `chat_once`, `generate_image` |
| `core/src/mcp.rs` | streamable-HTTP MCP client + `probe()` (5s timeout health check) |
| `core/src/db.rs` | D1 helpers; `core/schema.sql` is the schema |
| `core/src/auth.rs` | PBKDF2 pw, KV sessions, EVAL_TOKEN bearer for /api/chat |
| `core/wrangler.toml` | bindings + vars + `deleted_classes=["ChatAgent"]` migration |
| `web/src/` | React SPA: App.tsx state machine, sse.ts parser, components/ |
| `web/src/logos.ts` + `components/ServerLogo.tsx` | real brand SVGs (simple-icons CC0) + monogram fallback |
| `sandbox/` | TS worker, @cloudflare/sandbox, POST /run {code,language} |
| `evals/run.mjs` | 6-task eval harness with external `gh` ground-truth checks |

## ⚠️ Known footguns

1. **Never run `npx wrangler deploy` from repo root** — root `wrangler.jsonc` is the old TS starter and will overwrite prod (happened once; fixed via `deleted_classes` migration). Always: `cd core && npx wrangler deploy --config wrangler.toml`.
2. **workers.dev → workers.dev fetch is banned** (error 1042). Sandbox calls MUST go through the `SANDBOX` service binding; `SANDBOX_URL` is only a local-dev fallback.
3. **Secrets live in `core/.dev.vars`** (gitignored). Upload via `wrangler secret put`. `.dev.vars` uses bare `KEY=value` (no quotes).
4. Remote D1 schema: `wrangler d1 execute bloop-db --remote --file schema.sql` — required once per fresh DB.
5. `EVAL_TOKEN` bearer works ONLY on `/api/chat`; every other `/api/*` needs a session cookie.
6. Landing images must use absolute `/landing/assets/…` paths (page is served at `/` via rewrite).

## In-flight work — v3 (spec'd, NOT yet implemented)

Requested most recently, research done, zero code written yet. SSE contract additions below are the intended design — adjust freely.

### 1. Context file + lessons file
- New D1 table: `user_files(user_id, kind TEXT CHECK(kind IN ('context','lessons')), content TEXT, updated_at)` — PK `(user_id, kind)`
- REST: `GET/PUT /api/files/:kind` (or `/api/context`, `/api/lessons`)
- Built-ins: `update_context(markdown)` (overwrite context file), `save_lesson(lesson)` (append to lessons file)
- Inject both into `system_prompt()` alongside memories — cap context file ~4k chars, lessons ~2k
- UI: extend `MemoriesModal` into tabs: memories | context | lessons (markdown editors)

### 2. Cloudflare Browser Run (browser-use + user handoff)
- No `CLOUDFLARE_API_TOKEN` in env — wrangler auth is OAuth. **Agent-side browsing needs NO token** via a `browser` binding; **live-view handoff needs an API token** (`CF_ACCOUNT_ID` = `337c662fed500c2dff530141baaf75c9`, ask user to create token w/ Browser Rendering Edit).
- Sandbox worker additions (`sandbox/` is TS):
  - `browser = { binding = "BROWSER" }` in its wrangler.toml + `@cloudflare/puppeteer`
  - `POST /browser/fetch {url, mode:"markdown"|"screenshot"}` → text or base64 png
  - `POST /browser/session` → `puppeteer.launch(env.BROWSER, {keep_alive:600000})`, store sessionId, return it
  - `POST /browser/handoff {sessionId}` → if `CF_BROWSER_TOKEN` set: REST `GET /devtools/browser/{id}/json/list` → `devtoolsFrontendUrl` (live.browser.run hosted UI — user clicks/types in the remote browser, e.g. to log in); else 501
- Rust built-ins: `browse(url)` → sandbox `/browser/fetch`; `browser_handoff(reason)` → emits new SSE `handoff {url, reason, session_id}` → UI shows "take over" card
- Gotchas: free tier 3 concurrent sessions, 10-min max keep_alive; always `browser.close()` or sessions leak; store sessionId in KV for reuse.

### 3. Parallel tool calls
- `agent.rs` loop currently executes `reply.calls` sequentially. Azure already returns multiple tool_calls; run them concurrently (`futures::future::join_all`) and emit `tool_result` frames in index order. MCP calls through the same `McpClient` may need per-call serialize or per-client split — simplest: parallelize across different servers, serialize within a server.

### 4. Subagents (`delegate` built-in)
- `delegate(task, tools_hint?)` → nested agent loop: same model, read-only MCP tools + run_code only, max ~8 iters, no persist. SSE: `subagent_start {id,task}` / `subagent_end {id,ok,summary}`; tool events inside carry `parent: id`. UI: collapsible nested card.

### 5. Modes (Grok-style toggles)
- `{mode:"think"}` → forces a visible plan-first pass; `{mode:"deep"}` → MAX_ITERS→25 + prompt addendum "research iteratively, read ≥2 sources, cite URLs" + collect `sources[]` from browse/MCP results → `sources` SSE event + chips UI.

### 6. Animations / polish
- Thinking indicator: 3-blob bounce or shimmer on streaming text (CSS keyframes, `motion-safe` gated)
- View Transitions API for conversation switching (`document.startViewTransition`)
- transitions.dev (ssgoi) was suggested by user but plain View Transitions likely suffices

## Deployment / verify loop

```bash
cd web && npm run build                          # copies landing → public, vite build
cd core && npx wrangler deploy --config wrangler.toml
BLOOP_API=https://bloop.rough-cell-383c.workers.dev EVAL_TOKEN=$(grep '^EVAL_TOKEN' .dev.vars | cut -d= -f2-) node ../evals/run.mjs
# playwright: /tmp/bloop-check/check-v3.mjs (npm i playwright in /tmp, keep repo clean)
```

Commit often in logical units with the Devin trailer (see `git log` style). Push to `main`.
