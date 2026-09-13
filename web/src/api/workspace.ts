import { ApiError } from "../api";
import type { ExecResult, WorkspaceFile } from "../types/workspace";

const root = (conv: string) => `/api/workspace/${encodeURIComponent(conv)}`;
const q = (path: string) => `?path=${encodeURIComponent(path)}`;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = "";
    try {
      const b: unknown = await res.json();
      if (b && typeof b === "object") {
        const r = b as Record<string, unknown>;
        detail =
          (typeof r.error === "string" && r.error) ||
          (typeof r.detail === "string" && r.detail) ||
          "";
      }
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, detail || res.statusText || "request failed");
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const withJson = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  signal
});

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export const normPath = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/{2,}/g, "/");

export async function listFiles(conv: string, signal?: AbortSignal): Promise<WorkspaceFile[]> {
  const raw = await req<unknown>(`${root(conv)}/files`, { signal });
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { files?: unknown }).files)
      ? (raw as { files: unknown[] }).files
      : [];
  return arr.flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const r = f as Record<string, unknown>;
    if (typeof r.path !== "string" || !normPath(r.path)) return [];
    return [
      {
        path: normPath(r.path),
        bytes: typeof r.bytes === "number" ? r.bytes : 0,
        updated_at: typeof r.updated_at === "string" ? r.updated_at : ""
      }
    ];
  });
}

export async function readFile(conv: string, path: string, signal?: AbortSignal): Promise<string> {
  const r = await req<{ content?: unknown } | undefined>(`${root(conv)}/file${q(path)}`, { signal });
  return typeof r?.content === "string" ? r.content : "";
}

export function writeFile(conv: string, path: string, content: string): Promise<unknown> {
  return req<unknown>(`${root(conv)}/file`, withJson("PUT", { path, content }));
}

export function deleteFile(conv: string, path: string): Promise<unknown> {
  return req<unknown>(`${root(conv)}/file${q(path)}`, { method: "DELETE" });
}

export async function exec(conv: string, command: string, signal?: AbortSignal): Promise<ExecResult> {
  const r = (await req<Record<string, unknown> | undefined>(
    `${root(conv)}/exec`,
    withJson("POST", { command }, signal)
  )) ?? {};
  return {
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    exit_code: typeof r.exit_code === "number" ? r.exit_code : -1,
    ms: typeof r.ms === "number" ? r.ms : 0,
    changed: strings(r.changed),
    deleted: strings(r.deleted),
    skipped: Array.isArray(r.skipped) ? strings(r.skipped) : undefined,
    sync_error: typeof r.sync_error === "string" && r.sync_error ? r.sync_error : undefined
  };
}

export const isBinaryError = (e: unknown) => e instanceof ApiError && e.status === 415;

export const errText = (e: unknown) =>
  e instanceof Error && e.message ? e.message.toLowerCase() : "request failed";
