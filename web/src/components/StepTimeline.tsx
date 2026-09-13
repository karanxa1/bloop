import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChatMessage, MessagePart, ToolCall } from "../types";
import { AgentIcon, ChevronIcon, CodeIcon, WrenchIcon } from "../icons";
import { cx, fmtMs } from "../lib";
import { ToolCallCard, ToolGroup, toolVerb } from "./ToolCallCard";
import { CodePart } from "./parts";
import { MarkdownText } from "./MarkdownText";
import { SkillChip, SubagentCard } from "./AgentParts";

type Part<K extends MessagePart["kind"]> = Extract<MessagePart, { kind: K }>;

export type Step =
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tools"; key: string; ids: string[] }
  | { kind: "skill"; key: string; part: Part<"skill"> }
  | { kind: "code"; key: string; part: Part<"code"> }
  | { kind: "subagent"; key: string; id: string };

export type Block =
  | { kind: "timeline"; key: string; steps: Step[] }
  | { kind: "part"; key: string; part: MessagePart };

/** parts that are "work" (fold into the timeline) rather than output the user reads */
const PROCESS: ReadonlySet<MessagePart["kind"]> = new Set([
  "tool",
  "subagent",
  "code",
  "skill",
  "thinking"
]);

/**
 * Split a reply into timeline blocks (think → tool → think → tool) and
 * visible blocks (answer text, images, app views, handoffs), keeping order.
 * Text immediately followed by work is narration (a thinking step); the
 * text after the last work is the answer.
 */
export function toBlocks(parts: MessagePart[]): Block[] {
  const blocks: Block[] = [];
  let steps: Step[] | null = null;
  const add = (s: Step) => {
    if (!steps) {
      steps = [];
      blocks.push({ kind: "timeline", key: `tl-${s.key}`, steps });
    }
    const prev = steps[steps.length - 1];
    if (s.kind === "tools" && prev?.kind === "tools") {
      prev.ids.push(...s.ids);
      return;
    }
    if (s.kind === "thinking" && prev?.kind === "thinking") {
      prev.text = `${prev.text}\n\n${s.text}`;
      return;
    }
    steps.push(s);
  };

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    switch (p.kind) {
      case "thinking":
        if (p.text.trim()) add({ kind: "thinking", key: p.id, text: p.text });
        break;
      case "text": {
        const next = parts[i + 1];
        if (!p.text.trim()) break;
        if (next && PROCESS.has(next.kind)) {
          add({ kind: "thinking", key: p.id, text: p.text.trim() });
        } else {
          steps = null;
          blocks.push({ kind: "part", key: p.id, part: p });
        }
        break;
      }
      case "tool":
        add({ kind: "tools", key: p.id, ids: [p.id] });
        break;
      case "skill":
        add({ kind: "skill", key: p.id, part: p });
        break;
      case "code":
        add({ kind: "code", key: p.id, part: p });
        break;
      case "subagent":
        add({ kind: "subagent", key: p.id, id: p.id });
        break;
      default:
        steps = null;
        blocks.push({ kind: "part", key: `${p.kind}-${p.id}`, part: p });
    }
  }
  return blocks;
}

// ── glyphs (local — icons.tsx is frozen) ────────────────────────────

function SparkGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c.4 4.9 2.9 7.6 8 8-5.1.4-7.6 3.1-8 8-.4-4.9-2.9-7.6-8-8 5.1-.4 7.6-3.1 8-8Z" />
      <path d="M19 15c.2 2 1 3 3 3.2-2 .2-2.8 1.1-3 3.1-.2-2-1-2.9-3-3.1 2-.2 2.8-1.2 3-3.2Z" opacity=".6" />
    </svg>
  );
}

function BookGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5A2.5 2.5 0 0 0 4 21.5v-2Z" />
    </svg>
  );
}

const GLYPH_TOP: Record<Step["kind"], string> = {
  thinking: "top-[5px]",
  tools: "top-[16px]",
  code: "top-[16px]",
  subagent: "top-[18px]",
  skill: "top-[8px]"
};

function Glyph({ kind, className }: { kind: Step["kind"]; className: string }) {
  switch (kind) {
    case "thinking":
      return <SparkGlyph className={className} />;
    case "tools":
      return <WrenchIcon className={className} />;
    case "code":
      return <CodeIcon className={className} />;
    case "subagent":
      return <AgentIcon className={className} />;
    case "skill":
      return <BookGlyph className={className} />;
  }
}

// ── rows ────────────────────────────────────────────────────────────

const THINK_CLAMP = 320;

function ThinkingText({ text, active }: { text: string; active: boolean }) {
  const [more, setMore] = useState(false);
  const long = text.length > THINK_CLAMP;
  const clamped = long && !more;
  return (
    <div className="py-0.5">
      <div
        className={cx(
          clamped &&
            (active
              ? "flex max-h-[4.6rem] flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_40%)]"
              : "max-h-[4.6rem] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]")
        )}
      >
        <MarkdownText
          text={text}
          className={cx("md md-sm italic", active ? "text-neutral-600!" : "text-neutral-500!")}
        />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className="mt-0.5 rounded-full text-[11px] font-semibold text-neutral-500 transition-colors duration-150 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
        >
          {more ? "show less" : "show more"}
        </button>
      )}
    </div>
  );
}

function callsOf(step: Step, tools: Record<string, ToolCall>): ToolCall[] {
  return step.kind === "tools"
    ? step.ids.map((id) => tools[id]).filter((c): c is ToolCall => c != null)
    : [];
}

function StepBody({
  step,
  message,
  animate,
  active
}: {
  step: Step;
  message: ChatMessage;
  animate: boolean;
  active: boolean;
}) {
  switch (step.kind) {
    case "thinking":
      return <ThinkingText text={step.text} active={active} />;
    case "tools": {
      const calls = callsOf(step, message.tools);
      if (calls.length === 0) return null;
      return calls.length === 1 ? (
        <ToolCallCard call={calls[0]} animate={animate} />
      ) : (
        <ToolGroup calls={calls} animate={animate} />
      );
    }
    case "skill":
      return (
        <div className="py-1">
          <SkillChip action={step.part.action} name={step.part.name} />
        </div>
      );
    case "code":
      return (
        <CodePart
          language={step.part.language}
          source={step.part.source}
          output={step.part.output}
          ok={step.part.ok}
          collapsed
        />
      );
    case "subagent": {
      const agent = message.subagents?.[step.id];
      return agent ? (
        <SubagentCard agent={agent} tools={message.tools} animate={animate} />
      ) : null;
    }
  }
}

function ContinuedNote() {
  return (
    <p className="mb-1 text-[11px] text-neutral-500">
      <span aria-hidden="true">↳ </span>bloop continued after the failure
    </p>
  );
}

// ── timeline ────────────────────────────────────────────────────────

interface StepTimelineProps {
  steps: Step[];
  message: ChatMessage;
  /** the whole turn is streaming */
  live: boolean;
  /** false for hydrated history — starts collapsed, no entry motion */
  animate: boolean;
  /** visible output follows this timeline (the run moved on) */
  continued: boolean;
}

export const StepTimeline = memo(function StepTimeline({
  steps,
  message,
  live,
  animate,
  continued
}: StepTimelineProps) {
  const bodyId = useId();
  const calls = useMemo(
    () => steps.flatMap((s) => callsOf(s, message.tools)),
    [steps, message.tools]
  );
  const failed = calls.filter((c) => c.status === "error").length;
  const active = live && !continued;

  const [open, setOpen] = useState(animate);
  const touched = useRef(false);
  const prevLive = useRef(live);
  useEffect(() => {
    const was = prevLive.current;
    prevLive.current = live;
    if (touched.current) return;
    if (live) {
      setOpen(true);
      return;
    }
    if (!was || failed > 0) return;
    const t = window.setTimeout(() => {
      if (!touched.current) setOpen(false);
    }, 800);
    return () => window.clearTimeout(t);
  }, [live, failed]);

  const failedIdx = steps.findIndex((s) =>
    callsOf(s, message.tools).some((c) => c.status === "error")
  );
  const noteAfter = (i: number) => i === failedIdx && (i < steps.length - 1 || continued);

  // a lone tool / subagent / code step needs no timeline chrome
  if (steps.length === 1 && steps[0].kind !== "thinking") {
    return (
      <div>
        <StepBody step={steps[0]} message={message} animate={animate} active={active} />
        {noteAfter(0) && <ContinuedNote />}
      </div>
    );
  }

  const running = [...calls].reverse().find((c) => c.status === "running");
  const lastStep = steps[steps.length - 1];
  const liveLabel = running
    ? `${toolVerb(running.name, true)}…`
    : lastStep.kind === "thinking"
      ? "thinking…"
      : "working…";
  const totalMs = calls.reduce((a, c) => a + (c.ms ?? 0), 0);
  const thoughts = steps.filter((s) => s.kind === "thinking").length;
  const summary = [
    thoughts > 0 && `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`,
    calls.length > 0 && `${calls.length} ${calls.length === 1 ? "tool" : "tools"}`,
    totalMs > 0 && fmtMs(totalMs)
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cx("my-2", animate && "motion-safe:tool-in")}>
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group/tl -ml-1 flex min-h-8 max-w-full items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-left text-xs transition-colors duration-150 hover:bg-neutral-200/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep"
      >
        <span
          className={cx(
            "flex h-4 w-4 shrink-0 items-center justify-center",
            active ? "text-bloop-deep" : "text-neutral-400"
          )}
        >
          <SparkGlyph className={cx("h-3.5 w-3.5", active && "motion-safe:animate-pulse")} />
        </span>
        <span className="min-w-0 truncate tabular-nums">
          {active ? (
            <span className="font-medium text-bloop-deep motion-safe:shimmer-text">
              {liveLabel}
            </span>
          ) : (
            <span className="text-neutral-500 transition-colors duration-150 group-hover/tl:text-neutral-800">
              {summary || `${steps.length} steps`}
            </span>
          )}
          {failed > 0 && (
            <span className="font-semibold text-red-600">
              {" "}
              · {failed} failed
              {failedIdx < steps.length - 1 || continued ? ", continued" : ""}
            </span>
          )}
        </span>
        <ChevronIcon
          className={cx(
            "h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform motion-safe:duration-150",
            open && "rotate-90"
          )}
        />
      </button>

      <div
        id={bodyId}
        inert={!open}
        className={cx(
          "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden px-0.5">
          <ol className="pt-0.5" aria-label="steps">
            {steps.map((s, i) => {
              const last = i === steps.length - 1;
              const isActive = active && last;
              return (
                <li
                  key={s.key}
                  className={cx("relative pl-6", animate && "motion-safe:tool-in")}
                  aria-current={isActive ? "step" : undefined}
                >
                  {!last && (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 left-[7.5px] top-0 w-px bg-neutral-200"
                    />
                  )}
                  <span
                    aria-hidden="true"
                    className={cx(
                      "absolute left-0 flex h-4 w-4 items-center justify-center rounded-full bg-page",
                      GLYPH_TOP[s.kind],
                      isActive ? "text-bloop-deep" : "text-neutral-400"
                    )}
                  >
                    <Glyph
                      kind={s.kind}
                      className={cx("h-3 w-3", isActive && "motion-safe:animate-pulse")}
                    />
                  </span>
                  <StepBody step={s} message={message} animate={animate} active={isActive} />
                  {noteAfter(i) && <ContinuedNote />}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
});
