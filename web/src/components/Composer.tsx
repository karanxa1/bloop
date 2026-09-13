import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "../icons";

interface ComposerProps {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ streaming, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autoresize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <label htmlFor="composer" className="sr-only">
          message bloop
        </label>
        <textarea
          id="composer"
          ref={taRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autoresize();
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="ask bloop to do something…"
          disabled={streaming}
          className="max-h-40 flex-1 resize-none border border-neutral-300 bg-page px-3.5 py-2.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40 disabled:opacity-60"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="stop generating"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bloop-deep text-white transition-all duration-150 hover:-translate-y-px hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            aria-label="send message"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bloop text-white transition-all duration-150 hover:-translate-y-px hover:bg-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendIcon />
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-[10px] text-neutral-400">
        enter to send · shift+enter for a new line
      </p>
    </div>
  );
}
