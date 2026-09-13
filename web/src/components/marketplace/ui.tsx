import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { errMsg } from "../../api/marketplace";
import { AlertIcon, CheckIcon, SpinnerIcon, TrashIcon, XIcon } from "../../icons";
import { cx } from "../../lib";
import type { AuthType, ErrorKind, ServerState } from "../../types/marketplace";

// ── class tokens ─────────────────────────────────────────────────
const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep";

export const inputCls =
  "w-full min-w-0 border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop-deep focus:outline-none focus:ring-2 focus:ring-bloop/40 disabled:bg-neutral-50 disabled:text-neutral-500 aria-invalid:border-red-400";
export const labelCls = "mb-1 block text-xs font-semibold text-neutral-700";
export const btnPrimary = cx(
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-bloop px-4 py-2 font-wordmark text-sm font-bold leading-none text-neutral-900 transition-colors duration-150 hover:bg-bloop-deep hover:text-white disabled:pointer-events-none disabled:opacity-50",
  focusRing
);
export const btnSmallPrimary = cx(
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-bloop px-3.5 py-1.5 font-wordmark text-xs font-bold leading-none text-neutral-900 transition-colors duration-150 hover:bg-bloop-deep hover:text-white disabled:pointer-events-none disabled:opacity-60",
  focusRing
);
export const btnSecondary = cx(
  "inline-flex items-center justify-center gap-1.5 rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 transition-colors duration-150 hover:border-neutral-400 hover:bg-neutral-50 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-50",
  focusRing
);
export const btnDark = cx(
  "inline-flex items-center justify-center gap-2 rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-neutral-700 disabled:pointer-events-none disabled:opacity-60",
  focusRing
);
export const btnIcon = cx(
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-40",
  focusRing
);
/** sharp card with a left accent border — add a border-l-* colour */
export const cardCls = "border border-neutral-200 border-l-2 bg-white";

// ── local glyphs (not in the shared icon set) ────────────────────
const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true
} as const;
type IconProps = { className?: string };
export const LockIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
export const RefreshIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);
export const SparkIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className}>
    <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />
  </svg>
);
export const BookIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
  </svg>
);

// ── escape stack: the top-most layer (overlay › shell) closes first ──
type EscEntry = { current: () => void };
const escStack: EscEntry[] = [];
export function useEscape(onEscape: () => void) {
  const ref = useRef(onEscape);
  useEffect(() => {
    ref.current = onEscape;
  });
  useEffect(() => {
    const entry: EscEntry = ref;
    escStack.push(entry);
    return () => {
      const i = escStack.lastIndexOf(entry);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, []);
}
export const runTopEscape = () => escStack[escStack.length - 1]?.current();

// ── shell context: overlays portal into the panel and inert the body ──
interface ShellApi {
  root: HTMLElement | null;
  push: () => () => void;
}
export const ShellContext = createContext<ShellApi>({ root: null, push: () => () => {} });

interface OverlayProps {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** drawer slides from the right; dialog/wide sit centred (bottom sheet on phones) */
  size?: "drawer" | "dialog" | "wide";
}

export function Overlay({ title, subtitle, onClose, children, footer, size = "drawer" }: OverlayProps) {
  const { root, push } = useContext(ShellContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscape(onClose);
  useLayoutEffect(() => push(), [push]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      (panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel)?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      // body is still inert during this commit — restore focus next frame
      requestAnimationFrame(() => {
        if (opener && document.contains(opener)) opener.focus();
      });
    };
  }, []);

  if (!root) return null;
  return createPortal(
    <div
      role="presentation"
      className={cx(
        "absolute inset-0 z-20 flex bg-neutral-900/35",
        size === "drawer" ? "justify-end" : "items-end justify-center sm:items-center sm:p-6"
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "motion-safe:rise flex w-full flex-col border-l-2 border-l-bloop bg-white shadow-2xl outline-none",
          size === "drawer" && "h-full max-w-lg",
          size === "dialog" && "max-h-[92%] max-w-xl border border-neutral-200 sm:max-h-full",
          size === "wide" && "h-full max-w-5xl border border-neutral-200 sm:h-auto sm:max-h-full"
        )}
      >
        <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="truncate font-wordmark text-lg font-bold leading-tight text-neutral-900">
              {title}
            </h3>
            {subtitle && <div className="mt-0.5 text-xs text-neutral-500">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label={`close ${title}`} className={btnIcon}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 bg-neutral-50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    root
  );
}

// ── toasts ───────────────────────────────────────────────────────
type Tone = "ok" | "error" | "info";
export interface ToastInput {
  tone?: Tone;
  text: string;
  action?: { label: string; run: () => void };
}
interface ToastItem extends ToastInput {
  id: number;
}
const ToastContext = createContext<(t: ToastInput) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) window.clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { ...t, id }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), t.action ? 8000 : 4500));
    },
    [dismiss]
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 p-3"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              "motion-safe:rise pointer-events-auto flex w-full max-w-md items-start gap-2.5 border border-neutral-200 border-l-2 bg-white px-3 py-2.5 text-xs text-neutral-800 shadow-lg",
              t.tone === "error" ? "border-l-red-500" : t.tone === "ok" ? "border-l-bloop-deep" : "border-l-neutral-400"
            )}
          >
            {t.tone === "error" ? (
              <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0 text-red-600" />
            ) : (
              <CheckIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
            )}
            <span className="min-w-0 flex-1 leading-relaxed">{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.run();
                }}
                className={cx("shrink-0 rounded-full px-2 py-0.5 font-semibold text-neutral-900 underline underline-offset-2 hover:bg-neutral-100", focusRing)}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="dismiss"
              className={cx("-m-1 shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700", focusRing)}
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── controls ─────────────────────────────────────────────────────
export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55",
        focusRing,
        checked ? "border-bloop-deep bg-bloop" : "border-neutral-300 bg-neutral-200"
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "inline-block h-4.5 w-4.5 rounded-full bg-white shadow ring-1 ring-black/5 motion-safe:transition-transform motion-safe:duration-150",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

const TONES = {
  neutral: "bg-neutral-100 text-neutral-700",
  lime: "bg-bloop/25 text-neutral-900",
  dark: "bg-neutral-900 text-white",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-50 text-red-800",
  sky: "bg-sky-50 text-sky-800",
  violet: "bg-violet-50 text-violet-800"
} as const;
export type BadgeTone = keyof typeof TONES;

export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold leading-4",
        TONES[tone]
      )}
    >
      {children}
    </span>
  );
}

const AUTH: Record<AuthType, { label: string; tone: BadgeTone; title: string }> = {
  none: { label: "no auth", tone: "neutral", title: "connects without credentials" },
  bearer: { label: "token", tone: "sky", title: "needs an api token" },
  headers: { label: "headers", tone: "violet", title: "needs custom request headers" },
  oauth: { label: "oauth", tone: "amber", title: "sign in with the app" }
};
export function AuthBadge({ auth }: { auth: AuthType }) {
  const a = AUTH[auth] ?? AUTH.none;
  return (
    <Badge tone={a.tone} title={a.title}>
      <span className="sr-only">auth: </span>
      {a.label}
    </Badge>
  );
}

const STATE: Record<ServerState, { label: string; dot: string }> = {
  ok: { label: "connected", dot: "bg-bloop-deep" },
  degraded: { label: "degraded", dot: "bg-amber-500" },
  error: { label: "error", dot: "bg-red-500" }
};
export const stateAccent = (s: ServerState) =>
  s === "ok" ? "border-l-bloop" : s === "degraded" ? "border-l-amber-400" : "border-l-red-500";

export function StateDot({ state, showLabel }: { state: ServerState; showLabel?: boolean }) {
  const s = STATE[state] ?? STATE.error;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full", s.dot)} />
      <span className={showLabel ? "text-[11px] font-medium text-neutral-600" : "sr-only"}>{s.label}</span>
    </span>
  );
}

export const ERROR_KIND: Record<ErrorKind, { label: string; hint: string }> = {
  timeout: { label: "timed out", hint: "the server didn't answer in time — check the url or try again." },
  transient: { label: "network error", hint: "a temporary network problem — retrying usually works." },
  auth: { label: "auth failed", hint: "the server rejected the credentials — update the token or headers." },
  circuit_open: { label: "circuit open", hint: "too many recent failures, so bloop paused calls to it for a bit." },
  invalid_args: { label: "bad request", hint: "the server rejected the handshake — check the transport." },
  error: { label: "error", hint: "the server returned an error." }
};

export function Chips({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (options.length <= 2) return null;
  return (
    <div
      role="group"
      aria-label={label}
      className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scroll-thin sm:flex-wrap sm:overflow-visible"
    >
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors duration-150",
              focusRing,
              on
                ? "border-neutral-900 bg-neutral-900 text-white"
                : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            )}
          >
            {o.label}
            {o.count != null && <span className="ml-1 tabular-nums opacity-60">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** trash → inline "remove? yes / no" */
export function ConfirmRemove({ label, onConfirm, disabled }: { label: string; onConfirm: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  const yesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) yesRef.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
        aria-label={`remove ${label}`}
        className={cx(btnIcon, "hover:bg-red-50 hover:text-red-600")}
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </button>
    );
  return (
    <span role="group" aria-label={`confirm removing ${label}`} className="inline-flex items-center gap-1">
      <span className="text-[11px] font-semibold text-red-700">remove?</span>
      <button
        ref={yesRef}
        type="button"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        className="rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
      >
        yes
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className={cx("rounded-full px-2 py-1 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100", focusRing)}
      >
        no
      </button>
    </span>
  );
}

/** hover / focus tooltip — the wrapper is focusable so disabled controls still explain themselves */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  return (
    <span tabIndex={0} aria-describedby={id} className={cx("group relative inline-flex rounded-full", focusRing)}>
      {children}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full right-0 z-10 mb-2 w-max max-w-[15rem] bg-neutral-900 px-2.5 py-1.5 text-[11px] leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

export function SectionHeader({ title, count, children, id }: { title: string; count?: number; children?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 id={id} className="font-wordmark text-base font-bold leading-none text-neutral-900">
        {title}
        {count != null && (
          <span className="ml-1.5 font-sans text-xs font-medium tabular-nums text-neutral-500">{count}</span>
        )}
      </h3>
      {children}
    </div>
  );
}

// ── states ───────────────────────────────────────────────────────
export function SkeletonCards({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div aria-busy="true" className={className}>
      <span className="sr-only">loading…</span>
      <ul aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className={cx(cardCls, "border-l-neutral-200 p-3.5")}>
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 shrink-0 bg-neutral-100 motion-safe:animate-pulse" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-2/5 bg-neutral-200 motion-safe:animate-pulse" />
                <span className="block h-2.5 w-1/4 rounded-full bg-neutral-100 motion-safe:animate-pulse" />
              </span>
            </div>
            <span className="mt-3 block h-2.5 w-11/12 bg-neutral-100 motion-safe:animate-pulse" />
            <span className="mt-1.5 block h-2.5 w-3/5 bg-neutral-100 motion-safe:animate-pulse" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">loading…</span>
      <ul aria-hidden="true" className="space-y-2">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className={cx(cardCls, "flex items-center gap-3 border-l-neutral-200 px-3.5 py-3")}>
            <span className="h-9 w-9 shrink-0 bg-neutral-100 motion-safe:animate-pulse" />
            <span className="flex-1 space-y-2">
              <span className="block h-3 w-1/3 bg-neutral-200 motion-safe:animate-pulse" />
              <span className="block h-2.5 w-1/2 bg-neutral-100 motion-safe:animate-pulse" />
            </span>
            <span className="h-6 w-10 rounded-full bg-neutral-100 motion-safe:animate-pulse" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className={cx(cardCls, "flex flex-wrap items-center gap-3 border-l-red-500 px-3.5 py-3 text-xs text-neutral-800")}>
      <AlertIcon className="h-4 w-4 shrink-0 text-red-600" />
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onRetry} className={btnSmallPrimary}>
        retry
      </button>
    </div>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx(cardCls, "border-dashed border-l-solid border-l-bloop px-5 py-6 text-center")}>
      {icon && <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-bloop/20 text-neutral-900">{icon}</div>}
      <p className="font-wordmark text-base font-bold text-neutral-900">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-neutral-600">{children}</div>}
      {actions && <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}

export const Spinner = ({ className = "h-3.5 w-3.5" }: { className?: string }) => <SpinnerIcon className={className} />;

// ── data loading ─────────────────────────────────────────────────
export type LoadStatus = "loading" | "ready" | "error";
export interface Loaded<T> {
  data: T | null;
  setData: Dispatch<SetStateAction<T | null>>;
  status: LoadStatus;
  error: string;
  /** silent = keep current data on screen and swallow errors */
  reload: (silent?: boolean) => Promise<void>;
}

export function useLoad<T>(fn: () => Promise<T>): Loaded<T> {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const reload = useCallback((silent = false) => {
    const mine = ++seq.current;
    if (!silent) {
      setStatus("loading");
      setError("");
    }
    return fnRef.current().then(
      (d) => {
        if (mine !== seq.current) return;
        setData(d);
        setStatus("ready");
      },
      (e: unknown) => {
        if (mine !== seq.current || silent) return;
        setError(errMsg(e, "something went wrong."));
        setStatus("error");
      }
    );
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, status, error, reload };
}

export const matches = (q: string, ...fields: (string | undefined)[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || fields.some((f) => f?.toLowerCase().includes(needle));
};
