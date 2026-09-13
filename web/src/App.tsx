import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ComponentType, CSSProperties } from "react";
import type { WorkspaceEvent, WorkspaceSignal } from "./types/workspace";
import type { MarketTab } from "./types/marketplace";
import { flushSync } from "react-dom";
import * as api from "./api";
import { Header, type HealthState } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Composer, type SentAttachment } from "./components/Composer";
import { ProofTrace } from "./components/ProofTrace";
import { readSidebarPref, Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { Toaster, toast } from "./components/Toast";
import { preloadMarkdown } from "./components/MarkdownText";
import { ChatActions } from "./chatActions";
import { fetchHealth, streamChat, type ServerEvent } from "./sse";
import { BlobIcon } from "./icons";
import type { RunResult } from "./types/voice";
import { cleanSources, cx, withViewTransition } from "./lib";
import type {
  ApiMessage,
  ChatMessage,
  ChatMode,
  CodeEvent,
  ConversationMeta,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  FileEvent,
  HandoffEvent,
  ImageEvent,
  McpServerFrame,
  McpAppEvent,
  MemoryEvent,
  MessagePart,
  ModeEvent,
  SkillEvent,
  ThinkingEvent,
  ModelInfo,
  PlanEvent,
  PlanStep,
  SourceItem,
  SourcesEvent,
  Subagent,
  SubagentDeltaEvent,
  SubagentEndEvent,
  SubagentStartEvent,
  ToolCall,
  ToolCallEvent,
  ToolResultEvent,
  ToolsLoadedEvent,
  TraceItem,
  User,
  VerifyEntry,
  VerifyEvent
} from "./types";

// ── code-split, rarely-needed screens ──────────────────────────────
function ChunkFailed() {
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 border border-neutral-200 border-l-2 border-l-red-500 bg-white px-4 py-2 text-sm text-neutral-700 shadow-sm"
    >
      couldn&rsquo;t load this panel.
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-full bg-bloop px-3 py-1 text-xs font-bold text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        reload
      </button>
    </div>
  );
}

function lazyNamed<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try {
      return { default: await load() };
    } catch {
      return { default: ChunkFailed };
    }
  });
}

const loadMarketplace = () => import("./components/MarketplaceModal");
const loadMemories = () => import("./components/MemoriesModal");
const AuthScreen = lazyNamed(() =>
  import("./components/AuthScreen").then((m) => m.AuthScreen)
);
const MarketplaceModal = lazyNamed(() =>
  loadMarketplace().then((m) => m.MarketplaceModal)
);
const MemoriesModal = lazyNamed(() => loadMemories().then((m) => m.MemoriesModal));
const VoiceOrb = lazyNamed(() => import("./components/voice/VoiceOrb").then((m) => m.VoiceOrb));
const WorkspacePanel = lazyNamed(() =>
  import("./components/workspace/WorkspacePanel").then((m) => m.WorkspacePanel)
);

// ── helpers ────────────────────────────────────────────────────────
let seq = 0;
const nextSeq = () => ++seq;
const uid = () => `m-${Date.now().toString(36)}-${++seq}`;
const isDesktop = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(min-width: 1024px)").matches;

const MODES: readonly ChatMode[] = ["default", "think", "deep"];
const isMode = (v: unknown): v is ChatMode =>
  typeof v === "string" && (MODES as readonly string[]).includes(v);
const MODE_KEY = "bloop.mode";
const readStoredMode = (): ChatMode => {
  try {
    const v = window.sessionStorage.getItem(MODE_KEY);
    return isMode(v) ? v : "default";
  } catch {
    return "default";
  }
};

function appendText(parts: MessagePart[], text: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    const copy = parts.slice();
    copy[copy.length - 1] = { ...last, text: last.text + text };
    return copy;
  }
  return [...parts, { kind: "text", id: uid(), text }];
}

/** streamed reasoning summary — consecutive chunks merge into one thinking part */
function appendThinking(parts: MessagePart[], text: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === "thinking") {
    const copy = parts.slice();
    copy[copy.length - 1] = { ...last, text: last.text + text };
    return copy;
  }
  return [...parts, { kind: "thinking", id: uid(), text }];
}

/** update (or lazily create) a subagent on a message */
function updateSub(
  m: ChatMessage,
  id: string,
  fn: (a: Subagent) => Subagent
): ChatMessage {
  const existing = m.subagents?.[id];
  const base: Subagent = existing ?? { id, task: "", status: "running", parts: [] };
  return {
    ...m,
    parts: existing ? m.parts : [...m.parts, { kind: "subagent", id }],
    subagents: { ...m.subagents, [id]: fn(base) }
  };
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-bloop">
      <div className="flex flex-col items-center gap-3">
        <BlobIcon className="h-12 w-12 motion-safe:animate-pulse" />
        <span className="font-wordmark text-2xl font-bold text-white">bloop</span>
      </div>
    </div>
  );
}

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

  if (phase === "loading") return <Splash />;

  if (phase === "auth" || !user) {
    return (
      <Suspense fallback={<Splash />}>
        <AuthScreen
          onAuthed={(u) => {
            setUser(u);
            setPhase("ready");
          }}
        />
      </Suspense>
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

type PendingDelta = { assistantId: string; sub?: string; text: string; thinking?: boolean };

function ChatApp({
  user,
  onSignedOut
}: {
  user: User;
  onSignedOut: () => void;
}) {
  const [convos, setConvos] = useState<ConversationMeta[]>([]);
  const [convosStatus, setConvosStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [convoError, setConvoError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [verifies, setVerifies] = useState<VerifyEntry[]>([]);
  const [extras, setExtras] = useState<TraceItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<ChatMode>(readStoredMode);
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [traceOpen, setTraceOpen] = useState(isDesktop);
  const [sidebarOpen, setSidebarOpen] = useState(() => isDesktop() && readSidebarPref());
  const [modal, setModal] = useState<"market" | "memories" | null>(null);
  const [marketTab, setMarketTab] = useState<MarketTab>("apps");
  const [connectedId, setConnectedId] = useState<string | null>(null);
  // right aside: proof trace | workspace (panel mounts on first visit, then stays)
  const [asideTab, setAsideTab] = useState<"proof" | "files">("proof");
  const [filesSeen, setFilesSeen] = useState(false);
  const [wsEvent, setWsEvent] = useState<WorkspaceSignal | null>(null);
  const [wsUnseen, setWsUnseen] = useState(false);
  const [wsWidth, setWsWidth] = useState(640);
  const showAside = useCallback((t: "proof" | "files") => {
    setAsideTab(t);
    setWsUnseen(false);
    if (t === "files") setFilesSeen(true);
  }, []);
  const [memTick, setMemTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  /** assistant message id of the run whose events we still accept */
  const runRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const openSeqRef = useRef(0);
  const subTasks = useRef(new Map<string, string>());
  const lastCallAt = useRef(0);
  const lastStagger = useRef(0);
  // rAF-batched text deltas
  const pending = useRef(new Map<string, PendingDelta>());
  const rafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    activeIdRef.current = activeId;
    messagesRef.current = messages;
  });

  const changeMode = useCallback((m: ChatMode) => {
    setMode(m);
    try {
      window.sessionStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable — state still holds it */
    }
  }, []);

  // ── bootstrap: conversations + models + warm lazy chunks ───────
  const loadConvos = useCallback(() => {
    setConvosStatus((s) => (s === "ready" ? s : "loading"));
    api
      .listConversations()
      .then((cs) => {
        setConvos(cs);
        setConvosStatus("ready");
      })
      .catch(() => setConvosStatus((s) => (s === "ready" ? s : "error")));
  }, []);

  useEffect(() => {
    loadConvos();
    api
      .listModels()
      .then((ms) => {
        setModels(ms);
        const d = ms.find((m) => m.default) ?? ms[0];
        if (d) setModel((prev) => prev || d.id);
      })
      .catch(() => {});

    preloadMarkdown();
    const warm = () => {
      void loadMarketplace().catch(() => {});
      void loadMemories().catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const h = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(h);
    }
    const t = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(t);
  }, [loadConvos]);

  // ── health check ────────────────────────────────────────────────
  const refreshHealth = useCallback(() => {
    return fetchHealth()
      .then((h) => {
        const list = Array.isArray(h.servers) ? h.servers : [];
        const apps = list.flatMap((s) => {
          if (!s || typeof s !== "object") return [];
          const r = s as Record<string, unknown>;
          if (typeof r.name !== "string") return [];
          return [
            {
              name: r.name,
              state: typeof r.state === "string" ? r.state : "ok",
              tools: typeof r.tool_count === "number" ? r.tool_count : undefined,
              error: typeof r.error === "string" ? r.error : undefined
            }
          ];
        });
        setHealth({ status: "ok", model: h.model, servers: list.length, apps, checkedAt: Date.now() });
      })
      .catch(() => setHealth({ status: "down", checkedAt: Date.now() }));
  }, []);

  useEffect(() => {
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 30_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  // ── streaming text: coalesce deltas into one commit per frame ──
  const flushDeltas = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pending.current.size === 0) return;
    const batch = [...pending.current.values()];
    pending.current.clear();
    setMessages((msgs) =>
      msgs.map((m) => {
        let next = m;
        for (const b of batch) {
          if (b.assistantId !== m.id) continue;
          next = b.sub
            ? updateSub(next, b.sub, (a) => ({ ...a, parts: appendText(a.parts, b.text) }))
            : b.thinking
              ? { ...next, parts: appendThinking(next.parts, b.text) }
              : { ...next, parts: appendText(next.parts, b.text) };
        }
        return next;
      })
    );
  }, []);

  const queueDelta = useCallback(
    (assistantId: string, text: string, sub?: string, thinking = false) => {
      const key = `${assistantId}|${sub ?? ""}|${thinking ? "t" : ""}`;
      // thinking ↔ text switch inside one frame: commit the other kind first to keep order
      const otherKey = `${assistantId}|${sub ?? ""}|${thinking ? "" : "t"}`;
      if (pending.current.has(otherKey)) flushDeltas();
      const cur = pending.current.get(key);
      if (cur) cur.text += text;
      else pending.current.set(key, { assistantId, sub, text, thinking });
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          flushDeltas();
        });
      }
    },
    [flushDeltas]
  );

  // ── SSE event dispatch ──────────────────────────────────────────
  const handleEvent = useCallback(
    (assistantId: string, evt: ServerEvent) => {
      if (runRef.current !== assistantId) return; // stale run (switched away)

      if (evt.type === "delta") {
        const d = evt.data as DeltaEvent;
        if (d && typeof d.text === "string" && d.text) queueDelta(assistantId, d.text);
        return;
      }
      if (evt.type === "subagent_delta") {
        const d = evt.data as SubagentDeltaEvent;
        if (d && typeof d.id === "string" && typeof d.text === "string" && d.text)
          queueDelta(assistantId, d.text, d.id);
        return;
      }
      if (evt.type === "thinking") {
        const d = evt.data as ThinkingEvent;
        if (d && typeof d.text === "string" && d.text)
          queueDelta(assistantId, d.text, undefined, true);
        return;
      }

      // any structural event lands after the text that preceded it
      flushDeltas();
      const update = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((msgs) => msgs.map((m) => (m.id === assistantId ? fn(m) : m)));

      // proof-trace rows for skills, mcp apps and failing servers (additive; the switch still runs)
      {
        const d = evt.data as Record<string, unknown> | null;
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        if (d && evt.type === "skill" && str(d.name)) {
          const action = d.action === "create" || d.action === "update" ? d.action : "use";
          setExtras((x) => [...x, { kind: "skill", seq: nextSeq(), action, name: str(d.name) }]);
        } else if (d && evt.type === "mcp_app" && str(d.url)) {
          setExtras((x) => [
            ...x,
            { kind: "mcp_app", seq: nextSeq(), id: str(d.id), server: str(d.server), tool: str(d.tool), url: str(d.url) }
          ]);
        } else if (d && evt.type === "server" && str(d.name) && (d.state === "degraded" || d.state === "error")) {
          const name = str(d.name);
          const state = d.state === "degraded" ? "degraded" : "error";
          setExtras((x) => [...x, { kind: "server", seq: nextSeq(), name, state }]);
          setHealth((h) =>
            h.status === "ok" && h.apps
              ? { ...h, apps: h.apps.map((a) => (a.name === name ? { ...a, state } : a)) }
              : h
          );
        }
      }

      switch (evt.type) {
        case "mode": {
          const d = evt.data as ModeEvent;
          if (d && isMode(d.mode)) {
            const next = d.mode;
            update((m) => ({ ...m, mode: next }));
          }
          break;
        }

        case "server": {
          const d = evt.data as McpServerFrame;
          if (!d || typeof d.name !== "string") break;
          const frame: McpServerFrame = {
            name: d.name,
            state: typeof d.state === "string" ? d.state : "connecting",
            tools: d.tools
          };
          update((m) => ({ ...m, servers: { ...m.servers, [frame.name]: frame } }));
          break;
        }

        case "tool_call": {
          const d = evt.data as ToolCallEvent;
          if (!d || typeof d.id !== "string") break;
          const now = Date.now();
          // calls arriving within 120ms of each other are a parallel burst
          const stagger = now - lastCallAt.current < 120 ? lastStagger.current + 1 : 0;
          lastCallAt.current = now;
          lastStagger.current = stagger;
          const call: ToolCall = {
            id: d.id,
            name: typeof d.name === "string" ? d.name : "tool",
            app: d.app ?? "",
            args: d.args,
            status: "running",
            seq: nextSeq(),
            parent: typeof d.parent === "string" ? d.parent : undefined,
            startedAt: now,
            stagger
          };
          update((m) => {
            const withTool = { ...m, tools: { ...m.tools, [call.id]: call } };
            if (call.parent) {
              return updateSub(withTool, call.parent, (a) => ({
                ...a,
                parts: [...a.parts, { kind: "tool", id: call.id }]
              }));
            }
            return { ...withTool, parts: [...m.parts, { kind: "tool", id: call.id }] };
          });
          break;
        }

        case "tool_result": {
          const d = evt.data as ToolResultEvent;
          if (!d || typeof d.id !== "string") break;
          update((m) => {
            const existing = m.tools[d.id];
            if (!existing) return m;
            const ms =
              typeof d.ms === "number"
                ? d.ms
                : existing.startedAt != null
                  ? Date.now() - existing.startedAt
                  : undefined;
            return {
              ...m,
              tools: {
                ...m.tools,
                [d.id]: {
                  ...existing,
                  name: d.name ?? existing.name,
                  app: d.app ?? existing.app,
                  status: d.ok ? "ok" : "error",
                  ms,
                  output: typeof d.output === "string" ? d.output : existing.output,
                  errorKind: d.ok ? undefined : (d.error_kind ?? existing.errorKind),
                  retries: typeof d.retries === "number" ? d.retries : existing.retries
                }
              }
            };
          });
          break;
        }

        case "image": {
          const d = evt.data as ImageEvent;
          if (!d || typeof d.url !== "string") break;
          const part: MessagePart = { kind: "image", id: uid(), url: d.url, prompt: d.prompt };
          const parent = typeof d.parent === "string" ? d.parent : undefined;
          update((m) =>
            parent
              ? updateSub(m, parent, (a) => ({ ...a, parts: [...a.parts, part] }))
              : { ...m, parts: [...m.parts, part] }
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
          const part: MessagePart = { kind: "code", id: uid(), ...code };
          const parent = typeof d.parent === "string" ? d.parent : undefined;
          update((m) =>
            parent
              ? updateSub(m, parent, (a) => ({ ...a, parts: [...a.parts, part] }))
              : { ...m, parts: [...m.parts, part] }
          );
          setExtras((x) => [...x, { kind: "code", seq: nextSeq(), code }]);
          break;
        }

        case "handoff": {
          const d = evt.data as HandoffEvent;
          if (!d || typeof d.url !== "string") break;
          const reason = typeof d.reason === "string" ? d.reason : "";
          const part: MessagePart = {
            kind: "handoff",
            id: uid(),
            url: d.url,
            reason,
            sessionId: typeof d.session_id === "string" ? d.session_id : undefined,
            externalUrl: typeof d.external_url === "string" ? d.external_url : undefined
          };
          update((m) => ({ ...m, parts: [...m.parts, part] }));
          setExtras((x) => [
            ...x,
            { kind: "handoff", seq: nextSeq(), handoff: { url: d.url, reason } }
          ]);
          break;
        }

        case "subagent_start": {
          const d = evt.data as SubagentStartEvent;
          if (!d || typeof d.id !== "string") break;
          const task = typeof d.task === "string" ? d.task : "";
          subTasks.current.set(d.id, task);
          update((m) =>
            updateSub(m, d.id, (a) => ({ ...a, task: task || a.task, status: "running" }))
          );
          setExtras((x) => [
            ...x,
            { kind: "subagent", seq: nextSeq(), phase: "start", id: d.id, task }
          ]);
          break;
        }

        case "subagent_end": {
          const d = evt.data as SubagentEndEvent;
          if (!d || typeof d.id !== "string") break;
          const summary = typeof d.summary === "string" ? d.summary : undefined;
          update((m) =>
            updateSub(m, d.id, (a) => ({
              ...a,
              status: d.ok ? "ok" : "error",
              summary
            }))
          );
          setExtras((x) => [
            ...x,
            {
              kind: "subagent",
              seq: nextSeq(),
              phase: "end",
              id: d.id,
              task: subTasks.current.get(d.id) ?? "",
              ok: d.ok !== false,
              summary
            }
          ]);
          break;
        }

        case "sources": {
          const d = evt.data as SourcesEvent;
          if (!d) break;
          const items = cleanSources(d.items); // cumulative — replace
          update((m) => ({ ...m, sources: items }));
          setSources(items);
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
          if (d && Array.isArray(d.steps)) setPlan(d.steps);
          break;
        }

        case "verify": {
          const d = evt.data as VerifyEvent;
          if (!d) break;
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
          update((m) => ({ ...m, error: d?.message ?? "unknown error" }));
          break;
        }

        case "skill": {
          const d = evt.data as SkillEvent | null;
          if (!d || typeof d.name !== "string" || !d.name) break;
          const action = d.action === "create" || d.action === "update" ? d.action : "use";
          const part: MessagePart = { kind: "skill", id: uid(), action, name: d.name };
          update((m) => ({ ...m, parts: [...m.parts, part] }));
          break;
        }

        case "mcp_app": {
          const d = evt.data as McpAppEvent | null;
          if (!d || typeof d.id !== "string" || typeof d.url !== "string") break;
          const part: MessagePart = {
            kind: "mcp_app",
            id: d.id,
            server: typeof d.server === "string" ? d.server : "",
            tool: typeof d.tool === "string" ? d.tool : "",
            uri: typeof d.uri === "string" ? d.uri : "",
            url: d.url
          };
          update((m) =>
            m.parts.some((p) => p.kind === "mcp_app" && p.id === part.id)
              ? m
              : { ...m, parts: [...m.parts, part] }
          );
          break;
        }

        case "workspace": {
          const d = evt.data as Partial<WorkspaceEvent> | null;
          if (!d || typeof d.action !== "string") break;
          setWsEvent({
            action: d.action,
            paths: Array.isArray(d.paths)
              ? d.paths.filter((p): p is string => typeof p === "string")
              : [],
            command: typeof d.command === "string" ? d.command : undefined,
            exit_code: typeof d.exit_code === "number" ? d.exit_code : undefined,
            seq: nextSeq()
          });
          setWsUnseen(true);
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
    },
    [flushDeltas, queueDelta]
  );

  // ── send ────────────────────────────────────────────────────────
  /** active conversation id, creating one on first use (first send or first upload) */
  const creatingRef = useRef<Promise<string | null> | null>(null);
  const ensureConversation = useCallback((): Promise<string | null> => {
    if (activeIdRef.current) return Promise.resolve(activeIdRef.current);
    if (!creatingRef.current) {
      creatingRef.current = api
        .createConversation()
        .then((c) => {
          activeIdRef.current = c.id;
          setActiveId(c.id);
          setActiveTitle(c.title || "new chat");
          setConvos((cs) => [
            { id: c.id, title: c.title || "new chat", updated_at: new Date().toISOString() },
            ...cs
          ]);
          return c.id;
        })
        .catch(() => null)
        .finally(() => {
          creatingRef.current = null;
        });
    }
    return creatingRef.current;
  }, []);

  const send = useCallback(
    (text: string, attachments?: SentAttachment[]) => {
      if (streamingRef.current) return;
      streamingRef.current = true; // synchronous guard against double submits
      void (async () => {
        const cid = await ensureConversation();
        if (!cid) {
          {
            streamingRef.current = false;
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
                error: "could not start a conversation — check your connection and try again."
              }
            ]);
            return;
          }
        }

        const userMsg: ChatMessage = {
          id: uid(),
          role: "user",
          parts: [
            ...(attachments ?? []).map(
              (a): MessagePart => ({
                kind: "attachment",
                id: uid(),
                path: a.path,
                mime: a.mime,
                bytes: a.bytes,
                url: a.url
              })
            ),
            { kind: "text", id: uid(), text }
          ],
          tools: {}
        };
        const assistantMsg: ChatMessage = {
          id: uid(),
          role: "assistant",
          parts: [],
          tools: {},
          mode
        };
        setMessages((m) => [...m, userMsg, assistantMsg]);
        setPlan([]);
        setVerifies([]);
        setExtras([]);
        setSources([]);
        setStreaming(true);

        const controller = new AbortController();
        abortRef.current = controller;
        runRef.current = assistantMsg.id;
        subTasks.current.clear();
        const convoId = cid;

        try {
          await streamChat(
            {
              conversation_id: convoId,
              message: text,
              model,
              mode,
              ...(attachments?.length
                ? { attachments: attachments.map(({ path, mime, bytes }) => ({ path, mime, bytes })) }
                : {})
            },
            {
              signal: controller.signal,
              onEvent: (evt) => handleEvent(assistantMsg.id, evt)
            }
          );
        } catch (err: unknown) {
          if (!controller.signal.aborted) {
            const message = err instanceof Error ? err.message : "connection failed";
            setMessages((msgs) =>
              msgs.map((m) => (m.id === assistantMsg.id ? { ...m, error: message } : m))
            );
          }
        } finally {
          if (runRef.current === assistantMsg.id) {
            flushDeltas();
            runRef.current = null;
          }
          if (abortRef.current === controller) abortRef.current = null;
          streamingRef.current = false;
          setStreaming(false);
          // the backend may have auto-titled the conversation
          void api
            .listConversations()
            .then((cs) => {
              setConvos(cs);
              setConvosStatus("ready");
              const me = cs.find((c) => c.id === convoId);
              if (me?.title && activeIdRef.current === convoId) setActiveTitle(me.title);
            })
            .catch(() => {});
        }
      })();
    },
    [model, mode, handleEvent, flushDeltas, ensureConversation]
  );

  // stable identity for memoized children
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  const sendStable = useCallback(
    (text: string, attachments?: SentAttachment[]) => sendRef.current(text, attachments),
    []
  );

  /** drop everything from a user turn onward and send it again (retry / edit & resend) */
  const resendFrom = useCallback((index: number, text: string) => {
    const msgs = messagesRef.current;
    const turn = msgs[index];
    if (!turn || turn.role !== "user" || streamingRef.current || !text.trim()) return;
    const attachments = turn.parts.flatMap((p) =>
      p.kind === "attachment" ? [{ path: p.path, mime: p.mime, bytes: p.bytes, url: p.url }] : []
    );
    setMessages(msgs.slice(0, index));
    sendRef.current(text, attachments.length ? attachments : undefined);
  }, []);
  const regenerate = useCallback(() => {
    const msgs = messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      const text = msgs[i].parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
      resendFrom(i, text);
      return;
    }
  }, [resendFrom]);
  const editMessage = useCallback(
    (id: string, text: string) => {
      const i = messagesRef.current.findIndex((m) => m.id === id);
      if (i >= 0) resendFrom(i, text);
    },
    [resendFrom]
  );

  // ── voice concierge: same send path as typing; resolves when the run's stream ends ──
  const voiceWait = useRef<{
    resolve: (r: RunResult) => void;
    lastId: string | undefined;
    started: boolean;
  } | null>(null);
  const voicePrompt = useCallback(
    (text: string, runMode?: ChatMode): Promise<RunResult> => {
      if (streamingRef.current || voiceWait.current) {
        return Promise.resolve({
          ok: false, text: "", tools: 0, verifications: 0, errors: 0,
          error: "bloop is already busy with another run — wait for it to finish"
        });
      }
      if (runMode && runMode !== mode) flushSync(() => changeMode(runMode)); // re-binds sendRef
      return new Promise<RunResult>((resolve) => {
        const msgs = messagesRef.current;
        voiceWait.current = { resolve, lastId: msgs[msgs.length - 1]?.id, started: false };
        sendRef.current(text);
      });
    },
    [mode, changeMode]
  );
  useEffect(() => {
    const w = voiceWait.current;
    if (!w) return;
    if (streaming) {
      w.started = true;
      return;
    }
    const last = messages[messages.length - 1];
    const fresh = last?.role === "assistant" && last.id !== w.lastId ? last : undefined;
    if (!w.started && !fresh?.error) return; // not started yet (conversation still being created)
    voiceWait.current = null;
    if (!fresh) {
      w.resolve({ ok: false, text: "", tools: 0, verifications: 0, errors: 0, error: "the run was interrupted" });
      return;
    }
    const lastNonText = fresh.parts.map((p) => p.kind).lastIndexOf("tool");
    const textOf = (from: number) =>
      fresh.parts.slice(from).map((p) => (p.kind === "text" ? p.text : "")).join("").trim();
    const calls = Object.values(fresh.tools);
    w.resolve({
      ok: !fresh.error,
      text: textOf(lastNonText + 1) || textOf(0),
      tools: calls.length,
      verifications: verifies.length,
      errors: calls.filter((c) => c.status === "error").length + (fresh.error ? 1 : 0),
      error: fresh.error
    });
  }, [streaming, messages, verifies]);
  const viewVoiceRun = useCallback(() => {
    showAside("proof");
    setTraceOpen(true);
  }, [showAside]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** drop the in-flight run (its events belong to the conversation we're leaving) */
  const detachRun = useCallback(() => {
    abortRef.current?.abort();
    runRef.current = null;
    pending.current.clear();
  }, []);

  // ── conversations ───────────────────────────────────────────────
  const newChat = useCallback(() => {
    detachRun();
    openSeqRef.current++;
    setLoadingId(null);
    if (!isDesktop()) setSidebarOpen(false);
    const apply = () => {
      setActiveId(null);
      setActiveTitle("");
      setMessages([]);
      setPlan([]);
      setVerifies([]);
      setExtras([]);
      setSources([]);
      setConvoError(null);
    };
    if (messagesRef.current.length === 0) apply();
    else withViewTransition(() => flushSync(apply));
    if (isDesktop()) requestAnimationFrame(() => document.getElementById("composer")?.focus());
  }, [detachRun]);

  const openConversation = useCallback(
    (id: string) => {
      if (!isDesktop()) setSidebarOpen(false);
      if (id === activeIdRef.current && !convoError) return;
      detachRun();
      const req = ++openSeqRef.current;
      setLoadingId(id);
      setConvoError(null);
      void (async () => {
        try {
          const d = await api.getConversation(id);
          if (req !== openSeqRef.current) return;
          const hydrated = d.messages.map((m, i) => fromApiMessage(m, i, id));
          withViewTransition(() =>
            flushSync(() => {
              if (req !== openSeqRef.current) return;
              setLoadingId(null);
              setActiveId(id);
              setActiveTitle(d.title || "untitled");
              if (d.model) setModel(d.model);
              setMessages(hydrated);
              setPlan([]);
              setVerifies([]);
              setExtras([]);
              setSources([]);
            })
          );
        } catch {
          if (req !== openSeqRef.current) return;
          setLoadingId(null);
          setActiveId(id);
          setMessages([]);
          setActiveTitle("unavailable");
          setConvoError("couldn’t load this conversation.");
        }
      })();
    },
    [convoError, detachRun]
  );

  const retryConversation = useCallback(() => {
    const id = activeIdRef.current;
    if (id) openConversation(id);
  }, [openConversation]);

  const removeConversation = useCallback(
    (id: string) => {
      void api.deleteConversation(id).catch(() => {
        toast({ kind: "error", message: "couldn’t delete that chat" });
        loadConvos();
      });
      setConvos((cs) => cs.filter((c) => c.id !== id));
      if (id === activeIdRef.current) newChat();
    },
    [newChat, loadConvos]
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
    detachRun();
    void api.logout().catch(() => {});
    onSignedOut();
  }, [onSignedOut, detachRun]);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
  const closeTrace = useCallback(() => setTraceOpen(false), []);
  const toggleTrace = useCallback(() => setTraceOpen((o) => !o), []);
  /** open the marketplace; pass "tools" | "skills" to deep-link (button event args are ignored) */
  const openMarket = useCallback((tab?: unknown) => {
    setMarketTab(tab === "tools" || tab === "skills" ? tab : "apps");
    setModal("market");
  }, []);
  const openMemories = useCallback(() => setModal("memories"), []);
  const closeModal = useCallback(() => {
    setModal(null);
    setConnectedId(null);
  }, []);
  const openSkills = useCallback(() => openMarket("skills"), [openMarket]);
  const renameConversation = useCallback(
    (id: string, title: string) => {
      if (id === activeIdRef.current) setActiveTitle(title);
      setConvos((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
      void api.renameConversation(id, title).catch(() => {
        toast({ kind: "error", message: "couldn’t rename that chat" });
        loadConvos();
      });
    },
    [loadConvos]
  );
  const toggleWorkspace = useCallback(() => {
    if (traceOpen && asideTab === "files") setTraceOpen(false);
    else {
      showAside("files");
      setTraceOpen(true);
    }
  }, [traceOpen, asideTab, showAside]);
  /** the palette never stacks on other overlays */
  const closeOverlays = useCallback(() => {
    closeModal();
    if (!isDesktop()) setSidebarOpen(false);
  }, [closeModal]);

  // oauth return (/app?connected=<server_id>): open the apps tab with a success banner, clean the url
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("connected");
    if (!id) return;
    params.delete("connected");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
    );
    setConnectedId(id);
    setMarketTab("apps");
    setModal("market");
    void refreshHealth();
  }, [refreshHealth]);

  // Esc closes the trace drawer on small screens
  useEffect(() => {
    if (!traceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDesktop() && !modal) setTraceOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [traceOpen, modal]);

  // ── derived trace (chronological across messages + verifies + extras) ──
  // Tool rows are cached per ToolCall object so unchanged calls keep identity
  // and the memoized ProofTrace skips re-rendering on text deltas.
  const toolRowCache = useRef(new WeakMap<ToolCall, TraceItem>());
  const trace = useMemo(() => {
    const cache = toolRowCache.current;
    const rows: TraceItem[] = [];
    for (const m of messages) {
      if (m.loaded) continue;
      for (const call of Object.values(m.tools)) {
        let row = cache.get(call);
        if (!row) {
          row = { kind: "tool", seq: call.seq, call };
          cache.set(call, row);
        }
        rows.push(row);
      }
    }
    for (const entry of verifies) rows.push({ kind: "verify", seq: entry.seq, entry });
    rows.push(...extras);
    return rows.sort((a, b) => a.seq - b.seq);
  }, [messages, verifies, extras]);

  const actions = useMemo(
    () => ({ send: sendStable, streaming, stop, regenerate, edit: editMessage }),
    [sendStable, streaming, stop, regenerate, editMessage]
  );

  return (
    <ChatActions.Provider value={actions}>
      <div className="flex h-full">
        <Sidebar
          user={user}
          conversations={convos}
          status={convosStatus}
          onRetry={loadConvos}
          activeId={activeId}
          loadingId={loadingId}
          open={sidebarOpen}
          onClose={closeSidebar}
          onNew={newChat}
          onSelect={openConversation}
          onDelete={removeConversation}
          onOpenMarketplace={openMarket}
          onOpenMemories={openMemories}
          onOpenSkills={openSkills}
          onRename={renameConversation}
          onToggle={toggleSidebar}
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
            onToggleSidebar={toggleSidebar}
            traceOpen={traceOpen}
            onToggleTrace={toggleTrace}
            onOpenMarketplace={openMarket}
            onRefreshHealth={refreshHealth}
            proofBadge={traceOpen ? 0 : verifies.length}
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
            <main className="relative flex min-w-0 flex-1 flex-col">
              <MessageList
                messages={messages}
                streaming={streaming}
                mode={mode}
                loading={loadingId != null}
                error={convoError}
                onRetry={retryConversation}
                onSuggestion={sendStable}
              />
              <Composer
                streaming={streaming}
                onSend={sendStable}
                onStop={stop}
                mode={mode}
                onModeChange={changeMode}
                ensureConversation={ensureConversation}
              />
              <Suspense fallback={null}>
                <VoiceOrb sendPrompt={voicePrompt} onViewRun={viewVoiceRun} />
              </Suspense>
            </main>

            {/* mobile trace backdrop */}
            {traceOpen && (
              <div
                className="fixed inset-0 z-30 bg-neutral-900/30 lg:hidden"
                onClick={closeTrace}
                aria-hidden="true"
              />
            )}

            {/* proof trace | workspace sidebar */}
            <aside
              className={cx(
                "z-40 flex shrink-0 flex-col border-l border-neutral-200 bg-white lg:relative",
                "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:transition-transform max-lg:motion-safe:duration-200",
                asideTab === "files"
                  ? "w-[26rem] max-lg:w-full xl:w-(--ws-w)"
                  : "w-80 max-lg:max-w-[88vw]",
                !traceOpen && "max-lg:invisible max-lg:translate-x-full lg:hidden"
              )}
              style={{ "--ws-w": `${wsWidth}px` } as CSSProperties}
              aria-label={asideTab === "files" ? "workspace" : "proof trace"}
            >
              <div
                role="group"
                aria-label="side panel"
                className="flex shrink-0 gap-1 border-b border-neutral-200 px-3 py-1.5"
              >
                {(["proof", "files"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={asideTab === t}
                    onClick={() => showAside(t)}
                    className={cx(
                      "relative rounded-full px-3 py-0.5 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-bloop-deep",
                      asideTab === t
                        ? "bg-bloop text-neutral-900"
                        : "text-neutral-600 hover:bg-neutral-100"
                    )}
                  >
                    {t}
                    {t === "files" && wsUnseen && asideTab !== "files" && (
                      <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-bloop-deep motion-safe:animate-pulse" />
                    )}
                  </button>
                ))}
              </div>
              <div className={cx("min-h-0 flex-1", asideTab !== "proof" && "hidden")}>
                <ProofTrace
                  plan={plan}
                  trace={trace}
                  verifyCount={verifies.length}
                  sources={sources}
                  onClose={closeTrace}
                />
              </div>
              {filesSeen && (
                <div className={cx("min-h-0 flex-1", asideTab !== "files" && "hidden")}>
                  <Suspense fallback={null}>
                    <WorkspacePanel
                      conversationId={activeId}
                      event={wsEvent}
                      streaming={streaming}
                      width={wsWidth}
                      onResize={setWsWidth}
                      onClose={closeTrace}
                    />
                  </Suspense>
                </div>
              )}
            </aside>
          </div>
        </div>

        <Suspense fallback={null}>
          {modal === "market" && (
            <MarketplaceModal
              onClose={closeModal}
              onChanged={refreshHealth}
              initialTab={marketTab}
              connectedId={connectedId}
            />
          )}
          {modal === "memories" && <MemoriesModal onClose={closeModal} tick={memTick} />}
        </Suspense>

        <CommandPalette
          conversations={convos}
          activeId={activeId}
          models={models}
          model={model}
          onModelChange={setModel}
          mode={mode}
          onModeChange={changeMode}
          onNewChat={newChat}
          onSelectConversation={openConversation}
          onOpenMarketplace={openMarket}
          onOpenKnowledge={openMemories}
          onOpenSkills={openSkills}
          onToggleTrace={toggleTrace}
          onToggleWorkspace={toggleWorkspace}
          onToggleSidebar={toggleSidebar}
          onSignOut={signOut}
          onOpen={closeOverlays}
        />
        <Toaster />
      </div>
    </ChatActions.Provider>
  );
}

/** Tolerantly map a stored API message into UI state. */
function fromApiMessage(m: ApiMessage, idx: number, convId?: string): ChatMessage {
  const msg: ChatMessage = {
    id: `h-${idx}-${uid()}`,
    role: m.role === "user" ? "user" : "assistant",
    parts: [],
    tools: {},
    loaded: true
  };

  const toolFrom = (p: Record<string, unknown>, parent?: string): ToolCall => {
    const id = typeof p.id === "string" ? p.id : uid();
    return {
      id,
      name: typeof p.name === "string" ? p.name : "tool",
      app: typeof p.app === "string" ? p.app : "",
      args: p.args,
      status: p.ok === false ? "error" : "ok",
      ms: typeof p.ms === "number" ? p.ms : undefined,
      output: typeof p.output === "string" ? p.output : undefined,
      errorKind:
        p.ok === false && typeof p.error_kind === "string"
          ? (p.error_kind as ToolCall["errorKind"])
          : undefined,
      retries: typeof p.retries === "number" ? p.retries : undefined,
      seq: 0,
      parent
    };
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
        const call = toolFrom(p);
        msg.tools[call.id] = call;
        msg.parts.push({ kind: "tool", id: call.id });
      } else if (p.kind === "subagent") {
        const id = typeof p.id === "string" ? p.id : uid();
        const agent: Subagent = {
          id,
          task: typeof p.task === "string" ? p.task : "",
          status: p.ok === false ? "error" : "ok",
          summary: typeof p.summary === "string" ? p.summary : undefined,
          parts: []
        };
        if (Array.isArray(p.tools)) {
          for (const t of p.tools) {
            if (!t || typeof t !== "object") continue;
            const call = toolFrom(t as Record<string, unknown>, id);
            msg.tools[call.id] = call;
            agent.parts.push({ kind: "tool", id: call.id });
          }
        }
        msg.subagents = { ...msg.subagents, [id]: agent };
        msg.parts.push({ kind: "subagent", id });
      } else if (p.kind === "sources") {
        const items = cleanSources(p.items);
        if (items.length > 0) msg.sources = items;
      } else if (p.kind === "handoff" && typeof p.url === "string") {
        msg.parts.push({
          kind: "handoff",
          id: uid(),
          url: p.url,
          reason: typeof p.reason === "string" ? p.reason : "",
          sessionId: typeof p.session_id === "string" ? p.session_id : undefined,
          externalUrl: typeof p.external_url === "string" ? p.external_url : undefined
        });
      } else if (p.kind === "thinking" && typeof p.text === "string") {
        msg.parts.push({ kind: "thinking", id: uid(), text: p.text });
      } else if (p.kind === "skill" && typeof p.name === "string") {
        const action = p.action === "create" || p.action === "update" ? p.action : "use";
        msg.parts.push({ kind: "skill", id: uid(), action, name: p.name });
      } else if (p.kind === "mcp_app" && typeof p.url === "string") {
        msg.parts.push({
          kind: "mcp_app",
          id: typeof p.id === "string" ? p.id : uid(),
          server: typeof p.server === "string" ? p.server : "",
          tool: typeof p.tool === "string" ? p.tool : "",
          uri: typeof p.uri === "string" ? p.uri : "",
          url: p.url
        });
      } else if (p.kind === "attachment" && typeof p.path === "string") {
        msg.parts.push({
          kind: "attachment",
          id: uid(),
          path: p.path,
          mime: typeof p.mime === "string" ? p.mime : "application/octet-stream",
          bytes: typeof p.bytes === "number" ? p.bytes : 0,
          url: convId
            ? `/api/workspace/${encodeURIComponent(convId)}/raw?path=${encodeURIComponent(p.path)}`
            : undefined
        });
      }
    }
  }
  // user turns persisted as attachments only still show their text
  if (
    m.content &&
    (msg.parts.length === 0 || (msg.role === "user" && !msg.parts.some((p) => p.kind === "text")))
  ) {
    msg.parts.push({ kind: "text", id: uid(), text: m.content });
  }
  return msg;
}
