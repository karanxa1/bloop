import { memo, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatMode } from "../types";
import { SendIcon, StopIcon } from "../icons";
import { cx } from "../lib";

const MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "default", label: "default", hint: "quick, everyday tasks" },
  { id: "think", label: "think", hint: "reasons longer before acting" },
  { id: "deep", label: "deep", hint: "multi-step research with subagents" }
];

interface ComposerProps {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
}

export const Composer = memo(function Composer({
  streaming,
  onSend,
  onStop,
  mode,
  onModeChange
}: ComposerProps) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  // grow with content (capped), shrink back after send
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // radiogroup keyboard model: arrows move + select, home/end jump
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % MODES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + MODES.length) % MODES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = MODES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onModeChange(MODES[next].id);
    radios.current[next]?.focus();
  };

  const canSend = value.trim() !== "" && !streaming;

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center gap-2">
          <div
            role="radiogroup"
            aria-label="reasoning mode"
            className="flex items-center gap-0.5 rounded-full bg-neutral-100 p-0.5"
          >
            {MODES.map((m, i) => {
              const selected = mode === m.id;
              const tipId = `mode-tip-${m.id}`;
              return (
                <span key={m.id} className="group relative">
                  <button
                    ref={(el) => {
                      radios.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-describedby={tipId}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onModeChange(m.id)}
                    onKeyDown={(e) => onRadioKey(e, i)}
                    className={cx(
                      "rounded-full px-3 py-1 text-[11px] font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep",
                      selected
                        ? "bg-bloop text-neutral-900 shadow-sm"
                        : "text-neutral-500 hover:text-neutral-800"
                    )}
                  >
                    {m.label}
                  </button>
                  <span
                    role="tooltip"
                    id={tipId}
                    className={cx(
                      "pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap bg-neutral-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100",
                      i === 0 ? "left-0" : "left-1/2 -translate-x-1/2"
                    )}
                  >
                    {m.hint}
                  </span>
                </span>
              );
            })}
          </div>
          <p className="ml-auto hidden text-[10px] text-neutral-400 sm:block">
            enter to send · shift+enter for a new line
          </p>
        </div>

        <div className="flex items-end gap-2">
          <label htmlFor="composer" className="sr-only">
            message bloop
          </label>
          <textarea
            id="composer"
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={
              mode === "deep"
                ? "what should bloop research?"
                : "tell bloop what to do…"
            }
            enterKeyHint="send"
            className="max-h-40 min-w-0 flex-1 resize-none border border-neutral-300 bg-page px-3.5 py-2.5 text-base text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40 sm:text-sm"
          />
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="stop generating"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bloop-deep text-white transition-[transform,background-color] duration-150 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep motion-safe:hover:-translate-y-px"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="send message"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bloop text-white transition-[transform,background-color] duration-150 hover:bg-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:cursor-not-allowed disabled:opacity-40 motion-safe:enabled:hover:-translate-y-px"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
