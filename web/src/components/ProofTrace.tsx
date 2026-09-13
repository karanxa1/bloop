import { memo } from "react";
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
  GlobeIcon,
  PencilIcon,
  PlugIcon,
  ShieldCheckIcon,
  SpinnerIcon,
  WrenchIcon,
  XIcon
} from "../icons";
import { CodePart, ImagePart } from "./parts";
import { cx, faviconUrl, fmtMs, hostOf, safeHttpUrl } from "../lib";

interface ProofTraceProps {
  plan: PlanStep[];
  trace: TraceItem[];
  verifyCount: number;
  sources: SourceItem[];
  onClose?: () => void;
}

function statusDot(status: PlanStep["status"]) {
  switch (status) {
    case "pending":
      return "border-neutral-300 bg-white";
    case "active":
      return "border-bloop bg-bloop motion-safe:animate-pulse";
    case "done":
      return "border-bloop-deep bg-bloop-deep";
    case "failed":
      return "border-red-500 bg-red-500";
  }
}

const sameItems = (a: TraceItem[], b: TraceItem[]) =>
  a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

function ProofTraceImpl({ plan, trace, verifyCount, sources, onClose }: ProofTraceProps) {
  const toolCalls = trace.filter(
    (t): t is Extract<TraceItem, { kind: "tool" }> => t.kind === "tool"
  );
  const mutating = toolCalls.filter(
    (t) =>
      t.call.status !== "running" &&
      t.call.app !== "bloop" &&
      MUTATING.test(t.call.name)
  ).length;
  const unverified = Math.max(0, mutating - verifyCount);

  return (
    <div className="flex h-full flex-col">
      {/* header / counters */}
      <div className="border-b border-neutral-200 bg-bloop/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="h-4 w-4 text-bloop-deep" />
          <h2 className="font-wordmark text-base font-bold leading-none text-bloop-deep">
            proof trace
          </h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="close proof trace"
              className="ml-auto rounded-full p-1.5 text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep lg:hidden"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <span className="tabular-nums">{toolCalls.length} calls</span>
          <span className="tabular-nums text-bloop-deep">{verifyCount} verified</span>
          {sources.length > 0 && (
            <span className="tabular-nums">{sources.length} sources</span>
          )}
        </div>
        {unverified > 0 && (
          <div className="mt-2 flex items-center gap-1.5 border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
            <AlertIcon className="h-3.5 w-3.5" />
            {unverified} unverified {unverified === 1 ? "write" : "writes"}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain scroll-thin">
        {/* plan checklist */}
        {plan.length > 0 && (
          <section className="border-b border-neutral-100 px-4 py-3" aria-label="plan">
            <h3 className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/70">
              plan
            </h3>
            <ol className="space-y-1.5">
              {plan.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 transition-colors duration-300 ${statusDot(step.status)}`}
                    aria-hidden="true"
                  />
                  <span
                    className={
                      step.status === "done"
                        ? "text-neutral-400 line-through"
                        : step.status === "failed"
                          ? "text-red-600"
                          : step.status === "active"
                            ? "font-medium text-neutral-800"
                            : "text-neutral-500"
                    }
                  >
                    {step.title}
                    <span className="sr-only"> — {step.status}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* sources */}
        {sources.length > 0 && (
          <section className="border-b border-neutral-100 px-4 py-3" aria-label="sources">
            <h3 className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/70">
              sources
            </h3>
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
                        <span className="block truncate text-[10px] text-neutral-400">
                          {host}
                        </span>
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
          <h3 className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/70">
            trace
          </h3>
          {trace.length === 0 ? (
            <p className="text-xs leading-relaxed text-neutral-400">
              tool calls, subagents, code runs, memories and verifications will
              appear here.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {trace.map((item) => {
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
                  default:
                    return null;
                }
              })}
            </ol>
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

const rowIn = "motion-safe:tool-in";

function ToolTraceRow({ call }: { call: ToolCall }) {
  const isMutating = call.app !== "bloop" && MUTATING.test(call.name);
  return (
    <li
      className={cx(
        rowIn,
        "border border-neutral-200 border-l-2 bg-white px-2.5 py-1.5",
        call.status === "error" ? "border-l-red-500" : "border-l-bloop",
        call.parent && "ml-3"
      )}
    >
      <div className="flex items-center gap-1.5">
        <WrenchIcon className="h-3 w-3 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-neutral-700">
          {call.name}
        </span>
        {call.app && (
          <span className="shrink-0 rounded-full bg-bloop px-1.5 py-px text-[9px] font-semibold text-white">
            {call.app}
          </span>
        )}
        {call.status === "running" && (
          <SpinnerIcon className="h-3 w-3 text-bloop-deep" />
        )}
        {call.status === "ok" && <CheckIcon className="h-3 w-3 text-bloop-deep" />}
        {call.status === "error" && <XIcon className="h-3 w-3 text-red-600" />}
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-4 text-[10px] text-neutral-400">
        {call.parent && <span className="font-medium text-bloop-deep">subagent</span>}
        {call.ms != null && <span className="font-mono tabular-nums">{fmtMs(call.ms)}</span>}
        {call.status !== "running" && isMutating && (
          <span className="font-medium text-amber-600">write</span>
        )}
        {call.status === "error" && <span className="text-red-600">failed</span>}
      </div>
    </li>
  );
}

function VerifyTraceRow({ entry }: { entry: VerifyEntry }) {
  return (
    <li className={cx(rowIn, "border border-bloop/50 border-l-2 border-l-bloop-deep bg-bloop/10 px-2.5 py-1.5")}>
      <div className="flex items-start gap-1.5">
        <ShieldCheckIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] font-medium leading-snug text-bloop-deep [overflow-wrap:anywhere]">
          {entry.claim}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-5">
        {entry.app && (
          <span className="rounded-full bg-bloop-deep px-1.5 py-px text-[9px] font-semibold text-white">
            {entry.app}
          </span>
        )}
        <span
          className="rounded-full border border-bloop/40 bg-white px-1.5 py-px font-mono text-[10px] text-bloop-deep"
          title={entry.hash}
        >
          #{entry.hash.slice(0, 8)}
        </span>
      </div>
    </li>
  );
}

function ImageTraceRow({
  item
}: {
  item: Extract<TraceItem, { kind: "image" }>;
}) {
  return (
    <li className={cx(rowIn, "border border-neutral-200 border-l-2 border-l-bloop bg-white px-2.5 py-1.5")}>
      <div className="flex items-center gap-2">
        <ImagePart url={item.image.url} prompt={item.image.prompt} compact />
        <div className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium text-neutral-700">
            image generated
          </span>
          {item.image.prompt && (
            <span className="block truncate text-[10px] text-neutral-400">
              {item.image.prompt}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function CodeTraceRow({ item }: { item: Extract<TraceItem, { kind: "code" }> }) {
  return (
    <li className={cx(rowIn, "[&>div]:my-0")}>
      <CodePart
        language={item.code.language}
        source={item.code.source}
        output={item.code.output}
        ok={item.code.ok}
        collapsed
      />
    </li>
  );
}

function MemoryTraceRow({ memory }: { memory: MemoryEvent }) {
  return (
    <li className={cx(rowIn, "flex items-start gap-1.5 border border-neutral-200 border-l-2 border-l-bloop-deep bg-white px-2.5 py-1.5")}>
      <BrainIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
        <span className="font-semibold text-bloop-deep">
          {memory.action === "forget" ? "forgot" : "remembered"}
        </span>{" "}
        {memory.content}
      </span>
    </li>
  );
}

function FileTraceRow({ file }: { file: FileEvent }) {
  return (
    <li className={cx(rowIn, "flex items-start gap-1.5 border border-neutral-200 border-l-2 border-l-bloop-deep bg-white px-2.5 py-1.5")}>
      <PencilIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
        <span className="font-semibold text-bloop-deep">
          {file.kind === "lessons" ? "lesson saved" : "context updated"}
        </span>{" "}
        <span className="line-clamp-2">{file.content}</span>
      </span>
    </li>
  );
}

function ToolsLoadedRow({ names }: { names: string[] }) {
  return (
    <li className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] text-neutral-400">
      <PlugIcon className="h-3 w-3" />
      <span className="min-w-0 truncate">
        loaded {names.length} {names.length === 1 ? "tool" : "tools"}
        {names.length > 0 && (
          <span className="text-neutral-300"> · {names.join(", ")}</span>
        )}
      </span>
    </li>
  );
}

function HandoffTraceRow({ item }: { item: Extract<TraceItem, { kind: "handoff" }> }) {
  const href = safeHttpUrl(item.handoff.url);
  return (
    <li className={cx(rowIn, "flex items-start gap-1.5 border border-neutral-200 border-l-2 border-l-bloop bg-white px-2.5 py-1.5")}>
      <GlobeIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
        <span className="font-semibold text-bloop-deep">handed off to you</span>{" "}
        <span className="line-clamp-2 [overflow-wrap:anywhere]">{item.handoff.reason}</span>
        {href && (
          <span className="block truncate text-[10px] text-neutral-400">{hostOf(href)}</span>
        )}
      </span>
    </li>
  );
}

function SubagentTraceRow({ item }: { item: Extract<TraceItem, { kind: "subagent" }> }) {
  const end = item.phase === "end";
  return (
    <li
      className={cx(
        rowIn,
        "flex items-start gap-1.5 border border-neutral-200 border-l-2 bg-white px-2.5 py-1.5",
        end && item.ok === false ? "border-l-red-500" : "border-l-bloop-deep"
      )}
    >
      <AgentIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-700">
        <span
          className={cx(
            "font-semibold",
            end && item.ok === false ? "text-red-600" : "text-bloop-deep"
          )}
        >
          {end ? (item.ok === false ? "subagent failed" : "subagent done") : "subagent started"}
        </span>{" "}
        <span className="line-clamp-2 [overflow-wrap:anywhere]">
          {end && item.summary ? item.summary : item.task}
        </span>
      </span>
    </li>
  );
}
