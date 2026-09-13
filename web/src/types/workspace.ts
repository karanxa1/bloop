/** workspace contract — see docs/contracts-v3.md § workspace */

export type WorkspaceAction = "write" | "delete" | "exec";

export interface WorkspaceFile {
  path: string;
  bytes: number;
  updated_at: string;
}

/** `workspace` SSE event */
export interface WorkspaceEvent {
  action: WorkspaceAction;
  paths: string[];
  command?: string;
  exit_code?: number;
}

/** a workspace event stamped with a monotonic seq, so identical repeats still re-trigger */
export interface WorkspaceSignal extends WorkspaceEvent {
  seq: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  ms: number;
  changed: string[];
  deleted: string[];
  skipped?: string[];
  sync_error?: string;
}

export type TabStatus = "loading" | "ready" | "binary" | "error";

export interface EditorTab {
  path: string;
  /** current editor text */
  content: string;
  /** last text known to be on the server */
  saved: string;
  status: TabStatus;
  error?: string;
  /** server copy moved under a dirty tab */
  stale?: "changed" | "deleted";
  saving?: boolean;
}
