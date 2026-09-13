import { memo, useState } from "react";
import type { ReactNode } from "react";
import type {
  FileEvent,
  MemoryEvent,
  PlanStep,
  SourceItem,
  TraceItem,
  VerifyEntry,
  ToolCall
} from "../types";
import { MUTATING } from "../types";
import {
  AgentIcon,
  AlertIcon,
  BrainIcon,
  CheckIcon,
  ExternalIcon,
  GlobeIcon,
  PencilIcon,
  PlugIcon,
  ShieldCheckIcon,
  SpinnerIcon,
  WrenchIcon,
  XIcon
} from "../icons";
import { CodePart, ImagePart } from "./parts";
import { cx, faviconUrl, fmtMs, hostOf, safeHttpUrl, sameOriginPath } from "../lib";
import { toast } from "./Toast";
import { SkillIcon } from "./CommandPalette";

interface ProofTraceProps {
  plan: PlanStep[];
  trace: TraceItem[];
  verifyCount: number;
  sources: SourceItem[];
  onClose?: () => void;
}

type Item<K extends TraceItem["kind"]> = Extract<TraceItem, { kind: K }>;
type Filter = "all" | "tools" | "verify" | "errors";
const FILTERS: Filter[] = ["all", "tools", "verify", "errors"];

const TOOLISH = new Set<TraceItem["kind"]>([
  "tool",
  "tools",
  "mcp_app",
  "skill",
  "subagent",
  "code",
  "image",
  "handoff"
]);
const OK_STATES = new Set(["ok", "connected", "connecting"]);

function isError(t: TraceItem): boolean {
  switch (t.kind) {
    case "tool":
      return t.call.status === "error";
    case "subagent":
      return t.phase === "end" && t.ok === false;
    case "server":
      return !OK_STATES.has(t.state);
    case "code":
      return t.code.ok === false;
    default:
      return false;
  }
}

const passes = (f: Filter, t: TraceItem) =>
  f === "all" ||
  (f === "tools" && TOOLISH.has(t.kind)) ||
  (f === "verify" && t.kind === "verify") ||
  (f === "errors" && isError(t));

const sameItems = (a: TraceItem[], b: TraceItem[]) =>
  a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

function serialize(t: TraceItem): unknown {
  if (t.kind !== "tool") return t;
  const c = t.call;
  return {
    kind: "tool",
    seq: t.seq,
    id: c.id,
    name: c.name,
    app: c.app,
    status: c.status,
    ms: c.ms,
    args: c.args,
    output: c.output,
    parent: c.parent,
    error_kind: c.errorKind,
    retries: c.retries
  };
}

function exportTrace(plan: PlanStep[], trace: TraceItem[], sources: SourceItem[]) {
  try {
    const stamp = new Date().toISOString();
    const body = JSON.stringify(
      { exported_at: stamp, plan, sources, trace: trace.map(serialize) },
      null,
      2
    );
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bloop-trace-${stamp.replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast({ kind: "success", message: "run trace exported" });
  } catch {
    toast({ kind: "error", message: "couldn’t export the trace" });
  }
}

function ProofTraceImpl({ plan, trace, verifyCount, sources, onClose }: ProofTraceProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const toolCalls = trace.filter((t): t is Item<"tool"> => t.kind === "tool");
  const mutating = toolCalls.filter(
    (t) => t.call.status !== "running" && t.call.app !== "bloop" && MUTATING.test(t.call.name)
  ).length;
  const unverified = Math.max(0, mutating - verifyCount);
  const errorCount = trace.filter(isError).length;
  const counts: Record<Filter, number> = {
    all: trace.length,
    tools: trace.filter((t) => TOOLISH.has(t.kind)).length,
    verify: trace.filter((t) => t.kind === "verify").length,
    errors: errorCount
  };
  const shown = filter === "all" ? trace : trace.filter((t) => passes(filter, t));
  const done = plan.filter((s) => s.status === "done").length;
  const empty = trace.length === 0 && plan.length === 0;

  return (
    <div className="flex h-full flex-col bg-white">
      {/* header / counters */}
      <div className="border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="h-4 w-4 text-bloop-deep" />
          <h2 className="font-wordmark text-base font-bold leading-none text-bloop-deep">
            proof trace
          </h2>
          <button
            type="button"
            onClick={() => exportTrace(plan, trace, sources)}
            disabled={empty}
            aria-label="export run trace as json"
            title="export run trace (json)"
            className="ml-auto rounded-full p-1.5 text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:pointer-events-none disabled:opacity-40"
          >
            <DownloadIcon />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="close proof trace"
              className="rounded-full p-1.5 text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep lg:hidden"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <span className="tabular-nums">{toolCalls.length} calls</span>
          <span className="tabular-nums text-bloop-deep">{verifyCount} verified</span>
          {errorCount > 0 && (
            <span className="tabular-nums text-red-700">{errorCount} failed</span>
          )}
          {sources.length > 0 && <span className="tabular-nums">{sources.length} sources</span>}
        </div>
        {unverified > 0 && (
          <div className="mt-2 flex items-center gap-1.5 border border-amber-200 border-l-2 border-l-amber-600 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">
            <AlertIcon className="h-3.5 w-3.5" />
            {unverified} unverified {unverified === 1 ? "write" : "writes"}
          </div>
        )}
      </div>

      <div className="relative flex-1 overflow-y-auto overscroll-contain scroll-thin">
        {/* plan */}
        {plan.length > 0 && (
          <section className="border-b border-neutral-100" aria-label="plan">
            <div className="sticky top-0 z-10 bg-white/95 px-4 pb-2 pt-3 backdrop-blur-sm">
              <div className="flex items-baseline justify-between">
                <h3 className="font-wordmark text-xs font-bold text-bloop-deep/80">plan</h3>
                <span className="text-[11px] tabular-nums text-neutral-500">
                  {done}/{plan.length} steps
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="plan progress"
                aria-valuemin={0}
                aria-valuemax={plan.length}
                aria-valuenow={done}
                className="mt-1.5 h-[3px] bg-neutral-200"
              >
                <div
                  className="h-full bg-bloop motion-safe:transition-[width] motion-safe:duration-[240ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)]"
                  style={{ width: `${plan.length ? (done / plan.length) * 100 : 0}%` }}
                />
              </div>
            </div>
            <div className="px-4 pb-3 pt-1">
              <ol className={railCls}>
                {plan.map((step, i) => (
                  <li key={i} className="relative flex items-start gap-2 pl-6 text-xs">
                    <span
                      aria-hidden="true"
                      className={cx(
                        "absolute left-[3px] top-[3px] flex h-2.5 w-2.5 items-center justify-center shadow-[0_0_0_3px_#fff] transition-colors duration-300",
                        step.status === "pending" && "border border-neutral-300 bg-white",
                        step.status === "active" && "bg-bloop motion-safe:animate-pulse",
                        step.status === "done" && "bg-bloop-deep",
                        step.status === "failed" && "bg-red-600"
                      )}
                    >
                      {step.status === "done" && <CheckIcon className="h-2 w-2 text-white" />}
                    </span>
                    <span
                      className={cx(
                        "min-w-0 flex-1 leading-snug",
                        step.status === "done" && "text-neutral-600",
                        step.status === "failed" && "text-red-700",
                        step.status === "active" && "font-semibold text-neutral-900",
                        step.status === "pending" && "text-neutral-500"
                      )}
                    >
                      {step.title}
                      <span className="sr-only"> — {step.status}</span>
                    </span>
                    {step.status === "active" && (
                      <span className="shrink-0 rounded-full bg-bloop px-1.5 py-px text-[9px] font-bold text-neutral-900">
                        now
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </section>
        )}

        {/* sources */}
        {sources.length > 0 && (
          <section className="border-b border-neutral-100 px-4 py-3" aria-label="sources">
            <h3 className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/80">sources</h3>
            <ol className="space-y-1">
              {sources.map((s, i) => {
                const href = safeHttpUrl(s.url);
                if (!href) return null;
                const host = hostOf(href);
                return (
                  <li key={href}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={href}
                      className="flex items-start gap-2 border border-transparent px-1.5 py-1 transition-colors duration-150 hover:border-neutral-200 hover:bg-page focus-visible:outline-2 focus-visible:outline-bloop-deep"
                    >
                      <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-[9px] text-neutral-400">
                        {i + 1}
                      </span>
                      <img
                        src={faviconUrl(host)}
                        alt=""
                        width={16}
                        height={16}
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="mt-px h-4 w-4 shrink-0 rounded-full bg-page"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-neutral-700">
                          {s.title || host}
                        </span>
                        <span className="block truncate text-[10px] text-neutral-400">{host}</span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {/* trace feed */}
        <section className="px-4 py-3" aria-label="trace feed">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-wordmark text-xs font-bold text-bloop-deep/80">trace</h3>
          </div>

          {trace.length === 0 ? (
            <div>
              <div className="border border-dashed border-neutral-300 px-3 py-4 text-center text-[12px] leading-relaxed text-neutral-500">
                run something — every step lands here with proof.
              </div>
              <ol aria-hidden="true" className={cx(railCls, "mt-3 opacity-40")}>
                {["70%", "45%", "60%"].map((w) => (
                  <li key={w} className="relative pl-6">
                    <span className="absolute left-[3px] top-[11px] h-2.5 w-2.5 border border-neutral-300 bg-white shadow-[0_0_0_3px_#fff]" />
                    <div className="border border-neutral-200 border-l-2 border-l-neutral-300 bg-white px-2.5 py-2">
                      <span className="block h-2 bg-neutral-200" style={{ width: w }} />
                      <span className="mt-1.5 block h-1.5 w-1/4 bg-neutral-100" />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <>
              <div role="group" aria-label="filter trace" className="mb-3 flex flex-wrap gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                    className={cx(
                      "flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep",
                      filter === f
                        ? "bg-bloop text-neutral-900"
                        : f === "errors" && counts.errors > 0
                          ? "bg-red-50 text-red-700 hover:bg-red-100"
                          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    )}
                  >
                    {f}
                    <span className="tabular-nums opacity-70">{counts[f]}</span>
                  </button>
                ))}
              </div>

              {shown.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-neutral-500">
                  {filter === "errors"
                    ? "no errors in this run."
                    : filter === "verify"
                      ? "nothing verified yet."
                      : "no tool activity yet."}
                </p>
              ) : (
                <ol className={railCls}>
                  {shown.map((item) => {
                    switch (item.kind) {
                      case "tool":
                        return <ToolTraceRow key={`t-${item.call.id}`} call={item.call} />;
                      case "verify":
                        return <VerifyTraceRow key={`v-${item.seq}`} entry={item.entry} />;
                      case "image":
                        return <ImageTraceRow key={`i-${item.seq}`} item={item} />;
                      case "code":
                        return <CodeTraceRow key={`c-${item.seq}`} item={item} />;
                      case "memory":
                        return <MemoryTraceRow key={`m-${item.seq}`} memory={item.memory} />;
                      case "tools":
                        return <ToolsLoadedRow key={`l-${item.seq}`} names={item.names} />;
                      case "file":
                        return <FileTraceRow key={`f-${item.seq}`} file={item.file} />;
                      case "handoff":
                        return <HandoffTraceRow key={`h-${item.seq}`} item={item} />;
                      case "subagent":
                        return <SubagentTraceRow key={`s-${item.seq}`} item={item} />;
                      case "server":
                        return <ServerTraceRow key={`sv-${item.seq}`} item={item} />;
                      case "skill":
                        return <SkillTraceRow key={`sk-${item.seq}`} item={item} />;
                      case "mcp_app":
                        return <McpAppTraceRow key={`ma-${item.seq}`} item={item} />;
                      default:
                        return null;
                    }
                  })}
                </ol>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** re-renders only when a trace row, the plan or sources actually change */
export const ProofTrace = memo(
  ProofTraceImpl,
  (a, b) =>
    a.plan === b.plan &&
    a.verifyCount === b.verifyCount &&
    a.sources === b.sources &&
    a.onClose === b.onClose &&
    sameItems(a.trace, b.trace)
);

// ── timeline primitives ─────────────────────────────────────────────

/** 1px vertical rail; nodes are 10px sharp squares centred on it */
const railCls =
  "relative space-y-1.5 before:absolute before:bottom-3 before:left-[7.5px] before:top-3 before:w-px before:bg-neutral-200";

type Tone = "run" | "ok" | "err" | "warn" | "info" | "proof";
const NODE: Record<Tone, string> = {
  run: "bg-bloop motion-safe:animate-pulse",
  ok: "bg-bloop-deep",
  err: "bg-red-600",
  warn: "bg-amber-500",
  info: "border border-neutral-300 bg-white",
  proof: "bg-bloop-deep ring-2 ring-bloop/50"
};
const EDGE: Record<Tone, string> = {
  run: "border-l-bloop",
  ok: "border-l-bloop-deep",
  err: "border-l-red-600",
  warn: "border-l-amber-500",
  info: "border-l-neutral-300",
  proof: "border-l-bloop-deep"
};

function Row({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <li className="relative pl-6 motion-safe:tool-in">
      <span
        aria-hidden="true"
        className={cx("absolute left-[3px] top-[11px] h-2.5 w-2.5 shadow-[0_0_0_3px_#fff]", NODE[tone])}
      />
      {children}
    </li>
  );
}

const card = "border border-neutral-200 border-l-2 bg-white px-2.5 py-1.5";

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

const ERROR_COPY: Record<string, string> = {
  timeout: "timed out",
  transient: "transient",
  auth: "auth failed",
  circuit_open: "circuit open",
  invalid_args: "invalid args",
  error: "error"
};

// ── rows ────────────────────────────────────────────────────────────

function ToolTraceRow({ call }: { call: ToolCall }) {
  const isMutating = call.app !== "bloop" && MUTATING.test(call.name);
  const tone: Tone = call.status === "running" ? "run" : call.status === "error" ? "err" : "ok";
  const firstLine =
    call.status === "error" && call.output ? call.output.split("\n")[0].slice(0, 160) : "";
  return (
    <Row tone={tone}>
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(new CustomEvent("bloop:focus-tool", { detail: { toolId: call.id } }))
        }
        title="show in chat"
        className={cx(
          card,
          EDGE[tone],
          "block w-full text-left transition-colors duration-150 hover:bg-page focus-visible:outline-2 focus-visible:outline-bloop-deep",
          call.parent && "ml-3 w-[calc(100%-0.75rem)]"
        )}
      >
        <span className="flex items-center gap-1.5">
          <WrenchIcon className="h-3 w-3 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium normal-case text-neutral-800">
            {call.name}
          </span>
          {call.app && (
            <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-px text-[9px] font-semibold text-neutral-600">
              {call.app}
            </span>
          )}
          {call.status === "running" && <SpinnerIcon className="h-3 w-3 text-bloop-deep" />}
          {call.status === "ok" && <CheckIcon className="h-3 w-3 text-bloop-deep" />}
          {call.status === "error" && <XIcon className="h-3 w-3 text-red-600" />}
          <span className="sr-only">{call.status === "running" ? "running" : call.status === "ok" ? "succeeded" : "failed"}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 text-[10px] text-neutral-500">
          {call.parent && <span className="font-medium text-bloop-deep">subagent</span>}
          {call.ms != null && <span className="font-mono tabular-nums">{fmtMs(call.ms)}</span>}
          {call.status !== "running" && isMutating && (
            <span className="font-medium text-amber-700">write</span>
          )}
          {call.status === "error" && (
            <span className="rounded-full bg-red-50 px-1.5 py-px font-medium text-red-700">
              {ERROR_COPY[call.errorKind ?? "error"] ?? call.errorKind}
            </span>
          )}
          {call.retries != null && call.retries > 0 && (
            <span className="tabular-nums">
              retried {call.retries}×
            </span>
          )}
        </span>
        {firstLine && (
          <span className="mt-0.5 block pl-4 text-[10px] leading-snug text-red-700 [overflow-wrap:anywhere]">
            {firstLine}
          </span>
        )}
      </button>
    </Row>
  );
}

function HashChip({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  if (!hash) return null;
  const short = hash.length > 10 ? `${hash.slice(0, 4)}…${hash.slice(-4)}` : hash;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      toast({ kind: "success", message: "ledger hash copied" });
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast({ kind: "error", message: "couldn’t copy the hash" });
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={`${hash} — click to copy`}
      aria-label={`copy ledger hash ${hash}`}
      className="inline-flex h-5 items-center gap-1 rounded-full border border-bloop/50 bg-white px-2 font-mono text-[10px] normal-case text-bloop-deep transition-colors duration-150 hover:bg-bloop/15 focus-visible:outline-2 focus-visible:outline-bloop-deep"
    >
      {copied ? (
        <>
          <CheckIcon className="h-2.5 w-2.5" /> copied
        </>
      ) : (
        <>#{short}</>
      )}
    </button>
  );
}

function VerifyTraceRow({ entry }: { entry: VerifyEntry }) {
  return (
    <Row tone="proof">
      <div className="border border-bloop/40 border-l-2 border-l-bloop-deep bg-bloop/10 px-2.5 py-1.5">
        <div className="flex items-start gap-1.5">
          <ShieldCheckIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
          <span className="min-w-0 flex-1 text-[11px] font-medium leading-snug text-neutral-900 [overflow-wrap:anywhere]">
            <span className="sr-only">verified: </span>
            {entry.claim}
          </span>
        </div>
        {entry.evidence && (
          <p
            className="mt-0.5 truncate pl-5 font-mono text-[10px] normal-case text-neutral-500"
            title={entry.evidence}
          >
            {entry.evidence}
          </p>
        )}
        <div className="mt-1 flex items-center gap-1.5 pl-5">
          {entry.app && (
            <span className="rounded-full bg-white px-1.5 py-px text-[9px] font-semibold text-bloop-deep">
              {entry.app}
            </span>
          )}
          <HashChip hash={entry.hash} />
        </div>
      </div>
    </Row>
  );
}

function ServerTraceRow({ item }: { item: Item<"server"> }) {
  const degraded = item.state === "degraded";
  const tone: Tone = degraded ? "warn" : "err";
  return (
    <Row tone={tone}>
      <div className={cx(card, EDGE[tone], "flex items-start gap-1.5")}>
        <PlugIcon className={cx("mt-px h-3.5 w-3.5 shrink-0", degraded ? "text-amber-600" : "text-red-600")} />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-800">
          <span className={cx("font-semibold", degraded ? "text-amber-800" : "text-red-700")}>
            {degraded ? "server degraded" : "server unavailable"}
          </span>{" "}
          {item.name}
          <span className="block text-[10px] text-neutral-500">
            {degraded
              ? "circuit breaker opened — calls to it are paused"
              : "couldn’t connect — its tools were skipped"}
          </span>
        </span>
      </div>
    </Row>
  );
}

function SkillTraceRow({ item }: { item: Item<"skill"> }) {
  const verb = item.action === "create" ? "skill created" : item.action === "update" ? "skill updated" : "skill used";
  return (
    <Row tone="ok">
      <div className={cx(card, EDGE.ok, "flex items-start gap-1.5")}>
        <SkillIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-800">
          <span className="font-semibold text-bloop-deep">{verb}</span> {item.name}
        </span>
      </div>
    </Row>
  );
}

function McpAppTraceRow({ item }: { item: Item<"mcp_app"> }) {
  const href = sameOriginPath(item.url);
  return (
    <Row tone="ok">
      <div className={cx(card, EDGE.ok, "flex items-start gap-1.5")}>
        <GlobeIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-800">
          <span className="font-semibold text-bloop-deep">app view</span>{" "}
          <span className="font-mono normal-case">
            {item.server} · {item.tool}
          </span>
        </span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`open ${item.tool} app view in a new tab`}
            className="shrink-0 rounded-full p-1 text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
          >
            <ExternalIcon className="h-3 w-3" />
          </a>
        )}
      </div>
    </Row>
  );
}

function ImageTraceRow({ item }: { item: Item<"image"> }) {
  return (
    <Row tone="ok">
      <div className={cx(card, EDGE.ok, "flex items-center gap-2")}>
        <ImagePart url={item.image.url} prompt={item.image.prompt} compact />
        <div className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium text-neutral-700">image generated</span>
          {item.image.prompt && (
            <span className="block truncate text-[10px] text-neutral-500">{item.image.prompt}</span>
          )}
        </div>
      </div>
    </Row>
  );
}

function CodeTraceRow({ item }: { item: Item<"code"> }) {
  return (
    <Row tone={item.code.ok === false ? "err" : "ok"}>
      <div className="[&>div]:my-0">
        <CodePart
          language={item.code.language}
          source={item.code.source}
          output={item.code.output}
          ok={item.code.ok}
          collapsed
        />
      </div>
    </Row>
  );
}

function MemoryTraceRow({ memory }: { memory: MemoryEvent }) {
  return (
    <Row tone="info">
      <div className={cx(card, EDGE.ok, "flex items-start gap-1.5")}>
        <BrainIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
          <span className="font-semibold text-bloop-deep">
            {memory.action === "forget" ? "forgot" : "remembered"}
          </span>{" "}
          {memory.content}
        </span>
      </div>
    </Row>
  );
}

function FileTraceRow({ file }: { file: FileEvent }) {
  return (
    <Row tone="info">
      <div className={cx(card, EDGE.ok, "flex items-start gap-1.5")}>
        <PencilIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
          <span className="font-semibold text-bloop-deep">
            {file.kind === "lessons" ? "lesson saved" : "context updated"}
          </span>{" "}
          <span className="line-clamp-2">{file.content}</span>
        </span>
      </div>
    </Row>
  );
}

function ToolsLoadedRow({ names }: { names: string[] }) {
  return (
    <Row tone="info">
      <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-neutral-500">
        <PlugIcon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">
          loaded {names.length} {names.length === 1 ? "tool" : "tools"}
          {names.length > 0 && (
            <span className="normal-case text-neutral-400"> · {names.join(", ")}</span>
          )}
        </span>
      </div>
    </Row>
  );
}

function HandoffTraceRow({ item }: { item: Item<"handoff"> }) {
  const href = safeHttpUrl(item.handoff.url);
  return (
    <Row tone="warn">
      <div className={cx(card, EDGE.warn, "flex items-start gap-1.5")}>
        <GlobeIcon className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
          <span className="font-semibold text-amber-800">waiting on you</span>{" "}
          <span className="line-clamp-2 [overflow-wrap:anywhere]">{item.handoff.reason}</span>
          {href && <span className="block truncate text-[10px] text-neutral-500">{hostOf(href)}</span>}
        </span>
      </div>
    </Row>
  );
}

function SubagentTraceRow({ item }: { item: Item<"subagent"> }) {
  const end = item.phase === "end";
  const failed = end && item.ok === false;
  const tone: Tone = failed ? "err" : end ? "ok" : "run";
  return (
    <Row tone={tone}>
      <div className={cx(card, EDGE[tone], "flex items-start gap-1.5")}>
        <AgentIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
          <span className={cx("font-semibold", failed ? "text-red-700" : "text-bloop-deep")}>
            {end ? (failed ? "subagent failed" : "subagent done") : "subagent started"}
          </span>{" "}
          <span className="line-clamp-2 [overflow-wrap:anywhere]">
            {end && item.summary ? item.summary : item.task}
          </span>
        </span>
      </div>
    </Row>
  );
}
