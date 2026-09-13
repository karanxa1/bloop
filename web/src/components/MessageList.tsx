import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ChatMode } from "../types";
import { ToolCallCard } from "./ToolCallCard";
import { CodePart, ImagePart } from "./parts";
import { MarkdownText } from "./MarkdownText";
import {
  HandoffCard,
  ServerChips,
  SourcesRow,
  SubagentCard,
  ThinkingIndicator
} from "./AgentParts";
import { AlertIcon, ArrowDownIcon, BlobIcon } from "../icons";

const SUGGESTIONS = [
  {
    label: "teach it a taste",
    text: "remember that I prefer terse answers with bullet points — then list my github repos briefly"
  },
  {
    label: "paint me a blob",
    text: "generate an image of a tiny green blob surfing a wave of spreadsheets"
  },
  {
    label: "run some code",
    text: "run python to compute the first 20 fibonacci numbers and show me the output"
  }
];

const MODE_LABEL: Record<ChatMode, string> = {
  default: "working…",
  think: "thinking…",
  deep: "researching…"
};

interface MessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  /** selected mode — label fallback until the run echoes its own */
  mode: ChatMode;
  /** a conversation is being fetched */
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSuggestion: (text: string) => void;
}

export function MessageList({
  messages,
  streaming,
  mode,
  loading,
  error,
  onRetry,
  onSuggestion
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const prevLen = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [announce, setAnnounce] = useState("");
  const wasStreaming = useRef(streaming);
  const hasMessages = messages.length > 0;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = atBottom;
    setShowJump((s) => (s === !atBottom ? s : !atBottom));
  }, []);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // new messages (send / conversation switch) re-pin; deltas follow only if pinned
  useLayoutEffect(() => {
    if (messages.length !== prevLen.current) pinned.current = true;
    prevLen.current = messages.length;
    if (pinned.current) toBottom();
  }, [messages, streaming, toBottom]);

  // content that grows without a state change (images loading, expanding cards)
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [hasMessages, toBottom]);

  // screen readers: announce run completion once instead of every token
  useEffect(() => {
    if (wasStreaming.current && !streaming) setAnnounce("bloop replied");
    else if (streaming) setAnnounce("");
    wasStreaming.current = streaming;
  }, [streaming]);

  const last = messages[messages.length - 1];
  const liveMode = (last?.role === "assistant" && last.mode) || mode;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {loading && (
        <div
          className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
          role="progressbar"
          aria-label="loading conversation"
        >
          <span className="tool-progress !h-0.5" />
        </div>
      )}
      <section
        ref={scrollRef}
        onScroll={handleScroll}
        className="vt-chat min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
        aria-label="chat messages"
        aria-busy={loading || undefined}
      >
        {error ? (
          <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 border border-neutral-200 border-l-2 border-l-red-500 bg-white px-4 py-3 text-sm text-neutral-700"
            >
              <AlertIcon className="h-4 w-4 shrink-0 text-red-600" />
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-full bg-bloop px-4 py-1.5 font-wordmark text-sm font-bold text-neutral-900 transition-colors duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
              >
                retry
              </button>
            </div>
          </div>
        ) : !hasMessages ? (
          loading ? (
            <MessageSkeleton />
          ) : (
            <EmptyState onSuggestion={onSuggestion} />
          )
        ) : (
          <div ref={contentRef} className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                live={streaming && i === messages.length - 1}
              />
            ))}
            {streaming && <ThinkingIndicator label={MODE_LABEL[liveMode]} />}
          </div>
        )}
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {showJump && hasMessages && (
        <button
          type="button"
          onClick={() => {
            pinned.current = true;
            toBottom();
          }}
          className="motion-safe:tool-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-bloop-deep shadow-sm transition-colors duration-150 hover:border-bloop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
        >
          <ArrowDownIcon className="h-3.5 w-3.5" />
          {streaming ? "follow along" : "jump to latest"}
        </button>
      )}
    </div>
  );
}

function MessageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-4">
          <div className="flex justify-end">
            <div className="h-9 w-2/5 bg-bloop-deep/15 motion-safe:animate-pulse" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-4/5 bg-neutral-200 motion-safe:animate-pulse" />
            <div className="h-3 w-3/5 bg-neutral-200 motion-safe:animate-pulse" />
            <div className="h-9 w-full border-l-2 border-l-bloop/40 bg-white motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onSuggestion }: { onSuggestion: (t: string) => void }) {
  return (
    <div className="flex min-h-full flex-col">
      {/* hero panel — same language as the landing hero */}
      <div className="relative flex min-h-[46%] shrink-0 items-end overflow-hidden bg-bloop">
        <img
          src="/assets/hero.webp"
          width={1400}
          height={933}
          decoding="async"
          fetchPriority="high"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover opacity-40 motion-safe:scale-[1.03]"
        />
        <div className="absolute inset-0 bg-bloop/50" aria-hidden="true" />
        <svg
          className="pointer-events-none absolute -right-20 -top-24 h-80 w-80 text-white/20"
          viewBox="0 0 200 200"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="100" cy="100" r="45" stroke="currentColor" />
          <circle cx="100" cy="100" r="75" stroke="currentColor" />
          <circle cx="100" cy="100" r="100" stroke="currentColor" />
        </svg>
        <div className="relative px-5 pb-8 pt-16 sm:px-10">
          <div className="motion-safe:rise flex items-end gap-3">
            <BlobIcon className="h-10 w-10 sm:h-12 sm:w-12" />
            <h1 className="sticker font-wordmark text-6xl font-extrabold leading-[0.9] text-bloop sm:text-8xl">
              bloop
            </h1>
          </div>
          <p className="motion-safe:rise mt-3 max-w-md text-sm font-medium leading-relaxed text-white [animation-delay:120ms]">
            a general agent that acts across your apps — and proves every step.
            plan it, run it, verify it.
          </p>
        </div>
      </div>

      {/* suggestion cards — white on lime-grey, like landing features */}
      <div className="flex-1 bg-page px-5 py-6 sm:px-10">
        <p className="text-[11px] font-semibold text-neutral-500">
          try one — watch the proof trace on the right
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onSuggestion(s.text)}
              style={{ animationDelay: `${i * 75}ms` }}
              className="motion-safe:rise border border-neutral-200 border-l-2 border-l-bloop bg-white px-4 py-3 text-left transition-[transform,border-color] duration-150 hover:border-bloop/60 motion-safe:hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
            >
              <span className="block font-wordmark text-base font-bold text-bloop-deep">
                {s.label}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-neutral-500">
                {s.text}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized on (message, live). The streaming reducer keeps object identity
 * for every untouched message, so a delta re-renders only the live bubble —
 * and inside it only the text part that changed (MarkdownText is memoized).
 */
const MessageBubble = memo(function MessageBubble({
  message,
  live
}: {
  message: ChatMessage;
  live: boolean;
}) {
  const animate = !message.loaded;

  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("");
    return (
      <div className={animate ? "motion-safe:tool-in mb-4 flex justify-end" : "mb-4 flex justify-end"}>
        <div className="max-w-[88%] whitespace-pre-wrap bg-bloop-deep px-4 py-2.5 text-sm leading-relaxed text-white [overflow-wrap:anywhere] sm:max-w-[75%]">
          {text}
        </div>
      </div>
    );
  }

  const servers = message.servers ? Object.values(message.servers) : [];
  const waitingForFirstToken = live && message.parts.length === 0;

  return (
    <article className="mb-6 min-w-0" aria-label="bloop reply">
      {waitingForFirstToken && <ServerChips servers={servers} />}
      {message.parts.map((part) => {
        switch (part.kind) {
          case "tool": {
            const call = message.tools[part.id];
            return call ? (
              <ToolCallCard key={part.id} call={call} animate={animate} />
            ) : null;
          }
          case "subagent": {
            const agent = message.subagents?.[part.id];
            return agent ? (
              <SubagentCard
                key={part.id}
                agent={agent}
                tools={message.tools}
                animate={animate}
              />
            ) : null;
          }
          case "handoff":
            return <HandoffCard key={part.id} url={part.url} reason={part.reason} />;
          case "image":
            return <ImagePart key={part.id} url={part.url} prompt={part.prompt} />;
          case "code":
            return (
              <CodePart
                key={part.id}
                language={part.language}
                source={part.source}
                output={part.output}
                ok={part.ok}
              />
            );
          case "text":
            return part.text ? <MarkdownText key={part.id} text={part.text} /> : null;
          default:
            return null;
        }
      })}
      {message.sources && message.sources.length > 0 && (
        <SourcesRow items={message.sources} />
      )}
      {message.error && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 border border-red-200 border-l-2 border-l-red-500 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{message.error}</span>
        </div>
      )}
    </article>
  );
});
