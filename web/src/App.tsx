import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { AuthScreen } from "./components/AuthScreen";
import { Header, type HealthState } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ProofTrace } from "./components/ProofTrace";
import { Sidebar } from "./components/Sidebar";
import { MarketplaceModal } from "./components/MarketplaceModal";
import { MemoriesModal } from "./components/MemoriesModal";
import { fetchHealth, streamChat, type ServerEvent } from "./sse";
import { BlobIcon } from "./icons";
import { cx } from "./lib";
import type {
  ApiMessage,
  ChatMessage,
  CodeEvent,
  ConversationMeta,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  FileEvent,
  ImageEvent,
  MemoryEvent,
  ModelInfo,
  PlanEvent,
  PlanStep,
  ToolCallEvent,
  ToolResultEvent,
  ToolsLoadedEvent,
  TraceItem,
  User,
  VerifyEntry,
  VerifyEvent
} from "./types";

let seq = 0;
const nextSeq = () => ++seq;
const uid = () => `m-${Date.now().toString(36)}-${++seq}`;
const isDesktop = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(min-width: 1024px)").matches;

export default function App() {
  const [phase, setPhase] = useState<"loading" | "auth" | "ready">("loading");
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("auth");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-bloop">
        <div className="flex flex-col items-center gap-3">
          <BlobIcon className="h-12 w-12 motion-safe:animate-pulse" />
          <span className="font-wordmark text-2xl font-bold text-white">
            bloop
          </span>
        </div>
      </div>
    );
  }

  if (phase === "auth" || !user) {
    return (
      <AuthScreen
        onAuthed={(u) => {
          setUser(u);
          setPhase("ready");
        }}
      />
    );
  }

  return (
    <ChatApp
      user={user}
      onSignedOut={() => {
        setUser(null);
        setPhase("auth");
      }}
    />
  );
}

function ChatApp({
  user,
  onSignedOut
}: {
  user: User;
  onSignedOut: () => void;
}) {
  const [convos, setConvos] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [verifies, setVerifies] = useState<VerifyEntry[]>([]);
  const [extras, setExtras] = useState<TraceItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [traceOpen, setTraceOpen] = useState(isDesktop);
  const [sidebarOpen, setSidebarOpen] = useState(isDesktop);
  const [modal, setModal] = useState<"market" | "memories" | null>(null);
  const [memTick, setMemTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // ── bootstrap: conversations + models ──────────────────────────
  useEffect(() => {
    api
      .listConversations()
      .then(setConvos)
      .catch(() => {});
    api
      .listModels()
      .then((ms) => {
        setModels(ms);
        const d = ms.find((m) => m.default) ?? ms[0];
        if (d) setModel((prev) => prev || d.id);
      })
      .catch(() => {});
  }, []);

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

      case "image": {
        const d = evt.data as ImageEvent;
        if (!d || typeof d.url !== "string") break;
        setMessages((msgs) =>
          msgs.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  parts: [
                    ...m.parts,
                    { kind: "image" as const, id: uid(), url: d.url, prompt: d.prompt }
                  ]
                }
              : m
          )
        );
        setExtras((x) => [
          ...x,
          { kind: "image", seq: nextSeq(), image: { url: d.url, prompt: d.prompt } }
        ]);
        break;
      }

      case "code": {
        const d = evt.data as CodeEvent;
        if (!d || typeof d.source !== "string") break;
        const code = {
          language: d.language ?? "",
          source: d.source,
          output: d.output,
          ok: d.ok
        };
        setMessages((msgs) =>
          msgs.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  parts: [...m.parts, { kind: "code" as const, id: uid(), ...code }]
                }
              : m
          )
        );
        setExtras((x) => [...x, { kind: "code", seq: nextSeq(), code }]);
        break;
      }

      case "memory": {
        const d = evt.data as MemoryEvent;
        if (!d || typeof d.content !== "string") break;
        setExtras((x) => [...x, { kind: "memory", seq: nextSeq(), memory: d }]);
        setMemTick((t) => t + 1);
        break;
      }

      case "file": {
        const d = evt.data as FileEvent;
        if (!d || typeof d.kind !== "string") break;
        setExtras((x) => [...x, { kind: "file", seq: nextSeq(), file: d }]);
        setMemTick((t) => t + 1);
        break;
      }

      case "tools_loaded": {
        const d = evt.data as ToolsLoadedEvent;
        if (!d || !Array.isArray(d.names)) break;
        setExtras((x) => [...x, { kind: "tools", seq: nextSeq(), names: d.names }]);
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

      case "done": {
        const d = evt.data as DoneEvent;
        if (d && typeof d === "object" && d.conversation_id) {
          setActiveId(d.conversation_id);
        }
        break;
      }

      default:
        break;
    }
  }, []);

  // ── send ────────────────────────────────────────────────────────
  const send = useCallback(
    (text: string) => {
      if (streaming) return;
      void (async () => {
        let cid = activeId;
        if (!cid) {
          try {
            const c = await api.createConversation();
            cid = c.id;
            setActiveId(cid);
            setActiveTitle(c.title || "new chat");
            setConvos((cs) => [
              {
                id: c.id,
                title: c.title || "new chat",
                updated_at: new Date().toISOString()
              },
              ...cs
            ]);
          } catch {
            setMessages((m) => [
              ...m,
              {
                id: uid(),
                role: "user" as const,
                parts: [{ kind: "text" as const, id: uid(), text }],
                tools: {}
              },
              {
                id: uid(),
                role: "assistant" as const,
                parts: [],
                tools: {},
                error: "could not start a conversation."
              }
            ]);
            return;
          }
        }
        if (!cid) return;

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
        setMessages((m) => [...m, userMsg, assistantMsg]);
        setPlan([]);
        setVerifies([]);
        setExtras([]);
        setStreaming(true);

        const controller = new AbortController();
        abortRef.current = controller;
        const convoId = cid;

        try {
          await streamChat(
            { conversation_id: convoId, message: text, model },
            {
              signal: controller.signal,
              onEvent: (evt) => handleEvent(assistantMsg.id, evt)
            }
          );
        } catch (err: unknown) {
          if (!controller.signal.aborted) {
            const message =
              err instanceof Error ? err.message : "connection failed";
            setMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantMsg.id ? { ...m, error: message } : m
              )
            );
          }
        } finally {
          abortRef.current = null;
          setStreaming(false);
          // the backend may have auto-titled the conversation
          void api
            .listConversations()
            .then((cs) => {
              setConvos(cs);
              const me = cs.find((c) => c.id === convoId);
              if (me?.title) setActiveTitle(me.title);
            })
            .catch(() => {});
        }
      })();
    },
    [activeId, messages, streaming, model, handleEvent]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── conversations ───────────────────────────────────────────────
  const newChat = useCallback(() => {
    setActiveId(null);
    setActiveTitle("");
    setMessages([]);
    setPlan([]);
    setVerifies([]);
    setExtras([]);
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      if (id === activeId) {
        if (!isDesktop()) setSidebarOpen(false);
        return;
      }
      setActiveId(id);
      if (!isDesktop()) setSidebarOpen(false);
      void (async () => {
        try {
          const d = await api.getConversation(id);
          setActiveTitle(d.title || "untitled");
          if (d.model) setModel(d.model);
          setMessages(d.messages.map((m, i) => fromApiMessage(m, i)));
          setPlan([]);
          setVerifies([]);
          setExtras([]);
        } catch {
          setMessages([]);
          setActiveTitle("unavailable");
        }
      })();
    },
    [activeId]
  );

  const removeConversation = useCallback(
    (id: string) => {
      void api.deleteConversation(id).catch(() => {});
      setConvos((cs) => cs.filter((c) => c.id !== id));
      if (id === activeId) newChat();
    },
    [activeId, newChat]
  );

  const renameActive = useCallback(
    (title: string) => {
      if (!activeId) return;
      const id = activeId;
      setActiveTitle(title);
      setConvos((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
      void api.renameConversation(id, title).catch(() => {});
    },
    [activeId]
  );

  const signOut = useCallback(() => {
    void api.logout().catch(() => {});
    onSignedOut();
  }, [onSignedOut]);

  // ── derived trace (chronological across messages + verifies + extras) ──
  const trace: TraceItem[] = [
    ...messages
      .filter((m) => !m.loaded)
      .flatMap((m) =>
        Object.values(m.tools).map(
          (call): TraceItem => ({ kind: "tool", seq: call.seq, call })
        )
      ),
    ...verifies.map(
      (entry): TraceItem => ({ kind: "verify", seq: entry.seq, entry })
    ),
    ...extras
  ].sort((a, b) => a.seq - b.seq);

  return (
    <div className="flex h-full">
      <Sidebar
        user={user}
        conversations={convos}
        activeId={activeId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={newChat}
        onSelect={openConversation}
        onDelete={removeConversation}
        onOpenMarketplace={() => setModal("market")}
        onOpenMemories={() => setModal("memories")}
        onLogout={signOut}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          health={health}
          title={activeTitle}
          canRename={activeId != null}
          onRename={renameActive}
          models={models}
          model={model}
          onModelChange={setModel}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          traceOpen={traceOpen}
          onToggleTrace={() => setTraceOpen((o) => !o)}
        />

        {health.status === "down" && (
          <div
            role="status"
            className="shrink-0 bg-neutral-900 px-4 py-1.5 text-center text-[11px] font-medium text-white"
          >
            bloop is offline — retrying every 30s
          </div>
        )}

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

          {/* mobile trace backdrop */}
          {traceOpen && (
            <div
              className="fixed inset-0 z-30 bg-neutral-900/30 lg:hidden"
              onClick={() => setTraceOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* proof trace sidebar */}
          <aside
            className={cx(
              "z-40 w-80 shrink-0 border-l border-neutral-200 bg-white",
              "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:transition-transform max-lg:motion-safe:duration-200",
              !traceOpen &&
                "max-lg:invisible max-lg:translate-x-full lg:hidden"
            )}
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

      {modal === "market" && (
        <MarketplaceModal
          onClose={() => setModal(null)}
          onChanged={() => {
            void fetchHealth()
              .then((h) =>
                setHealth({
                  status: "ok",
                  model: h.model,
                  servers: Array.isArray(h.servers) ? h.servers.length : 0
                })
              )
              .catch(() => {});
          }}
        />
      )}
      {modal === "memories" && (
        <MemoriesModal onClose={() => setModal(null)} tick={memTick} />
      )}
    </div>
  );
}

/** Tolerantly map a stored API message into UI state. */
function fromApiMessage(m: ApiMessage, idx: number): ChatMessage {
  const msg: ChatMessage = {
    id: `h-${idx}-${uid()}`,
    role: m.role === "user" ? "user" : "assistant",
    parts: [],
    tools: {},
    loaded: true
  };
  if (Array.isArray(m.parts)) {
    for (const raw of m.parts) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      if (p.kind === "text" && typeof p.text === "string") {
        msg.parts.push({ kind: "text", id: uid(), text: p.text });
      } else if (p.kind === "image" && typeof p.url === "string") {
        msg.parts.push({
          kind: "image",
          id: uid(),
          url: p.url,
          prompt: typeof p.prompt === "string" ? p.prompt : undefined
        });
      } else if (p.kind === "code" && typeof p.source === "string") {
        msg.parts.push({
          kind: "code",
          id: uid(),
          language: typeof p.language === "string" ? p.language : "",
          source: p.source,
          output: typeof p.output === "string" ? p.output : undefined,
          ok: typeof p.ok === "boolean" ? p.ok : undefined
        });
      } else if (p.kind === "tool") {
        const id = typeof p.id === "string" ? p.id : uid();
        msg.tools[id] = {
          id,
          name: typeof p.name === "string" ? p.name : "tool",
          app: typeof p.app === "string" ? p.app : "",
          args: p.args,
          status: p.ok === false ? "error" : "ok",
          ms: typeof p.ms === "number" ? p.ms : undefined,
          output: typeof p.output === "string" ? p.output : undefined,
          seq: 0
        };
        msg.parts.push({ kind: "tool", id });
      }
    }
  }
  if (msg.parts.length === 0 && m.content) {
    msg.parts.push({ kind: "text", id: uid(), text: m.content });
  }
  return msg;
}
