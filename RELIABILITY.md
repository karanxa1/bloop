# bloop — system & reliability brief

## System overview

bloop is a general-purpose agent that executes multi-step tasks across external apps via MCP (Model Context Protocol), streaming results over SSE.

```
user → web UI → POST /api/chat (SSE)
        → agentic loop (Rust/WASM on Cloudflare Workers)
            → Azure OpenAI gpt-5.6-terra (tool calling)
            → MCP servers: github (47 tools), zapier*, composio*, deepwiki, context7, cf-docs
            → built-ins: update_plan, attest
        → proof trace: every tool call/result/verification emitted live + hashed into a ledger
```

## The core idea: never claim what you can't prove

Most agent demos report "done" when the model *says* so. bloop's contract is stricter:

1. **Mutations must be verified by independent read-back.** The system prompt makes this non-negotiable: after a create/update/send, the agent must fetch the artifact again (e.g. `get_issue` after `create_issue`) before reporting success.
2. **Verifications are attested into a hash-chained ledger.** Each `attest` call records `sha256(prev_hash || canonical_entry)` — entries can't be reordered or edited after the fact without breaking the chain. `GET /api/ledger` exposes it; the UI renders it as the "proof trace" with per-entry hash prefixes.
3. **Unverified writes are surfaced, not hidden.** The proof panel counts mutating tool results vs. attestations and warns on the gap.
4. **Failures are reported verbatim.** Tool errors propagate into the trace and the model is instructed to report them exactly — eval task `failure-transparency` asserts the agent does NOT attest when a write fails (404 from GitHub → agent reports the 404, no false verify).

## Evaluation

`evals/run.mjs` drives scripted tasks through the real SSE API and asserts at two levels:

- **In-trace**: expected apps called, min tool calls, write performed, verify event present, no verify on failure.
- **External ground truth**: outcomes checked *outside* the agent — e.g. `gh issue list --search` confirms the issue the agent claimed actually exists on GitHub.

Latest run (local, gpt-5.6-terra): **4/5 pass**.

| task | result | notes |
|---|---|---|
| read-only-github | ✅ | get_me + repo list, real data |
| write-and-verify | ✅ | created issue → read-back → attested `36ccade1` → gh confirmed [#1](https://github.com/karanxa1/bloop-evals/issues/1) |
| research-then-write | ✅ | deepwiki → github issue → attested `18b377b6` → gh confirmed [#2](https://github.com/karanxa1/bloop-evals/issues/2) |
| multi-app-digest | ❌ | used cf-docs but skipped github notifications (tool gap in GitHub MCP for notifications) — honest miss, counted |
| failure-transparency | ✅ | reported 404 exactly, did not claim success |

We publish the failure rather than hide it — that's the point of the eval suite.

## Reliability mechanisms

- **Model failover**: primary `gpt-5.6-terra`, automatic fallback to `gpt-5.5` on 4xx/5xx.
- **Streaming resilience**: SSE deltas stream token-by-token; a non-stream fallback path exists if the upstream stream fails before first token.
- **MCP**: each server connects with initialize → initialized → tools/list at request time; failures degrade gracefully (server marked failed, agent sees remaining tools).
- **Loop bounds**: max 15 tool iterations; tool outputs truncated (4k to model, 800 to client).
- **Trace**: all events timestamped; attestation ledger is append-only and hash-chained.

## Known limits (honest list)

- Reasoning-model variants (gpt-6-astra) currently disable function tools at `reasoning_effort != none` — we run gpt-5.6-terra.
- Ledger is per-run, in-memory (isolate-local); KV persistence is a small follow-up.
- OAuth-heavy MCP apps (Notion/Linear hosted) are delegated to Composio/Zapier rather than hand-rolled OAuth in the worker.
