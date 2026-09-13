# bloop v3 — todo

Living tracker for the v3 work specced in HANDOFF.md. `[x]` done · `[~]` in progress · `[ ]` not started.

## features
- [x] **1. context + lessons files** — d1 `user_files`, `GET/PUT /api/files/:kind`, `update_context` / `save_lesson`, prompt injection, tabbed knowledge modal (50e2b25) · remote d1 migrated
- [~] **2. browser run** — sandbox `/browser/{fetch,session,handoff,close}` + `BROWSER` binding + puppeteer (sandbox agent) · rust `browse` / `browser_handoff` + `handoff` sse (core agent) · take-over card (web agent)
- [~] **3. parallel tool calls** — join_all, per-server serialization, results in index order (core agent)
- [~] **4. `delegate` subagents** — nested loop, live `parent`-tagged events, `subagent_start/end` (core) · nested card (web)
- [~] **5. modes** — `think` (forced plan-first) / `deep` (25 iters, `sources` event) (core) · mode pills + source chips (web)
- [~] **6. polish** — 3-blob thinking animation, view transitions, production ui pass (web agent)

## also requested
- [~] webp: generated images as webp (core) · landing/web raster assets → webp (web)
- [x] ci deploy workflow — `.github/workflows/deploy.yml` (check → sandbox → d1 → core → smoke)
- [x] ci red on every push — root `sanity-check.yml` ran `npm install` on the dead TS starter (ai@7 vs @cloudflare/ai-chat peer ai@6) → removed; deploy.yml checks run on PRs, deploy jobs skip (not fail) without the token
- [~] blazing fast + everything streamed — concurrent mcp connect + `server` frames, parallel context load, streamed subagents (`subagent_delta`) (core) · tool-call animations (shimmer, live ms, staggered parallel groups, ok pop / error shake), rAF-batched deltas, lazy modals, bundle report (web)
- [ ] **blocked on user:** add repo secret `CLOUDFLARE_API_TOKEN` (wrangler is oauth locally — ci needs a token)
- [ ] **optional, user:** `CF_BROWSER_TOKEN` secret on bloop-sandbox for live-view handoff

## release checklist
- [ ] integrate agent work, cargo check + web build + sandbox typecheck
- [ ] commit in logical units
- [ ] deploy sandbox → core (`cd core && npx wrangler deploy --config wrangler.toml`, never repo root)
- [ ] evals 6/6 on prod + new v3 smoke prompts (browse, delegate, deep mode, lessons)
- [ ] playwright visual check (desktop + mobile)
- [ ] update HANDOFF.md (sse contract, api surface, footguns) · push `main`
