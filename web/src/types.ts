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

export interface ToolCallEvent {
  id: string;
  name: string;
  app?: string;
  args: unknown;
}

export interface ToolResultEvent {
  id: string;
  name?: string;
  app?: string;
  ok: boolean;
  ms: number;
  output: string;
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
}

export interface CodeEvent {
  language: string;
  source: string;
  output?: string;
  ok?: boolean;
}

export interface MemoryEvent {
  action: "remember" | "forget";
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
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  tools: Record<string, ToolCall>;
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
  | { kind: "tools"; seq: number; names: string[] };

// mutating tool names — a result from one of these without a matching
// verify event counts as an "unverified write"
export const MUTATING =
  /create|update|delete|send|post|comment|merge|close|add|remove|set|write|invite|reply|assign|label|move/i;
