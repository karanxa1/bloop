import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { XIcon } from "../icons";
import { cx, prefersReducedMotion } from "../lib";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** wider panel for grid layouts */
  wide?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

const EXIT_MS = 120;

// nested-safe body scroll lock
let lockDepth = 0;
let prevOverflow = "";
function lockScroll() {
  if (lockDepth++ === 0) {
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}
function unlockScroll() {
  if (lockDepth > 0 && --lockDepth === 0) document.body.style.overflow = prevOverflow;
}

const visible = (el: HTMLElement) =>
  el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;

/**
 * Shared dialog shell — sharp panel with a lime accent, bottom sheet under 640px.
 * Focus moves in (first field, or the close button on touch), Tab is trapped,
 * Esc / backdrop close with an exit transition, body scroll is locked,
 * and focus returns to the opener.
 */
export function Modal({ title, onClose, children, wide }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  // latest onClose without re-running the mount effect
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (prefersReducedMotion()) {
      closeRef.current();
      return;
    }
    setClosing(true);
    window.setTimeout(() => closeRef.current(), EXIT_MS);
  }, []);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    lockScroll();

    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const field = coarse
      ? null
      : panel?.querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled])'
        );
    (field ?? closeBtnRef.current ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockScroll();
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [requestClose]);

  return (
    <div
      className={cx(
        "fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4",
        "motion-safe:transition-[background-color] motion-safe:duration-150 starting:bg-neutral-900/0",
        closing ? "bg-neutral-900/0" : "bg-neutral-900/40"
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "relative flex w-full flex-col bg-white shadow-[0_24px_64px_rgb(0_0_0/0.18)] outline-none",
          "max-h-[90dvh] border-t-4 border-t-bloop",
          "sm:max-h-[min(85dvh,52rem)] sm:border sm:border-neutral-200 sm:border-l-4 sm:border-l-bloop",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg",
          "motion-safe:transition-[opacity,translate] motion-safe:ease-[cubic-bezier(.22,1,.36,1)]",
          "starting:translate-y-6 starting:opacity-0 sm:starting:translate-y-2",
          closing
            ? "translate-y-6 opacity-0 motion-safe:duration-[120ms] motion-safe:ease-[cubic-bezier(.4,0,1,1)] sm:translate-y-2"
            : "motion-safe:duration-[180ms]"
        )}
      >
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <span className="h-1 w-9 rounded-full bg-neutral-300" />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3">
          <h2
            id={titleId}
            className="font-wordmark text-lg font-bold leading-none text-bloop-deep"
          >
            {title}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={requestClose}
            aria-label={`close ${title}`}
            title="close (esc)"
            className="rounded-full p-1.5 text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin pb-[env(safe-area-inset-bottom)]">
          {children}
        </div>
      </div>
    </div>
  );
}
