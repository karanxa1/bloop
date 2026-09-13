import { mreq } from "./marketplace";
import type { BuiltinTool } from "../types/marketplace";

export const listTools = () => mreq<BuiltinTool[]>("/api/tools");

export const setToolEnabled = (name: string, enabled: boolean) =>
  mreq<unknown>(`/api/tools/${encodeURIComponent(name)}`, { method: "PUT", json: { enabled } });
