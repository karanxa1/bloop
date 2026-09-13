# bloop — 2-minute demo script

Target: ~110 seconds. Landing page → live run → proof → evals → out.

## 0:00–0:12 — the problem (landing page)

Show `landing/` (or workers.dev hero). Say:

> "Agents can *say* they did something. bloop proves it. It's a general-purpose agent that takes real actions across your apps — and shows a tamper-evident proof trace for every step."

## 0:12–0:30 — the task (live app UI)

At `https://bloop.rough-cell-383c.workers.dev`, paste a multi-app prompt, e.g.:

> "research cloudflare/agents on deepwiki, file a github issue in karanxa1/bloop-evals summarizing it, then verify the issue and report the link"

Point out as it runs: the **plan checklist** appearing (update_plan), streamed tokens, and **tool calls landing in the proof trace** in real time.

## 0:30–0:55 — the verified run

Narrate the trace as it fills:

> "Watch: it planned three steps, called deepwiki, wrote the GitHub issue — then instead of just claiming success, it *read the issue back* and attested it. Every attestation is SHA-256 hash-chained — reorder or edit the trace and the hashes break."

Show the issue on GitHub (open the link from the report).

## 0:55–1:20 — the ledger + evals

- Open `GET /api/ledger` or the proof panel — point at the chained hashes.
- Show `evals/` → `node evals/run.mjs` output / the report:

> "The eval suite runs scripted multi-app tasks and checks the outcome *outside* the agent — it shells out to the GitHub CLI to confirm the issue really exists. Latest run: 4 of 5 pass — and the one failure is reported, not hidden. Failure-transparency test: when a write 404s, bloop reports the 404 and does not attest."

## 1:20–1:45 — architecture

Show the README diagram, 20 seconds:

> "Rust backend compiled to WASM on Cloudflare Workers — hand-rolled MCP client over streamable HTTP, streaming SSE end to end. Apps plug in via MCP: GitHub, Zapier, Composio — that's 1,000+ SaaS tools behind one protocol. Model is Azure gpt-5.6 with automatic failover. There's also a TypeScript Agents SDK implementation with durable-object state as the reference/fallback."

## 1:45–2:00 — close

> "One agent, many apps, every action verified and hash-chained. bloop — tiny blob, big brain. The repo, eval report, and reliability brief are linked in the submission."

## Recording notes

- Prep: clean GitHub issue list in bloop-evals, fresh chat, landing + app + ledger + eval report in tabs.
- Have the prompt pre-copied. Hit enter, narrate while it runs (~40s run).
- If a tool is slow, cut — the trace is async so a trimmed timeline still tells the story.
- Backup if live flakes: screen-capture the eval report + a saved trace.
