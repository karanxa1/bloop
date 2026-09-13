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
    <header className="relative flex h-14 shrink-0 items-center justify-between overflow-hidden bg-bloop px-4 sm:px-6">
      {/* concentric rings bleeding off the left edge, like the landing panels */}
      <svg
        className="pointer-events-none absolute -left-16 -top-20 h-56 w-56 text-white/20"
        viewBox="0 0 200 200"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="100" cy="100" r="40" stroke="currentColor" />
        <circle cx="100" cy="100" r="70" stroke="currentColor" />
        <circle cx="100" cy="100" r="100" stroke="currentColor" />
      </svg>

      <a href="/" className="relative flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        <BlobIcon />
        <span className="font-wordmark text-2xl font-bold leading-none text-white">
          bloop
        </span>
        <span className="mt-1 hidden text-[11px] font-medium text-white/70 sm:inline">
          tiny blob. big brain.
        </span>
      </a>

      <div className="relative flex items-center gap-3">
        <div
          className="flex items-center gap-2 rounded-full bg-white/20 px-3 py-1 text-[11px] font-medium text-white"
          role="status"
          aria-label="backend status"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              health.status === "ok"
                ? "bg-white motion-safe:animate-pulse"
                : health.status === "down"
                  ? "bg-red-200"
                  : "bg-white/50"
            }`}
          />
          {health.status === "ok" ? (
            <>
              {health.model && <span>{health.model}</span>}
              <span className="text-white/60">·</span>
              <span>
                {health.servers} {health.servers === 1 ? "app" : "apps"} connected
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
          className="rounded-full bg-white/20 p-2 text-white transition-colors duration-150 hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:hidden"
        >
          <TraceIcon className="h-4.5 w-4.5" />
        </button>
      </div>
    </header>
  );
}
