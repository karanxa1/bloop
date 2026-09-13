import { useCallback, useEffect, useRef, useState } from "react";
import { planVoiceConnection } from "../../api/voice";
import type { ChatMode } from "../../types";
import type {
  AgentServerMessage,
  Caption,
  RunResult,
  SendPrompt,
  VoicePhase
} from "../../types/voice";
import { AudioEngine, voiceSupported } from "./audio";

/** must match core/src/voice.rs INPUT_RATE / OUTPUT_RATE */
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;
const KEEPALIVE_MS = 8_000; // Deepgram: send KeepAlive every 8s while not streaming audio
/**
 * Deepgram doesn't document a client-side function-call deadline, so long runs get an
 * early "still running" FunctionCallResponse and the outcome is spoken later via
 * InjectAgentMessage.
 */
const EARLY_RESPONSE_MS = 15_000;
const RESULT_MAX = 800;
const MAX_CAPTIONS = 6;

export interface VoiceTask {
  prompt: string;
  startedAt: number;
}

export interface VoiceAgent {
  phase: VoicePhase;
  active: boolean;
  muted: boolean;
  captions: Caption[];
  task: VoiceTask | null;
  problem: string | null;
  notice: string | null;
  start: () => void;
  end: () => void;
  toggleMute: () => void;
  levels: () => { mic: number; out: number };
}

/** strip markdown/URLs so text reads well aloud */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code in chat) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

function compactResult(r: RunResult): string {
  return JSON.stringify({
    status: r.ok ? "done" : "failed",
    result: speakable(r.text).slice(0, RESULT_MAX) || (r.ok ? "(no text — see the chat)" : ""),
    ...(r.error ? { error: r.error.slice(0, 200) } : {}),
    tool_calls: r.tools,
    verifications: r.verifications,
    errors: r.errors
  });
}

function spokenSummary(r: RunResult): string {
  if (!r.ok) {
    const why = r.error ? speakable(r.error).slice(0, 140) : "something went wrong";
    return `that bloop task didn't finish: ${why}. want me to try again?`;
  }
  const body = firstSentences(speakable(r.text), 260);
  return body ? `bloop's done. ${body} the details are in the chat.` : "bloop's done — the details are in the chat.";
}

function closeMessage(code: number, applied: boolean): string {
  if (code === 4001) return "voice session hit its time limit.";
  if (code === 4002) return "voice was opened in another tab.";
  return applied ? "voice connection lost." : "couldn't connect to the voice agent.";
}

export function useVoiceAgent(sendPrompt: SendPrompt): VoiceAgent {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [task, setTask] = useState<VoiceTask | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sendPromptRef = useRef(sendPrompt);
  sendPromptRef.current = sendPrompt;
  const wsRef = useRef<WebSocket | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const appliedRef = useRef(false);
  const mutedRef = useRef(false);
  const endedRef = useRef(true);
  const reconnectsRef = useRef(0);
  const audioDoneRef = useRef(false);
  const keepAliveRef = useRef<number | null>(null);
  const captionSeq = useRef(0);
  const injectRef = useRef<{ message: string; tries: number } | null>(null);
  const phaseRef = useRef<VoicePhase>("idle");
  phaseRef.current = phase;

  const addCaption = useCallback((role: Caption["role"], text: string) => {
    const t = text.trim();
    if (!t) return;
    setCaptions((cs) => [...cs, { id: ++captionSeq.current, role, text: t }].slice(-MAX_CAPTIONS));
  }, []);

  const sendJson = useCallback((msg: object): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  const teardown = useCallback(() => {
    if (keepAliveRef.current != null) window.clearInterval(keepAliveRef.current);
    keepAliveRef.current = null;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "bye");
    engineRef.current?.close();
    engineRef.current = null;
    appliedRef.current = false;
    injectRef.current = null;
  }, []);

  const fail = useCallback(
    (message: string) => {
      endedRef.current = true;
      teardown();
      setProblem(message);
      setPhase("error");
    },
    [teardown]
  );

  const inject = useCallback(
    (message: string) => {
      injectRef.current = { message, tries: 0 };
      sendJson({ type: "InjectAgentMessage", message });
    },
    [sendJson]
  );

  const runTask = useCallback(
    async (fn: { id: string; name: string; arguments: string }) => {
      const respond = (content: string) => sendJson({ type: "FunctionCallResponse", id: fn.id, name: fn.name, content });
      let args: { prompt?: unknown; mode?: unknown } = {};
      try {
        args = JSON.parse(fn.arguments || "{}");
      } catch {
        /* handled below */
      }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        respond(JSON.stringify({ status: "failed", error: "missing prompt — ask the user what to do" }));
        return;
      }
      const mode = (["default", "think", "deep"] as const).find((m) => m === args.mode) as ChatMode | undefined;
      const ws = wsRef.current;
      setTask({ prompt, startedAt: Date.now() });
      let respondedEarly = false;
      const early = window.setTimeout(() => {
        respondedEarly = true;
        respond(
          JSON.stringify({
            status: "running",
            note: "bloop started the task and it is still running; progress is visible in the chat. tell the user it's underway and that you'll report back when it finishes."
          })
        );
      }, EARLY_RESPONSE_MS);

      let result: RunResult;
      try {
        result = await sendPromptRef.current(prompt, mode);
      } catch (err) {
        result = {
          ok: false,
          text: "",
          tools: 0,
          verifications: 0,
          errors: 1,
          error: err instanceof Error ? err.message : "the task could not start"
        };
      }
      window.clearTimeout(early);
      setTask(null);
      if (endedRef.current) return;
      // a reconnect invalidates the original function call id — speak the outcome instead
      if (!respondedEarly && wsRef.current === ws) respond(compactResult(result));
      else inject(spokenSummary(result));
    },
    [inject, sendJson]
  );

  const onMessage = useCallback(
    (msg: AgentServerMessage) => {
      switch (msg.type) {
        case "SettingsApplied":
          appliedRef.current = true;
          reconnectsRef.current = 0;
          setProblem(null);
          setPhase("listening");
          break;
        case "UserStartedSpeaking":
          engineRef.current?.flush(); // barge-in
          audioDoneRef.current = false;
          setPhase("user");
          break;
        case "ConversationText": {
          const m = msg as { role: string; content: string };
          if (m.role === "user") {
            addCaption("user", m.content);
            if (phaseRef.current === "user" || phaseRef.current === "listening") setPhase("thinking");
          } else {
            addCaption("agent", m.content);
            if (injectRef.current && m.content.startsWith(injectRef.current.message.slice(0, 24)))
              injectRef.current = null;
          }
          break;
        }
        case "AgentThinking":
          setPhase("thinking");
          break;
        case "AgentStartedSpeaking":
          audioDoneRef.current = false;
          setPhase("speaking");
          break;
        case "AgentAudioDone":
          audioDoneRef.current = true;
          if (!engineRef.current?.pending) setPhase("listening");
          break;
        case "FunctionCallRequest": {
          const fns = (msg as Extract<AgentServerMessage, { type: "FunctionCallRequest" }>).functions ?? [];
          for (const fn of fns) {
            if (!fn.client_side) continue;
            if (fn.name === "run_bloop_task") void runTask(fn);
            else
              sendJson({
                type: "FunctionCallResponse",
                id: fn.id,
                name: fn.name,
                content: JSON.stringify({ status: "failed", error: `unknown function ${fn.name}` })
              });
          }
          setPhase("thinking");
          break;
        }
        case "InjectionRefused": {
          const pending = injectRef.current;
          if (pending && pending.tries < 4) {
            pending.tries++;
            window.setTimeout(() => {
              if (injectRef.current === pending) sendJson({ type: "InjectAgentMessage", message: pending.message });
            }, 2500);
          }
          break;
        }
        case "Error": {
          const m = msg as { description?: string };
          setNotice(m.description ? `voice agent: ${m.description.slice(0, 140)}` : "the voice agent hit an error.");
          break;
        }
        default:
          break;
      }
    },
    [addCaption, runTask, sendJson]
  );

  const connect = useCallback(async () => {
    const plan = await planVoiceConnection();
    if (endedRef.current) return;
    if (plan.kind === "error") {
      fail(plan.message);
      return;
    }
    const ws =
      plan.kind === "direct" ? new WebSocket(plan.wsUrl, ["bearer", plan.accessToken]) : new WebSocket(plan.wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    appliedRef.current = false;

    ws.onopen = () => {
      if (plan.kind === "direct") ws.send(JSON.stringify(plan.settings));
      if (keepAliveRef.current != null) window.clearInterval(keepAliveRef.current);
      keepAliveRef.current = window.setInterval(() => {
        if (mutedRef.current && wsRef.current === ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, KEEPALIVE_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (wsRef.current !== ws) return;
      if (typeof e.data === "string") {
        try {
          onMessage(JSON.parse(e.data) as AgentServerMessage);
        } catch {
          /* ignore malformed */
        }
      } else if (e.data instanceof ArrayBuffer) {
        engineRef.current?.play(e.data);
      }
    };
    ws.onclose = (e: CloseEvent) => {
      if (wsRef.current !== ws || endedRef.current) return;
      const wasApplied = appliedRef.current;
      const transient = e.code !== 1000 && e.code !== 4001 && e.code !== 4002;
      if (transient && reconnectsRef.current < 1) {
        reconnectsRef.current++;
        wsRef.current = null;
        engineRef.current?.flush();
        setNotice("reconnecting…");
        setPhase("connecting");
        void connect().then(() => setNotice(null));
        return;
      }
      fail(closeMessage(e.code, wasApplied));
    };
  }, [fail, onMessage]);

  const start = useCallback(() => {
    if (!endedRef.current) return;
    setProblem(null);
    setNotice(null);
    setCaptions([]);
    if (!voiceSupported()) {
      setProblem("voice isn't supported in this browser.");
      setPhase("error");
      return;
    }
    endedRef.current = false;
    reconnectsRef.current = 0;
    mutedRef.current = false;
    setMuted(false);
    setPhase("connecting");
    // create the context synchronously inside the gesture
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const engine = new AudioEngine(ctx, {
      inputRate: INPUT_RATE,
      outputRate: OUTPUT_RATE,
      onPcm: (frame) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || !appliedRef.current || mutedRef.current) return;
        if (ws.bufferedAmount > 256_000) return; // congested — drop rather than add latency
        ws.send(frame);
      },
      onDrained: () => {
        if (audioDoneRef.current && phaseRef.current === "speaking") setPhase("listening");
      }
    });
    engineRef.current = engine;
    void (async () => {
      try {
        await engine.start();
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        fail(
          name === "NotAllowedError" || name === "SecurityError"
            ? "microphone blocked — allow mic access for this site, then try again."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "no microphone found."
              : "couldn't start audio in this browser."
        );
        return;
      }
      if (endedRef.current) return;
      await connect();
    })();
  }, [connect, fail]);

  const end = useCallback(() => {
    endedRef.current = true;
    teardown();
    setPhase("idle");
    setProblem(null);
    setNotice(null);
    setCaptions([]);
    setMuted(false);
    mutedRef.current = false;
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    engineRef.current?.setMuted(next);
  }, []);

  const levels = useCallback(() => engineRef.current?.levels() ?? { mic: 0, out: 0 }, []);

  useEffect(
    () => () => {
      endedRef.current = true;
      teardown();
    },
    [teardown]
  );

  const active = phase !== "idle" && phase !== "error";
  return { phase, active, muted, captions, task, problem, notice, start, end, toggleMute, levels };
}
