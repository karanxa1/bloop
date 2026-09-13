import type { PlanStep, TraceItem, VerifyEntry, ToolCall } from "../types";
import { MUTATING } from "../types";
import { AlertIcon, CheckIcon, ShieldCheckIcon, SpinnerIcon, WrenchIcon, XIcon } from "../icons";

interface ProofTraceProps {
  plan: PlanStep[];
  trace: TraceItem[];
  verifyCount: number;
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

export function ProofTrace({ plan, trace, verifyCount, onClose }: ProofTraceProps) {
  const toolCalls = trace.filter((t): t is Extract<TraceItem, { kind: "tool" }> => t.kind === "tool");
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
              className="ml-auto rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep lg:hidden"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <span>{toolCalls.length} calls</span>
          <span className="text-bloop-deep">{verifyCount} verified</span>
        </div>
        {unverified > 0 && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
            <AlertIcon className="h-3.5 w-3.5" />
            {unverified} unverified {unverified === 1 ? "write" : "writes"}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {/* plan */}
        {plan.length > 0 && (
          <section className="border-b border-neutral-100 px-4 py-3" aria-label="plan">
            <h3 className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/70">
              plan
            </h3>
            <ol className="space-y-1.5">
              {plan.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 ${statusDot(step.status)}`}
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
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* trace feed */}
        <section className="px-4 py-3" aria-label="trace feed">
          <h3 className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/70">
            trace
          </h3>
          {trace.length === 0 ? (
            <p className="text-xs text-neutral-400">
              tool calls and verifications will appear here.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {trace.map((item) =>
                item.kind === "tool" ? (
                  <ToolTraceRow key={`t-${item.call.id}`} call={item.call} />
                ) : (
                  <VerifyTraceRow key={`v-${item.seq}`} entry={item.entry} />
                )
              )}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function ToolTraceRow({ call }: { call: ToolCall }) {
  const isMutating = call.app !== "bloop" && MUTATING.test(call.name);
  return (
    <li className="border border-neutral-200 border-l-2 border-l-bloop bg-white px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <WrenchIcon className="h-3 w-3 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-neutral-700">
          {call.name}
        </span>
        {call.app && (
          <span className="rounded-full bg-bloop px-1.5 py-px text-[9px] font-semibold text-white">
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
        {call.ms != null && <span className="font-mono">{call.ms}ms</span>}
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
    <li className="border border-bloop/50 border-l-2 border-l-bloop-deep bg-bloop/10 px-2.5 py-1.5">
      <div className="flex items-start gap-1.5">
        <ShieldCheckIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
        <span className="min-w-0 flex-1 text-[11px] font-medium leading-snug text-bloop-deep">
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
          className="font-mono text-[10px] text-neutral-500"
          title={entry.hash}
        >
          #{entry.hash.slice(0, 8)}
        </span>
      </div>
    </li>
  );
}
