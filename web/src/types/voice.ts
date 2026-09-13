import type { ChatMode } from "../types";

/** Outcome of a bloop run started by voice, resolved when the chat SSE stream ends. */
export interface RunResult {
  ok: boolean;
  /** final assistant text (may be long / markdown) */
  text: string;
  tools: number;
  verifications: number;
  errors: number;
  /** why the run failed or was interrupted */
  error?: string;
}

export type SendPrompt = (text: string, mode?: ChatMode) => Promise<RunResult>;

/** Visual/interaction state of the orb. */
export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "user" // user speaking
  | "thinking"
  | "speaking"
  | "error";

export type VoiceProblem =
  | "mic-denied"
  | "mic-missing"
  | "unsupported"
  | "not-configured"
  | "rate-limited"
  | "network"
  | "agent";

export interface Caption {
  id: number;
  role: "user" | "agent";
  text: string;
}

/** Result of POST /api/voice/token. */
export type VoiceConnectPlan =
  | { kind: "direct"; accessToken: string; wsUrl: string; settings: Record<string, unknown> }
  | { kind: "relay"; wsUrl: string }
  | { kind: "error"; problem: VoiceProblem; message: string };

/** Deepgram Voice Agent server → client JSON messages (subset we use). */
export type AgentServerMessage =
  | { type: "Welcome"; request_id?: string }
  | { type: "SettingsApplied" }
  | { type: "ConversationText"; role: "user" | "assistant"; content: string }
  | { type: "UserStartedSpeaking" }
  | { type: "AgentThinking"; content?: string }
  | { type: "AgentStartedSpeaking" }
  | { type: "AgentAudioDone" }
  | {
      type: "FunctionCallRequest";
      functions: { id: string; name: string; arguments: string; client_side: boolean }[];
    }
  | { type: "InjectionRefused"; message?: string }
  | { type: "Error"; description?: string; code?: string }
  | { type: "Warning"; description?: string; code?: string }
  | { type: string; [k: string]: unknown };
