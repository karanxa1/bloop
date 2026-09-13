import { memo, useContext, useId, useMemo, useState } from "react";
import type { McpServerFrame, SourceItem, Subagent, ToolCall } from "../types";
import { ChatActions } from "../chatActions";
import {
  AgentIcon,
  CheckIcon,
  ChevronIcon,
  ExternalIcon,
  GlobeIcon,
  SpinnerIcon,
  XIcon
} from "../icons";
import { cleanSources, cx, faviconUrl, hostOf, safeHttpUrl } from "../lib";
import { ToolCallCard } from "./ToolCallCard";
import { CodePart, ImagePart } from "./parts";
import { MarkdownText } from "./MarkdownText";
import { AppLogo } from "./ServerLogo";

export const HANDOFF_DONE_MESSAGE = "done — i finished in the browser, continue";
export const HANDOFF_SKIP_MESSAGE = "skip that step — continue without it";

// ── handoff ─────────────────────────────────────────────────────────

const secondaryPill =
  "inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:cursor-not-allowed";

export function HandoffCard({ url, reason }: { url: string; reason: string }) {
  const { send, streaming } = useContext(ChatActions);
  const [choice, setChoice] = useState<"done" | "skip" | null>(null);
  const href = safeHttpUrl(url);
  const titleId = useId();
  const locked = streaming || choice != null;

  const choose = (c: "done" | "skip") => {
    if (locked) return;
    setChoice(c);
    send(c === "done" ? HANDOFF_DONE_MESSAGE : HANDOFF_SKIP_MESSAGE);
  };

  const choiceCls = (c: "done" | "skip") =>
    cx(
      secondaryPill,
      choice === c
        ? "border-bloop bg-bloop/15 text-bloop-deep"
        : choice != null
          ? "border-neutral-200 bg-white text-neutral-400 opacity-60"
          : "border-neutral-300 bg-white text-neutral-700 hover:border-bloop hover:text-bloop-deep disabled:opacity-50"
    );

  return (
    <section
      aria-labelledby={titleId}
      className="motion-safe:tool-in my-3 border border-neutral-200 border-l-2 border-l-bloop bg-white"
    >
      <div className="flex items-start gap-3 px-3.5 py-3 sm:px-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bloop/15 text-bloop-deep">
          <GlobeIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-wordmark text-sm font-bold text-bloop-deep">
            your turn in the browser
          </h3>
          <p className="mt-0.5 text-sm leading-relaxed text-neutral-700 [overflow-wrap:anywhere]">
            {reason || "bloop needs you to finish a step in the browser."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-bloop px-4 py-2 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color,color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep motion-safe:hover:-translate-y-px"
              >
                take over browser
                <ExternalIcon className="h-3.5 w-3.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span className="text-xs text-red-600">browser link unavailable</span>
            )}
            <button
              type="button"
              disabled={locked}
              aria-pressed={choice === "done"}
              onClick={() => choose("done")}
              className={choiceCls("done")}
            >
              {choice === "done" && <CheckIcon className="motion-safe:pop h-3.5 w-3.5" />}
              done — continue
            </button>
            <button
              type="button"
              disabled={locked}
              aria-pressed={choice === "skip"}
              onClick={() => choose("skip")}
              className={choiceCls("skip")}
            >
              {choice === "skip" && <CheckIcon className="motion-safe:pop h-3.5 w-3.5" />}
              skip
            </button>
          </div>
          <p className="mt-2 text-[11px] text-neutral-400" aria-live="polite">
            {choice === "done"
              ? "you finished in the browser — bloop is continuing."
              : choice === "skip"
                ? "skipped — bloop is continuing without this step."
                : streaming
                  ? "you can respond once bloop pauses."
                  : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

// ── subagent ────────────────────────────────────────────────────────

interface SubagentCardProps {
  agent: Subagent;
  tools: Record<string, ToolCall>;
  animate: boolean;
}

export const SubagentCard = memo(function SubagentCard({
  agent,
  tools,
  animate
}: SubagentCardProps) {
  const running = agent.status === "running";
  const [open, setOpen] = useState(running);
  const bodyId = useId();
  const toolCount = agent.parts.filter((p) => p.kind === "tool").length;

  return (
    <section
      aria-label={`subagent: ${agent.task || "delegated task"}`}
      className={cx(
        "relative my-2.5 overflow-hidden border border-neutral-200 border-l-2 bg-white text-sm",
        agent.status === "error" ? "border-l-red-500" : "border-l-bloop-deep",
        animate && "motion-safe:tool-in",
        animate && agent.status === "error" && "motion-safe:shake"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-page/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
      >
        <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bloop-deep/10 text-bloop-deep">
          <AgentIcon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-neutral-400">
            subagent
            {toolCount > 0 && (
              <span className="rounded-full bg-neutral-100 px-1.5 py-px text-neutral-500">
                {toolCount} {toolCount === 1 ? "tool" : "tools"}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[13px] font-medium leading-snug text-neutral-800 [overflow-wrap:anywhere] line-clamp-3">
            {agent.task || "delegated task"}
          </span>
        </span>
        <span className="mt-1 flex shrink-0 items-center gap-2">
          {running && (
            <span className="text-bloop-deep">
              <SpinnerIcon className="h-3.5 w-3.5" />
              <span className="sr-only">running</span>
            </span>
          )}
          {agent.status === "ok" && (
            <span className={cx("text-bloop-deep", animate && "motion-safe:pop")}>
              <CheckIcon className="h-3.5 w-3.5" />
              <span className="sr-only">done</span>
            </span>
          )}
          {agent.status === "error" && (
            <span className={cx("text-red-600", animate && "motion-safe:pop")}>
              <XIcon className="h-3.5 w-3.5" />
              <span className="sr-only">failed</span>
            </span>
          )}
          <ChevronIcon
            className={cx(
              "h-3.5 w-3.5 text-neutral-400 transition-transform motion-safe:duration-200",
              open && "rotate-90"
            )}
          />
        </span>
      </button>

      {running && <span className="tool-progress" aria-hidden="true" />}

      <div
        id={bodyId}
        inert={!open}
        className={cx(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-neutral-100 bg-page/60 px-3 py-1.5">
            {agent.parts.length === 0 ? (
              <p className="py-1.5 text-[11px] text-neutral-400">
                {running ? "starting up…" : "no steps recorded."}
              </p>
            ) : (
              agent.parts.map((part) => {
                switch (part.kind) {
                  case "tool": {
                    const call = tools[part.id];
                    return call ? (
                      <ToolCallCard key={part.id} call={call} animate={animate} />
                    ) : null;
                  }
                  case "code":
                    return (
                      <CodePart
                        key={part.id}
                        language={part.language}
                        source={part.source}
                        output={part.output}
                        ok={part.ok}
                        collapsed
                      />
                    );
                  case "image":
                    return <ImagePart key={part.id} url={part.url} prompt={part.prompt} />;
                  case "text":
                    return part.text ? (
                      <MarkdownText key={part.id} text={part.text} className="md md-sm my-1.5" />
                    ) : null;
                  default:
                    return null;
                }
              })
            )}
          </div>
        </div>
      </div>

      {agent.summary && !running && (
        <div className="border-t border-neutral-100 px-3 py-2">
          <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-neutral-400">
            summary
          </div>
          <MarkdownText text={agent.summary} className="md md-sm" />
        </div>
      )}
    </section>
  );
});

// ── sources ─────────────────────────────────────────────────────────

const VISIBLE_SOURCES = 6;

export function SourceChip({ item }: { item: SourceItem }) {
  const host = hostOf(item.url);
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      title={item.title ? `${item.title} — ${host}` : item.url}
      className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-2.5 text-[11px] font-medium text-neutral-600 transition-colors duration-150 hover:border-bloop hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
    >
      <img
        src={faviconUrl(host)}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={(e) => {
          e.currentTarget.style.visibility = "hidden";
        }}
        className="h-4 w-4 shrink-0 rounded-full bg-page"
      />
      <span className="truncate">{host}</span>
      {item.title && <span className="sr-only">: {item.title}</span>}
    </a>
  );
}

export function SourcesRow({ items }: { items: SourceItem[] }) {
  const [all, setAll] = useState(false);
  const clean = useMemo(() => cleanSources(items), [items]);
  if (clean.length === 0) return null;
  const shown = all ? clean : clean.slice(0, VISIBLE_SOURCES);
  const hidden = clean.length - shown.length;

  return (
    <div className="mt-3">
      <h3 className="sr-only">sources</h3>
      <ul className="flex flex-wrap items-center gap-1.5">
        {shown.map((s) => (
          <li key={s.url} className="motion-safe:tool-in min-w-0">
            <SourceChip item={s} />
          </li>
        ))}
        {(hidden > 0 || all) && clean.length > VISIBLE_SOURCES && (
          <li>
            <button
              type="button"
              onClick={() => setAll((a) => !a)}
              aria-expanded={all}
              className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
            >
              {all ? "show less" : `+${hidden} more`}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

// ── mcp server connection chips ─────────────────────────────────────

const serverPhase = (state: string): "pending" | "ok" | "error" => {
  const s = state.toLowerCase();
  if (/err|fail|down|timeout/.test(s)) return "error";
  if (/ok|connected|ready|done|loaded/.test(s)) return "ok";
  return "pending";
};

export function ServerChips({ servers }: { servers: McpServerFrame[] }) {
  if (servers.length === 0) return null;
  return (
    <ul aria-label="connecting apps" className="mb-2 flex flex-wrap items-center gap-1.5">
      {servers.map((s) => {
        const phase = serverPhase(s.state);
        const count = Array.isArray(s.tools) ? s.tools.length : s.tools;
        return (
          <li
            key={s.name}
            className={cx(
              "motion-safe:tool-in inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2 text-[10px] font-semibold transition-colors duration-300",
              phase === "ok" && "border-bloop/40 bg-bloop/10 text-bloop-deep",
              phase === "pending" && "border-neutral-200 bg-white text-neutral-500",
              phase === "error" && "border-red-200 bg-red-50 text-red-700"
            )}
          >
            <AppLogo name={s.name} className="h-3 w-3" />
            <span className="max-w-[9rem] truncate">{s.name}</span>
            {phase === "pending" && <SpinnerIcon className="h-3 w-3" />}
            {phase === "ok" && (
              <span className="motion-safe:pop flex items-center gap-0.5">
                <CheckIcon className="h-3 w-3" />
                {typeof count === "number" && <span className="tabular-nums">{count}</span>}
              </span>
            )}
            {phase === "error" && <XIcon className="h-3 w-3" />}
            <span className="sr-only">
              {phase === "ok" ? "connected" : phase === "error" ? "failed to connect" : "connecting"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── thinking indicator ──────────────────────────────────────────────

export function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="mb-4 flex items-center gap-2.5" role="status">
      <span className="flex h-4 items-end gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{ animationDelay: `${i * 140}ms` }}
            className={cx(
              "block h-2 w-2 rounded-full bg-bloop motion-safe:blob-bounce",
              i === 1 && "opacity-80 motion-safe:opacity-100",
              i === 2 && "opacity-60 motion-safe:opacity-100"
            )}
          />
        ))}
      </span>
      <span className="text-xs font-semibold text-bloop-deep motion-safe:shimmer-text">
        bloop is {label}
      </span>
    </div>
  );
}
