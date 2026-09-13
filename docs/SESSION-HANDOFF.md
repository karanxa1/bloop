# session handoff — 2026-09-14 (read this first, then TODO.md)

Base docs: `HANDOFF.md` (architecture, footguns), `docs/contracts-v3.md` (all new SSE/REST contracts), `docs/security-audit.md` (findings), `docs/ui-spec.md` (ui research). Live tracker: `TODO.md`. Hackathon: multiappagenthackathon.com (tech 30 / reliability 25 / usefulness 20 / originality 15 / demo 10).

## rules (from user)
gpt-5.6 family only · sandbox via SANDBOX service binding only · never deploy from repo root (`cd core && npx wrangler deploy --config wrangler.toml`) · `.dev.vars` never committed · lowercase bloop brand (#8DC63F, Baloo 2, sharp panels / round pills) · commit in logical units · **token-sensitive**, parallel subagents with disjoint file ownership, verify API docs, keep README + TODO.md updated.

## live on prod
- core worker version `601cc0fe` = commit `60fc0d4` (v3 core: browse/handoff, parallel tools, streamed subagents, modes, workspace built-ins; web v3 ui round 1; webp assets). **evals 6/6** (`e5d6681`), v3 smoke ok.
- sandbox worker `6196d465` (browser endpoints + r2-backed `/workspace/exec`, container standard-1).
- remote D1 has `user_files`; **not yet**: skills, user_settings, server_configs, oauth tables → run `npx wrangler d1 execute bloop-db --remote --file schema.sql` in core before next deploy.
- secrets set on core: AZURE_OPENAI_API_KEY, GITHUB_TOKEN, SANDBOX_TOKEN, EVAL_TOKEN, INVITE_CODE (unused now), **DEEPGRAM_API_KEY** (valid, but lacks grant permission → voice uses server WS relay; user will rotate key). Also in `core/.dev.vars`.
- CI: `.github/workflows/deploy.yml` (actions pinned to SHAs). Deploy jobs skip until user adds repo secret `CLOUDFLARE_API_TOKEN`. Last CI failure (`__dirname` in vite config) is fixed in `78e9985`.

## committed since deploy (not deployed)
`11b60bf` open signup · `d29c2c9` core v3 · `c68781d` webp · `78e9985` web v3 · `60fc0d4` docs · `718b59f` robots.txt + llms.txt · `3d9c050` ci pins · `906b1b0` landing (prebuilt tailwind css, all features, crawlable) + tokens + codemirror deps · `c688d47` attachments contract · `231c01c` workspace editor panel files · TODO commits.

## uncommitted work in tree (owned by running/stopped agents)
- **core/** — mixed: core-agent batch (jpeg + `edit_image`, `skills.rs`, `tools_registry.rs`, narration think→tool→think, deadlines/circuit breaker/`error_kind`, security fixes in progress: `auth.rs` Secure cookie + rate limits + `is_admin`/ADMIN_EMAILS, …) and core-mcp (done: `mcp.rs` hardened transport, `netguard.rs` SSRF guard, `marketplace.rs` 23-server catalog incl. higgsfield, `oauth.rs` OAuth 2.1 + refresh lock, `config.rs`, `db.rs`, schema). Full crate **did not compile** at last report only because of core-agent's in-progress lib.rs call sites (`RunOpts.admin`, `workspace::exec` args, `ledger::last_run_entries`).
- **web/** — ui-a chat surface (StepTimeline, McpAppFrame, message actions, attachments composer, click-to-load external images), ui-b chrome (CommandPalette, Toast, sidebar/header/modal/auth/proof trace; fixing `//` same-origin bypass), ui-c marketplace (apps · tools · skills, custom mcp, oauth, logos), ui-d App.tsx wiring for workspace panel, voice orb (`components/voice/*`). Build was failing mid-edit (App.tsx ChatActionsValue, StepTimeline SkillChip import, MessageList duplicate import) — expected until agents finish.
- **sandbox/** — per-user `sandbox_id` containers (C1), constant-time token, exec limits, browser host guard (in progress).

## agents (resume by SendMessage to their saved transcripts if the session restarts; if ids are gone, relaunch with the scope below)
| agent | scope | state |
|---|---|---|
| core-agent | agent.rs, azure.rs, skills.rs, tools_registry.rs, sandbox.rs, workspace.rs, auth.rs, lib.rs/db.rs/schema anchored | security batch (audit C2/H1/H2/M) → integrate core-mcp API + MCP Apps (`mcp_app` sse, `u/<user>/mcpapp/` html, `POST /api/mcp/call`) → attachments backend |
| core-mcp | mcp.rs, netguard.rs, marketplace.rs, oauth.rs | **done** |
| sandbox | sandbox/ | per-user sandbox_id + hardening; must report new request contract for core sandbox.rs |
| ui-a | chat surface files | step timeline, mcp app host, actions, attachments, H3 image fix |
| ui-b | chrome files | ⌘K, sidebar groups/undo, proof trace timeline, auth polish, `//` fix |
| ui-c | marketplace/* | apps/tools/skills UI against contracts |
| ui-d | workspace panel | **done** (committed files; App.tsx wiring uncommitted) |
| ui-e | landing + tokens | **done** |
| voice | core/src/voice.rs, web/components/voice/* | **done** (files committed; lib.rs `mod voice` + route and App.tsx mount uncommitted; vite dev proxy needs `ws: true`; models flux-general-en / claude-sonnet-5 / sonic-3.6 verified) |

## next steps (in order)
1. Wait for agents; then `cd core && cargo check --target wasm32-unknown-unknown && cargo test` and `cd web && npm run build` green. Fix integration gaps (sandbox_id contract into sandbox.rs; ADMIN_EMAILS var `karan@bloop.dev` in wrangler.toml vars; CSP `connect-src 'self'` for voice relay; mic Permissions-Policy).
2. Commit per area: core security · core mcp/marketplace/oauth/netguard · core skills/tools/failure-protection/images · mcp apps + attachments · voice · web chat surface · web chrome · web marketplace · workspace wiring.
3. Security review pass over the integrated diff (authz on every new route, secret masking, iframe sandbox/CSP, oauth state/pkce, path traversal, markdown xss, rate limits).
4. Deploy: sandbox (`cd sandbox && npx wrangler deploy --config wrangler.toml`) → remote D1 schema → web build → core deploy — **from a clean worktree of HEAD** (`git worktree add --detach <scratch> HEAD`). Then evals (`BLOOP_API=https://bloop.rough-cell-383c.workers.dev EVAL_TOKEN=… node evals/run.mjs`) + v3 smoke (think/browse, deep/delegate, skills, marketplace install, voice token/relay) + Playwright at 1280/375.
5. Update README (flip shipped v3 items), HANDOFF.md (new API/SSE surface), TODO.md; push `main`.

## open user items
CLOUDFLARE_API_TOKEN repo secret · optional CF_BROWSER_TOKEN on sandbox (live browser handoff) · demo video link in README · rotate Deepgram key (was pasted in chat) · optional Deepgram key with Member role (direct browser voice path).
