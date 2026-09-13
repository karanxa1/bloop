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

- [~] **build subagents + code workspace** — r2 `ws/<conv>/…` is source of truth · [ ] sandbox `POST /workspace/exec` hydrate→run→sync (sandbox agent) · [ ] core `workspace_{write,read,list,delete,exec}` built-ins, `workspace` sse, `delegate(kind: research|build)`, `/api/workspace/:conv/{files,file,exec}` (core agent) · [ ] web: lazy codemirror 6 editor panel (file tree, tabs, save, run, live refresh on `workspace` events) + richer subagent ui (launch after web agent lands)
- [~] remove invite code — backend check deleted in auth.rs (lead) · signup form field + api (web agent)
- [~] ui-perfect pass — research best agent app uis → `ui-spec.md` (research agent) · then 3 parallel implementers: (a) chat surface (b) chrome/modals/auth/trace (c) landing + tokens — launch after web agent lands

## release checklist
- [ ] integrate agent work, cargo check + web build + sandbox typecheck
- [ ] commit in logical units
- [ ] deploy sandbox → core (`cd core && npx wrangler deploy --config wrangler.toml`, never repo root)
- [ ] evals 6/6 on prod + new v3 smoke prompts (browse, delegate, deep mode, lessons)
- [ ] playwright visual check (desktop + mobile)
- [ ] update HANDOFF.md (sse contract, api surface, footguns) · push `main`
