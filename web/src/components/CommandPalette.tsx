import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ChatMode, ConversationMeta, ModelInfo } from "../types";
import {
  BrainIcon,
  ChatIcon,
  CheckIcon,
  LogoutIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  TraceIcon
} from "../icons";
import { cx, prefersReducedMotion, relTime } from "../lib";

// ── shared keyboard helpers (used by Header + Sidebar too) ──────────

export const PALETTE_EVENT = "bloop:palette";
export const openPalette = () => window.dispatchEvent(new CustomEvent(PALETTE_EVENT));

export const SHORTCUTS = {
  palette: "mod+k",
  newChat: "mod+shift+o",
  sidebar: "mod+b",
  trace: "mod+."
} as const;

const isMac = () =>
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);

/** "mod+shift+o" → "⌘⇧O" on mac, "ctrl+shift+O" elsewhere */
export function shortcutLabel(s: string): string {
  const mac = isMac();
  const parts = s.split("+").map((p) =>
    p === "mod" ? (mac ? "⌘" : "ctrl") : p === "shift" ? (mac ? "⇧" : "shift") : p.toUpperCase()
  );
  return parts.join(mac ? "" : "+");
}

/** value for aria-keyshortcuts */
export function ariaShortcut(s: string): string {
  return s
    .split("+")
    .map((p) =>
      p === "mod" ? (isMac() ? "Meta" : "Control") : p === "shift" ? "Shift" : p.toUpperCase()
    )
    .join("+");
}

function matches(e: KeyboardEvent, s: string): boolean {
  const parts = s.split("+");
  const key = parts[parts.length - 1];
  const wantShift = parts.includes("shift");
  if (parts.includes("mod") && !(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey || e.shiftKey !== wantShift) return false;
  return e.key.toLowerCase() === key;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

/** roving arrow-key focus for role="menu" containers */
export function menuKeyDown(e: ReactKeyboardEvent<HTMLElement>, close: (refocus: boolean) => void) {
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]')
  ];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const focusAt = (n: number) => items[(n + items.length) % items.length]?.focus();
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      focusAt(i + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      focusAt(i < 0 ? -1 : i - 1);
      break;
    case "Home":
      e.preventDefault();
      focusAt(0);
      break;
    case "End":
      e.preventDefault();
      focusAt(-1);
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      close(true);
      break;
    case "Tab":
      close(false);
      break;
  }
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 shrink-0 items-center rounded-full bg-neutral-100 px-1.5 font-sans text-[10px] font-medium text-neutral-500",
        className
      )}
    >
      {children}
    </kbd>
  );
}

// ── fuzzy match ─────────────────────────────────────────────────────

interface Match {
  score: number;
  hits: number[];
}

export function fuzzy(query: string, text: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    const boundary = at === 0 || /[\s\-_.·:/]/.test(t[at - 1]);
    return {
      score: 1000 + (boundary ? 200 : 0) - at * 2 - (t.length - q.length) * 0.2,
      hits: Array.from({ length: q.length }, (_, k) => at + k)
    };
  }
  const hits: number[] = [];
  let from = 0;
  let prev = -2;
  let score = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, from);
    if (found < 0) return null;
    if (found === prev + 1) score += 12;
    else if (found === 0 || /[\s\-_.·:/]/.test(t[found - 1])) score += 8;
    else score += 1;
    score -= Math.min(found - from, 12) * 0.4;
    hits.push(found);
    prev = found;
    from = found + 1;
  }
  return { score, hits };
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let buf = "";
  let on = false;
  const push = (k: number) => {
    if (!buf) return;
    out.push(
      on ? (
        <mark key={k} className="bg-transparent font-semibold text-neutral-950">
          {buf}
        </mark>
      ) : (
        buf
      )
    );
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      push(i);
      on = hit;
    }
    buf += text[i];
  }
  push(text.length);
  return <>{out}</>;
}

// ── local icons (icons.tsx is frozen) ───────────────────────────────

const svg = "h-4 w-4 shrink-0";
function SkillIcon({ className = svg }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}
function CubeIcon({ className = svg }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 16V8l-9-5-9 5v8l9 5z" />
      <path d="M3.3 7.5L12 12l8.7-4.5M12 22V12" />
    </svg>
  );
}
function DialIcon({ className = svg }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}
function FolderIcon({ className = svg }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z" />
    </svg>
  );
}
export function SidebarIcon({ className = svg }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" />
      <path d="M9 4v16" />
    </svg>
  );
}
export { SkillIcon };

// ── palette ─────────────────────────────────────────────────────────

const MODE_COPY: Record<ChatMode, string> = {
  default: "quick answers and actions",
  think: "reason it through first",
  deep: "research with sources"
};
const MODEL_COPY: Record<string, string> = {
  terra: "strongest",
  sol: "balanced",
  luna: "fastest"
};

export function splitModelLabel(m: ModelInfo): { name: string; desc: string } {
  const [name, ...rest] = (m.label || m.id).split("·").map((s) => s.trim());
  const key = Object.keys(MODEL_COPY).find((k) => m.id.includes(k) || name.includes(k));
  return { name: name || m.id, desc: rest.join(" · ") || (key ? MODEL_COPY[key] : "") };
}

interface Command {
  id: string;
  label: string;
  keywords?: string;
  hint?: string;
  shortcut?: string;
  icon: ReactNode;
  checked?: boolean;
  /** keep the palette open (e.g. drill into "model:") */
  stay?: boolean;
  /** only listed when searching */
  searchOnly?: boolean;
  run: () => void;
}

export interface CommandPaletteProps {
  conversations: ConversationMeta[];
  activeId?: string | null;
  models: ModelInfo[];
  model: string;
  onModelChange: (id: string) => void;
  mode?: ChatMode;
  onModeChange?: (m: ChatMode) => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onOpenMarketplace?: () => void;
  onOpenKnowledge?: () => void;
  onOpenSkills?: () => void;
  onToggleTrace?: () => void;
  onToggleWorkspace?: () => void;
  onToggleSidebar?: () => void;
  onSignOut?: () => void;
  /** called as the palette opens — close other overlays (no modal stacking) */
  onOpen?: () => void;
}

const RECENT_KEY = "bloop.palette.recent";
function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, 6);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

interface Section {
  key: string;
  label: string;
  items: { cmd: Command; hits: number[] }[];
}

export function CommandPalette(props: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const openRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const propsRef = useRef(props);
  const baseId = useId();
  useLayoutEffect(() => {
    propsRef.current = props;
    openRef.current = open;
  });

  const show = useCallback(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    setRecent(readRecent());
    setClosing(false);
    setOpen(true);
    openRef.current = true;
    propsRef.current.onOpen?.();
  }, []);

  const hide = useCallback((immediate = false, restore = true) => {
    openRef.current = false;
    const finish = () => {
      setOpen(false);
      setClosing(false);
      const o = openerRef.current;
      if (restore && o && document.contains(o)) o.focus();
    };
    if (immediate || prefersReducedMotion()) finish();
    else {
      setClosing(true);
      window.setTimeout(finish, 100);
    }
  }, []);

  // global shortcuts + open event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const p = propsRef.current;
      if (matches(e, SHORTCUTS.palette)) {
        e.preventDefault();
        if (openRef.current) hide();
        else show();
      } else if (matches(e, SHORTCUTS.newChat)) {
        e.preventDefault();
        if (openRef.current) hide(true, false);
        p.onNewChat();
      } else if (matches(e, SHORTCUTS.sidebar) && p.onToggleSidebar) {
        e.preventDefault();
        p.onToggleSidebar();
      } else if (matches(e, SHORTCUTS.trace) && p.onToggleTrace) {
        e.preventDefault();
        p.onToggleTrace();
      }
    };
    const onOpenEvent = () => {
      if (!openRef.current) show();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onOpenEvent);
    };
  }, [show, hide]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const { actions, chats } = useMemo(() => {
    if (!open) return { actions: [] as Command[], chats: [] as Command[] };
    const p = props;
    const a: Command[] = [
      {
        id: "new-chat",
        label: "new chat",
        keywords: "start fresh conversation",
        shortcut: SHORTCUTS.newChat,
        icon: <PlusIcon className={svg} />,
        run: p.onNewChat
      }
    ];
    if (p.models.length > 0)
      a.push({
        id: "switch-model",
        label: "switch model…",
        keywords: "model llm",
        hint: splitModelLabel(p.models.find((m) => m.id === p.model) ?? p.models[0]).name,
        icon: <CubeIcon />,
        stay: true,
        run: () => setQuery("model: ")
      });
    if (p.onModeChange)
      a.push({
        id: "switch-mode",
        label: "switch mode…",
        keywords: "think deep research default",
        hint: p.mode,
        icon: <DialIcon />,
        stay: true,
        run: () => setQuery("mode: ")
      });
    if (p.onOpenMarketplace)
      a.push({
        id: "open-marketplace",
        label: "open tools & apps",
        keywords: "marketplace mcp servers connect integrations",
        icon: <PlugIcon className={svg} />,
        run: p.onOpenMarketplace
      });
    if (p.onOpenSkills)
      a.push({
        id: "open-skills",
        label: "open skills",
        keywords: "marketplace playbooks",
        icon: <SkillIcon />,
        run: p.onOpenSkills
      });
    if (p.onOpenKnowledge)
      a.push({
        id: "open-knowledge",
        label: "open knowledge",
        keywords: "memories context lessons memory",
        icon: <BrainIcon className={svg} />,
        run: p.onOpenKnowledge
      });
    if (p.onToggleTrace)
      a.push({
        id: "toggle-trace",
        label: "toggle proof trace",
        keywords: "verify panel receipts",
        shortcut: SHORTCUTS.trace,
        icon: <TraceIcon className={svg} />,
        run: p.onToggleTrace
      });
    if (p.onToggleWorkspace)
      a.push({
        id: "toggle-workspace",
        label: "toggle workspace",
        keywords: "files sandbox panel",
        icon: <FolderIcon />,
        run: p.onToggleWorkspace
      });
    if (p.onToggleSidebar)
      a.push({
        id: "toggle-sidebar",
        label: "toggle sidebar",
        keywords: "collapse expand rail",
        shortcut: SHORTCUTS.sidebar,
        icon: <SidebarIcon />,
        run: p.onToggleSidebar
      });
    for (const m of p.models) {
      const { name, desc } = splitModelLabel(m);
      a.push({
        id: `model:${m.id}`,
        label: `model: ${name}`,
        keywords: m.id,
        hint: desc,
        checked: m.id === p.model,
        searchOnly: true,
        icon: <CubeIcon />,
        run: () => p.onModelChange(m.id)
      });
    }
    if (p.onModeChange) {
      const change = p.onModeChange;
      for (const md of ["default", "think", "deep"] as const)
        a.push({
          id: `mode:${md}`,
          label: `mode: ${md}`,
          hint: MODE_COPY[md],
          checked: md === p.mode,
          searchOnly: true,
          icon: <DialIcon />,
          run: () => change(md)
        });
    }
    if (p.onSignOut)
      a.push({
        id: "sign-out",
        label: "sign out",
        keywords: "log out logout",
        icon: <LogoutIcon className={svg} />,
        run: p.onSignOut
      });
    const c: Command[] = p.conversations.map((cv) => ({
      id: `chat:${cv.id}`,
      label: cv.title || "untitled",
      hint: cv.id === p.activeId ? "current" : relTime(cv.updated_at),
      icon: <ChatIcon className={svg} />,
      run: () => p.onSelectConversation(cv.id)
    }));
    return { actions: a, chats: c };
  }, [open, props]);

  const sections = useMemo<Section[]>(() => {
    if (!open) return [];
    const q = query.trim();
    const out: Section[] = [];
    if (!q) {
      const byId = new Map([...actions, ...chats].map((c) => [c.id, c]));
      const rec = recent
        .map((id) => byId.get(id))
        .filter((c): c is Command => !!c && !c.searchOnly)
        .slice(0, 4);
      const recentIds = new Set(rec.map((c) => c.id));
      out.push({ key: "recent", label: "recent", items: rec.map((cmd) => ({ cmd, hits: [] })) });
      out.push({
        key: "actions",
        label: "actions",
        items: actions
          .filter((c) => !c.searchOnly && !recentIds.has(c.id))
          .map((cmd) => ({ cmd, hits: [] }))
      });
      out.push({
        key: "chats",
        label: "chats",
        items: chats
          .filter((c) => !recentIds.has(c.id))
          .slice(0, 8)
          .map((cmd) => ({ cmd, hits: [] }))
      });
    } else {
      const rank = (list: Command[], limit: number) =>
        list
          .map((cmd) => {
            const m = fuzzy(q, cmd.label);
            if (m) return { cmd, hits: m.hits, score: m.score };
            const k = cmd.keywords ? fuzzy(q, cmd.keywords) : null;
            return k ? { cmd, hits: [], score: k.score - 50 } : null;
          })
          .filter((x): x is { cmd: Command; hits: number[]; score: number } => x != null)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      out.push({ key: "actions", label: "actions", items: rank(actions, 10) });
      out.push({ key: "chats", label: "chats", items: rank(chats, 12) });
    }
    return out.filter((s) => s.items.length > 0);
  }, [open, query, actions, chats, recent]);

  const flat = useMemo(() => sections.flatMap((s) => s.items.map((i) => i.cmd)), [sections]);
  const activeIdx = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optId = (i: number) => `${baseId}-opt-${i}`;

  useEffect(() => {
    if (activeIdx >= 0)
      document.getElementById(optId(activeIdx))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  const runAt = (i: number) => {
    const cmd = flat[i];
    if (!cmd) return;
    if (cmd.stay) {
      cmd.run();
      setActive(0);
      inputRef.current?.focus();
      return;
    }
    pushRecent(cmd.id);
    hide(true);
    cmd.run();
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const n = flat.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (n) setActive((activeIdx + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (n) setActive((activeIdx - 1 + n) % n);
        break;
      case "Enter":
        e.preventDefault();
        if (!e.nativeEvent.isComposing) runAt(activeIdx);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (query) {
          setQuery("");
          setActive(0);
        } else hide();
        break;
      case "Tab":
        e.preventDefault(); // focus stays in the dialog
        e.stopPropagation(); // …and no other focus trap reacts
        break;
    }
  };

  if (!open) return null;

  let index = -1;
  return (
    <div
      role="presentation"
      className={cx(
        "fixed inset-0 z-[60] flex justify-center px-2 pt-[10vh] sm:pt-[18vh]",
        "motion-safe:transition-[background-color,backdrop-filter] motion-safe:duration-150 starting:bg-black/0 starting:backdrop-blur-none",
        closing ? "bg-black/0 backdrop-blur-none" : "bg-black/20 backdrop-blur-[2px]"
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) hide();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="command palette"
        className={cx(
          "flex h-fit max-h-[min(70dvh,32rem)] w-full max-w-[560px] flex-col border-l-4 border-l-bloop bg-white shadow-[0_24px_64px_rgb(0_0_0/0.22)]",
          "motion-safe:transition-[opacity,scale] motion-safe:ease-[cubic-bezier(.22,1,.36,1)] starting:scale-[.98] starting:opacity-0",
          closing ? "scale-[.98] opacity-0 motion-safe:duration-100" : "motion-safe:duration-[160ms]"
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-neutral-200 px-3.5">
          <SearchIcon className="h-4 w-4 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={activeIdx >= 0 ? optId(activeIdx) : undefined}
            aria-autocomplete="list"
            aria-label="search chats or type a command"
            placeholder="search chats or type a command…"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-neutral-900 outline-none placeholder:text-neutral-400 sm:text-[15px]"
          />
          <Kbd>esc</Kbd>
        </div>

        <div
          id={`${baseId}-list`}
          role="listbox"
          aria-label="results"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin py-1.5"
        >
          {sections.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-neutral-500">
              nothing matches &ldquo;{query.trim()}&rdquo;
            </p>
          ) : (
            sections.map((s) => (
              <div key={s.key} role="group" aria-labelledby={`${baseId}-${s.key}`}>
                <div
                  id={`${baseId}-${s.key}`}
                  role="presentation"
                  className="px-4 pb-1 pt-2 text-[10px] font-semibold text-neutral-400"
                >
                  {s.label}
                </div>
                {s.items.map(({ cmd, hits }) => {
                  index++;
                  const i = index;
                  const on = i === activeIdx;
                  return (
                    <div
                      key={`${s.key}-${cmd.id}`}
                      id={optId(i)}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => {
                        if (!on) setActive(i);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runAt(i)}
                      className={cx(
                        "mx-1.5 flex h-9 cursor-pointer items-center gap-2.5 border-l-2 px-3 text-[13px]",
                        on
                          ? "border-l-bloop-deep bg-page text-neutral-900"
                          : "border-l-transparent text-neutral-700"
                      )}
                    >
                      <span className={on ? "text-bloop-deep" : "text-neutral-400"}>{cmd.icon}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <Highlight text={cmd.label} hits={hits} />
                      </span>
                      {cmd.checked && (
                        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-bloop-deep" />
                      )}
                      {cmd.hint && (
                        <span className="hidden max-w-[40%] truncate text-[11px] text-neutral-400 sm:inline">
                          {cmd.hint}
                        </span>
                      )}
                      {cmd.shortcut && <Kbd>{shortcutLabel(cmd.shortcut)}</Kbd>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-3 border-t border-neutral-100 px-4 py-2 text-[11px] text-neutral-400 sm:flex">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> run
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>{shortcutLabel(SHORTCUTS.palette)}</Kbd> toggle
          </span>
        </div>
        <div className="sr-only" aria-live="polite">
          {query.trim() ? `${flat.length} ${flat.length === 1 ? "result" : "results"}` : ""}
        </div>
      </div>
    </div>
  );
}
