# bloop — demo script (~2 min)

Written for the v3 build. Landing → live verified run → toolbox → depth → memory/voice → proof → out.

## 0:00–0:15 — hook (landing)

Show `bloop.rough-cell-383c.workers.dev`. Say:

> "Every AI agent *says* it did something. bloop **proves** it. bloop is a general-purpose agent that takes real actions across your apps — writes code, browses the web, talks to GitHub, Notion, Sentry — and records a tamper-evident proof of every step. Let me show you."

Click **get bloop** → sign in.

## 0:15–0:35 — the task (live run)

Paste (pre-copied):

> "research the cloudflare/agents repo on deepwiki, open a github issue in karanxa1/bloop-evals summarising it, and verify the issue exists."

Narrate while it runs:

> "Watch the left — it planned three steps. On the right, every tool call lands in the proof trace with live timing. DeepWiki for research, GitHub to write — then instead of just claiming it worked, bloop *reads the issue back* and attests it. Each attestation is hash-chained to the last — edit or reorder the trace and it breaks."

Open the created issue link.

## 0:35–0:55 — the toolbox (marketplace)

Open **mcp servers** → **custom mcp**:

> "Adding an app is one field — paste any MCP server url. bloop probes it and detects how it wants you to sign in — OAuth, a token, or nothing. This one needs OAuth, so it detected it and preselected sign-in. One click to authorize."

Point at catalog cards (github, notion, linear, sentry). Then **tools** tab:

> "Every built-in tool can be toggled, and there's a skills editor — teach bloop a reusable workflow once and it uses it forever."

## 0:55–1:15 — depth (code, workspace, subagents)

Paste: `run python to compute the first 20 fibonacci numbers`. Show the sandbox output card.

> "bloop runs real code in a Cloudflare container. It also has a persistent workspace — write files, install packages, run shells, isolated per user. And for hard problems it fans out — `delegate` spins up subagents in parallel and streams their progress back here."

## 1:15–1:35 — memory + voice

> "It remembers you — `remember that I prefer terse answers`. And it keeps a context file and a lessons file across sessions, so it learns how you work."

Tap the **voice orb**:

> "And you can just talk to it." Ask a question aloud; the agent answers in voice and the task streams into the chat.

## 1:35–1:55 — proof + architecture

Expand the **proof** panel; show the hash chain.

> "This is the part that matters — a hash-chained ledger of every verified action. 'I did it' becomes 'here's the proof, and here's the read-back.' Under the hood it's Rust compiled to WASM on Cloudflare Workers, a hand-rolled MCP client, Azure gpt-5.6 models, D1 for state, R2 for files, and Cloudflare containers for the sandbox and remote browser."

## 1:55–2:00 — close

> "One agent, every app, every action verified. bloop — tiny blob, big brain. Repo and eval report are in the submission."

## Recording notes

- Prep tabs: landing · `/app` signed in · GitHub issues list for bloop-evals · the prompt pre-copied.
- The mega prompt from `docs/USE-BLOOP.md` is the backup single-shot if you want one run to show everything.
- If a live step flakes, cut — the trace is async so a trimmed timeline still tells the story.
- Fallback if live is flaky: screen-capture a saved trace + `evals/report-*.md` (6/6 pass).
