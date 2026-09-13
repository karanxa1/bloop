import { memo, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { ModelInfo } from "../types";
import { ChevronIcon, PencilIcon, SearchIcon, SpinnerIcon, TraceIcon, CheckIcon } from "../icons";
import { cx, relTime } from "../lib";
import {
  ariaShortcut,
  Kbd,
  menuKeyDown,
  openPalette,
  shortcutLabel,
  SHORTCUTS,
  SidebarIcon,
  splitModelLabel,
  useMediaQuery
} from "./CommandPalette";

export interface HealthApp {
  name: string;
  /** "ok" | "connected" | "degraded" | "error" | … */
  state: string;
  tools?: number;
  error?: string;
}

export type HealthState =
  | { status: "loading" }
  | { status: "ok"; model?: string; servers: number; apps?: HealthApp[]; checkedAt?: number }
  | { status: "down"; checkedAt?: number };

interface HeaderProps {
  health: HealthState;
  title: string;
  /** whether a persisted conversation is active (title becomes editable) */
  canRename: boolean;
  onRename: (title: string) => void;
  models: ModelInfo[];
  model: string;
  onModelChange: (id: string) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  traceOpen: boolean;
  onToggleTrace: () => void;
  /** "manage tools" link in the status popover */
  onOpenMarketplace?: () => void;
  /** "check now" in the status popover */
  onRefreshHealth?: () => Promise<unknown> | void;
  /** new verifications since the proof panel was closed */
  proofBadge?: number;
}

const isOk = (s: string) => s === "ok" || s === "connected";

function healthSummary(health: HealthState) {
  if (health.status === "loading")
    return { tone: "idle" as const, label: "connecting…", short: "connecting" };
  if (health.status === "down") return { tone: "down" as const, label: "offline", short: "offline" };
  const apps = health.apps ?? [];
  const bad = apps.filter((a) => !isOk(a.state)).length;
  const n = health.apps ? apps.length : health.servers;
  if (bad > 0)
    return {
      tone: "warn" as const,
      label: `${bad} ${bad === 1 ? "app needs" : "apps need"} attention`,
      short: `${bad} need attention`
    };
  return {
    tone: "ok" as const,
    label: `${n} ${n === 1 ? "app" : "apps"} connected`,
    short: `${n} connected`
  };
}

export const Header = memo(function Header({
  health,
  title,
  canRename,
  onRename,
  models,
  model,
  onModelChange,
  sidebarOpen,
  onToggleSidebar,
  traceOpen,
  onToggleTrace,
  onOpenMarketplace,
  onRefreshHealth,
  proofBadge = 0
}: HeaderProps) {
  const desktop = useMediaQuery("(min-width: 1024px)");
  const sidebarLabel = desktop
    ? sidebarOpen
      ? "collapse sidebar"
      : "expand sidebar"
    : sidebarOpen
      ? "hide sidebar"
      : "show sidebar";

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-1.5 border-b border-neutral-200 bg-white px-2 sm:gap-2 sm:px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarLabel}
        aria-expanded={sidebarOpen}
        aria-keyshortcuts={ariaShortcut(SHORTCUTS.sidebar)}
        title={`${sidebarLabel} (${shortcutLabel(SHORTCUTS.sidebar)})`}
        className="shrink-0 rounded-full p-2 text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <SidebarIcon className="h-4.5 w-4.5" />
      </button>

      <TitleEditor title={title} canRename={canRename} onRename={onRename} />

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <button
          type="button"
          onClick={openPalette}
          aria-label="search and commands"
          aria-keyshortcuts={ariaShortcut(SHORTCUTS.palette)}
          title={`search and commands (${shortcutLabel(SHORTCUTS.palette)})`}
          className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-2 text-[12px] text-neutral-500 transition-colors duration-150 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-bloop-deep sm:pl-3 sm:pr-1.5"
        >
          <SearchIcon className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">search</span>
          <Kbd className="hidden sm:inline-flex">{shortcutLabel(SHORTCUTS.palette)}</Kbd>
        </button>

        <div className="hidden sm:block">
          <ModelPicker models={models} value={model} onChange={onModelChange} />
        </div>
        <div className="hidden sm:block">
          <HealthMenu
            health={health}
            onOpenMarketplace={onOpenMarketplace}
            onRefresh={onRefreshHealth}
          />
        </div>

        <button
          type="button"
          onClick={onToggleTrace}
          aria-expanded={traceOpen}
          aria-label="proof trace"
          aria-keyshortcuts={ariaShortcut(SHORTCUTS.trace)}
          title={`proof trace (${shortcutLabel(SHORTCUTS.trace)})`}
          className={cx(
            "relative flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep sm:px-3",
            traceOpen
              ? "bg-bloop text-neutral-900 hover:bg-bloop/85"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
          )}
        >
          <TraceIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">proof</span>
          {!traceOpen && proofBadge > 0 && (
            <span
              key={proofBadge}
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-bloop px-1 text-[10px] font-bold tabular-nums text-neutral-900 ring-2 ring-white motion-safe:transition-transform motion-safe:duration-300 starting:scale-150"
            >
              {proofBadge}
              <span className="sr-only"> new verifications</span>
            </span>
          )}
        </button>

        <div className="sm:hidden">
          <OverflowMenu
            health={health}
            models={models}
            model={model}
            onModelChange={onModelChange}
            onOpenMarketplace={onOpenMarketplace}
          />
        </div>
      </div>
    </header>
  );
});

// ── title ────────────────────────────────────────────────────────────

function TitleEditor({
  title,
  canRename,
  onRename
}: {
  title: string;
  canRename: boolean;
  onRename: (t: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setDraft(title), [title]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (save: boolean) => {
    setEditing(false);
    const t = draft.trim();
    if (save && t && t !== title) onRename(t);
    else setDraft(title);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    }
  };

  if (!canRename) {
    return (
      <h1 className="min-w-0 truncate font-wordmark text-base font-bold text-neutral-700">
        {title || "new chat"}
      </h1>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={onKey}
        aria-label="conversation title"
        maxLength={120}
        className="min-w-0 max-w-[16rem] flex-1 border-b-2 border-bloop bg-transparent font-wordmark text-base font-bold text-neutral-800 outline-none"
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setEditing(true)}
      aria-label={`rename conversation: ${title || "untitled"}`}
      title="rename conversation"
      className="group flex min-w-0 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-bloop-deep"
    >
      <h1 className="min-w-0 truncate font-wordmark text-base font-bold text-neutral-800">
        {title || "untitled"}
      </h1>
      <PencilIcon className="h-3 w-3 shrink-0 text-neutral-300 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

// ── popover plumbing ────────────────────────────────────────────────

function useOutsideClose(
  open: boolean,
  wrapRef: RefObject<HTMLElement | null>,
  close: () => void
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, wrapRef]);
}

const panelCls =
  "absolute right-0 top-full z-50 mt-1.5 border border-neutral-200 border-l-2 border-l-bloop bg-white shadow-[0_12px_32px_rgb(0_0_0/0.14)] outline-none motion-safe:transition-[opacity,translate] motion-safe:duration-150 motion-safe:ease-[cubic-bezier(.22,1,.36,1)] starting:-translate-y-1 starting:opacity-0";

// ── model picker (listbox popover) ──────────────────────────────────

function ModelPicker({
  models,
  value,
  onChange
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  useOutsideClose(open, wrapRef, () => setOpen(false));

  const selectedIdx = Math.max(0, models.findIndex((m) => m.id === value));
  useEffect(() => {
    if (!open) return;
    setActive(selectedIdx);
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (models.length === 0) return null;
  const current = splitModelLabel(models[selectedIdx]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (i: number) => {
    onChange(models[i].id);
    close();
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const n = models.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => (a + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => (a - 1 + n) % n);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(n - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`model: ${current.name}`}
        title="switch model"
        className="flex h-8 max-w-[10rem] items-center gap-1.5 rounded-full border border-neutral-200 bg-white pl-3 pr-2 text-[12px] font-semibold text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <span className="truncate">{current.name}</span>
        <ChevronIcon
          className={cx(
            "h-3 w-3 shrink-0 text-neutral-400 transition-transform duration-150",
            open ? "-rotate-90" : "rotate-90"
          )}
        />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label="model"
          aria-activedescendant={`${id}-opt-${active}`}
          onKeyDown={onListKey}
          className={cx(panelCls, "w-64 py-1")}
        >
          {models.map((m, i) => {
            const { name, desc } = splitModelLabel(m);
            const selected = m.id === value;
            return (
              <li
                key={m.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={selected}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
                className={cx(
                  "flex cursor-pointer items-center gap-2 border-l-2 px-3 py-2",
                  i === active ? "border-l-bloop-deep bg-page" : "border-l-transparent"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-neutral-900">{name}</span>
                  {desc && <span className="block text-[11px] text-neutral-500">{desc}</span>}
                </span>
                {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-bloop-deep" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── health / connected apps popover ─────────────────────────────────

function dotCls(state: string) {
  if (isOk(state)) return "bg-bloop-deep";
  if (state === "degraded") return "bg-amber-500";
  if (state === "error") return "bg-red-600";
  return "bg-neutral-300";
}

function HealthMenu({
  health,
  onOpenMarketplace,
  onRefresh
}: {
  health: HealthState;
  onOpenMarketplace?: () => void;
  onRefresh?: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useOutsideClose(open, wrapRef, () => setOpen(false));

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const s = healthSummary(health);
  const apps = health.status === "ok" ? (health.apps ?? []) : [];
  const checkedAt = health.status !== "loading" ? health.checkedAt : undefined;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const check = async () => {
    if (!onRefresh || checking) return;
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        aria-label={`app status: ${s.label}`}
        className={cx(
          "flex h-8 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-bloop-deep",
          s.tone === "warn"
            ? "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 hover:bg-amber-100"
            : s.tone === "down"
              ? "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-100"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "h-2 w-2 shrink-0 rounded-full",
            s.tone === "ok"
              ? "bg-bloop-deep"
              : s.tone === "warn"
                ? "bg-amber-500"
                : s.tone === "down"
                  ? "bg-red-600"
                  : "bg-neutral-400 motion-safe:animate-pulse"
          )}
        />
        <span className="hidden whitespace-nowrap md:inline">{s.label}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label="app status"
          tabIndex={-1}
          className={cx(panelCls, "w-72")}
        >
          <div className="flex items-baseline justify-between gap-2 border-b border-neutral-100 px-3.5 pb-2 pt-3">
            <span className="text-[12px] font-semibold text-neutral-900">connected apps</span>
            {checkedAt && (
              <span className="text-[10px] text-neutral-400">
                checked {relTime(new Date(checkedAt).toISOString())}
              </span>
            )}
          </div>
          {health.status === "down" ? (
            <p className="px-3.5 py-4 text-[12px] text-neutral-600">
              bloop&rsquo;s api isn&rsquo;t responding. retrying every 30s.
            </p>
          ) : health.status === "loading" ? (
            <p className="flex items-center gap-2 px-3.5 py-4 text-[12px] text-neutral-500">
              <SpinnerIcon className="h-3.5 w-3.5" /> checking…
            </p>
          ) : apps.length === 0 ? (
            <p className="px-3.5 py-4 text-[12px] text-neutral-500">
              {health.servers > 0
                ? `${health.servers} apps connected.`
                : "no apps connected yet."}
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto scroll-thin py-1" aria-label="apps">
              {apps.map((a) => (
                <li key={a.name} className="flex items-center gap-2.5 px-3.5 py-1.5">
                  <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full", dotCls(a.state))} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">{a.name}</span>
                  <span
                    className={cx(
                      "shrink-0 text-[11px] tabular-nums",
                      isOk(a.state)
                        ? "text-neutral-500"
                        : a.state === "degraded"
                          ? "font-medium text-amber-700"
                          : "font-medium text-red-700"
                    )}
                    title={a.error}
                  >
                    {isOk(a.state)
                      ? a.tools != null
                        ? `${a.tools} tools`
                        : "ok"
                      : a.state}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 border-t border-neutral-100 px-3 py-2.5">
            {onRefresh && (
              <button
                type="button"
                onClick={() => void check()}
                disabled={checking}
                className="flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-neutral-600 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:opacity-60"
              >
                {checking && <SpinnerIcon className="h-3 w-3" />}
                {checking ? "checking…" : "check now"}
              </button>
            )}
            {onOpenMarketplace && (
              <button
                type="button"
                onClick={() => {
                  close(false);
                  onOpenMarketplace();
                }}
                className="ml-auto flex h-7 items-center rounded-full bg-bloop px-3 text-[12px] font-bold text-neutral-900 transition-colors duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
              >
                manage tools
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── <640px overflow menu ────────────────────────────────────────────

function OverflowMenu({
  health,
  models,
  model,
  onModelChange,
  onOpenMarketplace
}: {
  health: HealthState;
  models: ModelInfo[];
  model: string;
  onModelChange: (id: string) => void;
  onOpenMarketplace?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const small = useMediaQuery("(max-width: 639px)");
  useOutsideClose(open, wrapRef, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]');
    const checked = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!small) setOpen(false);
  }, [small]);

  const s = healthSummary(health);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const itemCls =
    "flex h-10 w-full items-center gap-2.5 px-3.5 text-left text-[13px] text-neutral-800 outline-none transition-colors duration-100 hover:bg-page focus:bg-page";

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`more options${s.tone === "warn" || s.tone === "down" ? ` — ${s.label}` : ""}`}
        className="relative flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
        {(s.tone === "warn" || s.tone === "down") && (
          <span
            aria-hidden="true"
            className={cx(
              "absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white",
              s.tone === "warn" ? "bg-amber-500" : "bg-red-600"
            )}
          />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="more options"
          onKeyDown={(e) => menuKeyDown(e, close)}
          className={cx(panelCls, "w-[min(18rem,calc(100vw-1rem))] py-1")}
        >
          {models.length > 0 && (
            <div role="group" aria-label="model">
              <div role="presentation" className="px-3.5 pb-1 pt-2 text-[10px] font-semibold text-neutral-400">
                model
              </div>
              {models.map((m) => {
                const { name, desc } = splitModelLabel(m);
                const checked = m.id === model;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    onClick={() => {
                      onModelChange(m.id);
                      close(true);
                    }}
                    className={itemCls}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {name}
                      {desc && <span className="ml-1.5 text-[11px] text-neutral-500">{desc}</span>}
                    </span>
                    {checked && <CheckIcon className="h-3.5 w-3.5 text-bloop-deep" />}
                  </button>
                );
              })}
            </div>
          )}
          <div role="separator" className="my-1 h-px bg-neutral-100" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(false);
              onOpenMarketplace?.();
            }}
            className={itemCls}
          >
            <span
              aria-hidden="true"
              className={cx(
                "h-2 w-2 shrink-0 rounded-full",
                s.tone === "ok" ? "bg-bloop-deep" : s.tone === "warn" ? "bg-amber-500" : s.tone === "down" ? "bg-red-600" : "bg-neutral-400"
              )}
            />
            <span className="flex-1">{s.label}</span>
            <span className="text-[11px] text-neutral-400">manage</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(false);
              openPalette();
            }}
            className={itemCls}
          >
            <SearchIcon className="h-4 w-4 text-neutral-500" />
            <span className="flex-1">search &amp; commands</span>
          </button>
        </div>
      )}
    </div>
  );
}
