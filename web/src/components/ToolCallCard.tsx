import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ToolCall, ToolErrorKind, ToolStatus } from "../types";
import { CheckIcon, ChevronIcon, SpinnerIcon, WrenchIcon, XIcon } from "../icons";
import { AppLogo } from "./ServerLogo";
import { cx, fmtMs } from "../lib";

// ── helpers ─────────────────────────────────────────────────────────

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const fmtBytes = (n: number) => (n < 1024 ? `${n}b` : `${(n / 1024).toFixed(1)}kb`);

/** [running, done] verb forms for the first word of a tool's method name */
const VERBS: Record<string, [string, string]> = {
  list: ["listing", "listed"],
  search: ["searching", "searched"],
  find: ["finding", "found"],
  get: ["getting", "got"],
  fetch: ["fetching", "fetched"],
  read: ["reading", "read"],
  open: ["opening", "opened"],
  browse: ["browsing", "browsed"],
  create: ["creating", "created"],
  add: ["adding", "added"],
  update: ["updating", "updated"],
  edit: ["editing", "edited"],
  delete: ["deleting", "deleted"],
  remove: ["removing", "removed"],
  send: ["sending", "sent"],
  post: ["posting", "posted"],
  reply: ["replying", "replied"],
  comment: ["commenting", "commented"],
  run: ["running", "ran"],
  exec: ["running", "ran"],
  ask: ["asking", "asked"],
  query: ["querying", "queried"],
  generate: ["generating", "generated"],
  write: ["writing", "wrote"],
  remember: ["remembering", "remembered"],
  delegate: ["delegating", "delegated"]
};

/** human label: `github.list_repos` → "listing repos", `web.search` → "searching web" */
export function toolVerb(name: string, running: boolean): string {
  const dot = name.lastIndexOf(".");
  const ns = dot > 0 ? name.slice(0, name.indexOf(".")) : "";
  const method = dot > 0 ? name.slice(dot + 1) : name;
  const words = method
    .split(/[_\-\s]+|(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const v = words.length ? VERBS[words[0]] : undefined;
  if (!v) return running ? `running ${name}` : `ran ${name}`;
  const rest = words.slice(1).join(" ") || (ns && ns !== "bloop" ? ns : "");
  return `${running ? v[0] : v[1]}${rest ? ` ${rest}` : ""}`;
}

export const ERROR_KIND_LABEL: Record<ToolErrorKind, string> = {
  timeout: "timed out",
  transient: "transient",
  auth: "auth needed",
  circuit_open: "circuit open",
  invalid_args: "invalid args",
  error: "error"
};

const ERROR_HINT: Record<ToolErrorKind, string> = {
  timeout: "the app took too long to answer.",
  transient: "a temporary failure on the app's side.",
  auth: "reconnect this app from the marketplace.",
  circuit_open: "paused after repeated failures — bloop stopped calling it for now.",
  invalid_args: "the request was malformed.",
  error: ""
};

const firstLine = (s?: string) => (s ?? "").trim().split("\n")[0].slice(0, 240);

// ── small shared pieces ─────────────────────────────────────────────

function CopyGlyph({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** round 24–28px icon button that swaps to a check for 1.2s */
export function CopyButton({
  text,
  label = "copy",
  className,
  size = "sm"
}: {
  text: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        if (!(await copyText(text))) return;
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1200);
      }}
      aria-label={done ? "copied" : label}
      title={done ? "copied" : label}
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full text-neutral-400 transition-[color,background-color,opacity] duration-150 hover:bg-neutral-200/60 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep",
        size === "sm" ? "h-6 w-6" : "h-7 w-7",
        className
      )}
    >
      {done ? (
        <CheckIcon className="motion-safe:pop h-3.5 w-3.5 text-bloop-deep" />
      ) : (
        <CopyGlyph />
      )}
    </button>
  );
}

const LIMIT = 1200;

/** mono output block: copy on hover, "show all (8.4kb)" instead of silent truncation */
export function LongText({
  text,
  tone = "normal"
}: {
  text: string;
  tone?: "normal" | "error";
}) {
  const [all, setAll] = useState(false);
  const long = text.length > LIMIT;
  const shown = long && !all ? `${text.slice(0, LIMIT)}…` : text;
  return (
    <div className="group/out relative">
      <pre
        className={cx(
          "mt-0.5 overflow-auto whitespace-pre-wrap break-all pr-7 font-mono text-[11px] leading-relaxed scroll-thin",
          all ? "max-h-[28rem]" : "max-h-40",
          tone === "error" ? "text-red-700" : "text-neutral-700"
        )}
      >
        {shown}
      </pre>
      <CopyButton
        text={text}
        label="copy output"
        className="absolute right-0 top-0 bg-page opacity-0 focus-visible:opacity-100 group-hover/out:opacity-100 [@media(hover:none)]:opacity-100"
      />
      {long && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className="mt-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-bloop-deep transition-colors duration-150 hover:border-bloop focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep"
        >
          {all ? "show less" : `show all (${fmtBytes(text.length)})`}
        </button>
      )}
    </div>
  );
}

/** live elapsed counter for a running call — ticks locally, not through app state */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span
      aria-hidden="true"
      className={cx("font-mono text-[10px] tabular-nums text-bloop-deep", className)}
    >
      {fmtMs(Math.max(0, now - since))}
    </span>
  );
}

function StatusGlyph({ status, animate }: { status: ToolStatus; animate: boolean }) {
  if (status === "running")
    return (
      <span className="flex shrink-0 text-bloop-deep">
        <SpinnerIcon className="h-3.5 w-3.5" />
        <span className="sr-only">running:</span>
      </span>
    );
  if (status === "ok")
    return (
      <span className={cx("flex shrink-0 text-bloop-deep", animate && "motion-safe:pop")}>
        <CheckIcon className="h-3.5 w-3.5" />
        <span className="sr-only">done:</span>
      </span>
    );
  return (
    <span className={cx("flex shrink-0 text-red-600", animate && "motion-safe:pop")}>
      <XIcon className="h-3.5 w-3.5" />
      <span className="sr-only">failed:</span>
    </span>
  );
}

export function ErrorKindBadge({ kind }: { kind: ToolErrorKind }) {
  return (
    <span className="shrink-0 rounded-full border border-red-200 bg-red-50 px-1.5 py-px text-[10px] font-semibold text-red-700">
      {ERROR_KIND_LABEL[kind] ?? kind}
    </span>
  );
}

// ── single call ─────────────────────────────────────────────────────

interface ToolCallCardProps {
  call: ToolCall;
  /** false for hydrated history — skip entry/pop/shake animations */
  animate?: boolean;
  /** rendered inside a ToolGroup — no outer margin */
  inGroup?: boolean;
}

export const ToolCallCard = memo(function ToolCallCard({
  call,
  animate = true,
  inGroup = false
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  // details mount on first expand, then stay mounted so collapse can animate
  const [mounted, setMounted] = useState(false);
  const bodyId = useId();

  const argsText = useMemo(() => {
    if (call.args == null) return "";
    const t = pretty(call.args);
    return t === "{}" ? "" : t;
  }, [call.args]);
  const hasOutput = call.output != null && call.output !== "";
  const hasDetails = argsText !== "" || hasOutput;
  const running = call.status === "running";
  const failed = call.status === "error";
  const verb = toolVerb(call.name, running);
  const retries = call.retries ?? 0;

  const toggle = () => {
    setMounted(true);
    setOpen((o) => !o);
  };

  const headerInner = (
    <>
      <StatusGlyph status={call.status} animate={animate} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span
          className={cx(
            "truncate text-[13px] font-medium",
            running ? "text-bloop-deep motion-safe:shimmer-text" : "text-neutral-800"
          )}
        >
          {verb}
        </span>
        <span className="truncate font-mono text-[10px] text-neutral-400 max-sm:hidden">
          {call.name}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {call.app && call.app !== "bloop" && (
          <span className="flex items-center gap-1 rounded-full bg-bloop/15 py-0.5 pl-1 pr-1.5 text-[10px] font-semibold text-bloop-deep max-[420px]:hidden">
            <AppLogo name={call.app} className="h-3 w-3" />
            {call.app}
          </span>
        )}
        {failed && call.errorKind && <ErrorKindBadge kind={call.errorKind} />}
        {retries > 0 && (
          <span
            className="rounded-full bg-neutral-100 px-1.5 py-px text-[10px] font-semibold tabular-nums text-neutral-500"
            title={`retried ${retries} time${retries === 1 ? "" : "s"}`}
          >
            {retries}× retry
          </span>
        )}
        {running && call.startedAt != null ? (
          <Elapsed since={call.startedAt} />
        ) : (
          call.ms != null && (
            <span className="font-mono text-[10px] tabular-nums text-neutral-400">
              {fmtMs(call.ms)}
            </span>
          )
        )}
        {hasDetails && (
          <ChevronIcon
            className={cx(
              "h-3.5 w-3.5 text-neutral-400 transition-transform motion-safe:duration-150",
              open && "rotate-90"
            )}
          />
        )}
      </span>
    </>
  );

  const why = failed ? firstLine(call.output) : "";
  const hint = failed && call.errorKind ? ERROR_HINT[call.errorKind] : "";

  return (
    <div
      data-tool-id={call.id}
      style={
        animate && running && call.stagger
          ? { animationDelay: `${Math.min(call.stagger, 6) * 70}ms` }
          : undefined
      }
      className={cx(
        "relative overflow-hidden border border-neutral-200 border-l-2 bg-white text-sm transition-colors duration-300",
        !inGroup && "my-1.5",
        failed ? "border-l-red-500" : running ? "border-l-bloop" : "border-l-bloop-deep",
        running && "tool-running",
        animate && "motion-safe:tool-in",
        animate && failed && "motion-safe:shake"
      )}
    >
      {hasDetails ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="relative flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-page/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
        >
          {headerInner}
        </button>
      ) : (
        <div className="relative flex min-h-9 items-center gap-2 px-3 py-1.5">{headerInner}</div>
      )}

      {running && <span className="tool-progress" aria-hidden="true" />}

      {failed && (
        <p className="border-t border-red-100 bg-red-50/60 px-3 py-1.5 text-[11px] leading-relaxed text-red-700 [overflow-wrap:anywhere]">
          {why || "the tool failed without details."}
          {hint && <span className="text-red-600/80"> — {hint}</span>}
        </p>
      )}

      {hasDetails && (
        <div
          id={bodyId}
          inert={!open}
          className={cx(
            "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {mounted && (
              <div className="border-t border-neutral-100 bg-page px-3 py-2">
                {argsText !== "" && (
                  <div className="mb-1.5">
                    <div className="text-[10px] font-semibold text-neutral-400">args</div>
                    <LongText text={argsText} />
                  </div>
                )}
                {hasOutput && (
                  <div>
                    <div className="text-[10px] font-semibold text-neutral-400">output</div>
                    <LongText text={call.output!} tone={failed ? "error" : "normal"} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ── group of consecutive calls ──────────────────────────────────────

interface ToolGroupProps {
  calls: ToolCall[];
  animate: boolean;
}

/** consecutive calls folded under one header; auto-collapses 800ms after all succeed */
export const ToolGroup = memo(function ToolGroup({ calls, animate }: ToolGroupProps) {
  const running = calls.filter((c) => c.status === "running");
  const failed = calls.filter((c) => c.status === "error").length;
  const anyRunning = running.length > 0;
  const [open, setOpen] = useState(anyRunning);
  const touched = useRef(false);
  const wasRunning = useRef(anyRunning);
  const bodyId = useId();

  useEffect(() => {
    if (touched.current) return;
    if (anyRunning) {
      wasRunning.current = true;
      setOpen(true);
      return;
    }
    if (!wasRunning.current || failed > 0) return;
    const t = window.setTimeout(() => {
      wasRunning.current = false;
      if (!touched.current) setOpen(false);
    }, 800);
    return () => window.clearTimeout(t);
  }, [anyRunning, failed]);

  const starts = calls.map((c) => c.startedAt).filter((n): n is number => n != null);
  const parallel =
    starts.length === calls.length && Math.max(...starts) - Math.min(...starts) < 150;
  const times = calls.map((c) => c.ms ?? 0);
  const wall = parallel ? Math.max(...times) : times.reduce((a, b) => a + b, 0);
  const apps = [...new Set(calls.map((c) => c.app).filter((a) => a && a !== "bloop"))];
  const newest = running[running.length - 1];
  const firstStart = starts.length ? Math.min(...starts) : undefined;

  return (
    <div
      className={cx(
        "my-1.5 border border-neutral-200 border-l-2 bg-white text-sm",
        failed > 0 ? "border-l-red-500" : anyRunning ? "border-l-bloop" : "border-l-bloop-deep",
        animate && "motion-safe:tool-in"
      )}
    >
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors duration-150 hover:bg-page/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
      >
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {apps.length > 0 ? (
            apps.slice(0, 3).map((a, i) => (
              <span
                key={a}
                className={cx(
                  "flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white ring-1 ring-neutral-200",
                  i > 0 && "-ml-1"
                )}
              >
                <AppLogo name={a} className="h-3 w-3" />
              </span>
            ))
          ) : (
            <WrenchIcon className="h-3.5 w-3.5 text-bloop-deep" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs tabular-nums">
          {anyRunning && newest ? (
            <>
              <span className="font-medium text-bloop-deep motion-safe:shimmer-text">
                {toolVerb(newest.name, true)}…
              </span>
              <span className="text-neutral-400">
                {" "}
                · {calls.length - running.length}/{calls.length} done
              </span>
            </>
          ) : (
            <span className="text-neutral-600">
              ran {calls.length} tools
              {apps.length > 0 && ` · ${apps.join(", ")}`}
              {wall > 0 && ` · ${fmtMs(wall)}`}
            </span>
          )}
          {failed > 0 && <span className="font-semibold text-red-600"> · {failed} failed</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {anyRunning && firstStart != null && <Elapsed since={firstStart} />}
          {anyRunning ? (
            <SpinnerIcon className="h-3.5 w-3.5 text-bloop-deep" />
          ) : failed > 0 ? (
            <XIcon className="h-3.5 w-3.5 text-red-600" />
          ) : (
            <CheckIcon className="h-3.5 w-3.5 text-bloop-deep" />
          )}
          <ChevronIcon
            className={cx(
              "h-3.5 w-3.5 text-neutral-400 transition-transform motion-safe:duration-150",
              open && "rotate-90"
            )}
          />
        </span>
      </button>

      <div
        id={bodyId}
        inert={!open}
        className={cx(
          "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-neutral-100 bg-page/60 px-2 py-2">
            <div className={cx("flex flex-col gap-1", parallel && "border-l border-neutral-300 pl-2")}>
              {parallel && (
                <span className="text-[10px] font-semibold text-neutral-400">
                  {calls.length} at once
                </span>
              )}
              {calls.map((c) => (
                <ToolCallCard key={c.id} call={c} animate={animate} inGroup />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
