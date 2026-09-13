# bloop — tiny blob. big brain.

A general-purpose AI agent that takes **real, verified actions** across external apps — and proves every one of them.

Built for the Multi-App AI Agent Hackathon (Sept 13, 2026).

## What it does

You give bloop a goal in plain language. It plans the steps, executes them against live apps over MCP, **verifies each mutation by reading it back**, and records a tamper-evident proof trace — a SHA-256 hash-chained attestation ledger you can audit after the fact.

```
plan → act (MCP tools) → verify (independent read-back) → attest (hash-chained) → report
```

## Architecture

| Piece | Tech | Path |
|---|---|---|
| Agent core (backend) | **Rust → WASM on Cloudflare Workers** (workers-rs): SSE streaming agentic loop, hand-rolled MCP client (streamable HTTP), Azure OpenAI gpt-5.6 family, hash-chained proof ledger | `core/` |
| Chat UI (frontend) | React 19 + Vite + Tailwind v4; sidebar + conversation history, model selector, marketplace, memory panel, tool-call cards, live proof trace | `web/` |
| Sandbox | Separate Worker on **@cloudflare/sandbox** (containers): python/js/bash exec, wired via **service binding** | `sandbox/` |
| Persistence | **D1** (users, conversations, messages, memories, user MCP servers) · **KV** (sessions) · **R2** (generated images/files) | `core/schema.sql` |
| Reference implementation | Cloudflare Agents SDK (`AIChatAgent`, Durable Object state) — same SSE contract, kept as fallback | `src/` |
| Landing page | Single-file Tailwind, AI-generated photography, served at `/`; app at `/app` | `landing/` |
| Eval harness | Scripted multi-app tasks → SSE trace assertions + **external ground-truth checks** (`gh api`) → markdown report | `evals/run.mjs` |

### Product features (v2)

- **Auth** — email/password signup+login (invite-gated), PBKDF2 hashing, KV-backed sessions, secure cookies
- **Chat history** — conversations + messages persisted in D1, sidebar with titles/timestamps, rolling server-side summary for long threads
- **Memory** — `remember`/`forget` built-ins + memory panel; relevant memories are injected into context
- **Marketplace** — users add their own MCP servers (URL + optional token); per-user rows in D1, connected on demand
- **Tool loading** — `load_tools` built-in: the model discovers and pulls in just the tools it needs instead of holding all 50+ schemas in context
- **Model selector** — gpt-5.6 family only (terra / sol / luna on Azure OpenAI)
- **Image generation** — `generate_image` → Azure `gpt-image` → uploaded to R2 → rendered inline + served from `/files/img/...`
- **Code execution** — `run_code` → sandbox Worker over service binding (python/js/bash)
- **Context management** — recent-window + rolling conversation summary + tool-output truncation + selective tool schemas, sized for ~1M-token models without dumping everything in

### Connected apps (MCP)

- **GitHub** — hosted MCP (`api.githubcopilot.com/mcp`), 47 tools: issues, PRs, repos, code search
- **Zapier MCP** (optional, `ZAPIER_MCP_URL`) — Slack / Gmail / Notion / thousands more
- **Composio Connect** (optional, `COMPOSIO_MCP_URL`) — 1,000+ apps
- **DeepWiki** — repo knowledge (`mcp.deepwiki.com`)
- **Context7** — library docs (`mcp.context7.com`)
- **Cloudflare docs** — `docs.mcp.cloudflare.com`

## Reliability — how we know it works

1. **Verify-by-readback**: the agent's operating discipline *requires* an independent read call after every mutating action before it may claim success.
2. **`attest` ledger**: each verification is hash-chained (`sha256(prev_hash || entry)`) — a tamper-evident run log, exposed at `GET /api/ledger` and in the UI's proof trace panel.
3. **Unverified-write detection**: the UI counts mutating tool results vs attestations and flags the delta.
4. **Eval suite**: `node evals/run.mjs` runs 6 scripted tasks — read-only, write+verify, research+write, multi-app (github + cf-docs), sandbox exec, and a deliberately-impossible task (failure transparency). External assertions check real GitHub state via `gh`. Latest run: **6/6 pass** against production — see `evals/report-*.md`.

## Run it

```bash
# backend (rust → workers)
cd core
cp .dev.vars.example .dev.vars   # add AZURE_OPENAI_API_KEY, GITHUB_TOKEN, optionally ZAPIER_MCP_URL / COMPOSIO_MCP_URL
npx wrangler dev --config wrangler.toml --port 8899

# frontend
cd web
BLOOP_API=http://localhost:8899 npm run dev   # → http://localhost:5174

# evals
BLOOP_API=http://localhost:8899 node evals/run.mjs
```

TS fallback (Agents SDK): `npm run dev` at repo root → http://localhost:5173.

## Deploy

```bash
cd core && npx wrangler deploy --config wrangler.toml
# secrets: npx wrangler secret put AZURE_OPENAI_API_KEY (etc.)
```

## Stack

Cloudflare Workers (Rust→WASM + TS) · D1 · KV · R2 · Workers Assets · service bindings · @cloudflare/sandbox (containers) · MCP (streamable HTTP) · Azure OpenAI gpt-5.6 + gpt-image · Vite/React/Tailwind.
