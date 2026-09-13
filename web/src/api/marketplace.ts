import { ApiError } from "../api";
import type {
  AddServerBody,
  AddServerResult,
  CatalogServer,
  InstalledServer,
  PatchServerBody,
  ProbeResult,
  ServerTool,
  TestResult
} from "../types/marketplace";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** fetch wrapper shared by the marketplace api modules (same error shape as api.ts) */
export async function mreq<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { headers: JSON_HEADERS, body: JSON.stringify(json) } : {})
  });
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
    throw new ApiError(res.status, detail || res.statusText || "request failed");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const errMsg = (e: unknown, fallback: string) =>
  e instanceof ApiError && e.message ? e.message : fallback;

// ── catalog + installed servers ──────────────────────────────────
export const listServerCatalog = () => mreq<CatalogServer[]>("/api/servers/catalog");
export const listInstalledServers = () => mreq<InstalledServer[]>("/api/servers");

export const addServer = (body: AddServerBody) =>
  mreq<AddServerResult>("/api/servers", { method: "POST", json: body });

export const patchServer = (id: string, body: PatchServerBody) =>
  mreq<unknown>(`/api/servers/${encodeURIComponent(id)}`, { method: "PATCH", json: body });

export const removeServer = (id: string) =>
  mreq<unknown>(`/api/servers/${encodeURIComponent(id)}`, { method: "DELETE" });

export const testServer = (id: string) =>
  mreq<TestResult>(`/api/servers/${encodeURIComponent(id)}/test`, { method: "POST" });

/** unauthenticated detection pass — what auth does this server url need? */
export const probeServer = (url: string) =>
  mreq<ProbeResult>("/api/servers/probe", { method: "POST", json: { url } });

export const listServerTools = (id: string) =>
  mreq<ServerTool[]>(`/api/servers/${encodeURIComponent(id)}/tools`);

/** only same-origin paths or https urls may be used as an oauth hop */
export function startOauth(authorizeUrl: string): boolean {
  try {
    const u = new URL(authorizeUrl, window.location.origin);
    const sameOrigin = u.origin === window.location.origin;
    if (!sameOrigin && u.protocol !== "https:") return false;
    window.location.assign(u.toString()); // top-level navigation
    return true;
  } catch {
    return false;
  }
}
