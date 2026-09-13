import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as ws from "../../api/workspace";
import type { ExecResult } from "../../types/workspace";
import { AlertIcon, ChevronIcon, SpinnerIcon, StopIcon } from "../../icons";
import { cx, fmtMs, prefersReducedMotion } from "../../lib";

interface Entry {
  id: number;
  command: string;
  status: "running" | "done" | "error" | "stopped";
  startedAt: number;
  result?: ExecResult;
  error?: string;
}

const SUGGESTIONS = ["npm test", "python main.py", "ls -la"];
const MAX_OUT = 20_000;
const clip = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… ${s.length - MAX_OUT} more chars` : s);

let entrySeq = 0;

interface RunConsoleProps {
  conversationId: string | null;
  onResult: (r: ExecResult) => void;
}

function RunConsoleImpl({ conversationId, onResult }: RunConsoleProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(true);
  const [announce, setAnnounce] = useState("");
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const draft = useRef("");
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const running = entries.some((e) => e.status === "running");
  const disabled = !conversationId;

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, open]);

  const run = (raw: string) => {
    const command = raw.trim();
    if (!command || !conversationId || running) return;
    const h = history.current;
    if (h[h.length - 1] !== command) h.push(command);
    if (h.length > 50) h.shift();
    histIdx.current = -1;
    setInput("");
    setOpen(true);
    const id = ++entrySeq;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setEntries((es) => [...es.slice(-29), { id, command, status: "running", startedAt: Date.now() }]);
    const patch = (p: Partial<Entry>) => setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)));
    ws.exec(conversationId, command, ctrl.signal)
      .then((result) => {
        patch({ status: "done", result });
        setAnnounce(`${command} exited ${result.exit_code} in ${fmtMs(result.ms)}`);
        onResult(result);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) patch({ status: "stopped" });
        else {
          patch({ status: "error", error: ws.errText(e) });
          setAnnounce(`${command} failed`);
        }
      })
      .finally(() => {
        if (abort.current === ctrl) abort.current = null;
        requestAnimationFrame(() => inputRef.current?.focus());
      });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const h = history.current;
    if (e.key === "ArrowUp" && h.length) {
      e.preventDefault();
      if (histIdx.current === -1) {
        draft.current = input;
        histIdx.current = h.length - 1;
      } else histIdx.current = Math.max(0, histIdx.current - 1);
      setInput(h[histIdx.current]);
    } else if (e.key === "ArrowDown" && histIdx.current !== -1) {
      e.preventDefault();
      histIdx.current += 1;
      if (histIdx.current >= h.length) {
        histIdx.current = -1;
        setInput(draft.current);
      } else setInput(h[histIdx.current]);
    }
  };

  return (
    <section aria-label="run console" className="flex shrink-0 flex-col border-t border-neutral-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="ws-console-log"
          className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-600 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep"
        >
          <ChevronIcon className={cx("h-3 w-3 motion-safe:transition-transform", open && "rotate-90")} />
          console
        </button>
        {running && (
          <span className="inline-flex items-center gap-1 text-[11px] text-neutral-600">
            <SpinnerIcon className="h-3 w-3 motion-safe:animate-spin" /> running
          </span>
        )}
        {entries.length > 0 && !running && (
          <button
            type="button"
            onClick={() => setEntries([])}
            className="ml-auto rounded-full px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-bloop-deep"
          >
            clear
          </button>
        )}
        <span className="sr-only" role="status">
          {announce}
        </span>
      </div>

      {open && entries.length > 0 && (
        <div
          id="ws-console-log"
          ref={logRef}
          tabIndex={0}
          aria-label="command output"
          className="h-40 overflow-y-auto border-t border-neutral-100 bg-neutral-50 px-3 py-2 font-mono text-[12px] leading-relaxed @xl:h-52"
        >
          {entries.map((e) => (
            <ConsoleEntry key={e.id} entry={e} />
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
        }}
        className="flex items-center gap-2 border-t border-neutral-100 px-3 py-2"
      >
        <span aria-hidden="true" className="font-mono text-[13px] font-bold text-bloop-deep">
          $
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            histIdx.current = -1;
          }}
          onKeyDown={onKeyDown}
          disabled={disabled || running}
          aria-label="command"
          placeholder={disabled ? "start a conversation to run commands" : "run a command — ↑↓ for history"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-neutral-900 placeholder:text-neutral-500 focus-visible:outline-none disabled:cursor-not-allowed"
        />
        {running ? (
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-3 py-1 text-[11px] font-semibold text-neutral-800 hover:border-red-400 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-bloop-deep"
          >
            <StopIcon className="h-2.5 w-2.5" /> stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            className="rounded-full bg-bloop px-3 py-1 text-[11px] font-bold text-neutral-900 hover:bg-[#9bd24d] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep disabled:bg-neutral-200 disabled:text-neutral-500"
          >
            run
          </button>
        )}
      </form>

      {!disabled && !running && !input && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label="suggested commands">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => run(s)}
              className="rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 font-mono text-[11px] text-neutral-700 hover:border-bloop hover:bg-bloop/10 focus-visible:outline-2 focus-visible:outline-bloop-deep"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ConsoleEntry({ entry }: { entry: Entry }) {
  const r = entry.result;
  return (
    <div className="mb-3 last:mb-0 motion-safe:tool-in">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-semibold text-neutral-900">
          <span className="text-bloop-deep">$ </span>
          {entry.command}
        </span>
        {entry.status === "running" && <Elapsed since={entry.startedAt} />}
        {r && (
          <>
            <span
              className={cx(
                "rounded-full px-2 py-px font-sans text-[10px] font-bold",
                r.exit_code === 0 ? "bg-bloop text-neutral-900" : "bg-red-600 text-white"
              )}
            >
              exit {r.exit_code}
            </span>
            <span className="font-sans text-[10px] tabular-nums text-neutral-500">{fmtMs(r.ms)}</span>
          </>
        )}
        {entry.status === "stopped" && <span className="font-sans text-[10px] text-neutral-500">stopped</span>}
      </div>
      {entry.error && <div className="mt-1 text-red-700">{entry.error}</div>}
      {r && (
        <>
          {r.stdout && <Reveal text={clip(r.stdout)} className="text-neutral-800" />}
          {r.stderr && <Reveal text={clip(r.stderr)} className="text-red-700" />}
          {r.changed.length > 0 && <PathList sign="+" label="changed" paths={r.changed} cls="text-[#3f6b1a]" />}
          {r.deleted.length > 0 && <PathList sign="−" label="deleted" paths={r.deleted} cls="text-red-700" />}
          {r.skipped && r.skipped.length > 0 && (
            <PathList sign="·" label="skipped" paths={r.skipped} cls="text-neutral-500" />
          )}
          {r.sync_error && (
            <div role="alert" className="mt-1.5 flex items-start gap-1.5 border border-amber-200 border-l-2 border-l-amber-500 bg-amber-50 px-2 py-1 font-sans text-[11px] text-amber-900">
              <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>files may be out of sync: {r.sync_error}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PathList({ sign, label, paths, cls }: { sign: string; label: string; paths: string[]; cls: string }) {
  return (
    <div className={cx("mt-1 text-[11px]", cls)}>
      <span className="font-sans font-semibold">{label}</span>{" "}
      {paths.map((p) => (
        <span key={p} className="mr-2 whitespace-nowrap">
          {sign} {p}
        </span>
      ))}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  return <span className="font-sans text-[10px] tabular-nums text-neutral-500">{fmtMs(now - since)}</span>;
}

/** line-by-line reveal so a batch result reads like a stream (skipped for reduced motion) */
function Reveal({ text, className }: { text: string; className: string }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? text.length : 0));
  useEffect(() => {
    if (shown >= text.length) return;
    const lines = text.split("\n");
    const step = Math.max(1, Math.ceil(lines.length / 18));
    let n = 0;
    let raf = 0;
    const tick = () => {
      n += step;
      const end = n >= lines.length ? text.length : lines.slice(0, n).join("\n").length;
      setShown(end);
      if (end < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return <pre className={cx("mt-1 whitespace-pre-wrap break-words", className)}>{text.slice(0, shown)}</pre>;
}

export const RunConsole = memo(RunConsoleImpl);
