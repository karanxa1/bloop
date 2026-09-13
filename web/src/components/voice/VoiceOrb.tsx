import { memo, useEffect, useRef, useState } from "react";
import type { SendPrompt } from "../../types/voice";
import { useVoiceAgent } from "./useVoiceAgent";
import "./voice.css";

interface VoiceOrbProps {
  sendPrompt: SendPrompt;
  /** reveal the live chat run (e.g. open the proof trace) */
  onViewRun?: () => void;
}

const STATUS: Record<string, string> = {
  idle: "voice",
  connecting: "connecting…",
  listening: "listening",
  user: "hearing you…",
  thinking: "thinking…",
  speaking: "speaking",
  error: "voice unavailable"
};

function MicGlyph({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function EndGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="tabular-nums text-neutral-500">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>;
}

export const VoiceOrb = memo(function VoiceOrb({ sendPrompt, onViewRun }: VoiceOrbProps) {
  const v = useVoiceAgent(sendPrompt);
  const orbRef = useRef<HTMLButtonElement>(null);
  const panelOpen = v.active || v.problem != null;

  // level-reactive CSS var, written straight to the DOM (no re-render per frame)
  useEffect(() => {
    const el = orbRef.current;
    if (!el) return;
    if (!v.active) {
      el.style.setProperty("--lvl", "0");
      return;
    }
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const { mic, out } = v.levels();
      const target = v.phase === "speaking" ? out : v.muted ? 0 : mic;
      smooth += (target - smooth) * (target > smooth ? 0.45 : 0.12);
      el.style.setProperty("--lvl", smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [v.active, v.phase, v.muted, v.levels]);

  // ⌥V / Alt+V toggles voice from anywhere
  const { active, start, end } = v;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyV" || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      e.preventDefault();
      if (active) end();
      else start();
      orbRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, start, end]);

  const endAndFocus = () => {
    end();
    orbRef.current?.focus();
  };

  const lastUser = [...v.captions].reverse().find((c) => c.role === "user");
  const lastAgent = [...v.captions].reverse().find((c) => c.role === "agent");
  const status = v.muted && v.active ? "muted" : STATUS[v.phase];

  return (
    <div
      className="pointer-events-none absolute bottom-[8.25rem] right-3 z-20 flex flex-col items-end gap-2 sm:right-6"
      onKeyDown={(e) => {
        if (e.key === "Escape" && panelOpen) {
          e.stopPropagation();
          endAndFocus();
        }
      }}
    >
      {panelOpen && (
        <section
          aria-label="voice conversation"
          className="vo-panel pointer-events-auto w-[min(21rem,calc(100vw-1.5rem))] border-l-[3px] border-bloop bg-white/95 px-3 py-2.5 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.25)] ring-1 ring-neutral-200 backdrop-blur"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={
                v.phase === "error"
                  ? "h-2 w-2 rounded-full bg-err"
                  : v.muted
                    ? "h-2 w-2 rounded-full bg-neutral-400"
                    : "h-2 w-2 rounded-full bg-bloop"
              }
            />
            <p role="status" className="min-w-0 flex-1 truncate text-[12px] font-semibold lowercase text-neutral-800">
              {status}
              {v.notice && <span className="ml-1.5 font-normal text-neutral-500">· {v.notice}</span>}
            </p>
            {v.active && (
              <button
                type="button"
                onClick={v.toggleMute}
                aria-pressed={v.muted}
                aria-label={v.muted ? "unmute microphone" : "mute microphone"}
                className={
                  "grid h-8 w-8 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep " +
                  (v.muted ? "bg-neutral-900 text-white hover:bg-neutral-700" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200")
                }
              >
                <MicGlyph off={v.muted} />
              </button>
            )}
            <button
              type="button"
              onClick={endAndFocus}
              aria-label={v.active ? "end voice conversation" : "dismiss"}
              className="grid h-8 w-8 place-items-center rounded-full bg-neutral-100 text-neutral-700 transition-colors hover:bg-err-soft hover:text-err-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
            >
              <EndGlyph />
            </button>
          </div>

          {v.task && (
            <div className="mt-2 flex items-center gap-2 bg-ok-soft px-2 py-1.5 text-[12px] lowercase text-bloop-ink">
              <svg viewBox="0 0 16 16" className="vo-mini-arc shrink-0" aria-hidden="true">
                <circle cx="8" cy="8" r="6" fill="none" stroke="#c9e3a6" strokeWidth="2" />
                <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#5c8a2c" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="min-w-0 flex-1 truncate font-medium" title={v.task.prompt}>
                bloop is working…
              </span>
              <Elapsed since={v.task.startedAt} />
              {onViewRun && (
                <button
                  type="button"
                  onClick={onViewRun}
                  className="rounded-full px-2 py-0.5 font-semibold underline decoration-bloop underline-offset-2 hover:bg-white focus-visible:outline-2 focus-visible:outline-bloop-deep"
                >
                  view run
                </button>
              )}
            </div>
          )}

          {v.problem ? (
            <div className="mt-2 flex items-center gap-2">
              <p className="min-w-0 flex-1 text-[13px] lowercase text-err-text">{v.problem}</p>
              <button
                type="button"
                onClick={v.start}
                className="shrink-0 rounded-full bg-neutral-900 px-3 py-1 text-[12px] font-semibold text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
              >
                try again
              </button>
            </div>
          ) : (
            <div aria-live="polite" aria-atomic="false" className="mt-1.5 space-y-1 text-[13px] leading-snug">
              {!lastUser && !lastAgent && (
                <p className="text-neutral-500">
                  {v.phase === "connecting" ? "one sec…" : "say what you need — bloop can research, build and run tasks."}
                </p>
              )}
              {lastUser && (
                <p key={lastUser.id} className="text-neutral-500">
                  <span className="sr-only">you said: </span>
                  {lastUser.text}
                </p>
              )}
              {lastAgent && (
                <p key={lastAgent.id} className="text-neutral-900">
                  <span className="sr-only">bloop said: </span>
                  {lastAgent.text}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <button
        ref={orbRef}
        type="button"
        onClick={v.active ? endAndFocus : v.start}
        aria-pressed={v.active}
        aria-keyshortcuts="Alt+V"
        aria-label={v.active ? "end voice conversation (alt+v)" : "talk to bloop (alt+v)"}
        title={v.active ? "end voice · ⌥V" : "talk to bloop · ⌥V"}
        data-state={v.phase}
        data-working={v.task != null}
        data-muted={v.muted}
        className="vo-orb pointer-events-auto cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
      >
        <span className="vo-halo" />
        <svg className="vo-dash" viewBox="0 0 56 56" aria-hidden="true">
          <circle cx="28" cy="28" r="26" fill="none" stroke="#8dc63f" strokeWidth="2" strokeDasharray="5 6" strokeLinecap="round" />
        </svg>
        <svg className="vo-arc" viewBox="0 0 56 56" aria-hidden="true">
          <circle cx="28" cy="28" r="26" fill="none" stroke="#dcefc4" strokeWidth="3" />
          <path d="M28 2a26 26 0 0 1 26 26" fill="none" stroke="#5c8a2c" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <span className="vo-ripple" />
        <span className="vo-wave" />
        <span className="vo-sats" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="vo-core">
          <span className="vo-eye l" />
          <span className="vo-eye r" />
        </span>
      </button>
    </div>
  );
});
