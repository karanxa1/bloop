import type {
  ConversationDetail,
  ConversationMeta,
  McpServer,
  Memory,
  ModelInfo,
  User
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        detail =
          (typeof b.error === "string" && b.error) ||
          (typeof b.message === "string" && b.message) ||
          "";
      }
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, detail || res.statusText || `request failed`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── auth ──────────────────────────────────────────────────────────

export function me(): Promise<User> {
  return req<User>("/api/auth/me");
}

export function login(email: string, password: string): Promise<User> {
  return req<User>("/api/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password })
  });
}

export function signup(
  email: string,
  password: string,
  name: string,
  invite_code: string
): Promise<User> {
  return req<User>("/api/auth/signup", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password, name, invite_code })
  });
}

export function logout(): Promise<void> {
  return req<void>("/api/auth/logout", { method: "POST" });
}

// ── conversations ─────────────────────────────────────────────────

export function listConversations(): Promise<ConversationMeta[]> {
  return req<ConversationMeta[]>("/api/conversations");
}

export function createConversation(): Promise<{ id: string; title: string }> {
  return req<{ id: string; title: string }>("/api/conversations", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({})
  });
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return req<ConversationDetail>(`/api/conversations/${id}`);
}

export function renameConversation(id: string, title: string): Promise<unknown> {
  return req(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title })
  });
}

export function deleteConversation(id: string): Promise<void> {
  return req<void>(`/api/conversations/${id}`, { method: "DELETE" });
}

// ── models ────────────────────────────────────────────────────────

export function listModels(): Promise<ModelInfo[]> {
  return req<ModelInfo[]>("/api/models");
}

// ── memories ──────────────────────────────────────────────────────

export function listMemories(): Promise<Memory[]> {
  return req<Memory[]>("/api/memories");
}

export function addMemory(content: string): Promise<Memory> {
  return req<Memory>("/api/memories", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content })
  });
}

export function deleteMemory(id: string): Promise<void> {
  return req<void>(`/api/memories/${id}`, { method: "DELETE" });
}

// ── mcp servers ───────────────────────────────────────────────────

export function listServers(): Promise<McpServer[]> {
  return req<McpServer[]>("/api/servers");
}

export function addServer(
  name: string,
  url: string,
  token?: string
): Promise<McpServer> {
  return req<McpServer>("/api/servers", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, url, ...(token ? { token } : {}) })
  });
}

export function deleteServer(id: string): Promise<void> {
  return req<void>(`/api/servers/${id}`, { method: "DELETE" });
}
