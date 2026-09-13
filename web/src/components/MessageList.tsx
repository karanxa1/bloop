import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../types";
import { ToolCallCard } from "./ToolCallCard";
import { AlertIcon, BlobIcon } from "../icons";

const SUGGESTIONS = [
  "list my github repos, pick the most recently pushed, and create an issue there summarizing what it needs next — then verify it exists",
  "check slack for unread mentions, post a short digest to #general, and verify it landed",
  "create a notion page with today's standup notes, then read it back to confirm"
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
            <div className="mb-4 flex items-center gap-2 text-xs text-neutral-400">
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
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
      <BlobIcon className="h-14 w-14" />
      <h1 className="mt-3 font-wordmark text-4xl font-bold text-bloop-deep">
        bloop
      </h1>
      <p className="mt-2 text-sm text-neutral-500">
        a general agent that acts across your apps — and proves every step.
      </p>
      <div className="mt-8 flex w-full flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestion(s)}
            className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left text-sm text-neutral-700 shadow-sm transition-colors hover:border-bloop hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.kind === "text")
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("");
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-neutral-800 px-4 py-2.5 text-sm leading-relaxed text-white sm:max-w-[75%]">
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
          if (!part.text) return null;
          return (
            <div key={part.id} className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
            </div>
          );
        })}
        {message.error && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{message.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
