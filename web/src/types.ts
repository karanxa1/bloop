// ── API contract ──────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface ApiMessage {
  role: "user" | "assistant";
  content: string;
  /** persisted discriminated parts, when the backend stores them */
  parts?: unknown;
}

export interface ConversationMeta {
  id: string;
  title: string;
  model?: string;
  updated_at: string;
}

export interface ConversationDetail extends ConversationMeta {
  messages: ApiMessage[];
}

export interface ModelInfo {
  id: string;
  label: string;
  default?: boolean;
}

export interface Memory {
  id: string;
  content: string;
  created_at: string;
}

export type UserFileKind = "context" | "lessons";

export interface UserFile {
  kind: UserFileKind;
  content: string;
  updated_at: string | null;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  source: "global" | "user";
  state: "ok" | "error";
  tool_count: number;
}

// SSE event payloads from POST /api/chat
export interface DeltaEvent {
  text: string;
}

export type ChatMode = "default" | "think" | "deep";

export interface ToolCallEvent {
  id: string;
  name: string;
  app?: string;
  args: unknown;
  /** subagent id when emitted inside a delegated run */
  parent?: string;
}

export type ToolErrorKind =
  | "timeout"
  | "transient"
  | "auth"
  | "circuit_open"
  | "invalid_args"
  | "error";

export interface ToolResultEvent {
  id: string;
  name?: string;
  app?: string;
  ok: boolean;
  ms: number;
  output: string;
  parent?: string;
  error_kind?: ToolErrorKind;
  retries?: number;
}

export interface ThinkingEvent {
  text: string;
}

export interface SkillEvent {
  action: "use" | "create" | "update";
  name: string;
}

/** MCP Apps view attached to a tool call (`id` = tool call id) */
export interface McpAppEvent {
  id: string;
  server: string;
  tool: string;
  uri: string;
  url: string;
}

export interface ModeEvent {
  mode: ChatMode;
}

export interface HandoffEvent {
  url: string;
  reason: string;
  session_id: string;
  external_url?: string;
}

export interface SubagentStartEvent {
  id: string;
  task: string;
}

export interface SubagentEndEvent {
  id: string;
  ok: boolean;
  summary: string;
}

export interface SourceItem {
  url: string;
  title?: string;
}

export interface SourcesEvent {
  items: SourceItem[];
}

export interface SubagentDeltaEvent {
  id: string;
  text: string;
}

/** `server` frame — one MCP server's connection progress at run start */
export interface McpServerFrame {
  name: string;
  state: string; // "connecting" | "connected" | "ok" | "error" …
  tools?: number | string[];
}

export interface PlanEvent {
  steps: PlanStep[];
}

export interface VerifyEvent {
  claim: string;
  evidence: string;
  app?: string;
  hash: string;
}

export interface ImageEvent {
  url: string;
  prompt?: string;
  parent?: string;
}

export interface CodeEvent {
  language: string;
  source: string;
  output?: string;
  ok?: boolean;
  parent?: string;
}

export interface MemoryEvent {
  action: "remember" | "forget";
  content: string;
}

export interface FileEvent {
  kind: UserFileKind;
  action: "update" | "append";
  content: string;
}

export interface ToolsLoadedEvent {
  names: string[];
}

export interface DoneEvent {
  conversation_id?: string;
}

export interface ErrorEvent {
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  model?: string;
  servers?: unknown[];
}

// ── UI state ──────────────────────────────────────────────────────

export type PlanStatus = "pending" | "active" | "done" | "failed";

export interface PlanStep {
  title: string;
  status: PlanStatus;
}

export type ToolStatus = "running" | "ok" | "error";

export interface ToolCall {
  id: string;
  name: string;
  app: string;
  args: unknown;
  status: ToolStatus;
  ms?: number;
  output?: string;
  seq: number; // arrival order for the trace feed
  /** subagent id when the call ran inside a delegated run */
  parent?: string;
  /** Date.now() when the call started (live calls only) — drives the elapsed counter */
  startedAt?: number;
  /** position within a burst of parallel calls — drives the entry stagger */
  stagger?: number;
  /** classified failure reason from the backend's resilient tool runner */
  errorKind?: ToolErrorKind;
  /** how many times the backend retried before this result */
  retries?: number;
}

export interface Subagent {
  id: string;
  task: string;
  status: ToolStatus;
  summary?: string;
  /** tool / code / image parts emitted inside this subagent */
  parts: MessagePart[];
}

export interface VerifyEntry {
  claim: string;
  evidence: string;
  app?: string;
  hash: string;
  seq: number;
}

export type MessagePart =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string } // id matches a ToolCall id
  | { kind: "image"; id: string; url: string; prompt?: string }
  | {
      kind: "code";
      id: string;
      language: string;
      source: string;
      output?: string;
      ok?: boolean;
    }
  | { kind: "handoff"; id: string; url: string; reason: string; sessionId?: string; externalUrl?: string }
  | { kind: "subagent"; id: string } // id matches a Subagent id
  /** streamed reasoning summary */
  | { kind: "thinking"; id: string; text: string }
  /** skill used / created / updated during the run */
  | { kind: "skill"; id: string; action: SkillEvent["action"]; name: string }
  /** MCP Apps view — `id` matches the ToolCall id that produced it */
  | { kind: "mcp_app"; id: string; server: string; tool: string; uri: string; url: string }
  /** file uploaded to the conversation workspace (user turns); `url` = raw preview */
  | { kind: "attachment"; id: string; path: string; mime: string; bytes: number; url?: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  tools: Record<string, ToolCall>;
  /** delegated runs, keyed by subagent id */
  subagents?: Record<string, Subagent>;
  /** cumulative sources cited in this reply */
  sources?: SourceItem[];
  /** reasoning mode the run started with */
  mode?: ChatMode;
  /** MCP servers connecting for this run, keyed by name */
  servers?: Record<string, McpServerFrame>;
  error?: string;
  /** true when hydrated from GET /api/conversations/:id — excluded from the live trace */
  loaded?: boolean;
}

export type TraceItem =
  | { kind: "tool"; seq: number; call: ToolCall }
  | { kind: "verify"; seq: number; entry: VerifyEntry }
  | { kind: "image"; seq: number; image: { url: string; prompt?: string } }
  | {
      kind: "code";
      seq: number;
      code: { language: string; source: string; output?: string; ok?: boolean };
    }
  | { kind: "memory"; seq: number; memory: MemoryEvent }
  | { kind: "file"; seq: number; file: FileEvent }
  | { kind: "tools"; seq: number; names: string[] }
  | { kind: "handoff"; seq: number; handoff: { url: string; reason: string } }
  | {
      kind: "subagent";
      seq: number;
      phase: "start" | "end";
      id: string;
      task: string;
      ok?: boolean;
      summary?: string;
    }
  /** an MCP server that errored or tripped its circuit breaker mid-run */
  | { kind: "server"; seq: number; name: string; state: string }
  | { kind: "skill"; seq: number; action: "use" | "create" | "update"; name: string }
  | { kind: "mcp_app"; seq: number; id: string; server: string; tool: string; url: string };

// mutating tool names — a result from one of these without a matching
// verify event counts as an "unverified write"
export const MUTATING =
  /create|update|delete|send|post|comment|merge|close|add|remove|set|write|invite|reply|assign|label|move/i;
