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

/**
 * Shared modal shell — sharp white panel on a dim backdrop.
 * Esc closes, backdrop click closes, focus lands inside on open.
 */
export function Modal({ title, onClose, children, wide }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-4 sm:items-center"
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
          "motion-safe:rise w-full border border-neutral-200 bg-white outline-none",
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
        <div className="max-h-[75vh] overflow-y-auto scroll-thin">{children}</div>
      </div>
    </div>
  );
}
