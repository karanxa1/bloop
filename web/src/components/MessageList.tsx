import { memo, useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../types";
import { ToolCallCard } from "./ToolCallCard";
import { CodePart, ImagePart } from "./parts";
import { AlertIcon, BlobIcon } from "../icons";

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

interface MessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  onSuggestion: (text: string) => void;
}

export function MessageList({ messages, streaming, onSuggestion }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto scroll-thin"
      aria-live="polite"
      aria-label="chat messages"
    >
      {messages.length === 0 ? (
        <EmptyState onSuggestion={onSuggestion} />
      ) : (
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && (
            <div className="mb-4 flex items-center gap-2 text-xs font-medium text-bloop-deep">
              <span className="h-1.5 w-1.5 rounded-full bg-bloop motion-safe:animate-pulse" />
              bloop is working…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onSuggestion }: { onSuggestion: (t: string) => void }) {
  return (
    <div className="flex h-full flex-col">
      {/* hero panel — same language as the landing hero */}
      <div className="relative flex min-h-[46%] shrink-0 items-end overflow-hidden bg-bloop">
        <img
          src="/assets/hero.jpg"
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
        <div className="relative px-6 pb-8 sm:px-10">
          <div className="motion-safe:rise flex items-end gap-3">
            <BlobIcon className="h-12 w-12" />
            <h1 className="sticker font-wordmark text-7xl font-extrabold leading-[0.9] text-bloop sm:text-8xl">
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
      <div className="flex-1 bg-page px-6 py-6 sm:px-10">
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
              className="motion-safe:rise border border-neutral-200 bg-white px-4 py-3 text-left transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
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

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.kind === "text")
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("");
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words bg-bloop-deep px-4 py-2.5 text-sm leading-relaxed text-white sm:max-w-[75%]">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5 flex justify-start">
      <div className="w-full max-w-[92%] sm:max-w-[85%]">
        {message.parts.map((part) => {
          if (part.kind === "tool") {
            const call = message.tools[part.id];
            return call ? <ToolCallCard key={part.id} call={call} /> : null;
          }
          if (part.kind === "image") {
            return (
              <ImagePart key={part.id} url={part.url} prompt={part.prompt} />
            );
          }
          if (part.kind === "code") {
            return (
              <CodePart
                key={part.id}
                language={part.language}
                source={part.source}
                output={part.output}
                ok={part.ok}
              />
            );
          }
          if (!part.text) return null;
          return (
            <div key={part.id} className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
            </div>
          );
        })}
        {message.error && (
          <div className="mt-2 flex items-start gap-2 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{message.error}</span>
          </div>
        )}
      </div>
    </div>
  );
});
