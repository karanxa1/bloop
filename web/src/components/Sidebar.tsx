import { memo, useEffect, useRef, useState } from "react";
import type { ConversationMeta, User } from "../types";
import { cx, relTime } from "../lib";
import {
  BlobIcon,
  BrainIcon,
  ChatIcon,
  LogoutIcon,
  PlugIcon,
  PlusIcon,
  SpinnerIcon,
  TrashIcon,
  XIcon
} from "../icons";

interface SidebarProps {
  user: User;
  conversations: ConversationMeta[];
  status: "loading" | "ready" | "error";
  onRetry: () => void;
  activeId: string | null;
  /** conversation currently being fetched */
  loadingId: string | null;
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenMarketplace: () => void;
  onOpenMemories: () => void;
  onLogout: () => void;
}

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
  onOpenMarketplace,
  onOpenMemories,
  onLogout
}: SidebarProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Esc closes the drawer on small screens
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !window.matchMedia("(min-width: 1024px)").matches)
        onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-neutral-900/30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="conversations"
        className={cx(
          "z-40 flex w-[260px] shrink-0 flex-col bg-bloop-deep text-white",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:max-w-[85vw] max-lg:transition-transform max-lg:motion-safe:duration-200",
          !open && "max-lg:invisible max-lg:-translate-x-full lg:hidden"
        )}
      >
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
          <span className="font-wordmark text-2xl font-bold leading-none">
            bloop
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close sidebar"
            className="ml-auto rounded-full p-1.5 text-white/70 transition-colors duration-150 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white lg:hidden"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* actions */}
        <div className="space-y-1.5 px-3 pb-2">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center justify-center gap-1.5 rounded-full bg-bloop px-4 py-2.5 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-safe:hover:-translate-y-px"
          >
            <PlusIcon className="h-4 w-4" />
            new chat
          </button>
          <button
            type="button"
            onClick={onOpenMarketplace}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
          >
            <PlugIcon className="h-4 w-4" />
            tools
            <span className="ml-auto text-[10px] text-white/50">mcp servers</span>
          </button>
        </div>

        {/* conversation list */}
        <nav
          aria-label="conversation history"
          aria-busy={status === "loading" || undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin px-3 pb-2 pt-1"
        >
          {status === "loading" && conversations.length === 0 ? (
            <>
              <span className="sr-only">loading chats…</span>
              <ul className="space-y-0.5" aria-hidden="true">
                {[62, 80, 48, 72, 56].map((w, i) => (
                  <li key={i} className="flex items-center gap-2 px-3 py-2">
                    <span className="h-3.5 w-3.5 shrink-0 bg-white/10" />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block h-3 bg-white/15 motion-safe:animate-pulse"
                        style={{ width: `${w}%` }}
                      />
                      <span className="mt-1.5 block h-2 w-10 bg-white/10 motion-safe:animate-pulse" />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : status === "error" && conversations.length === 0 ? (
            <div className="px-3 py-4 text-xs text-white/70" role="alert">
              couldn&rsquo;t load your chats.{" "}
              <button
                type="button"
                onClick={onRetry}
                className="font-semibold text-white underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-white"
              >
                retry
              </button>
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-3 py-4 text-xs text-white/50">
              no chats yet — say hi.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={c.id === activeId ? "page" : undefined}
                    aria-busy={c.id === loadingId || undefined}
                    className={cx(
                      "flex w-full items-center gap-2 border-l-2 py-2 pl-3 pr-9 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white",
                      c.id === activeId || c.id === loadingId
                        ? "border-l-bloop bg-white/15 text-white"
                        : "border-l-transparent text-white/75 hover:bg-white/10 hover:text-white"
                    )}
                  >
                    {c.id === loadingId ? (
                      <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-bloop" />
                    ) : (
                      <ChatIcon className="h-3.5 w-3.5 shrink-0 text-white/50" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">
                        {c.title || "untitled"}
                      </span>
                      <span className="block text-[10px] text-white/45">
                        {relTime(c.updated_at)}
                      </span>
                    </span>
                  </button>
                  {confirmId === c.id ? (
                    <button
                      type="button"
                      autoFocus
                      onBlur={() => setConfirmId(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setConfirmId(null);
                        }
                      }}
                      onClick={() => {
                        setConfirmId(null);
                        onDelete(c.id);
                      }}
                      aria-label={`confirm delete ${c.title || "conversation"}`}
                      className="motion-safe:pop absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-red-500 px-2.5 py-1 text-[10px] font-semibold text-white transition-colors duration-150 hover:bg-red-600 focus-visible:outline-2 focus-visible:outline-white"
                    >
                      delete?
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(c.id)}
                      aria-label={`delete ${c.title || "conversation"}`}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-white/50 opacity-0 transition-all duration-150 hover:bg-white/20 hover:text-white focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </nav>

        {/* user chip + menu */}
        <UserMenu
          user={user}
          onOpenMemories={onOpenMemories}
          onLogout={onLogout}
        />
      </aside>
    </>
  );
});

function UserMenu({
  user,
  onOpenMemories,
  onLogout
}: {
  user: User;
  onOpenMemories: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const initial = (user.name || user.email || "?").trim().charAt(0) || "?";

  return (
    <div ref={wrapRef} className="relative border-t border-white/15 p-3">
      {open && (
        <div
          role="menu"
          aria-label="account menu"
          className="motion-safe:tool-in absolute bottom-full left-3 right-3 mb-1 border border-white/15 bg-bloop-deep py-1"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenMemories();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/85 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
          >
            <BrainIcon className="h-4 w-4" />
            memories
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/85 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
          >
            <LogoutIcon className="h-4 w-4" />
            sign out
          </button>
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="account menu"
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
          <span className="block truncate text-[10px] text-white/50">
            {user.email}
          </span>
        </span>
      </button>
    </div>
  );
}
