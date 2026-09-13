import { useState } from "react";
import type { ToolCall } from "../types";
import { CheckIcon, ChevronIcon, SpinnerIcon, WrenchIcon, XIcon } from "../icons";

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const hasDetails =
    (call.args != null && pretty(call.args) !== "" && pretty(call.args) !== "{}") ||
    (call.output != null && call.output !== "");

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-neutral-200 bg-white text-sm shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-neutral-500">
          <WrenchIcon className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-xs font-semibold text-neutral-800">
          {call.name}
        </span>
        {call.app && (
          <span className="rounded-full bg-bloop/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bloop-deep">
            {call.app}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {call.ms != null && (
            <span className="font-mono text-[10px] text-neutral-400">
              {call.ms}ms
            </span>
          )}
          {call.status === "running" && (
            <span className="text-bloop-deep" aria-label="running">
              <SpinnerIcon className="h-3.5 w-3.5" />
            </span>
          )}
          {call.status === "ok" && (
            <span className="text-bloop-deep" aria-label="ok">
              <CheckIcon className="h-3.5 w-3.5" />
            </span>
          )}
          {call.status === "error" && (
            <span className="text-red-600" aria-label="error">
              <XIcon className="h-3.5 w-3.5" />
            </span>
          )}
          {hasDetails && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={`${open ? "hide" : "show"} details for ${call.name}`}
              className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
            >
              <ChevronIcon
                className={`h-3.5 w-3.5 transition-transform motion-safe:duration-150 ${open ? "rotate-90" : ""}`}
              />
            </button>
          )}
        </span>
      </div>

      {open && hasDetails && (
        <div className="border-t border-neutral-100 bg-neutral-50 px-3 py-2">
          {call.args != null && pretty(call.args) !== "{}" && (
            <div className="mb-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                args
              </div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-700 scroll-thin">
                {pretty(call.args)}
              </pre>
            </div>
          )}
          {call.output != null && call.output !== "" && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                output
              </div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-700 scroll-thin">
                {call.output.length > 1200
                  ? `${call.output.slice(0, 1200)}…`
                  : call.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
