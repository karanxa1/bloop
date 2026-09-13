import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { XIcon } from "../icons";
import { cx } from "../lib";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** wider panel for grid layouts */
  wide?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Shared modal shell — sharp white panel on a dim backdrop.
 * Esc / backdrop close, focus moves in on open, Tab is trapped,
 * and focus returns to the opener on close.
 */
export function Modal({ title, onClose, children, wide }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // latest onClose without re-running the mount effect (which would steal focus
  // from inputs every time the parent re-renders with a new inline callback)
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
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
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-3 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(
          "motion-safe:rise w-full border border-neutral-200 border-l-2 border-l-bloop bg-white outline-none",
          wide ? "max-w-3xl" : "max-w-lg"
        )}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 bg-bloop/10 px-5 py-3">
          <h2 className="font-wordmark text-lg font-bold leading-none text-bloop-deep">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`close ${title}`}
            className="rounded-full p-1.5 text-neutral-500 transition-colors duration-150 hover:bg-white hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[min(75vh,48rem)] overflow-y-auto overscroll-contain scroll-thin">
          {children}
        </div>
      </div>
    </div>
  );
}
