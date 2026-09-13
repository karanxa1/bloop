import type { VoiceConnectPlan } from "../types/voice";

function relayUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/voice/ws`;
}

/** once the server says grants are unavailable, skip straight to the relay this page-load */
let grantUnavailable = false;

/**
 * Decide how to reach the voice agent. Always asks the server first so "not configured"
 * and rate limits surface as clear states (a failed WS upgrade is opaque in browsers).
 */
export async function planVoiceConnection(): Promise<VoiceConnectPlan> {
  let res: Response;
  try {
    res = await fetch("/api/voice/token", { method: "POST", credentials: "include" });
  } catch {
    return { kind: "error", problem: "network", message: "can't reach bloop — check your connection." };
  }
  if (res.status === 501 || (grantUnavailable && res.ok)) {
    grantUnavailable = true;
    return { kind: "relay", wsUrl: relayUrl() };
  }
  if (res.status === 503)
    return { kind: "error", problem: "not-configured", message: "voice isn't set up on this server yet." };
  if (res.status === 429)
    return { kind: "error", problem: "rate-limited", message: "too many voice sessions — try again in a minute." };
  if (res.status === 401)
    return { kind: "error", problem: "agent", message: "your session expired — sign in again to use voice." };
  if (!res.ok) {
    // upstream hiccup on the grant — the relay may still work
    return { kind: "relay", wsUrl: relayUrl() };
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    ws_url?: string;
    settings?: Record<string, unknown>;
  } | null;
  if (!body?.access_token || !body.ws_url || !body.settings) return { kind: "relay", wsUrl: relayUrl() };
  return { kind: "direct", accessToken: body.access_token, wsUrl: body.ws_url, settings: body.settings };
}
