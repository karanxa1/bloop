// ── API contract ──────────────────────────────────────────────────

export interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ApiMessage[];
}

// SSE event payloads from POST /api/chat
export interface DeltaEvent {
  text: string;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  app: string;
  args: unknown;
}

export interface ToolResultEvent {
  id: string;
  name: string;
  app: string;
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
  | { kind: "tool"; id: string }; // id matches a ToolCall id

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  tools: Record<string, ToolCall>;
  error?: string;
}

export type TraceItem =
  | { kind: "tool"; seq: number; call: ToolCall }
  | { kind: "verify"; seq: number; entry: VerifyEntry };

// mutating tool names — a result from one of these without a matching
// verify event counts as an "unverified write"
export const MUTATING =
  /create|update|delete|send|post|comment|merge|close|add|remove|set|write|invite|reply|assign|label|move/i;
