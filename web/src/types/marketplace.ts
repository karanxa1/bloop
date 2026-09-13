// marketplace types — mirrors docs/contracts-v3.md (skills · built-in tools · mcp servers)

export type MarketTab = "apps" | "tools" | "skills";

// ── skills ───────────────────────────────────────────────────────
export type SkillSource = "user" | "agent" | "catalog";

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  source: SkillSource;
  enabled: boolean;
  updated_at: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface CatalogSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
  category: string;
  installed: boolean;
}

// ── built-in tools ───────────────────────────────────────────────
export type ToolCategory = "core" | "web" | "code" | "media" | "memory" | "agents";

export interface BuiltinTool {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  enabled: boolean;
  locked: boolean;
}

// ── mcp servers ──────────────────────────────────────────────────
export type AuthType = "none" | "bearer" | "headers" | "oauth";
export type Transport = "auto" | "streamable-http" | "sse";
export type ServerState = "ok" | "error" | "degraded";
export type ErrorKind =
  | "timeout"
  | "transient"
  | "auth"
  | "circuit_open"
  | "invalid_args"
  | "error";

export interface CatalogServer {
  slug: string;
  name: string;
  description: string;
  category: string;
  url: string;
  auth: AuthType;
  docs_url: string;
  logo: string;
  featured: boolean;
  installed: boolean;
}

export interface InstalledServer {
  id: string;
  name: string;
  url: string;
  source: "global" | "user";
  state: ServerState;
  tool_count: number;
  transport: Transport;
  auth_type: AuthType;
  enabled: boolean;
  oauth_status: "connected" | "required" | null;
  logo?: string;
  error?: string;
}

export interface ServerAuth {
  type: AuthType;
  token?: string;
  headers?: Record<string, string>;
}

export interface AddServerBody {
  name: string;
  url: string;
  transport?: Transport;
  auth?: ServerAuth;
  catalog_slug?: string;
}

export interface ToolSummary {
  name: string;
  description: string;
}

export interface AddServerOk {
  id: string;
  name: string;
  url: string;
  state: ServerState;
  tool_count: number;
  tools: ToolSummary[];
}

export interface AddServerOauth {
  id: string;
  oauth_required: true;
  authorize_url: string;
}

export type AddServerResult = AddServerOk | AddServerOauth;

export interface PatchServerBody {
  enabled?: boolean;
  name?: string;
  headers?: Record<string, string>;
  token?: string;
}

export interface TestResult {
  state: ServerState;
  tool_count: number;
  tools: ToolSummary[];
  error?: string;
  error_kind?: ErrorKind;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ServerTool {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  has_ui: boolean;
}

export const isOauthResult = (r: AddServerResult): r is AddServerOauth =>
  "oauth_required" in r && r.oauth_required === true;

// ── url probe (auth auto-detection) ──────────────────────────────
export type DetectedAuth = "none" | "oauth" | "credentials";

export interface ProbeResult {
  state: "ok" | "auth_required" | "error";
  detected_auth?: DetectedAuth;
  tool_count?: number;
  tools?: ToolSummary[];
  issuer?: string;
  registration?: boolean;
  hint?: string;
}
