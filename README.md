# bloop — tiny blob. big brain.

A general-purpose AI agent that takes **real, verified, multi-step actions across external apps** — and proves every one of them.

Built for the [Multi-App AI Agent Hackathon](https://multiappagenthackathon.com/) (Sept 13, 2026): *"build one useful, multi-step AI agent, connected to at least three external apps."*

| | |
|---|---|
| **Live app** | https://bloop.rough-cell-383c.workers.dev (landing) · [`/app`](https://bloop.rough-cell-383c.workers.dev/app) (agent) |
| **Demo video** | _link coming — ≤ 2 min_ |
| **Evals** | **6/6 pass** against production (`evals/report-*.md`) |

---

## Overview

You give bloop a goal in plain language. It plans, acts on live apps over MCP, **verifies every mutation with an independent read-back**, and writes a tamper-evident proof trace — a SHA-256 hash-chained attestation ledger you can audit afterwards.

```
plan → act (MCP tools, in parallel) → verify (independent read-back) → attest (hash-chained) → report
```

Everything streams: plan updates, tool calls with live timing, verifications, code runs, images, memories — on the chat and in the **proof trace** panel.

## External apps used

| App | How bloop uses it | Connection |
|---|---|---|
| **GitHub** | issues, PRs, repos, code search — the main write target (47 tools) | hosted MCP `api.githubcopilot.com/mcp` |
| **DeepWiki** | research any public repo | MCP `mcp.deepwiki.com` |
| **Context7** | up-to-date library docs | MCP `mcp.context7.com` |
| **Cloudflare Docs** | platform docs lookups | MCP `docs.mcp.cloudflare.com` |
| **Azure OpenAI** | gpt-5.6 terra / sol / luna reasoning, gpt-image generation | REST |
| **Cloudflare Sandbox** | python / js / bash execution in containers | service binding |
| **Zapier MCP** *(optional)* | Slack, Gmail, Notion and thousands more | `ZAPIER_MCP_URL` |
| **Composio** *(optional)* | 1,000+ apps | `COMPOSIO_MCP_URL` |
| **Any MCP server** | users add their own in the in-app marketplace | per-user, stored in D1 |

## Features

**Shipped (v2, live):** email/password auth · persisted conversations with rolling summaries · memory (`remember` / `forget`) · MCP marketplace · `load_tools` tool discovery (the model pulls only the schemas it needs from 50+) · model picker (gpt-5.6 family) · `generate_image` → R2 · `run_code` sandbox · hash-chained proof ledger · unverified-write detection in the UI.

**v3 (in progress — see [`TODO.md`](TODO.md) for live status):**

- **context + lessons files** — a user-editable context file and an agent-grown lessons file, injected into every run (`update_context`, `save_lesson`); tabbed knowledge editor · *merged*
- **browser** — `browse` any page as clean markdown (Readability + Turndown on Cloudflare Browser Rendering) or webp screenshot; `browser_handoff` lets the user take over a live remote browser to log in · *sandbox endpoints live, agent + ui integrating*
- **parallel tool calls** — calls across different apps run concurrently, results stay ordered
- **subagents** — `delegate` spawns streamed subagents: *research* (read-only) or *build* (write + run code in a durable per-conversation workspace), shown as nested live cards
- **code workspace + editor** — R2-backed project files, container exec with hydrate/sync, in-app editor with run button
- **modes** — *think* (forced plan-first) and *deep* (25 iterations, ≥2 sources, cited source chips)
- **open signup** — invite codes removed
- **polish** — tool-call animations, thinking indicator, view transitions, webp assets, code-split bundle

## Architecture

```
/        → landing page            (landing/, served from worker assets)
/app     → React SPA               (web/)
/api/*   → Rust/WASM agent worker  (core/)   — auth-guarded
/files/* → R2 objects              (core/)   — auth-guarded
sandbox  → TS worker bloop-sandbox (sandbox/) — containers + Browser Rendering, reached only via service binding
```

| Piece | Tech | Path |
|---|---|---|
| Agent core | **Rust → WASM on Cloudflare Workers** (workers-rs): SSE agentic loop, hand-rolled streamable-HTTP MCP client, Azure OpenAI with model fallback, hash-chained ledger | `core/` |
| Web app | React 19 · Vite · Tailwind v4 | `web/` |
| Sandbox | `@cloudflare/sandbox` containers + `@cloudflare/puppeteer` (Browser Rendering) | `sandbox/` |
| Persistence | **D1** users/conversations/messages/memories/servers/user_files · **KV** sessions · **R2** images, screenshots, workspaces | `core/schema.sql` |
| Evals | scripted multi-app tasks → SSE trace assertions + external `gh api` ground truth → markdown report | `evals/run.mjs` |
| CI/CD | GitHub Actions: cargo check (wasm32) · sandbox typecheck · web build → deploy sandbox → D1 schema → core → smoke test | `.github/workflows/deploy.yml` |

SSE event contract and API surface: [`HANDOFF.md`](HANDOFF.md).

## Reliability & evaluation

How we know it works — not just that it looked right in a demo:

1. **Verify-by-readback.** The operating discipline requires an independent read call after every mutating action before bloop may claim success.
2. **Attestation ledger.** Each verification is hash-chained (`sha256(prev_hash ‖ entry)`) — tamper-evident, exposed at `GET /api/ledger` and in the proof trace.
3. **Unverified-write detection.** The UI counts mutating tool results against attestations and flags any gap.
4. **Failure transparency.** Tool errors are passed to the model verbatim (`ERROR: …`) and reported, never papered over; model calls fall back from stream → non-stream → fallback model.
5. **Lessons loop.** When bloop works around a failure it records a one-line lesson that is injected into future runs.
6. **Eval suite with external ground truth.** `node evals/run.mjs` runs 6 tasks against the real deployment — read-only GitHub, write + verify, research → write (deepwiki + github), multi-app digest (github + cf-docs), sandbox code execution, and a deliberately impossible task that must be reported as a failure. Assertions check the SSE trace (tool apps used, verify events, no false success) **and** real GitHub state via `gh api`. Latest: **6/6 pass on production.** See [`RELIABILITY.md`](RELIABILITY.md).

## Setup

Prereqs: Node 22, Rust stable + `wasm32-unknown-unknown`, `worker-build` (`cargo install worker-build`), a Cloudflare account (wrangler logged in), Docker (sandbox container build), Azure OpenAI with gpt-5.6 + gpt-image deployments, a GitHub token.

```bash
# 1. backend secrets (bare KEY=value, gitignored)
cd core
cat > .dev.vars <<'EOF'
AZURE_OPENAI_API_KEY=...
GITHUB_TOKEN=...
SANDBOX_TOKEN=...          # shared with the sandbox worker
EVAL_TOKEN=...             # bearer for the eval harness
EOF
npx wrangler d1 execute bloop-db --local --file schema.sql
npx wrangler dev --config wrangler.toml --port 8899

# 2. web
cd ../web && npm ci && npm run dev

# 3. evals
BLOOP_API=http://localhost:8899 EVAL_TOKEN=... node evals/run.mjs
```

### Deploy

```bash
cd sandbox && npm ci && npx wrangler deploy --config wrangler.toml   # container + browser worker
cd ../web  && npm run build                                          # builds assets served by core
cd ../core && npx wrangler d1 execute bloop-db --remote --file schema.sql
npx wrangler deploy --config wrangler.toml                           # never from the repo root
# secrets: npx wrangler secret put AZURE_OPENAI_API_KEY   (GITHUB_TOKEN, SANDBOX_TOKEN, EVAL_TOKEN …)
# optional: cd sandbox && npx wrangler secret put CF_BROWSER_TOKEN   (live browser handoff)
```

CI deploys on every push to `main` once the `CLOUDFLARE_API_TOKEN` repo secret is set.

> The repo-root `src/` + `wrangler.jsonc` is the original Agents-SDK TypeScript prototype, kept for reference only — **don't deploy from the root**.

## Stack

Cloudflare Workers (Rust→WASM + TS) · D1 · KV · R2 · Workers Assets · service bindings · Containers (`@cloudflare/sandbox`) · Browser Rendering · MCP (streamable HTTP) · Azure OpenAI gpt-5.6 + gpt-image · React 19 · Vite · Tailwind v4 · GitHub Actions.
