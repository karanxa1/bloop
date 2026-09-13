# bloop v3 — todo

Living tracker for the v3 work specced in HANDOFF.md. `[x]` done · `[~]` in progress · `[ ]` not started.

## features
- [x] **1. context + lessons files** — d1 `user_files`, `GET/PUT /api/files/:kind`, `update_context` / `save_lesson`, prompt injection, tabbed knowledge modal (50e2b25) · remote d1 migrated
- [~] **2. browser run** — [x] sandbox `/browser/{fetch,session,handoff,close}` + `BROWSER` binding + puppeteer/readability/turndown — deployed (47b34856), smoke-tested · note: cf free plan = 3 concurrent browsers, 1 launch/20s, 10 min/day → core single-flights browse · idea: `Cloudflare.getLiveView` cdp could enable handoff without a token · [ ] rust `browse` / `browser_handoff` + `handoff` sse (core agent) · take-over card (web agent)
- [~] **3. parallel tool calls** — join_all, per-server serialization, results in index order (core agent)
- [~] **4. `delegate` subagents** — nested loop, live `parent`-tagged events, `subagent_start/end` (core) · nested card (web)
- [~] **5. modes** — `think` (forced plan-first) / `deep` (25 iters, `sources` event) (core) · mode pills + source chips (web)
- [~] **6. polish** — 3-blob thinking animation, view transitions, production ui pass (web agent)

## also requested
- [~] webp: generated images as webp (core) · landing/web raster assets → webp (web)
- [x] ci deploy workflow — `.github/workflows/deploy.yml` (check → sandbox → d1 → core → smoke)
- [x] ci red on every push — root `sanity-check.yml` ran `npm install` on the dead TS starter (ai@7 vs @cloudflare/ai-chat peer ai@6) → removed; deploy.yml checks run on PRs, deploy jobs skip (not fail) without the token
- [~] ci `check` red on e317780 — cargo check + sandbox typecheck pass; web build fails `vite.config.ts: Cannot find name '__dirname'` (no @types/node in web/, local pass came from root node_modules) → web agent fixing, verify with root node_modules moved aside
- [~] blazing fast + everything streamed — concurrent mcp connect + `server` frames, parallel context load, streamed subagents (`subagent_delta`) (core) · tool-call animations (shimmer, live ms, staggered parallel groups, ok pop / error shake), rAF-batched deltas, lazy modals, bundle report (web)
- [ ] **blocked on user:** add repo secret `CLOUDFLARE_API_TOKEN` (wrangler is oauth locally — ci needs a token)
- [ ] **optional, user:** `CF_BROWSER_TOKEN` secret on bloop-sandbox for live-view handoff

- [~] **build subagents + code workspace** — r2 `ws/<conv>/…` is source of truth · [x] sandbox `POST /workspace/exec` hydrate→run→sync — deployed 6196d465, container → standard-1 · [ ] core `workspace_{write,read,list,delete,exec}` built-ins, `workspace` sse, `delegate(kind: research|build)`, `/api/workspace/:conv/{files,file,exec}` (core agent) · [ ] web: lazy codemirror 6 editor panel (file tree, tabs, save, run, live refresh on `workspace` events) + richer subagent ui (launch after web agent lands)
- [x] core v3 landed (d29c2c9): browse/handoff, parallel tools, live streaming merge, delegate research|build, modes, workspace built-ins + rest · 0 warnings, 9 tests
- [~] images: azure gpt-image supports only png|jpeg (verified 400 on webp) → switch to jpeg q85 (~170kb), `edit_image` (core-agent)
- [~] **skills** — d1 skills, progressive disclosure (`use_skill`), agent `create_skill`/`update_skill`, ≥8 prefab catalog skills, `/api/skills{,/catalog}` (core-agent) · skills marketplace ui (web, after web agent)
- [~] **built-in tool toggles** — `/api/tools`, `user_settings` (core-agent) · tools tab (web)
- [~] **think → tool → think** — azure responses reasoning summaries if supported (`thinking` sse) else one-line narration discipline (core-agent) · step timeline ui (web)
- [~] **failure protection** — per-tool timeouts, per-server circuit breaker, `error_kind`/`retries`, invalid-args self-correction (core-agent) · mcp retries/backoff/re-init/classification (core-mcp)
- [~] **mcp marketplace** — streamable http + legacy sse, bearer/headers/oauth 2.1 (dcr + pkce), `server_configs`, concurrent probes, verified catalog incl. higgsfield (core-mcp) · catalog with logos, custom mcp form, oauth connect flow (web)
- [~] **mcp apps (ui)** — `call_tool_full`/`read_resource` (core-mcp) → `mcp_app` sse + r2 html + `/api/mcp/call` bridge (core-agent) · sandboxed iframe host + json-rpc bridge (web)
- [~] handoff card: take over / done / skip (web agent)
- [~] remove invite code — backend check deleted in auth.rs (lead) · signup form field + api (web agent)
- [~] ui-perfect pass — research best agent app uis → `ui-spec.md` (research agent) · then 3 parallel implementers: (a) chat surface (b) chrome/modals/auth/trace (c) landing + tokens — launch after web agent lands

- [x] readme rewritten around hackathon submission requirements (overview · external apps · setup · reliability methodology · demo link) — keep updated as each feature lands; flip v3 items from "in progress" to shipped only after prod verification
- [ ] **user:** demo video (≤ 2 min) link → README · team member emails in submission form

- [x] web v3 committed (78e9985) + webp assets (c68781d) · contracts + ui spec in `docs/` (60fc0d4)
- [~] parallel ui agents: A chat surface/step timeline/mcp app host · B chrome/⌘k/proof trace/auth · C marketplace apps·tools·skills + custom mcp/oauth + higgsfield logo · D workspace codemirror editor · E landing (all ui features, crawlable) + design tokens
- [x] deployed 60fc0d4 from clean worktree → core version 601cc0fe · **prod evals 6/6** (e5d6681) · v3 prod smoke: think mode forced plan + `browse` example.com ok (5.4s, correct answer); deep mode 2 parallel `delegate` subagents ok (11–17s each, 89 live `subagent_delta` frames, `sources` emitted)
- [~] **voice agent orb (deepgram managed voice agent)** — `POST /api/voice/token` (short-lived grant, server-built settings, per-user rate limit) · stt: best deepgram model · think: strongest claude model deepgram lists · speak: cartesia sonic (exact id per deepgram docs) · single client-side function `run_bloop_task(prompt, mode)` → normal chat run, spoken summary · lazy orb ui with audio-reactive states, captions, barge-in (voice agent) · [ ] **user:** `cd core && npx wrangler secret put DEEPGRAM_API_KEY` (+ `core/.dev.vars` for local)
- [x] security audit → `docs/security-audit.md`: **C1** shared sandbox container across users · **C2** operator github/composio/zapier tokens usable by any signup · **H1** svg on app origin (stored xss) · **H2** `/files/*` not scoped to owner · **H3** markdown image exfil · M: ledger cross-user, no login rate limit + enumeration, public health probes with operator tokens, cors echo, sandbox bearer not constant-time, no security headers, tailwind cdn, no exec quotas, unpinned worker-build/actions
- [~] security fixes: C1 per-user `sandbox_id` containers + constant-time token + exec limits + browser host guard (sandbox agent) · C2 `ADMIN_EMAILS` gate for operator-token servers, H1/H2 `u/<user>/…` keys + nosniff/csp/attachment, per-user ledger, cached health, cors allowlist, `Secure` cookie, auth rate limits, security headers + noindex, quotas, pinned worker-build (core-agent, after its batch) · H3 click-to-load external images (ui-a) · tailwind cdn → prebuilt css (ui-e) · [ ] pin actions to shas (lead)
- [x] core-agent batch written: jpeg + `edit_image` (netguard fetch), skills (`skills.rs`, 8 prefab), tool toggles (`tools_registry.rs`), narration-based think→tool→think (azure reasoning summaries only on /openai/v1/responses — not adopted), deadlines + breaker + `error_kind`/`retries` · compiles with mcp.rs stubbed, 33 tests · **d1: apply schema.sql (skills, user_settings) before deploy**
- [x] ui-e landing: every ui feature, animated demo strip, crawlable (json-ld, canonical, llms.txt link), status/motion/elevation tokens, `--color-bloop-ink` for small text (bloop-deep is 4.1:1 on white)
- [~] **security**: ssrf guard for model/user-supplied urls (`netguard.rs` shared validator — core-mcp; edit_image hardening — core-agent) · [ ] full security review agent over the integrated diff before deploy (authz on every new route, secret masking, iframe sandbox/csp for mcp apps, oauth state/pkce, path traversal, xss in markdown, rate limits) · [ ] `x-robots-tag: noindex` on /app, /api, /files
- [x] `web/public/robots.txt` (training scrapers disallowed, user-initiated agents + search allowed on landing/.md/.txt, app/api/files disallowed) + `web/public/llms.txt` — note: robots is advisory; hard blocking would need cloudflare bot management / waf
> session restart (2026-09-14): 3 agents stopped. web partial work survived on disk (tsc clean); core-agent + core-mcp batches had not written anything → both restarted; web agent resumed to finish + report.

## hackathon (multiappagenthackathon.com)
judging: technical execution 30% · reliability & evaluation 25% · usefulness 20% · originality 15% · demo clarity 10% · must connect ≥ 3 external apps · submit repo + ≤2 min video + readme

## release checklist
- [ ] integrate agent work, cargo check + web build + sandbox typecheck
- [ ] commit in logical units
- [ ] deploy sandbox → core (`cd core && npx wrangler deploy --config wrangler.toml`, never repo root)
- [ ] evals 6/6 on prod + new v3 smoke prompts (browse, delegate, deep mode, lessons)
- [ ] playwright visual check (desktop + mobile)
- [ ] update HANDOFF.md (sse contract, api surface, footguns) · push `main`
