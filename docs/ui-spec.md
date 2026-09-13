# bloop ui spec v4: patterns from the best agent UIs

Scope: `web/src/components/*`, `web/src/index.css`, `web/public/landing/index.html`. Research only, no repo edits made.
Brand rules are fixed: lowercase copy, lime `#8DC63F` / deep `#5c8a2c`, page `#f2f2f2`, Baloo 2 wordmark, Inter body, **sharp panels with a left accent border**, **round pills and buttons**.

Where the code is today (read from the repo):
- `MessageList.tsx` puts `aria-live="polite"` on the **whole scroll container**. Screen readers would read out every streamed token, so this is an a11y bug (fixed in A1).
- Auto-scroll is pinned at a 120px threshold, but there is no scroll-to-bottom button.
- A generic "bloop is working…" line shows during streaming.
- There are no message actions (copy, retry, edit, feedback).
- `Composer.tsx` **disables the textarea while streaming**, so you can't draft the next message. It has no mode tray, no attachments, and only Enter/Shift+Enter shortcuts.
- `ToolCallCard.tsx` is one card per call. Expand/collapse is instant (no height motion). It shows raw `call.name` with no verb label or live timer, and output is cut at 1200 chars with no copy button.
- `Sidebar.tsx` is a flat list with relative times, no date groups and no search. Delete runs immediately with no undo.
- `index.css` has only one `rise` keyframe. There are no motion or status tokens.

---

## 0. shared contracts (agree before parallel work)

**Tokens.** Package C adds these to `index.css` `@theme`. Packages A and B use them by name. Until C merges, A and B use the literal fallback values in brackets.

| token | value | use |
|---|---|---|
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | all enters/expands |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | exits |
| `--dur-1` / `--dur-2` / `--dur-3` / `--dur-4` | 120ms / 180ms / 240ms / 400ms | hover · expand · panel · hero |
| `--color-ok` | `#5c8a2c` | done |
| `--color-run` | `#8dc63f` | running |
| `--color-warn` | `#b45309` | needs you / takeover |
| `--color-err` | `#dc2626` | failed |
| `--color-surface` / `--color-line` | `#fff` / `#e5e5e5` | panels / hairlines (prep for dark mode) |
| utilities | `shimmer-text`, `skeleton`, `collapse` (+`data-open`), `flash`, `blob-dots` | see C1/C3 |

**`App.tsx` is not owned by any package.** Each package ships components with **new optional props** that default to no-op, and lists the wiring it needs in its PR. A short integration pass (~40 lines) happens after merge.
**`types.ts` is owned by A.** B only reads `Conversation`.
**`icons.tsx` is frozen.** New icons are defined locally in the file that uses them, which avoids merge conflicts.

---

## P0

### A · chat surface (MessageList, Composer, ToolCallCard, parts, types.ts, new `MessageActions.tsx`, `Sources.tsx`)

**A1. stick-to-bottom + scroll-to-bottom button** (ChatGPT, Claude.ai, assistant-ui `ThreadPrimitive.ScrollToBottom`, Vercel chatbot `use-stick-to-bottom`). Effort **S**
- `MessageList.tsx`: keep the pinned logic, and track `atBottom` with an IntersectionObserver on a 1px sentinel after the last message (cheaper than onScroll math).
- When not at bottom, show a **round** 36px white button: `border-line`, shadow `0 2px 8px rgb(0 0 0/.08)`, deep-green chevron-down. Place it centered, 12px above the composer, absolutely positioned inside the list wrapper.
  - Enter: `opacity 0→1`, `translateY 6px→0`, `--dur-2 --ease-out`.
- If content arrives while scrolled up, the button becomes a lime pill `new activity ↓` (h-8, px-3, text-[11px] font-semibold).
- Click scrolls smoothly (`behavior: smooth`, or instant under reduced motion) and re-pins.
- If the user scrolls up by 1px or more during streaming, unpin. Never snap back.
- **a11y:** move `aria-live` off the scroller. Add one visually hidden `<div role="status" aria-live="polite">` that announces only step changes ("searching gmail", "done, 4 tools, 2 verified"). Never announce tokens.

**A2. tool-call grouping + auto-collapse** (Claude.ai "used N tools", Cursor agent, ChatGPT agent activity, AI Elements `Tool`/`ChainOfThought`). Effort **M**
- In `MessageBubble`, fold **consecutive** `tool` parts (with no text between them) into a new `<ToolGroup>` in `ToolCallCard.tsx`.
- **Header row:** sharp, `border-l-2 border-l-bloop`, h-9, bg white. Contents:
  - stacked app logos (max 3, 14px, overlapping by -4px)
  - `ran 4 tools · gmail, notion · 2.1s` (text-xs, neutral-600, tabular-nums)
  - status icon on the right, then the chevron
- **While any call is running:** the group is open, and the header text is the live verb of the newest running call in `shimmer-text` (e.g. `searching gmail…`).
- **Auto-collapse:** 800ms after every call is `ok`, the group collapses by itself via `collapse` (grid-template-rows 0fr↔1fr, `--dur-2`).
  - If the user manually toggled it, stop auto-behaviour for that group.
  - If any call errored, stay open and give the header left border `--color-err`.
- **Parallel calls** (same batch id or overlapping start times): render inside the group as a lane. A 1px `--color-line` vertical bracket on the left with a `parallel ×3` micro-label (text-[10px] uppercase is off-brand, so use lowercase `3 at once`). Rows stack with 4px gaps.
- A single tool call with no neighbours still uses `ToolCallCard` directly, with no group chrome.

**A3. ToolCallCard states & detail** (ChatGPT tool rows, Claude.ai, v0/Bolt step rows). Effort **S**
- **Human verb label:** keep a map `name → verb` (`gmail.search → searching gmail`, fallback `running {name}`). Show the verb in text-[13px] and keep the mono `call.name` as a secondary text-[10px] neutral-400.
- **Live elapsed timer** while running: `1.2s`, updated every 100ms via rAF, tabular-nums. On finish, freeze it at the final `ms`.
- **State visuals** (all 14px icons):

  | state | left border | icon | text |
  |---|---|---|---|
  | queued | neutral-300 | hollow | neutral-400 |
  | running | lime | spinner | shimmer |
  | ok | deep | check, which scales 0.6→1 over 180ms on entry | normal |
  | error | red | x | normal |

- **Error body is always visible** and has 3 parts: what failed / why (first line of output) / a round `retry` text-button if an `onRetryTool` prop exists.
- **Expand animation:** use `collapse` (no instant pop). The chevron rotates over `--dur-1`.
- **Details:** args and output get a hover copy icon-button (round 24px, top-right, shows `copied` for 1.2s). Output over 1200 chars gets `show all (8.4kb)` instead of silent truncation. JSON gets light syntax tint (keys deep-green, strings neutral-700).
- The whole header row is the toggle button (a bigger hit target than a 14px chevron), with `aria-expanded` and `aria-controls`.

**A4. reasoning / thinking block** (ChatGPT "thought for 12s", Grok think, Claude extended thinking, AI Elements `Reasoning`). Effort **S**
- Add `kind: "reasoning"` to `types.ts` (text plus startedAt/endedAt).
- **While streaming:** a row with the 3-blob animation (`blob-dots`) and `thinking` in shimmer. Up to 3 lines of the latest reasoning text appear below it (text-xs neutral-500, italic off, mask-fade top). The block is open.
- **On finish:** collapse to `thought for 12s ›` (text-xs neutral-500, chevron). Clicking expands the full text in a sharp `bg-page border-l-2 border-l-neutral-300` panel. No lime here: reasoning is secondary to tool proof.
- Merge several reasoning parts in one message into one block.

**A5. message actions** (ChatGPT, Claude.ai, assistant-ui `ActionBar` + `BranchPicker`, LibreChat fork). Effort **M**
- New `MessageActions.tsx`, rendered under each message.
  - **Assistant messages:** copy · retry · 👍/👎 (use SVG thumbs, no emoji) · `n/m` branch picker if alternates exist.
  - **User messages:** edit · copy, right-aligned.
- **Buttons:** round 28px, icon 14px, neutral-400 → hover bg neutral-200/60 text-bloop-deep, `--dur-1`. Tooltip after a 400ms delay.
- **Visibility:**
  - Always visible on the **last** assistant message and on touch devices (`@media (hover:none)`).
  - Otherwise `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`.
  - Actions reserve their height, so rows never shift.
- **Copy:** copies markdown. The icon swaps to a check for 1.2s, plus an sr-only "copied".
- **Edit:** the user bubble turns in place into a sharp textarea (same width, `border-bloop-deep`) with a round `cancel` (ghost) and a round `send` (lime). Enter sends, Esc cancels. Sending truncates everything after it (branching is P1). Props: `onEdit(id, text)`, `onRetry(id)`, `onFeedback(id, up|down)`.
- **Feedback:** 👎 opens a small inline row of chips (`wrong`, `didn't finish`, `unsafe action`, `other`) and a note input. The chips are round pills.
- **Hover timestamp** on the user bubble: `2:14 pm` (text-[10px] neutral-400).

**A6. composer upgrade** (ChatGPT, Claude.ai, Grok toggles, Perplexity, v0). Effort **M**
- **Structure:** one sharp box (`bg-white border border-line`, focus-within `border-bloop-deep` plus a 2px `ring-bloop/30`). Inside it:
  - textarea (no own border), min 1 row, max 8 rows / 200px
  - **bottom tray** h-10: left = paperclip (P1 placeholder hidden) and mode pills `default · think · deep`; right = char/tokens hint (only if more than 2k chars) and the round send/stop button (36px)
- **Mode pills:** h-7 px-3 text-xs, round.
  - off: `bg-page text-neutral-600`
  - on: `bg-bloop-deep text-white` with an icon (think = blob, deep = globe)
  - Switching the pill animates with a shared `view-transition-name: mode-pill`, or a 120ms bg crossfade as fallback.
  - The placeholder changes per mode: `tell bloop what to do…` / `think it through…` / `research anything — bloop will cite sources…`.
- **Don't disable the textarea while streaming.** Drafting is allowed. Enter while streaming does nothing, and the hint shows `esc to stop`.
- **Send ↔ stop:** crossfade/scale (0.8→1, 120ms). Stop is deep-green with a 2px lime progress ring (animated conic border) while streaming.
- **Shortcuts:**
  - `/` focuses the composer from anywhere (not inside inputs)
  - `Esc` stops the stream
  - `↑` in an empty composer edits the last user message
  - `⌘/Ctrl+Enter` always sends
  - Show these in a hint line that fades after the first 3 sends (keep a localStorage counter, wrapped in try/catch).
- **Mobile:** tray pills scroll horizontally, send stays pinned right, and the textarea font is 16px (prevents iOS zoom).

**A7. sources: inline citations + source strip** (Perplexity, ChatGPT deep research, AI Elements `InlineCitation`/`Sources`). Effort **M**
- Add `sources: {id,url,title,domain,snippet}[]` to the message type. In markdown, `[n]` markers become `<Cite n>` (remark plugin or a regex on text nodes, skipping code).
- **Inline marker:** a round pill `domain +2`, h-[18px] px-1.5 text-[10px] font-semibold, `bg-bloop/15 text-bloop-deep`, baseline-aligned. Hover sets bg `bg-bloop/30`.
- **Hover/focus card** (300ms open delay, 100ms close grace):
  - A **sharp** 320px panel with `border-l-2 border-l-bloop`, white, shadow-md. Contents: favicon 14px + domain, title (2 lines, font-semibold), snippet (≤200 chars), `1/3 ‹ ›` pager.
  - Enter: opacity + translateY 4px over 120ms.
  - Click on touch opens the same card; Esc closes it.
- **Source strip** above the answer body in deep mode: a `12 sources` pill with an overlapping favicon stack (4 max). Clicking toggles a horizontal row of sharp source cards (160×64, title plus domain, numbered `1`…) with overflow-x scroll and snap. Clicking a card opens the url in a new tab.
- Don't render the strip for 0–1 sources.

**A8. contextual streaming status + caret** (ChatGPT agent, Manus, Perplexity "completed 2 steps"). Effort **S**
- Replace `bloop is working…` with a status row: `blob-dots` + the current step label (the latest running tool verb, `thinking`, or `writing`) in `shimmer-text` + elapsed time.
- While the final text streams, a trailing **sharp** caret (7×14px lime block) blinks at 1s steps at the end of the last `.md` node. It is removed on finish.
- No per-token fade-in (it looks mushy and costs perf).

### B · chrome (Sidebar, Header, Modal, MemoriesModal, MarketplaceModal, AuthScreen, ProofTrace, new `CommandPalette.tsx`, new `Toast.tsx`)

**B1. command palette ⌘K** (ChatGPT ⌘K search, Claude.ai, Linear, Cursor). Effort **M**
- New `CommandPalette.tsx`. It owns its own global keydown (`⌘/Ctrl+K`) and listens for a `bloop:palette` CustomEvent so Sidebar/Header can open it without App state. It is mounted inside `Header.tsx`, which is always mounted. Conversations and actions arrive via optional props (App integration).
- **Panel:** sharp, 560px (full width minus 16px on mobile), top 18vh, white, `border-l-4 border-l-bloop`, shadow-xl. Backdrop `bg-black/20 backdrop-blur-[2px]`. Enter: scale .98→1 + opacity over 160ms `--ease-out`. Exit: 100ms.
- **Input:** h-12 text-[15px], no border, bottom hairline, placeholder `search chats or type a command…`.
- **Sections** (text-[10px] neutral-400 labels):
  - `actions`: new chat `⌘⇧O`, toggle proof `⌘.`, open tools, open knowledge, model → terra/sol/luna, mode → think/deep
  - `chats`: fuzzy match on title with matched chars in font-semibold
- **Rows:** h-9, px-3, the active row gets `bg-page border-l-2 border-l-bloop-deep`. Shortcuts are round `kbd` pills (h-5 px-1.5 text-[10px] bg-neutral-100).
- **Keys:** ↑/↓ wrap, Enter runs, Esc closes. `role="combobox"` + `listbox`, `aria-activedescendant`. Focus returns to the trigger on close.

**B2. sidebar: date groups, search, undo delete, collapse** (ChatGPT, Claude.ai, Open WebUI). Effort **M**
- **Groups:** `today · yesterday · previous 7 days · previous 30 days · older` (month names for older than 30 days: `august`). Headers are sticky, text-[10px] font-semibold text-white/45, px-3 pt-3 pb-1, with the deep-green background so rows scroll underneath.
- **Row:** drop the per-row relative time (the group already conveys it) to get denser 32px rows. Show the time only in a `title` tooltip.
- **Search:** a round `search ⌘K` pill button at the top (h-8, `bg-white/10 text-white/70`) opens the palette. This avoids a second search implementation.
- **Rename:** double-click the title (or the row menu) for an inline input. Enter saves, Esc reverts.
- **Row menu:** replace the lone trash icon with a `⋯` round button: rename · delete.
- **Delete:** optimistic remove with a row collapse animation (height→0 over 180ms), then a **toast** `chat deleted · undo` for 5s (new `Toast.tsx`: sharp, bottom-left, `border-l-4 border-l-bloop`, deep text, round `undo` pill). The real delete call fires when the toast expires (`onDelete` is invoked late).
- **Loading:** 6 `skeleton` rows (sharp bars 70%/45% width) instead of an empty flash.
- **Collapse:** `⌘B` toggles a 56px icon rail (new chat, tools, search, avatar). Width animates over `--dur-3`, and the state persists to localStorage.
- **Mobile (<768px):** off-canvas drawer 84vw with a scrim. Swipe-close is optional (P1). Focus is trapped while open.

**B3. header: status popover, proof badge, mobile compaction** (ChatGPT model picker, Claude connectors menu, Devin status). Effort **S**
- **Health pill** `3 apps connected` becomes a button. Clicking opens a sharp popover (260px) listing apps with a status dot (8px round: ok deep / warn amber / err red), last check time, and a `manage tools` link that fires `onOpenMarketplace`. If any app is erroring, the pill turns amber with `1 app needs attention`.
- **Model picker:** each option gets a one-line description in text-[11px] neutral-500 (`terra: fastest`, `sol: balanced`, `luna: deepest`), a check on the selected option, and ↑/↓ keyboard nav.
- **Proof toggle:** when the panel is closed and new verifications arrive, show a lime count badge (round 16px, text-[10px]) that pulses once (scale 1→1.15→1, 400ms).
- **<640px:** the title truncates, the model picker collapses to its icon, and health becomes a dot only.

**B4. ProofTrace as a real timeline** (Manus "computer" panel, ChatGPT agent activity view, Devin progress, v0/Lovable step lists). Effort **M**
- **Sticky top:** plan progress `3/5 steps` plus a 3px sharp progress bar (bg neutral-200, fill lime, width transition `--dur-3`).
- **Plan checklist nodes** are **sharp 10px squares** on a 1px vertical rail (`--color-line`), aligned to the rail's x center:

  | state | node | text |
  |---|---|---|
  | pending | hollow neutral-300 | neutral-400 |
  | active | lime fill with a 1.6s pulse ring (box-shadow 0→6px lime/0) | neutral-900, semibold |
  | done | deep fill with a white check | neutral-600 |
  | failed | red | normal |

  The active step also gets a `now` round pill.
- **Live feed:** each tool event appears as a compact row (verb, app logo, ms) with a `rise` entry (translateY 4px, 180ms). If new rows arrive while the user has scrolled up, show a `jump to live` round pill (same pattern as A1).
- **Cross-link:** clicking a feed row dispatches `bloop:focus-tool` with `{toolId}`. A listens: it scrolls that card into view (block center) and applies `flash` (bg lime/20 → transparent over 900ms). Both sides only need the event name, no shared file.
- **Verifications:** hash chips are round mono pills (text-[10px]) truncated to `a1f3…9c2e`. Clicking copies the full hash (`copied`). Failed verifications pin to the top with a red left border.
- **Empty state:** a sharp dashed-border box `run something — every step lands here with proof` plus 3 skeleton rows at 40% opacity.
- **Width:** 320px (resizable to 480px via a drag handle is P2). Below 1024px it becomes an overlay sheet from the right with a scrim.

**B5. Modal foundation** (Radix/shadcn Dialog behaviour used by all the reference apps). Effort **S**
- **Behaviour:** focus trap (Tab cycles), initial focus on the first input or the close button, restore focus to the opener, Esc and backdrop-click close, `aria-modal`, `aria-labelledby`, body scroll lock.
- **Motion:** in = backdrop fade 160ms + panel translateY 8px→0 & opacity over 180ms `--ease-out`. Out = 120ms `--ease-in` (keep it mounted until `animationend`).
- **Mobile (<640px):** bottom sheet, full width, sharp top edge with a 4px lime top border, max-h 90vh, with a round grab handle 36×4.
- **Tabs** (MemoriesModal: memories|context|lessons): round pill tabs with a lime underline-free active fill (`bg-bloop-deep text-white`), arrow-key roving tabindex, and a count badge per tab.

**B6. AuthScreen polish** (Claude.ai, ChatGPT, Vercel template auth). Effort **S**
- Autofocus email.
- Validation runs on blur (not on every keystroke), with the message under the field in text-xs red and `aria-describedby`.
- Show/hide password round icon button.
- Caps-lock hint.
- Submit button: round, full width, shows a spinner and `signing in…` while pending, disabled against double submit.
- Server error goes in a sharp `border-l-2 border-l-red-600 bg-red-50` banner with `role="alert"`.
- Login↔signup switch is a cross-fade (no layout jump; the container keeps a fixed min-height).
- `autocomplete` attributes set (`email`, `current-password` / `new-password`).

### C · landing + global tokens (`web/src/index.css`, `web/public/landing/index.html`)

**C1. motion system** (Linear/Vercel/Claude motion restraint). Effort **S**
- Add the §0 tokens. Keyframes plus utilities:
  - `shimmer-text`: `background: linear-gradient(90deg, neutral-500 0%, neutral-900 50%, neutral-500 100%)`, `background-size: 200%`, `bg-clip:text`, 1.6s linear infinite.
  - `blob-dots`: 3 × 6px lime circles, translateY 0→-3px, 900ms, staggered 0/150/300ms. Reuse it for the existing 3-blob thinking animation.
  - `collapse`: `display:grid; grid-template-rows:0fr; transition: grid-template-rows var(--dur-2) var(--ease-out)`, `[data-open=true]{grid-template-rows:1fr}`, and the child gets `min-height:0; overflow:hidden`.
  - `flash`: keyframes bg `rgb(141 198 63/.2)`→transparent over 900ms.
  - `pulse-ring`: for active plan nodes.
  - `caret-blink`: `steps(1)` 1s.
- **View transitions:** `@view-transition { navigation: auto }` for landing→app. `::view-transition-old(root)`/`new(root)` get a 180ms fade. Named transitions: `proof-panel`, `mode-pill`.
- **Global guard:** `@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important; scroll-behavior:auto!important } }`. Shimmer degrades to static neutral-600.
- **Focus ring:** `:focus-visible { outline: 2px solid var(--color-bloop-deep); outline-offset: 2px }` as the base (the components already do this per-element, so this unifies it).
- `.tabular { font-variant-numeric: tabular-nums }`.

**C2. skeleton + prose polish.** Effort **S**
- `skeleton`: sharp (no radius), `bg neutral-200`, with a moving highlight via `::after` gradient 1.4s. Height is set by the caller.
- `.md` prose:
  - max line length 68ch
  - `h1–h3` 1.25/1.1/1rem semibold with a 1.25em top margin
  - lists 1.5 line-height
  - tables: sharp, header bg-page, hairline rows, horizontal scroll wrapper
  - inline code round-sm pill `bg-neutral-100`
  - blockquote keeps the 3px lime border
  - links: deep-green underline-offset-2, hover lime

**C3. landing page** (v0/Lovable/Manus landings: show the product working, not adjectives). Effort **M**
- **Hero:**
  - Left side keeps the lime wordmark block.
  - Right side gets a **live mini demo**: a sharp panel with a CSS/JS loop (~12s) that types a prompt, then 3 tool rows appear with a check pop and hash chips, then `verified ✓`.
  - Pure CSS/vanilla JS, paused off-screen (IntersectionObserver), static final frame under reduced motion.
- **Sticky nav:** 56px, blur `bg-page/80`. Wordmark left; `how it works`, `tools`, round `open bloop` lime CTA right. Gets a hairline border once scrolled more than 8px.
- **Sections:**
  1. app logo strip (grayscale → color on hover)
  2. `plan → run → verify`: 3 sharp cards with left accent borders and numbered Baloo 2 digits
  3. proof trace screenshot/mock with callouts
  4. MCP marketplace chips
  5. final CTA
- **Performance:** `<link rel=preconnect>` to fonts, `font-display:swap`, explicit width/height on images, hero image `fetchpriority=high`, everything else `loading=lazy`. Target LCP under 2s.
- **Mobile:** stack the hero with the demo below, nav collapses to wordmark + CTA, 16px gutters.
- **a11y:** proper `h1`/`h2` order, skip link, 4.5:1 contrast. Note white on `#8DC63F` is only about 2.1:1, so **body text on lime must be deep `#1f2d10` or the text must be ≥24px bold**. Apply the same rule in `MessageList` EmptyState (flag to A as P1).

---

## P1

| # | pattern | from | maps to | details | effort |
|---|---|---|---|---|---|
| 1 | attachments (drop, paste, chips) | ChatGPT, Claude | Composer.tsx, parts.tsx | drag overlay: sharp dashed lime border across the whole chat surface, `drop files for bloop`. Files show as sharp 56px thumb chips in the composer with a round × and an upload progress bar along the bottom 2px | M |
| 2 | branch picker after edit/retry | ChatGPT, assistant-ui, LibreChat | MessageActions.tsx, types.ts | `‹ 2/3 ›` text-[11px] tabular. Switching crossfades the message body over 120ms | M |
| 3 | delegate (subagent) card nesting | Claude Code subagents, Devin | ToolCallCard.tsx | sharp card, `border-l-2 border-l-bloop-deep`, header `delegated · researcher · 6 tools`. Children indented 12px with a 1px rail, collapsed by default when done. Max nesting 2 visual levels, deeper levels flatten with a `↳` prefix | M |
| 4 | browser take-over handoff | OpenAI Operator / ChatGPT agent, Manus | parts.tsx, ProofTrace.tsx | amber `--color-warn` left border. Title `bloop needs you: log in to notion`. Live screenshot thumb 16:10. Round lime `take over` + ghost `skip`. The card is **sticky** at the bottom of the chat viewport until resolved. Proof trace node turns amber `waiting on you`. Browser tab title prefixes `(!)` | M |
| 5 | code block header | ChatGPT, Claude | parts.tsx | bar h-8 bg-neutral-800 with language label, `copy`, and `wrap` toggle. Line numbers for more than 10 lines. Output panel shows an exit status pill | S |
| 6 | image part | ChatGPT images | parts.tsx | skeleton with shimmer at the known aspect ratio while generating, blur-up on load, click opens a lightbox Modal with download (via fetch+blob in-app, not a `<a download>` in the landing) | S |
| 7 | follow-up suggestions | Perplexity "related" | MessageList.tsx | after the final answer, 3 round pills `bg-white border-line` that send on click. Only on the last message | S |
| 8 | marketplace connect flow | Claude connectors, LobeChat plugins | MarketplaceModal.tsx | search input + category pills. Card button states: `connect` → spinner `connecting…` → `connected ✓` (deep) → hover shows `disconnect`. Grid skeleton on load. Empty search `no servers match "x"` | M |
| 9 | knowledge modal search + undo | Open WebUI memory, ChatGPT memory mgmt | MemoriesModal.tsx | filter input per tab, inline edit, delete with undo toast, `source: chat title · 3d ago` meta | M |
| 10 | hover preview on chat rows | Open WebUI | Sidebar.tsx | after 600ms hover, a sharp card shows the last 2 message snippets. Desktop only | S |
| 11 | deep-research plan approval | ChatGPT deep research, Gemini | MessageList.tsx, ProofTrace.tsx | before a deep run, the plan renders as an editable checklist card with `start research` (lime round) and `edit plan`. Auto-starts after 10s countdown ring unless touched | M |
| 12 | notification when long runs finish | ChatGPT agent, Manus | Header.tsx | tab title `✓ done · bloop` + optional Notification API if the tab is hidden and the run took more than 30s | S |

## P2

- **Dark mode.** Tokens from §0 make it possible. Sidebar stays deep green; page `#141614`, surface `#1c1f1b`, lime text only ≥14px semibold. Ship it only after an a11y audit.
- **Replay/scrub the proof trace timeline** (Manus replay): a slider scrubs tool events and dims the chat after the cursor. Effort L.
- **Resizable proof panel + split view** of a browser live view (ChatGPT agent desktop view). Effort L.
- **Share conversation read-only link** with proof hashes shown (Perplexity share, Claude share). Effort M.
- **Voice input** mic in the composer tray (LobeChat, ChatGPT). Effort M.
- **Conversation pin/folders/tags** (Open WebUI, LibreChat). Effort M.
- **Context meter** (AI Elements `Context`): a round ring in the composer showing context used by the model. Effort S.

---

## anti-patterns to avoid

- **`aria-live` on the streaming container.** It announces every token (current bug). Announce step changes only.
- **Scroll hijacking.** Never force-scroll a user who scrolled up. Never use smooth-scroll on every token (jank). Instant-pin while pinned, smooth only on an explicit button click.
- **Disabling the composer during streaming.** Let users draft. Only block the send action.
- **Every tool call as a full card forever.** 20 cards bury the answer. Group, auto-collapse when done, keep errors open.
- **Spinners without words.** Always pair motion with a verb (`searching gmail`) and elapsed time.
- **Raw JSON or tool ids as primary labels.** Human verb first, mono name secondary.
- **Fake or paragraph-level citations.** Cite per claim. No citation pills on unsourced text, and no source strip for 0–1 sources.
- **Layout shift from hover actions.** Reserve the action row height and use opacity only.
- **Over-animation.** No per-token fades, no bouncy springs on panels, no looping motion outside running states. Everything obeys `prefers-reduced-motion`.
- **Brand drift.** No rounded cards or modals (panels stay sharp), no square buttons (buttons stay round), no Title Case or UPPERCASE labels, no second accent color (amber and red are status only, never decoration).
- **White text on lime at small sizes** (~2.1:1 contrast). Use deep green or near-black on lime.
- **Instant destructive actions.** Delete chat, memory or server gets an undo toast, not a confirm dialog and not silence.
- **Icon-only controls without labels/tooltips** (health dot, proof toggle, mode pills on mobile).
- **Modal stacking** (palette over modal over drawer). Opening the palette closes other overlays.

---

## parallel work packages (P0 only; disjoint file ownership)

| pkg | owns (exclusive) | items | est. |
|---|---|---|---|
| **A · chat surface** | `MessageList.tsx`, `Composer.tsx`, `ToolCallCard.tsx`, `parts.tsx`, `types.ts`, new `MessageActions.tsx`, new `Sources.tsx` | A1 scroll + live region · A2 tool grouping · A3 tool card states · A4 reasoning · A5 message actions · A6 composer · A7 citations/sources · A8 streaming status + caret | ~3 dev-days |
| **B · chrome** | `Sidebar.tsx`, `Header.tsx`, `Modal.tsx`, `MemoriesModal.tsx`, `MarketplaceModal.tsx`, `AuthScreen.tsx`, `ProofTrace.tsx`, new `CommandPalette.tsx`, new `Toast.tsx` | B1 ⌘K palette · B2 sidebar groups/undo/collapse · B3 header popovers/badge · B4 proof timeline · B5 modal a11y+motion · B6 auth polish | ~3 dev-days |
| **C · landing + tokens** | `web/src/index.css`, `web/public/landing/index.html` (and its `web/dist` copy is build output, not hand-edited) | C1 motion tokens/utilities/view transitions/reduced motion · C2 skeleton + prose · C3 landing demo hero, nav, sections, perf, contrast | ~2 dev-days |

**Cross-package contracts (no file overlap):**
1. **Token and utility names** in §0. C should merge first (S, about 2h). A and B can start in parallel using the fallback values.
2. **DOM events:**
   - `bloop:palette` (open palette): dispatched by Sidebar and Header, handled in CommandPalette.
   - `bloop:focus-tool` `{toolId}`: dispatched by ProofTrace, handled in MessageList.
   - `bloop:stop`: dispatched by the palette, optionally handled in Composer.
3. **`App.tsx` integration pass after merge:**
   - pass `onEdit`, `onRetry`, `onFeedback`, `sources`, and reasoning parts into MessageList
   - pass `conversations`/actions into CommandPalette via Header
   - wire delayed delete for the undo toast
   - add the mode state to Composer
4. **Icons:** define new SVGs locally, and don't touch `icons.tsx`.

---

## references consulted
- assistant-ui primitives: ActionBar, BranchPicker, ThreadPrimitive.ScrollToBottom (assistant-ui.com/docs/primitives)
- Vercel AI Elements: Reasoning (auto-open while streaming, "thought for N seconds", shimmer), InlineCitation (`hostname +N` badge, hover carousel 1/N), ChainOfThought, Tool, Sources, Context (elements.ai-sdk.dev)
- Perplexity citation teardown (aiuxplayground.com/teardowns/perplexity/citations), AI citation UI patterns 2026 (aydesign.ai)
- Agent UX patterns: activity panel separate from chat, timeline survives interruption, plan approval, 3-part errors (fuselabcreative.com/ui-design-for-ai-agents)
- ChatGPT agent mode: desktop vs activity views, takeover for logins/payments (2026 guides)
- Manus "computer" third panel and replay (workos.com, designcode.io)
- Open WebUI history grouping (today/yesterday/previous 7 days) and hover preview card (docs.openwebui.com)
