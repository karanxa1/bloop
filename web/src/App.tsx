import { useCallback, useEffect, useRef, useState } from "react";
import { Header, type HealthState } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ProofTrace } from "./components/ProofTrace";
import { fetchHealth, streamChat, type ServerEvent } from "./sse";
import type {
  ApiMessage,
  ChatMessage,
  DeltaEvent,
  ErrorEvent,
  PlanEvent,
  PlanStep,
  ToolCallEvent,
  ToolResultEvent,
  TraceItem,
  VerifyEntry,
  VerifyEvent
} from "./types";

let seq = 0;
const nextSeq = () => ++seq;
const uid = () => `m-${Date.now().toString(36)}-${++seq}`;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [verifies, setVerifies] = useState<VerifyEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [traceOpen, setTraceOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ── health check ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetchHealth()
        .then((h) => {
          if (cancelled) return;
          setHealth({
            status: "ok",
            model: h.model,
            servers: Array.isArray(h.servers) ? h.servers.length : 0
          });
        })
        .catch(() => {
          if (!cancelled) setHealth({ status: "down" });
        });
    };
    check();
    const t = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // ── SSE event dispatch ──────────────────────────────────────────
  const handleEvent = useCallback((assistantId: string, evt: ServerEvent) => {
    switch (evt.type) {
      case "delta": {
        const { text } = evt.data as DeltaEvent;
        if (!text) break;
        setMessages((msgs) =>
          msgs.map((m) => {
            if (m.id !== assistantId) return m;
            const parts = [...m.parts];
            const last = parts[parts.length - 1];
            if (last && last.kind === "text") {
              parts[parts.length - 1] = { ...last, text: last.text + text };
            } else {
              parts.push({ kind: "text", id: uid(), text });
            }
            return { ...m, parts };
          })
        );
        break;
      }

      case "tool_call": {
        const d = evt.data as ToolCallEvent;
        setMessages((msgs) =>
          msgs.map((m) => {
            if (m.id !== assistantId) return m;
            return {
              ...m,
              parts: [...m.parts, { kind: "tool" as const, id: d.id }],
              tools: {
                ...m.tools,
                [d.id]: {
                  id: d.id,
                  name: d.name,
                  app: d.app ?? "",
                  args: d.args,
                  status: "running" as const,
                  seq: nextSeq()
                }
              }
            };
          })
        );
        break;
      }

      case "tool_result": {
        const d = evt.data as ToolResultEvent;
        setMessages((msgs) =>
          msgs.map((m) => {
            const existing = m.tools[d.id];
            if (!existing) return m;
            return {
              ...m,
              tools: {
                ...m.tools,
                [d.id]: {
                  ...existing,
                  name: d.name ?? existing.name,
                  app: d.app ?? existing.app,
                  status: d.ok ? ("ok" as const) : ("error" as const),
                  ms: d.ms,
                  output: d.output
                }
              }
            };
          })
        );
        break;
      }

      case "plan": {
        const d = evt.data as PlanEvent;
        if (Array.isArray(d.steps)) setPlan(d.steps);
        break;
      }

      case "verify": {
        const d = evt.data as VerifyEvent;
        setVerifies((v) => [
          ...v,
          {
            claim: d.claim,
            evidence: d.evidence,
            app: d.app,
            hash: d.hash ?? "",
            seq: nextSeq()
          }
        ]);
        break;
      }

      case "error": {
        const d = evt.data as ErrorEvent;
        setMessages((msgs) =>
          msgs.map((m) =>
            m.id === assistantId
              ? { ...m, error: d.message ?? "unknown error" }
              : m
          )
        );
        break;
      }

      case "done":
      default:
        break;
    }
  }, []);

  // ── send ────────────────────────────────────────────────────────
  const send = useCallback(
    (text: string) => {
      if (streaming) return;
      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        parts: [{ kind: "text", id: uid(), text }],
        tools: {}
      };
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: "assistant",
        parts: [],
        tools: {}
      };
      const history: ApiMessage[] = [
        ...messages.map(toApiMessage),
        { role: "user", content: text }
      ];
      setMessages((m) => [...m, userMsg, assistantMsg]);
      setPlan([]);
      setVerifies([]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      streamChat(history, {
        signal: controller.signal,
        onEvent: (evt) => handleEvent(assistantMsg.id, evt)
      })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            err instanceof Error ? err.message : "connection failed";
          setMessages((msgs) =>
            msgs.map((m) =>
              m.id === assistantMsg.id ? { ...m, error: message } : m
            )
          );
        })
        .finally(() => {
          abortRef.current = null;
          setStreaming(false);
        });
    },
    [messages, streaming, handleEvent]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── derived trace (chronological across messages + verifies) ────
  const trace: TraceItem[] = [
    ...messages.flatMap((m) =>
      Object.values(m.tools).map(
        (call): TraceItem => ({ kind: "tool", seq: call.seq, call })
      )
    ),
    ...verifies.map(
      (entry): TraceItem => ({ kind: "verify", seq: entry.seq, entry })
    )
  ].sort((a, b) => a.seq - b.seq);

  return (
    <div className="flex h-full flex-col">
      <Header
        health={health}
        onToggleTrace={() => setTraceOpen((o) => !o)}
        traceOpen={traceOpen}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* chat column */}
        <main className="flex min-w-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            streaming={streaming}
            onSuggestion={send}
          />
          <Composer streaming={streaming} onSend={send} onStop={stop} />
        </main>

        {/* mobile backdrop */}
        {traceOpen && (
          <div
            className="fixed inset-0 z-30 bg-neutral-900/30 lg:hidden"
            onClick={() => setTraceOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* proof trace sidebar */}
        <aside
          className={`w-80 shrink-0 border-l border-neutral-200 bg-white max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:shadow-xl max-lg:transition-transform max-lg:motion-safe:duration-200 ${
            traceOpen ? "max-lg:translate-x-0" : "max-lg:translate-x-full"
          }`}
          aria-label="proof trace"
        >
          <ProofTrace
            plan={plan}
            trace={trace}
            verifyCount={verifies.length}
            onClose={() => setTraceOpen(false)}
          />
        </aside>
      </div>
    </div>
  );
}

function toApiMessage(m: ChatMessage): ApiMessage {
  return {
    role: m.role,
    content: m.parts
      .filter((p) => p.kind === "text")
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("")
  };
}
