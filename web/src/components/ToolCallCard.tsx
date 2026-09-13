import { memo, useEffect, useId, useMemo, useState } from "react";
import type { ToolCall } from "../types";
import { CheckIcon, ChevronIcon, SpinnerIcon, WrenchIcon, XIcon } from "../icons";
import { AppLogo } from "./ServerLogo";
import { cx, fmtMs } from "../lib";

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** live elapsed counter for a running call — ticks locally, not through app state */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span
      aria-hidden="true"
      className="font-mono text-[10px] tabular-nums text-bloop-deep"
    >
      {fmtMs(now - since)}
    </span>
  );
}

interface ToolCallCardProps {
  call: ToolCall;
  /** false for hydrated history — skip entry/pop/shake animations */
  animate?: boolean;
}

export const ToolCallCard = memo(function ToolCallCard({
  call,
  animate = true
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

  const toggle = () => {
    setMounted(true);
    setOpen((o) => !o);
  };

  const headerInner = (
    <>
      <WrenchIcon className="h-3.5 w-3.5 shrink-0 text-bloop-deep" />
      <span className="min-w-0 truncate font-mono text-xs font-semibold text-neutral-800">
        {call.name}
      </span>
      {call.app && (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-bloop/15 py-0.5 pl-1.5 pr-2 text-[10px] font-semibold tracking-wide text-bloop-deep max-[380px]:hidden">
          <AppLogo name={call.app} className="h-3 w-3" />
          {call.app}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {running && call.startedAt != null ? (
          <Elapsed since={call.startedAt} />
        ) : (
          call.ms != null && (
            <span className="font-mono text-[10px] tabular-nums text-neutral-400">
              {fmtMs(call.ms)}
            </span>
          )
        )}
        {running && (
          <span className="text-bloop-deep">
            <SpinnerIcon className="h-3.5 w-3.5" />
            <span className="sr-only">running</span>
          </span>
        )}
        {call.status === "ok" && (
          <span className={cx("text-bloop-deep", animate && "motion-safe:pop")}>
            <CheckIcon className="h-3.5 w-3.5" />
            <span className="sr-only">succeeded</span>
          </span>
        )}
        {call.status === "error" && (
          <span className={cx("text-red-600", animate && "motion-safe:pop")}>
            <XIcon className="h-3.5 w-3.5" />
            <span className="sr-only">failed</span>
          </span>
        )}
        {hasDetails && (
          <ChevronIcon
            className={cx(
              "h-3.5 w-3.5 text-neutral-400 transition-transform motion-safe:duration-200",
              open && "rotate-90"
            )}
          />
        )}
      </span>
    </>
  );

  return (
    <div
      style={
        animate && running && call.stagger
          ? { animationDelay: `${Math.min(call.stagger, 6) * 70}ms` }
          : undefined
      }
      className={cx(
        "relative my-2 overflow-hidden border border-neutral-200 border-l-2 bg-white text-sm transition-colors duration-300",
        call.status === "error" ? "border-l-red-500" : "border-l-bloop",
        running && "tool-running",
        animate && "motion-safe:tool-in",
        animate && call.status === "error" && "motion-safe:shake"
      )}
    >
      {hasDetails ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${call.name}${call.app ? ` on ${call.app}` : ""} — ${open ? "hide" : "show"} details`}
          className="relative flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-page/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
        >
          {headerInner}
        </button>
      ) : (
        <div className="relative flex items-center gap-2 px-3 py-2">{headerInner}</div>
      )}

      {running && <span className="tool-progress" aria-hidden="true" />}

      {hasDetails && (
        <div
          id={bodyId}
          inert={!open}
          className={cx(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {mounted && (
              <div className="border-t border-neutral-100 bg-page px-3 py-2">
                {argsText !== "" && (
                  <div className="mb-1.5">
                    <div className="text-[10px] font-semibold tracking-wide text-neutral-400">
                      args
                    </div>
                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-700 scroll-thin">
                      {argsText}
                    </pre>
                  </div>
                )}
                {hasOutput && (
                  <div>
                    <div className="text-[10px] font-semibold tracking-wide text-neutral-400">
                      output
                    </div>
                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-700 scroll-thin">
                      {call.output!.length > 1200
                        ? `${call.output!.slice(0, 1200)}…`
                        : call.output}
                    </pre>
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
