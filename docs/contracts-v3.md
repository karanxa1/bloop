# bloop v3 — frontend ↔ backend contracts (in-flight)

Source of truth for agents building against features whose backend is still landing. Existing SSE events (delta, plan, tool_call, tool_result, verify, memory, file, image, code, tools_loaded, server, mode, handoff, subagent_start/delta/end, sources, workspace, error, done) are implemented — see `web/src/types.ts`.

## New / extended SSE events
- `thinking {text}` — streamed reasoning summary chunk (only if the backend's azure path supports it). Otherwise: assistant text immediately followed by tool calls in the same turn is a **thinking step**; the last text with no following tools is the answer.
- `tool_result` gains optional `error_kind: "timeout"|"transient"|"auth"|"circuit_open"|"invalid_args"|"error"` and `retries: number`.
- `server {name, state: "ok"|"error"|"degraded", tools}` — `degraded` = circuit breaker opened mid-run.
- `skill {action: "use"|"create"|"update", name}`
- `mcp_app {id, server, tool, uri, url}` — `id` = tool call id; `url` = `/files/mcpapp/<sha>.html` (auth-guarded, text/html, sandbox CSP).
- `workspace {action: "write"|"delete"|"exec", paths: string[], command?, exit_code?}`

Persisted parts add `{kind:"thinking", text}` and `{kind:"mcp_app", id, server, tool, uri, url}` (plus existing subagent / sources / handoff).

## REST (session cookie)
### skills
- `GET /api/skills` → `[{id, name, description, body, source: "user"|"agent"|"catalog", enabled, updated_at}]`
- `POST /api/skills {name, description, body}` · `PUT /api/skills/:id {name?, description?, body?, enabled?}` · `DELETE /api/skills/:id`
- `GET /api/skills/catalog` → `[{slug, name, description, body, category, installed}]` · `POST /api/skills/catalog/:slug/install`
### built-in tools
- `GET /api/tools` → `[{name, label, description, category: "core"|"web"|"code"|"media"|"memory"|"agents", enabled, locked}]`
- `PUT /api/tools/:name {enabled}`
### mcp servers / marketplace
- `GET /api/servers/catalog` → `[{slug, name, description, category, url, auth: "none"|"bearer"|"headers"|"oauth", docs_url, logo, featured, installed}]`
- `GET /api/servers` → `[{id, name, url, source: "global"|"user", state: "ok"|"error", tool_count, transport, auth_type, enabled, oauth_status: "connected"|"required"|null, logo?, error?}]` (secrets never returned)
- `POST /api/servers {name, url, transport?: "auto"|"streamable-http"|"sse", auth?: {type, token?, headers?: {k: v}}, catalog_slug?}` → `{id, name, url, state, tool_count, tools: [{name, description}]}` or, for oauth, `{id, oauth_required: true, authorize_url}`
- `PATCH /api/servers/:id {enabled?, name?, headers?, token?}` · `DELETE /api/servers/:id`
- `POST /api/servers/:id/test` → `{state, tool_count, tools, error?, error_kind?}` · `GET /api/servers/:id/tools` → `[{name, description, annotations?, has_ui}]`
- OAuth: open `authorize_url` (`/api/servers/:id/oauth/start`) as a top-level navigation or popup; backend redirects back to `/app?connected=<server_id>`.
### mcp apps bridge
- `POST /api/mcp/call {server, tool, arguments}` → `{ok, output, structured?}`
### workspace
- `GET /api/workspace/:conv/files` → `[{path, bytes, updated_at}]`
- `GET /api/workspace/:conv/file?path=` → `{path, content}` (415 for binary)
- `PUT /api/workspace/:conv/file {path, content}` · `DELETE /api/workspace/:conv/file?path=`
- `POST /api/workspace/:conv/exec {command}` → `{stdout, stderr, exit_code, ms, changed, deleted, skipped?, sync_error?}`

## MCP Apps host (per MCP Apps spec — verify at modelcontextprotocol.io)
Render `url` in `<iframe sandbox="allow-scripts allow-forms">` (never `allow-same-origin`). postMessage JSON-RPC bridge: `ui/initialize` → host context (theme, display mode, tool input/result); `tools/call` → `POST /api/mcp/call` (same server only); `ui/message` → send as a chat message; `ui/open-link` → `window.open(url, "_blank", "noopener")` (http/https only); size-change notifications → resize iframe. Validate `event.source === iframe.contentWindow`.

## Shared-file rules for parallel web agents
- Own your listed files. For shared files (`App.tsx`, `types.ts`, `api.ts`, `sse.ts`, `index.css`, `icons.tsx`, `lib.ts`, `web/mock/server.mjs`) make small anchored edits and **re-read immediately before each edit**.
- Put new API calls/types for your area in a new module (e.g. `web/src/api/skills.ts`) rather than growing `api.ts`.
- Mock server: add your routes/events in `web/mock/<area>.mjs` and register with a single import line in `server.mjs`.
- Don't commit or deploy — the lead does.
