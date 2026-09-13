import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ChatMessage, ChatMode, MessagePart } from "../types";
import { ChatActions, EDIT_LAST_EVENT, MessageSources } from "../chatActions";
import { ImagePart } from "./parts";
import { MarkdownText } from "./MarkdownText";
import { HandoffCard, ServerChips, SourcesRow, ThinkingIndicator } from "./AgentParts";
import { StepTimeline, toBlocks } from "./StepTimeline";
import { McpAppFrame } from "./McpAppFrame";
import { CopyButton, toolVerb } from "./ToolCallCard";
import { AlertIcon, ArrowDownIcon, BlobIcon, PencilIcon } from "../icons";
import { cx, prefersReducedMotion } from "../lib";

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

/** short step label for the polite status region — never token text */
function stepLabel(m: ChatMessage | undefined): string {
  if (!m || m.role !== "assistant") return "";
  let running: { name: string; seq: number } | undefined;
  for (const c of Object.values(m.tools)) {
    if (c.status === "running" && (!running || c.seq > running.seq)) running = c;
  }
  if (running) return toolVerb(running.name, true);
  const lp = m.parts[m.parts.length - 1];
  if (!lp || lp.kind === "thinking") return "thinking";
  return lp.kind === "text" ? "writing" : "working";
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
  const jumping = useRef(false);
  const lastTop = useRef(0);
  const prevLen = useRef(0);
  const streamingRef = useRef(streaming);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const hasMessages = messages.length > 0;
  streamingRef.current = streaming;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const dist = el.scrollHeight - top - el.clientHeight;
    const up = top < lastTop.current - 1;
    lastTop.current = top;
    // any upward scroll unpins at once (no snap-back); re-pin near the bottom
    let bottom = dist <= 2 || (!up && dist < 32);
    if (jumping.current) {
      if (up) jumping.current = false;
      else bottom = true;
      if (dist <= 2) jumping.current = false;
    }
    pinned.current = bottom;
    setAtBottom((b) => (b === bottom ? b : bottom));
    if (bottom) setUnseen(false);
  }, []);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    jumping.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  // new messages (send / conversation switch) re-pin; deltas follow only if pinned
  useLayoutEffect(() => {
    if (messages.length !== prevLen.current) pinned.current = true;
    prevLen.current = messages.length;
    if (pinned.current) toBottom();
    else if (messages.length > 0) setUnseen(true);
  }, [messages, streaming, toBottom]);

  // content that grows without a state change (images loading, expanding cards)
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
      else if (streamingRef.current) setUnseen(true);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [hasMessages, toBottom]);

  // ↑ in an empty composer → edit the last user message
  useEffect(() => {
    const onEditLast = () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          setEditingId(messages[i].id);
          return;
        }
      }
    };
    window.addEventListener(EDIT_LAST_EVENT, onEditLast);
    return () => window.removeEventListener(EDIT_LAST_EVENT, onEditLast);
  }, [messages]);

  const last = messages[messages.length - 1];
  const liveMode = (last?.role === "assistant" && last.mode) || mode;
  const label = streaming ? stepLabel(last) : "";

  // screen readers: announce step changes (debounced) and completion — never tokens
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (streaming) {
      if (!label) return;
      const t = window.setTimeout(() => setAnnounce(label), 700);
      return () => window.clearTimeout(t);
    }
    if (wasStreaming.current && last?.role === "assistant") {
      const calls = Object.values(last.tools);
      const failed = calls.filter((c) => c.status === "error").length;
      setAnnounce(
        last.error
          ? "bloop stopped with an error"
          : `done${calls.length ? `, ${calls.length} tools` : ""}${failed ? `, ${failed} failed` : ""}`
      );
    }
  }, [streaming, label, last]);
  useEffect(() => {
    wasStreaming.current = streaming;
  }, [streaming]);

  const stopEditing = useCallback(() => setEditingId(null), []);

  // waiting between steps (no running tool, no text streaming) → show a contextual blob row
  const lastPart = last?.role === "assistant" ? last.parts[last.parts.length - 1] : undefined;
  const idle =
    streaming &&
    last?.role === "assistant" &&
    label !== "writing" &&
    !(lastPart?.kind === "tool" && last.tools[lastPart.id]?.status === "running") &&
    lastPart?.kind !== "thinking";

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
          <div ref={contentRef} className="mx-auto max-w-3xl px-4 pb-10 pt-6 sm:px-6">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                live={streaming && i === messages.length - 1}
                isLast={i === messages.length - 1}
                editing={editingId === m.id}
                onEditStart={setEditingId}
                onEditEnd={stopEditing}
              />
            ))}
            {idle && <ThinkingIndicator label={MODE_LABEL[liveMode]} />}
          </div>
        )}
      </section>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </p>

      {!atBottom && hasMessages && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={unseen ? "new activity — scroll to latest" : "scroll to latest"}
          className={cx(
            "motion-safe:tool-in absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center justify-center gap-1.5 rounded-full shadow-[0_2px_8px_rgb(0_0_0/0.08)] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep",
            unseen
              ? "h-8 bg-bloop px-3 text-[11px] font-semibold text-neutral-900 hover:bg-bloop-deep hover:text-white"
              : "h-9 w-9 border border-neutral-200 bg-white text-bloop-deep hover:border-bloop"
          )}
        >
          {unseen && <span>new activity</span>}
          <ArrowDownIcon className="h-3.5 w-3.5" />
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

// ── message actions ─────────────────────────────────────────────────

function RetryGlyph() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" />
    </svg>
  );
}

function ThumbGlyph({ down }: { down?: boolean }) {
  return (
    <svg className={cx("h-3.5 w-3.5", down && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2.5 2.5 0 0 1 2.5 2.8L13 10h6.3a2 2 0 0 1 2 2.4l-1.4 7a2 2 0 0 1-2 1.6H7" />
    </svg>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  pressed,
  children
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cx(
        "flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep disabled:cursor-not-allowed disabled:opacity-40",
        pressed
          ? "bg-bloop/20 text-bloop-deep"
          : "text-neutral-400 enabled:hover:bg-neutral-200/60 enabled:hover:text-bloop-deep"
      )}
    >
      {children}
    </button>
  );
}

const FEEDBACK_REASONS = ["wrong", "didn't finish", "unsafe action", "other"];

/** consumes ChatActions itself so bubbles don't re-render when streaming flips */
function AssistantActions({ text, isLast }: { text: string; isLast: boolean }) {
  const { regenerate, streaming } = useContext(ChatActions);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const reveal = isLast || vote != null;
  return (
    <div className="mt-1">
      <div
        className={cx(
          "-ml-1.5 flex h-7 items-center gap-0.5 transition-opacity duration-150",
          reveal
            ? "opacity-100"
            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        )}
      >
        {text && <CopyButton text={text} label="copy reply" size="md" />}
        {isLast && (
          <ActionButton label="regenerate reply" onClick={regenerate} disabled={streaming}>
            <RetryGlyph />
          </ActionButton>
        )}
        <ActionButton
          label="good reply"
          pressed={vote === "up"}
          onClick={() => {
            setVote((v) => (v === "up" ? null : "up"));
            setReason(null);
          }}
        >
          <ThumbGlyph />
        </ActionButton>
        <ActionButton
          label="bad reply"
          pressed={vote === "down"}
          onClick={() => {
            setVote((v) => (v === "down" ? null : "down"));
            setReason(null);
          }}
        >
          <ThumbGlyph down />
        </ActionButton>
        {vote === "up" && <span className="ml-1 text-[11px] text-neutral-400">thanks</span>}
      </div>
      {vote === "down" &&
        (reason ? (
          <p className="mt-1 text-[11px] text-neutral-400">thanks — noted: {reason}</p>
        ) : (
          <div role="group" aria-label="what went wrong" className="motion-safe:tool-in mt-1 flex flex-wrap gap-1.5">
            {FEEDBACK_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors duration-150 hover:border-bloop hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep"
              >
                {r}
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

function UserActions({ text, onEdit }: { text: string; onEdit: () => void }) {
  const { streaming } = useContext(ChatActions);
  return (
    <div className="mt-1 flex h-7 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      <ActionButton label="edit message" onClick={onEdit} disabled={streaming}>
        <PencilIcon className="h-3.5 w-3.5" />
      </ActionButton>
      <CopyButton text={text} label="copy message" size="md" />
    </div>
  );
}

function EditBox({ initial, onCancel }: { initial: string; onCancel: () => void; }) {
  const { edit, streaming } = useContext(ChatActions);
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [value]);
  useEffect(() => {
    const ta = ref.current;
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  const messageIdRef = useContext(EditTarget);
  const submit = () => {
    const t = value.trim();
    if (!t || streaming) return;
    edit(messageIdRef, t);
    onCancel();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="mb-5 ml-auto w-full max-w-[88%] sm:max-w-[75%]">
      <label className="sr-only" htmlFor={`edit-${messageIdRef}`}>
        edit message
      </label>
      <textarea
        id={`edit-${messageIdRef}`}
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        className="block w-full resize-none border border-bloop-deep bg-white px-3.5 py-2.5 text-base leading-relaxed text-neutral-800 focus:outline-none focus:ring-2 focus:ring-bloop/40 sm:text-sm"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-[10px] text-neutral-400">
          sending replaces the replies after this message
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-3.5 py-1.5 text-xs font-semibold text-neutral-600 transition-colors duration-150 hover:bg-neutral-200/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim() || streaming}
          className="rounded-full bg-bloop px-3.5 py-1.5 text-xs font-bold text-neutral-900 transition-colors duration-150 enabled:hover:bg-bloop-deep enabled:hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep disabled:opacity-40"
        >
          send
        </button>
      </div>
    </div>
  );
}

/** id of the user message being edited (keeps EditBox props minimal) */
const EditTarget = createContext("");

// ── attachments on user turns ───────────────────────────────────────

type AttachmentPart = Extract<MessagePart, { kind: "attachment" }>;

const fmtSize = (n: number) =>
  n < 1024 ? `${n} b` : n < 1048576 ? `${Math.round(n / 1024)} kb` : `${(n / 1048576).toFixed(1)} mb`;

function FileGlyph({ folder }: { folder?: boolean }) {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {folder ? (
        <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z" />
      ) : (
        <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5" />
      )}
    </svg>
  );
}

/** image thumbnails, file chips, folders collapsed to "folder · N files" */
function AttachmentChips({ files }: { files: AttachmentPart[] }) {
  const items = useMemo(() => {
    const folders = new Map<string, AttachmentPart[]>();
    const loose: AttachmentPart[] = [];
    for (const f of files) {
      const rel = f.path.replace(/^uploads\//, "");
      if (rel.includes("/")) {
        const dir = rel.split("/")[0];
        folders.set(dir, [...(folders.get(dir) ?? []), f]);
      } else loose.push(f);
    }
    return { folders: [...folders.entries()], loose };
  }, [files]);

  const chip =
    "flex h-12 max-w-[14rem] items-center gap-2 border border-neutral-200 bg-white px-2.5 text-left";
  return (
    <ul aria-label="attachments" className="mb-1.5 flex max-w-[88%] flex-wrap justify-end gap-1.5 sm:max-w-[75%]">
      {items.loose.map((f) => {
        const name = f.path.split("/").pop() || f.path;
        const image = /^image\/(png|jpe?g|webp|gif)$/i.test(f.mime) && f.url;
        return (
          <li key={f.id}>
            {image ? (
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`open ${name}`}
                className="block border border-neutral-200 bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
              >
                <img src={f.url} alt={name} loading="lazy" decoding="async" className="h-20 w-20 object-cover" />
              </a>
            ) : (
              <span className={chip} title={f.path}>
                <span className="text-bloop-deep">
                  <FileGlyph />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium normal-case text-neutral-800">{name}</span>
                  <span className="block text-[10px] text-neutral-400">{fmtSize(f.bytes)}</span>
                </span>
              </span>
            )}
          </li>
        );
      })}
      {items.folders.map(([dir, list]) => (
        <li key={`dir-${dir}`}>
          <span className={chip} title={list.map((f) => f.path).join("\n")}>
            <span className="text-bloop-deep">
              <FileGlyph folder />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium normal-case text-neutral-800">{dir}</span>
              <span className="block text-[10px] text-neutral-400">
                folder · {list.length} {list.length === 1 ? "file" : "files"} ·{" "}
                {fmtSize(list.reduce((a, f) => a + f.bytes, 0))}
              </span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── bubbles ─────────────────────────────────────────────────────────

/** trailing sharp lime caret while the answer streams (no per-token fades) */
const CARET =
  "md [&>:last-child]:after:ml-0.5 [&>:last-child]:after:inline-block [&>:last-child]:after:h-[14px] [&>:last-child]:after:w-[7px] [&>:last-child]:after:translate-y-[2px] [&>:last-child]:after:bg-bloop [&>:last-child]:after:content-[''] motion-safe:[&>:last-child]:after:animate-pulse";

function VisiblePart({
  part,
  message,
  caret
}: {
  part: MessagePart;
  message: ChatMessage;
  caret: boolean;
}) {
  switch (part.kind) {
    case "text":
      return <MarkdownText text={part.text} className={caret ? CARET : "md"} />;
    case "image":
      return <ImagePart url={part.url} prompt={part.prompt} />;
    case "handoff":
      return <HandoffCard url={part.url} reason={part.reason} />;
    case "mcp_app":
      return <McpAppFrame app={part} call={message.tools[part.id]} />;
    default:
      return null;
  }
}

/**
 * Memoized on props. The streaming reducer keeps object identity for every
 * untouched message, so a delta re-renders only the live bubble — and inside
 * it only the parts that changed (cards and MarkdownText are memoized).
 */
const MessageBubble = memo(function MessageBubble({
  message,
  live,
  isLast,
  editing,
  onEditStart,
  onEditEnd
}: {
  message: ChatMessage;
  live: boolean;
  isLast: boolean;
  editing: boolean;
  onEditStart: (id: string) => void;
  onEditEnd: () => void;
}) {
  const animate = !message.loaded;
  const blocks = useMemo(
    () => (message.role === "assistant" ? toBlocks(message.parts) : []),
    [message.role, message.parts]
  );

  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    const files = message.parts.filter(
      (p): p is Extract<MessagePart, { kind: "attachment" }> => p.kind === "attachment"
    );
    if (editing) {
      return (
        <EditTarget.Provider value={message.id}>
          <EditBox initial={text} onCancel={onEditEnd} />
        </EditTarget.Provider>
      );
    }
    return (
      <div className={cx("group mb-3 flex flex-col items-end", animate && "motion-safe:tool-in")}>
        {files.length > 0 && <AttachmentChips files={files} />}
        {text && (
          <div className="max-w-[88%] whitespace-pre-wrap bg-bloop-deep px-4 py-2.5 text-sm leading-relaxed text-white [overflow-wrap:anywhere] sm:max-w-[75%]">
            {text}
          </div>
        )}
        <UserActions text={text} onEdit={() => onEditStart(message.id)} />
      </div>
    );
  }

  const servers = message.servers ? Object.values(message.servers) : [];
  const waitingForFirstToken = live && message.parts.length === 0;
  const answer = blocks
    .map((b) => (b.kind === "part" && b.part.kind === "text" ? b.part.text : ""))
    .filter(Boolean)
    .join("\n\n");

  return (
    <MessageSources.Provider value={message.sources}>
      <article className="group mb-6 min-w-0" aria-label="bloop reply">
        {waitingForFirstToken && <ServerChips servers={servers} />}
        {blocks.map((b, i) =>
          b.kind === "timeline" ? (
            <StepTimeline
              key={b.key}
              steps={b.steps}
              message={message}
              live={live}
              animate={animate}
              continued={i < blocks.length - 1}
            />
          ) : (
            <VisiblePart
              key={b.key}
              part={b.part}
              message={message}
              caret={live && i === blocks.length - 1 && b.part.kind === "text"}
            />
          )
        )}
        {message.sources && message.sources.length > 0 && <SourcesRow items={message.sources} />}
        {message.error && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 border border-red-200 border-l-2 border-l-red-500 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{message.error}</span>
          </div>
        )}
        {!live && (answer || message.error || isLast) && (
          <AssistantActions text={answer} isLast={isLast} />
        )}
      </article>
    </MessageSources.Provider>
  );
});
