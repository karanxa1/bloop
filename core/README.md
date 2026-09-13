# bloop core — Cloudflare Worker backend (Rust / workers-rs)

The agentic backend for **bloop**, a general AI agent. Rust compiled to WASM
via [workers-rs](https://github.com/cloudflare/workers-rs).

## Architecture

- `src/lib.rs` — fetch router: `/api/chat`, `/api/health`, `/api/ledger`, static assets
- `src/agent.rs` — agentic loop (plan → act → verify → report), SSE event stream
- `src/azure.rs` — Azure OpenAI chat completions (streaming + non-stream fallback)
- `src/mcp.rs` — MCP client: JSON-RPC over streamable HTTP, session tracking, SSE frame parsing
- `src/ledger.rs` — in-memory run ledger + sha256 hash-chained attestations
- `src/config.rs` — env/secret bindings

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/chat` | `{"messages":[...]}` → `text/event-stream` agent run |
| GET | `/api/health` | `{"ok":true,"model":"...","servers":[{name,state,tools}]}` |
| GET | `/api/ledger` | JSON trace entries of the last run |
| * | other | static assets from `../web/dist` (ASSETS binding) |

### SSE events emitted by `/api/chat`

`event: <type>\ndata: <json>\n\n` where type ∈
`delta` `{text}` · `tool_call` `{id,name,app,args}` · `tool_result`
`{id,name,app,ok,ms,output}` · `plan` `{steps[]}` · `verify`
`{claim,evidence,app,hash}` · `error` `{message}` · `done` `{}`

## Setup

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build      # needs >= 0.8.x (worker = "0.8")
```

Secrets live in `.dev.vars` (gitignored): `AZURE_OPENAI_API_KEY`,
`GITHUB_TOKEN`, optional `COMPOSIO_MCP_URL` + `COMPOSIO_API_KEY`.
Non-secret config is in `[vars]` in `wrangler.toml`.

## Run

```bash
cd core
wrangler dev --config wrangler.toml --port 8787
```

> **Important:** always pass `--config wrangler.toml`. The repo root has a
> different `wrangler.jsonc` (a separate TypeScript worker also named "bloop")
> that wrangler will pick up otherwise.

## Test

```bash
curl localhost:8787/api/health

curl -N -X POST localhost:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"use github tools: run get_me, then list my 3 most recently updated repos"}]}'

curl localhost:8787/api/ledger
```

## Deploy

```bash
wrangler deploy --config wrangler.toml
# then set secrets: wrangler secret put AZURE_OPENAI_API_KEY / GITHUB_TOKEN
```

## Notes

- Agent loop caps at 15 iterations; tool results truncated to 4k chars for the
  model and 800 chars for SSE `tool_result` events.
- Built-in tools `update_plan` and `attest` are handled internally (not MCP).
- `attest` chains a sha256 hash over `prev_hash + canonical_json(entry)`;
  genesis prev is `"bloop"`.
- The ledger is in-memory (per isolate); it resets on cold start.
- If Azure streaming fails mid-run, the loop falls back to a non-streaming call
  on the same model, then to `AGENT_MODEL_FALLBACK`.
