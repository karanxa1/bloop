<p align="center">
  <img src="landing/assets/hero.webp" alt="bloop" width="640" />
</p>

<h1 align="center">bloop — tiny blob. big brain.</h1>

<p align="center"><b>An AI agent that doesn't just say it did something — it proves it.</b></p>

<p align="center">
  <a href="https://bloop.rough-cell-383c.workers.dev"><b>live app</b></a> ·
  <a href="https://www.loom.com/share/fdcc943af2e24d599e647a1b5735f784"><b>demo video</b></a> ·
  <a href="evals"><b>eval reports</b></a> ·
  <a href="docs/USE-BLOOP.md"><b>feature tour</b></a>
</p>

<p align="center">
  <img src="https://github.com/karanxa1/bloop/actions/workflows/deploy.yml/badge.svg" alt="ci" />
  <img src="https://img.shields.io/badge/evals-6%2F6%20pass-8DC63F" alt="evals 6/6" />
  <img src="https://img.shields.io/badge/apps-15%2B%20MCP%20servers-8DC63F" alt="15+ apps" />
</p>

bloop is a general-purpose agent that plans, takes real actions across your apps,
**verifies every mutation with an independent read-back**, and records a
tamper-evident, hash-chained proof trace you can audit afterwards.

Built for the [Multi-App AI Agent Hackathon](https://multiappagenthackathon.com/):
*"build one useful, multi-step AI agent, connected to at least three external apps."*
bloop connects to **any MCP server ever published** — and ships with 15+ wired in.

| | |
|---|---|
| **Live app** | https://bloop.rough-cell-383c.workers.dev (landing) · [`/app`](https://bloop.rough-cell-383c.workers.dev/app) (agent) |
| **Demo video** | [watch on Loom](https://www.loom.com/share/fdcc943af2e24d599e647a1b5735f784) (~2 min) |
| **Evals** | **6/6 pass** against production — verified against real GitHub state (`evals/report-*.md`) |
| **Repo** | https://github.com/karanxa1/bloop |

## Try it in 30 seconds

1. Open **https://bloop.rough-cell-383c.workers.dev/app** and sign up — no invite needed.
2. Paste: *"create a github issue in karanxa1/bloop-evals titled 'hello from a judge', then read it back and prove it exists."*
3. Watch the **proof** panel on the right — the issue gets written, read back from GitHub, and attested into the hash chain. Click the link; the issue is really there.

Then try the [full 20-step self-test prompt](docs/USE-BLOOP.md#the-full-system-test-prompt) to exercise every subsystem in one run.

## The hackathon brief, answered

| Brief | How bloop answers |
|---|---|
| **One useful, multi-step agent** | Plans with `update_plan`, executes across iterations, narrates each step, finishes with a verified report — for everyday work (`default`), hard reasoning (`think`), and long-horizon research (`deep`). |
| **≥ 3 external apps** | 15+ connected out of the box (GitHub, Linear, Notion, Sentry, Stripe, Zapier, DeepWiki, Context7, Cloudflare, Exa…), plus **paste any MCP URL** — bloop probes it, detects OAuth/token/none, and connects. |
| **Multi-app orchestration** | `load_tools` searches every server's tools and pulls only what's needed; parallel calls fan out across apps; `delegate` runs parallel subagents that each reach the apps. |
| **Beyond a chatbot** | Sandboxed code, a persistent workspace, image generation, a **live browser embedded in the chat** (click, type, scroll — for logins), voice, memory, skills — and a tamper-evident proof trace for every action. |
| **Show how you know it works** | `node evals/run.mjs` → 6/6 tasks pass against the live deployment, verified against real GitHub state — not self-reported. Reports in `evals/report-*.md`. |

---

## Why bloop is different

Agents today are confident liars. Ask one to "file the issue" and it tells you it did —
whether or not the write actually landed. bloop's answer is a discipline, not a disclaimer:

```
plan → act (MCP tools, in parallel) → verify (independent read-back) → attest (hash-chained) → report
```

Every mutating call is followed by a **read-back from the same system of record**, then
recorded in an attestation ledger where each entry's hash is chained to the previous one
(`sha256(prev_hash ‖ entry)`). Reorder, delete or edit a step and the chain breaks. The UI
shows every verification — and honestly flags anything it *couldn't* verify.

That one idea — *claims are worthless without receipts* — is the whole product.

## What it can do

### Every app you have — and any you don't

- **15+ apps wired in**: GitHub, Linear, Notion, Sentry, Stripe, Zapier, Hugging Face,
  Exa, Tavily, Higgsfield, Cloudflare (docs, bindings, observability), DeepWiki, Context7.
- **Add any MCP server by URL** — paste it and bloop probes the endpoint, detects whether it
  wants **OAuth, a bearer token, or nothing**, and preselects the right connect flow.
- **`load_tools`** — the model searches every connected server's tools by keyword and pulls
  only the schemas it needs, so bloop scales past provider tool caps instead of hitting them.

### Real work, not chat

- **Sandboxed code** — `run_code` executes Python, JavaScript and Bash in a per-user
  Cloudflare container; isolated by `sandbox_id`, billed only while awake.
- **A real workspace** — `workspace_write / read / list / delete / exec`: files, `npm`/`pip`
  installs, builds and tests, persisted in R2 and hydrated into the container on demand.
- **Image generation & editing** — `generate_image` / `edit_image` via Azure, served from R2.
- **Attachments & vision** — drag in a screenshot or file and bloop sees it.
- **Voice** — a live voice concierge (Deepgram agent) that answers aloud and streams the
  resulting task into the chat.

### A browser you can share

- **`browse`** — reads any page as clean markdown (Readability + Turndown on Cloudflare
  Browser Rendering) or takes a screenshot.
- **`browser_handoff`** — embeds a **live remote browser right inside the chat**: a
  screencast stream you can click, type and scroll in. Use it for the one thing agents
  can't do — signing in — then hand the session back to bloop, which picks it up by id.

### An agent of agents

- **`delegate`** — spawns parallel *research* (read-only) or *build* (write + run code)
  subagents, each streaming into nested live cards.
- **Parallel tool calls** — calls across different apps run concurrently, results stay ordered.
- **Modes** — `default` for everyday work, `think` (forces a plan first), `deep`
  (25 iterations, ≥2 sources, cited source chips).

### Remembers, and gets better

- **Memory** — `remember` / `forget` durable facts; bloop recalls them next session.
- **Context file** — a user-editable standing brief injected into every run.
- **Lessons file** — bloop records what failed and what it learned, so it doesn't repeat
  mistakes. Both files are editable in the knowledge panel.
- **Skills** — teach a workflow once (`create_skill`), reuse it forever; a skills marketplace
  and built-in tool toggles live in the app.

### A trace you can trust

- **Live proof trace** — plan steps, tool calls with timing, verifications, hash-chained
  attestations, unverified-write warnings, sources.
- **`/api/ledger`** — the raw attestation ledger, per-user and auditable.

## External apps

| App | Used for | Connection |
|---|---|---|
| **GitHub** | issues, PRs, repos, code search — the main write target | MCP `api.githubcopilot.com/mcp` |
| **Linear, Notion, Sentry, Stripe, Higgsfield, Tavily** | OAuth'd app actions | catalog MCP servers |
| **Zapier** | Slack, Gmail, Sheets — 8,000+ apps | `ZAPIER_MCP_URL` |
| **Composio** | 1,000+ more apps | `COMPOSIO_MCP_URL` |
| **DeepWiki · Context7 · Cloudflare Docs · Exa · Hugging Face** | research, docs, search | public MCP servers |
| **Azure OpenAI** | gpt-5.6 terra / sol / luna reasoning · image generation | REST |
| **Cloudflare Sandbox** | code execution, workspaces, remote browser | service binding + containers |
| **Any MCP server** | users add their own | per-user, stored in D1 |

## Architecture

```
/        → landing page              (landing/, served from worker assets)
/app     → React SPA                 (web/)
/api/*   → Rust/WASM agent worker    (core/)    — auth-guarded
/files/* → R2 objects                (core/)    — auth-guarded
sandbox  → TS worker bloop-sandbox   (sandbox/) — containers + Browser Rendering,
                                                reached only via service binding
```

| Piece | Tech | Path |
|---|---|---|
| Agent core | **Rust → WASM on Cloudflare Workers** (workers-rs): SSE agentic loop, hand-rolled streamable-HTTP MCP client, Azure OpenAI with model fallback, hash-chained ledger | `core/` |
| Web app | React 19 · Vite · Tailwind v4 | `web/` |
| Sandbox | `@cloudflare/sandbox` containers · `@cloudflare/puppeteer` · Browser Rendering | `sandbox/` |
| Persistence | **D1** users / conversations / messages / memories / servers / files / skills · **KV** sessions · **R2** images, screenshots, workspaces | `core/schema.sql` |
| Auth | email/password (PBKDF2) · session cookies · per-user everything | `core/src/auth.rs` |
| Evals | scripted tasks → SSE trace assertions + external `gh api` ground truth | `evals/run.mjs` |
| CI/CD | GitHub Actions: cargo check (wasm32) · sandbox typecheck · web build → deploy → smoke | `.github/workflows/deploy.yml` |

API surface and SSE contract: [`docs/contracts-v3.md`](docs/contracts-v3.md) ·
Feature tour with ready-to-paste prompts: [`docs/USE-BLOOP.md`](docs/USE-BLOOP.md).

## Reliability & evaluation

How we know it works — not just that it looked right in a demo:

1. **Verify-by-readback.** An independent read follows every mutating action before success may be claimed.
2. **Attestation ledger.** Each verification is hash-chained — tamper-evident at `GET /api/ledger`.
3. **Unverified-write detection.** The UI counts mutations against attestations and flags any gap.
4. **Failure transparency.** Tool errors reach the model verbatim and are reported, never papered over; model calls fall back stream → non-stream → fallback model.
5. **Lessons loop.** Worked-around failures become one-line lessons injected into future runs.
6. **Eval suite with external ground truth.** `node evals/run.mjs` runs 6 tasks against the real deployment — read-only GitHub, write + verify, research → write, multi-app digest, sandbox code, and a deliberately impossible task that must be reported as a failure. Assertions check the SSE trace *and* real GitHub state. **Latest: 6/6 on production.** See [`RELIABILITY.md`](RELIABILITY.md).

## Setup

Prereqs: Node 22, Rust + `wasm32-unknown-unknown`, `worker-build`, a Cloudflare account,
Docker (sandbox image), Azure OpenAI deployments, a GitHub token.

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
cd ../web  && npm run build                                          # assets served by core
cd ../core && npx wrangler d1 execute bloop-db --remote --file schema.sql
npx wrangler deploy --config wrangler.toml                           # never from the repo root
# secrets: npx wrangler secret put AZURE_OPENAI_API_KEY   (GITHUB_TOKEN, SANDBOX_TOKEN, EVAL_TOKEN …)
# optional: cd sandbox && npx wrangler secret put CF_BROWSER_TOKEN   (live browser handoff)
```

CI deploys automatically on every push to `main`: checks → sandbox (when changed) →
D1 schema → core worker + SPA → smoke test.

> The repo-root `src/` + `wrangler.jsonc` is the original Agents-SDK TypeScript prototype —
> kept for reference only. **Never deploy from the root.**

## Stack

Cloudflare Workers (Rust→WASM + TS) · D1 · KV · R2 · Workers Assets · service bindings ·
Containers (`@cloudflare/sandbox`) · Browser Rendering · MCP (streamable HTTP + OAuth 2.1) ·
Azure OpenAI gpt-5.6 + gpt-image · Deepgram (voice) · React 19 · Vite · Tailwind v4 · GitHub Actions.
