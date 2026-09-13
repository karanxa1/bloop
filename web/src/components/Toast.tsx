import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertIcon, CheckIcon, XIcon } from "../icons";
import { cx } from "../lib";

/**
 * Global toasts — a tiny external store so any module can call `toast()`
 * without context. Mount <Toaster /> once. The region is aria-live="polite".
 */

export type ToastKind = "success" | "error" | "info" | "undo";

export interface ToastOptions {
  message: string;
  kind?: ToastKind;
  /** ms before auto-dismiss (defaults: undo 5s, error 6s, others 3.5s) */
  duration?: number;
  /** round pill action, e.g. undo — using it settles the toast without `onExpire` */
  action?: { label: string; onClick: () => void };
  /** fires when the toast leaves without its action being used (timeout, ×, page hide) */
  onExpire?: () => void;
}

interface ToastRecord extends ToastOptions {
  id: number;
  kind: ToastKind;
  duration: number;
}

const MAX_VISIBLE = 4;
let items: ToastRecord[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => items;

function expire(t: ToastRecord) {
  try {
    t.onExpire?.();
  } catch {
    /* a failing commit must not break the queue */
  }
}

function settle(id: number, expired: boolean) {
  const t = items.find((x) => x.id === id);
  if (!t) return;
  items = items.filter((x) => x.id !== id);
  emit();
  if (expired) expire(t);
}

export function toast(opts: ToastOptions): number {
  const kind = opts.kind ?? (opts.action ? "undo" : "info");
  const rec: ToastRecord = {
    ...opts,
    id: ++seq,
    kind,
    duration:
      opts.duration ?? (kind === "undo" ? 5000 : kind === "error" ? 6000 : 3500)
  };
  const overflow = Math.max(0, items.length + 1 - MAX_VISIBLE);
  const dropped = items.slice(0, overflow);
  items = [...items.slice(overflow), rec];
  emit();
  dropped.forEach(expire);
  return rec.id;
}

/** dismiss as if it timed out (runs `onExpire`) */
export const dismissToast = (id: number) => settle(id, true);

/** settle every pending toast now — used on page hide / unmount so undo-delays still commit */
export function flushToasts() {
  const all = items;
  if (all.length === 0) return;
  items = [];
  emit();
  all.forEach(expire);
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    const onHide = () => flushToasts();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flushToasts();
    };
  }, []);

  return (
    <div
      role="region"
      aria-label="notifications"
      className="pointer-events-none fixed inset-x-0 top-[4.25rem] z-[70] flex justify-center px-4"
    >
      <div aria-live="polite" aria-relevant="additions text" className="flex w-full max-w-sm flex-col gap-2">
        {list.map((t) => (
          <ToastItem key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}

function ToastItem({ t }: { t: ToastRecord }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.duration);

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const h = window.setTimeout(() => settle(t.id, true), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(h);
      remaining.current -= Date.now() - started;
    };
  }, [paused, t.id]);

  return (
    <div
      role={t.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
      className={cx(
        "pointer-events-auto flex items-center gap-2.5 border border-neutral-200 border-l-4 bg-white py-2 pl-3 pr-2 text-[13px] text-neutral-800 shadow-[0_8px_24px_rgb(0_0_0/0.12)]",
        "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(.22,1,.36,1)] starting:-translate-y-2 starting:opacity-0",
        t.kind === "error" ? "border-l-red-600" : "border-l-bloop"
      )}
    >
      {t.kind === "success" && <CheckIcon className="h-4 w-4 shrink-0 text-bloop-deep" />}
      {t.kind === "error" && <AlertIcon className="h-4 w-4 shrink-0 text-red-600" />}
      <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{t.message}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            const action = t.action;
            settle(t.id, false);
            action?.onClick();
          }}
          className="shrink-0 rounded-full bg-bloop px-3 py-1 text-xs font-bold text-neutral-900 transition-colors duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => settle(t.id, true)}
        aria-label="dismiss notification"
        className="shrink-0 rounded-full p-1.5 text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
