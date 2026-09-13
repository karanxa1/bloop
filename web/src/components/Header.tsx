import { BlobIcon, TraceIcon } from "../icons";

export type HealthState =
  | { status: "loading" }
  | { status: "ok"; model?: string; servers: number }
  | { status: "down" };

interface HeaderProps {
  health: HealthState;
  onToggleTrace: () => void;
  traceOpen: boolean;
}

export function Header({ health, onToggleTrace, traceOpen }: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-2.5">
        <BlobIcon />
        <span className="font-wordmark text-2xl font-bold leading-none text-bloop-deep">
          bloop
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 text-xs text-neutral-600"
          role="status"
          aria-label="backend status"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              health.status === "ok"
                ? "bg-bloop motion-safe:animate-pulse"
                : health.status === "down"
                  ? "bg-red-500"
                  : "bg-neutral-300"
            }`}
          />
          {health.status === "ok" ? (
            <>
              {health.model && (
                <span className="font-medium text-neutral-800">
                  {health.model}
                </span>
              )}
              <span className="text-neutral-400">·</span>
              <span>
                {health.servers} {health.servers === 1 ? "app" : "apps"}
              </span>
            </>
          ) : health.status === "down" ? (
            <span>offline</span>
          ) : (
            <span>connecting…</span>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleTrace}
          aria-expanded={traceOpen}
          aria-label="toggle proof trace"
          className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep lg:hidden"
        >
          <TraceIcon className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
