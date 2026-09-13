import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationMeta, User } from "../types";
import { cx, prefersReducedMotion, relTime } from "../lib";
import {
  BlobIcon,
  BrainIcon,
  LogoutIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon,
  XIcon
} from "../icons";
import {
  ariaShortcut,
  menuKeyDown,
  openPalette,
  shortcutLabel,
  SHORTCUTS,
  SidebarIcon,
  SkillIcon,
  useMediaQuery
} from "./CommandPalette";
import { toast } from "./Toast";

interface SidebarProps {
  user: User;
  conversations: ConversationMeta[];
  status: "loading" | "ready" | "error";
  onRetry: () => void;
  activeId: string | null;
  /** conversation currently being fetched */
  loadingId: string | null;
  /** mobile: drawer visible · desktop: full width (false = icon rail) */
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  /** called after the undo window (~5s) — performs the real delete */
  onDelete: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onOpenMarketplace: () => void;
  onOpenMemories: () => void;
  /** opens the marketplace on its skills tab */
  onOpenSkills?: () => void;
  onLogout: () => void;
  /** desktop collapse ↔ expand */
  onToggle?: () => void;
}

const PREF_KEY = "bloop.sidebar";
/** desktop preference: true = expanded, false = icon rail */
export function readSidebarPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "rail";
  } catch {
    return true;
  }
}

const DAY = 86_400_000;
type Group = { label: string; items: ConversationMeta[] };

function groupByDate(list: ConversationMeta[]): Group[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: Group[] = [
    { label: "today", items: [] },
    { label: "yesterday", items: [] },
    { label: "previous 7 days", items: [] },
    { label: "previous 30 days", items: [] },
    { label: "older", items: [] }
  ];
  const time = (c: ConversationMeta) => {
    const t = new Date(c.updated_at).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  for (const c of [...list].sort((a, b) => time(b) - time(a))) {
    const t = time(c);
    const i = t >= today ? 0 : t >= today - DAY ? 1 : t >= today - 7 * DAY ? 2 : t >= today - 30 * DAY ? 3 : 4;
    buckets[i].items.push(c);
  }
  return buckets.filter((b) => b.items.length > 0);
}

const without = (s: ReadonlySet<string>, id: string) => {
  const n = new Set(s);
  n.delete(id);
  return n;
};
const withId = (s: ReadonlySet<string>, id: string) => new Set(s).add(id);

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

export const Sidebar = memo(function Sidebar({
  user,
  conversations,
  status,
  onRetry,
  activeId,
  loadingId,
  open,
  onClose,
  onNew,
  onSelect,
  onDelete,
  onRename,
  onOpenMarketplace,
  onOpenMemories,
  onOpenSkills,
  onLogout,
  onToggle
}: SidebarProps) {
  const desktop = useMediaQuery("(min-width: 1024px)");
  const rail = desktop && !open;
  const asideRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const latest = useRef({ onDelete, onNew, activeId });
  useLayoutEffect(() => {
    latest.current = { onDelete, onNew, activeId };
  });

  // remember expanded / rail on desktop
  useEffect(() => {
    if (!desktop) return;
    try {
      window.localStorage.setItem(PREF_KEY, open ? "open" : "rail");
    } catch {
      /* storage unavailable */
    }
  }, [desktop, open]);

  // drop undo-hidden ids once the list no longer contains them
  useEffect(() => {
    setHidden((h) => {
      if (h.size === 0) return h;
      const ids = new Set(conversations.map((c) => c.id));
      const next = new Set([...h].filter((id) => ids.has(id)));
      return next.size === h.size ? h : next;
    });
  }, [conversations]);

  // mobile drawer: Esc closes, focus is trapped, focus returns to the opener
  useEffect(() => {
    if (!open || desktop) return;
    const aside = asideRef.current;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    aside?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !aside) return;
      const items = [...aside.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!aside.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener) && !aside?.contains(opener)) opener.focus();
    };
  }, [open, desktop, onClose]);

  const visible = useMemo(
    () => conversations.filter((c) => !hidden.has(c.id)),
    [conversations, hidden]
  );
  const q = query.trim().toLowerCase();
  const groups = useMemo<Group[]>(
    () =>
      q
        ? [
            {
              label: "results",
              items: visible.filter((c) => (c.title || "untitled").toLowerCase().includes(q))
            }
          ]
        : groupByDate(visible),
    [visible, q]
  );
  const order = groups.flatMap((g) => g.items.map((c) => c.id));
  const orderRef = useRef(order);
  orderRef.current = order;

  const requestDelete = (c: ConversationMeta) => {
    const ids = orderRef.current;
    const i = ids.indexOf(c.id);
    const nextId = ids[i + 1] ?? ids[i - 1];
    if (c.id === latest.current.activeId) latest.current.onNew();
    const title = c.title || "untitled";
    const commit = () => {
      setLeaving((s) => without(s, c.id));
      setHidden((s) => withId(s, c.id));
      requestAnimationFrame(() => {
        const next = nextId
          ? document.querySelector<HTMLElement>(`[data-convo="${CSS.escape(nextId)}"]`)
          : null;
        (next ?? searchRef.current)?.focus();
      });
      toast({
        kind: "undo",
        message: `deleted “${title}”`,
        action: {
          label: "undo",
          onClick: () => {
            setHidden((s) => without(s, c.id));
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>(`[data-convo="${CSS.escape(c.id)}"]`)?.focus()
            );
          }
        },
        onExpire: () => latest.current.onDelete(c.id)
      });
    };
    if (prefersReducedMotion()) commit();
    else {
      setLeaving((s) => withId(s, c.id));
      window.setTimeout(commit, 180);
    }
  };

  const toggle = onToggle ?? onClose;

  return (
    <>
      {/* mobile scrim */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-neutral-900/30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        ref={asideRef}
        aria-label="sidebar"
        className={cx(
          "z-40 flex shrink-0 flex-col bg-bloop-deep text-white",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:w-[84vw] max-lg:max-w-[300px] max-lg:transition-transform max-lg:motion-safe:duration-200",
          "lg:motion-safe:transition-[width] lg:motion-safe:duration-[240ms] lg:motion-safe:ease-[cubic-bezier(.22,1,.36,1)]",
          open ? "lg:w-[260px]" : "max-lg:invisible max-lg:-translate-x-full lg:w-14"
        )}
      >
        {rail ? (
          <Rail
            user={user}
            onExpand={toggle}
            onNew={onNew}
            onOpenMarketplace={onOpenMarketplace}
            onOpenMemories={onOpenMemories}
            onOpenSkills={onOpenSkills}
            onLogout={onLogout}
          />
        ) : (
          <>
            {/* wordmark */}
            <div className="relative flex items-center gap-2.5 overflow-hidden px-4 pb-3 pt-4">
              <svg
                className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 text-white/15"
                viewBox="0 0 200 200"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="100" cy="100" r="40" stroke="currentColor" />
                <circle cx="100" cy="100" r="70" stroke="currentColor" />
                <circle cx="100" cy="100" r="100" stroke="currentColor" />
              </svg>
              <BlobIcon className="h-7 w-7" />
              <span className="font-wordmark text-2xl font-bold leading-none">bloop</span>
              {desktop ? (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label="collapse sidebar"
                  aria-keyshortcuts={ariaShortcut(SHORTCUTS.sidebar)}
                  title={`collapse sidebar (${shortcutLabel(SHORTCUTS.sidebar)})`}
                  className="relative ml-auto rounded-full p-1.5 text-white/70 transition-colors duration-150 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                >
                  <SidebarIcon className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="close sidebar"
                  className="relative ml-auto rounded-full p-1.5 text-white/70 transition-colors duration-150 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* primary actions */}
            <div className="space-y-2 px-3 pb-2">
              <button
                type="button"
                onClick={onNew}
                aria-keyshortcuts={ariaShortcut(SHORTCUTS.newChat)}
                className="group flex h-10 w-full items-center gap-2 rounded-full bg-bloop pl-4 pr-3 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-px"
              >
                <PlusIcon className="h-4 w-4" />
                new chat
                <kbd className="ml-auto font-sans text-[10px] font-semibold text-neutral-900/60">
                  {shortcutLabel(SHORTCUTS.newChat)}
                </kbd>
              </button>

              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/55" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query) {
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                  aria-label="search chats"
                  aria-controls="convo-history"
                  placeholder="search chats"
                  className="h-8 w-full rounded-full bg-white/10 pl-8 pr-12 text-[13px] text-white outline-none transition-colors duration-150 placeholder:text-white/55 hover:bg-white/15 focus:bg-white/15 focus:ring-2 focus:ring-white/60 [&::-webkit-search-cancel-button]:hidden"
                />
                <button
                  type="button"
                  onClick={openPalette}
                  aria-label="open command palette"
                  aria-keyshortcuts={ariaShortcut(SHORTCUTS.palette)}
                  title="command palette"
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-2 py-0.5 font-sans text-[10px] font-semibold text-white/70 transition-colors duration-150 hover:bg-white/25 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                >
                  <kbd className="font-sans">{shortcutLabel(SHORTCUTS.palette)}</kbd>
                </button>
              </div>
              <span className="sr-only" aria-live="polite">
                {q ? `${groups[0]?.items.length ?? 0} chats match` : ""}
              </span>
            </div>

            {/* destinations */}
            <ul className="space-y-px px-3 pb-2" aria-label="destinations">
              <NavItem icon={<PlugIcon className="h-4 w-4" />} label="tools & apps" onClick={onOpenMarketplace} />
              {onOpenSkills && (
                <NavItem icon={<SkillIcon className="h-4 w-4" />} label="skills" onClick={onOpenSkills} />
              )}
              <NavItem
                icon={<BrainIcon className="h-4 w-4" />}
                label="knowledge"
                sub="memories · context · lessons"
                onClick={onOpenMemories}
              />
            </ul>

            {/* conversation history */}
            <nav
              id="convo-history"
              aria-label="conversation history"
              aria-busy={status === "loading" || undefined}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin border-t border-white/10 pb-2"
            >
              {status === "loading" && conversations.length === 0 ? (
                <>
                  <span className="sr-only">loading chats…</span>
                  <ul className="space-y-1 px-3 pt-4" aria-hidden="true">
                    {[70, 45, 70, 45, 70, 45].map((w, i) => (
                      <li key={i} className="flex h-8 items-center px-3">
                        <span
                          className="block h-2.5 bg-white/15 motion-safe:animate-pulse"
                          style={{ width: `${w}%`, animationDelay: `${i * 80}ms` }}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : status === "error" && conversations.length === 0 ? (
                <div className="px-6 py-4 text-xs text-white/75" role="alert">
                  couldn&rsquo;t load your chats.{" "}
                  <button
                    type="button"
                    onClick={onRetry}
                    className="font-semibold text-white underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-white"
                  >
                    retry
                  </button>
                </div>
              ) : visible.length === 0 ? (
                <p className="px-6 py-4 text-xs text-white/60">no chats yet — say hi.</p>
              ) : q && groups[0].items.length === 0 ? (
                <p className="px-6 py-4 text-xs text-white/60">
                  no chats match &ldquo;{query.trim()}&rdquo;
                </p>
              ) : (
                groups.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="sticky top-0 z-10 bg-bloop-deep px-6 pb-1 pt-3 text-[10px] font-semibold text-white/60">
                      {g.label}
                    </h3>
                    <ul className="px-3">
                      {g.items.map((c) => (
                        <ConversationRow
                          key={c.id}
                          c={c}
                          active={c.id === activeId}
                          loading={c.id === loadingId}
                          leaving={leaving.has(c.id)}
                          onSelect={onSelect}
                          onRename={onRename}
                          onDelete={requestDelete}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </nav>

            <UserMenu
              user={user}
              onOpenMemories={onOpenMemories}
              onLogout={onLogout}
            />
          </>
        )}
      </aside>
    </>
  );
});

function NavItem({
  icon,
  label,
  sub,
  onClick
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium text-white/85 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
      >
        <span className="text-white/70">{icon}</span>
        <span className="whitespace-nowrap">{label}</span>
        {sub && <span className="ml-auto truncate text-[10px] font-normal text-white/50">{sub}</span>}
      </button>
    </li>
  );
}

function RailButton({
  label,
  onClick,
  children,
  className,
  shortcut,
  ...rest
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  shortcut?: string;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      className={cx(
        "group relative flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-white",
        className ?? "text-white/75 hover:bg-white/15 hover:text-white"
      )}
      {...rest}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap bg-neutral-900 px-2 py-1 font-sans text-[11px] font-medium text-white opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {label}
        {shortcut && <span className="ml-1.5 text-white/60">{shortcutLabel(shortcut)}</span>}
      </span>
    </button>
  );
}

function Rail({
  user,
  onExpand,
  onNew,
  onOpenMarketplace,
  onOpenMemories,
  onOpenSkills,
  onLogout
}: {
  user: User;
  onExpand: () => void;
  onNew: () => void;
  onOpenMarketplace: () => void;
  onOpenMemories: () => void;
  onOpenSkills?: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center gap-1.5 py-3">
      <RailButton label="expand sidebar" onClick={onExpand} shortcut={SHORTCUTS.sidebar}>
        <BlobIcon className="h-6 w-6" />
      </RailButton>
      <div className="my-1 h-px w-6 bg-white/15" />
      <RailButton
        label="new chat"
        onClick={onNew}
        shortcut={SHORTCUTS.newChat}
        className="bg-bloop text-neutral-900 hover:bg-white"
      >
        <PlusIcon className="h-4 w-4" />
      </RailButton>
      <RailButton label="search" onClick={openPalette} shortcut={SHORTCUTS.palette}>
        <SearchIcon className="h-4 w-4" />
      </RailButton>
      <RailButton label="tools & apps" onClick={onOpenMarketplace}>
        <PlugIcon className="h-4 w-4" />
      </RailButton>
      {onOpenSkills && (
        <RailButton label="skills" onClick={onOpenSkills}>
          <SkillIcon className="h-4 w-4" />
        </RailButton>
      )}
      <RailButton label="knowledge" onClick={onOpenMemories}>
        <BrainIcon className="h-4 w-4" />
      </RailButton>
      <div className="mt-auto">
        <UserMenu user={user} onOpenMemories={onOpenMemories} onLogout={onLogout} rail />
      </div>
    </div>
  );
}

function ConversationRow({
  c,
  active,
  loading,
  leaving,
  onSelect,
  onRename,
  onDelete
}: {
  c: ConversationMeta;
  active: boolean;
  loading: boolean;
  leaving: boolean;
  onSelect: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onDelete: (c: ConversationMeta) => void;
}) {
  const title = c.title || "untitled";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const focusRow = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-convo="${CSS.escape(c.id)}"]`)?.focus()
    );

  const startRename = () => {
    if (!onRename) return;
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== title) onRename?.(c.id, t);
    focusRow();
  };

  return (
    <li
      className={cx(
        "grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-[180ms]",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"
      )}
    >
      <div className="group relative min-h-0 overflow-hidden">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
                focusRow();
              }
            }}
            aria-label="rename chat"
            maxLength={120}
            className="my-px h-8 w-full border-l-2 border-l-bloop bg-white/15 px-3 text-[13px] text-white outline-none ring-1 ring-inset ring-white/50"
          />
        ) : (
          <button
            type="button"
            data-convo={c.id}
            onClick={() => onSelect(c.id)}
            onDoubleClick={startRename}
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault();
                startRename();
              } else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
                e.preventDefault();
                onDelete(c);
              }
            }}
            title={`${title} · ${relTime(c.updated_at)}`}
            aria-current={active ? "page" : undefined}
            aria-busy={loading || undefined}
            className={cx(
              "flex h-8 w-full items-center gap-2 border-l-2 pl-3 pr-9 text-left text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white",
              active || loading
                ? "border-l-bloop bg-white/15 font-medium text-white"
                : "border-l-transparent text-white/80 hover:bg-white/10 hover:text-white",
              active && "[view-transition-name:active-chat]"
            )}
          >
            {loading && <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-bloop" />}
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
        )}
        {!editing && (
          <button
            ref={moreRef}
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`options for ${title}`}
            className={cx(
              "absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-white/70 transition-[opacity,background-color] duration-150 hover:bg-white/20 hover:text-white focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white group-hover:opacity-100 [@media(hover:none)]:opacity-100",
              active || menuOpen ? "opacity-100" : "opacity-0"
            )}
          >
            <DotsIcon />
          </button>
        )}
      </div>
      {menuOpen && moreRef.current && (
        <RowMenu
          anchor={moreRef.current}
          label={`options for ${title}`}
          onClose={(refocus) => {
            setMenuOpen(false);
            if (refocus) moreRef.current?.focus();
          }}
          items={[
            ...(onRename
              ? [{ label: "rename", icon: <PencilIcon className="h-3.5 w-3.5" />, run: startRename }]
              : []),
            {
              label: "delete",
              icon: <TrashIcon className="h-3.5 w-3.5" />,
              danger: true,
              run: () => onDelete(c)
            }
          ]}
        />
      )}
    </li>
  );
}

function DotsIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

const MENU_W = 168;

function RowMenu({
  anchor,
  label,
  items,
  onClose
}: {
  anchor: HTMLElement;
  label: string;
  items: { label: string; icon: ReactNode; danger?: boolean; run: () => void }[];
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    const h = items.length * 36 + 8;
    const top = r.bottom + 4 + h > window.innerHeight ? r.top - h - 4 : r.bottom + 4;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    return { top, left };
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) closeRef.current(false);
    };
    const onMove = () => closeRef.current(false);
    const scroller = anchor.closest("nav");
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    scroller?.addEventListener("scroll", onMove, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      scroller?.removeEventListener("scroll", onMove);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => menuKeyDown(e, closeRef.current)}
      style={{ top: pos.top, left: pos.left, width: MENU_W }}
      className="fixed z-[55] border border-neutral-200 border-l-2 border-l-bloop bg-white py-1 shadow-[0_8px_24px_rgb(0_0_0/0.14)] motion-safe:transition-[opacity,translate] motion-safe:duration-150 starting:-translate-y-1 starting:opacity-0"
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          type="button"
          tabIndex={-1}
          onClick={() => {
            onClose(false);
            it.run();
          }}
          className={cx(
            "flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] outline-none transition-colors duration-100 focus:bg-page",
            it.danger
              ? "text-red-700 hover:bg-red-50 focus:bg-red-50"
              : "text-neutral-800 hover:bg-page"
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

function UserMenu({
  user,
  onOpenMemories,
  onLogout,
  rail
}: {
  user: User;
  onOpenMemories: () => void;
  onLogout: () => void;
  rail?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const initial = (user.name || user.email || "?").trim().charAt(0) || "?";
  const itemCls =
    "flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] text-neutral-800 outline-none transition-colors duration-100 hover:bg-page focus:bg-page";

  return (
    <div ref={wrapRef} className={cx("relative", !rail && "border-t border-white/15 p-3")}>
      {open && (
        <div
          role="menu"
          aria-label="account"
          onKeyDown={(e) => menuKeyDown(e, close)}
          className={cx(
            "absolute z-50 border border-neutral-200 border-l-2 border-l-bloop bg-white py-1 shadow-[0_8px_24px_rgb(0_0_0/0.14)] motion-safe:transition-[opacity,translate] motion-safe:duration-150 starting:translate-y-1 starting:opacity-0",
            rail ? "bottom-0 left-full ml-3 w-52" : "bottom-full left-3 right-3 mb-1"
          )}
        >
          <div className="border-b border-neutral-100 px-3 pb-2 pt-1.5">
            <span className="block truncate text-[12px] font-semibold text-neutral-900">
              {user.name || user.email}
            </span>
            <span className="block truncate text-[11px] normal-case text-neutral-500">{user.email}</span>
          </div>
          <button
            role="menuitem"
            type="button"
            tabIndex={-1}
            onClick={() => {
              close(false);
              openPalette();
            }}
            className={itemCls}
          >
            <SearchIcon className="h-4 w-4 text-neutral-500" />
            commands
            <kbd className="ml-auto font-sans text-[10px] text-neutral-400">
              {shortcutLabel(SHORTCUTS.palette)}
            </kbd>
          </button>
          <button
            role="menuitem"
            type="button"
            tabIndex={-1}
            onClick={() => {
              close(false);
              onOpenMemories();
            }}
            className={itemCls}
          >
            <BrainIcon className="h-4 w-4 text-neutral-500" />
            knowledge
          </button>
          <button
            role="menuitem"
            type="button"
            tabIndex={-1}
            onClick={() => {
              close(false);
              onLogout();
            }}
            className={itemCls}
          >
            <LogoutIcon className="h-4 w-4 text-neutral-500" />
            sign out
          </button>
        </div>
      )}

      {rail ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`account: ${user.name || user.email}`}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-bloop font-wordmark text-sm font-bold text-neutral-900 transition-colors duration-150 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <span aria-hidden="true">{initial}</span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`account: ${user.name || user.email}`}
          className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bloop font-wordmark text-sm font-bold text-neutral-900"
          >
            {initial}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-white">
              {user.name || user.email}
            </span>
            <span className="block truncate text-[10px] normal-case text-white/60">{user.email}</span>
          </span>
        </button>
      )}
    </div>
  );
}
