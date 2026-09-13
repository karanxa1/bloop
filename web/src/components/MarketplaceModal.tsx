import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CheckIcon, SearchIcon, XIcon } from "../icons";
import { cx } from "../lib";
import type { MarketTab } from "../types/marketplace";
import { AppsTab } from "./marketplace/AppsTab";
import { SkillsTab } from "./marketplace/SkillsTab";
import { ToolsTab } from "./marketplace/ToolsTab";
import { ShellContext, ToastProvider, btnIcon, runTopEscape, useEscape } from "./marketplace/ui";

export type { MarketTab };

const TABS: { id: MarketTab; label: string; placeholder: string; filter: string }[] = [
  { id: "apps", label: "apps", placeholder: "search apps and mcp servers…", filter: "installed" },
  { id: "tools", label: "tools", placeholder: "search built-in tools…", filter: "enabled" },
  { id: "skills", label: "skills", placeholder: "search skills…", filter: "installed" }
];

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

interface MarketplaceModalProps {
  onClose: () => void;
  /** fired whenever installed servers change so the header count can refresh */
  onChanged?: () => void;
  /** deep-link tab */
  initialTab?: MarketTab;
  /** server id from an oauth return (`?connected=`) — shows a success banner */
  connectedId?: string | null;
}

/**
 * Marketplace — apps (mcp servers) · built-in tools · skills.
 * Full-screen sheet on phones, wide sharp panel on desktop.
 */
export function MarketplaceModal({ onClose, onChanged, initialTab = "apps", connectedId = null }: MarketplaceModalProps) {
  const baseId = useId();
  const [tab, setTab] = useState<MarketTab>(initialTab);
  const [visited, setVisited] = useState<ReadonlySet<MarketTab>>(() => new Set([initialTab]));
  const [query, setQuery] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [overlayRoot, setOverlayRoot] = useState<HTMLDivElement | null>(null);
  const [overlays, setOverlays] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const select = useCallback((t: MarketTab) => {
    setTab(t);
    setVisited((v) => (v.has(t) ? v : new Set([...v, t])));
  }, []);
  useEffect(() => select(initialTab), [initialTab, select]);

  const push = useCallback(() => {
    setOverlays((n) => n + 1);
    return () => setOverlays((n) => Math.max(0, n - 1));
  }, []);
  const shell = useMemo(() => ({ root: overlayRoot, push }), [overlayRoot, push]);

  useEscape(onClose);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        runTopEscape();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.closest("[inert]") && el.getClientRects().length > 0
      );
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !panel.contains(active) || !!active.closest("[inert]");
      if (e.shiftKey && (active === first || active === panel || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const n =
      e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (n < 0) return;
    e.preventDefault();
    select(TABS[n].id);
    document.getElementById(`${baseId}-tab-${TABS[n].id}`)?.focus();
  };

  const clearFilters = useCallback(() => {
    setQuery("");
    setInstalledOnly(false);
  }, []);

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-neutral-900/45 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        tabIndex={-1}
        className="motion-safe:rise relative flex h-full w-full flex-col overflow-hidden bg-page outline-none sm:h-[min(90vh,58rem)] sm:max-w-5xl sm:border sm:border-neutral-200 sm:border-l-2 sm:border-l-bloop sm:shadow-2xl"
      >
        <ShellContext.Provider value={shell}>
          <ToastProvider>
            <div className="flex min-h-0 flex-1 flex-col" inert={overlays > 0}>
              <header className="border-b border-neutral-200 bg-white">
                <div className="flex items-start gap-3 px-4 pt-3.5 sm:px-6 sm:pt-4">
                  <div className="min-w-0 flex-1">
                    <h2 id={`${baseId}-title`} className="font-wordmark text-xl font-bold leading-none text-neutral-900 sm:text-2xl">
                      marketplace
                    </h2>
                    <p className="mt-1 text-xs text-neutral-500">apps, tools and skills bloop can use for you</p>
                  </div>
                  <button type="button" onClick={onClose} aria-label="close marketplace" className={btnIcon}>
                    <XIcon className="h-4 w-4" />
                  </button>
                </div>
                <div role="tablist" aria-label="marketplace sections" onKeyDown={onTabKey} className="mt-2.5 flex gap-1 px-2 sm:px-4">
                  {TABS.map((t) => {
                    const on = t.id === tab;
                    return (
                      <button
                        key={t.id}
                        id={`${baseId}-tab-${t.id}`}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        aria-controls={`${baseId}-panel-${t.id}`}
                        tabIndex={on ? 0 : -1}
                        onClick={() => select(t.id)}
                        className={cx(
                          "relative px-3 pb-2.5 pt-1.5 font-wordmark text-base font-bold leading-none transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep",
                          on ? "text-neutral-900" : "text-neutral-500 hover:text-neutral-800"
                        )}
                      >
                        {t.label}
                        <span
                          aria-hidden="true"
                          className={cx(
                            "absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-bloop motion-safe:transition-opacity motion-safe:duration-150",
                            on ? "opacity-100" : "opacity-0"
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
              </header>

              <div className="flex items-center gap-2 border-b border-neutral-200 bg-white/80 px-4 py-2.5 sm:px-6">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={current.placeholder}
                    aria-label={current.placeholder.replace("…", "")}
                    className="w-full rounded-full border border-neutral-300 bg-white py-2 pl-9 pr-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop-deep focus:outline-none focus:ring-2 focus:ring-bloop/40"
                  />
                </div>
                <button
                  type="button"
                  aria-pressed={installedOnly}
                  onClick={() => setInstalledOnly((v) => !v)}
                  className={cx(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep",
                    installedOnly
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
                  )}
                >
                  {installedOnly && <CheckIcon className="h-3.5 w-3.5" />}
                  {current.filter}
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin">
                {TABS.map((t) =>
                  visited.has(t.id) ? (
                    <div
                      key={t.id}
                      id={`${baseId}-panel-${t.id}`}
                      role="tabpanel"
                      aria-labelledby={`${baseId}-tab-${t.id}`}
                      hidden={t.id !== tab}
                      className="px-4 pb-24 pt-4 sm:px-6 sm:pt-5"
                    >
                      {t.id === "apps" && (
                        <AppsTab
                          query={query}
                          installedOnly={installedOnly}
                          connectedId={connectedId}
                          onChanged={onChanged}
                          onClearFilters={clearFilters}
                        />
                      )}
                      {t.id === "tools" && <ToolsTab query={query} installedOnly={installedOnly} onClearFilters={clearFilters} />}
                      {t.id === "skills" && <SkillsTab query={query} installedOnly={installedOnly} onClearFilters={clearFilters} />}
                    </div>
                  ) : null
                )}
              </div>
            </div>
            <div ref={setOverlayRoot} />
          </ToastProvider>
        </ShellContext.Provider>
      </div>
    </div>
  );
}
