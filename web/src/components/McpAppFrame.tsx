import { memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ToolCall } from "../types";
import { ChatActions } from "../chatActions";
import { AlertIcon, XIcon } from "../icons";
import { cx, safeHttpUrl } from "../lib";
import { AppLogo } from "./ServerLogo";

/**
 * MCP Apps host (SEP-1865, `io.modelcontextprotocol/ui`): renders a tool's
 * UI resource in a sandboxed iframe and bridges JSON-RPC 2.0 over postMessage.
 * Per bloop's contract the frame never gets `allow-same-origin`, so the view
 * runs at an opaque origin ("null") and every message is checked against
 * `event.source === iframe.contentWindow`.
 */

const PROTOCOL_VERSION = "2026-01-26";
const INLINE_MAX = 720;
const LOAD_TIMEOUT = 15_000;

interface McpApp {
  id: string;
  server: string;
  tool: string;
  uri: string;
  url: string;
}

type Json = Record<string, unknown>;

/** app views load only from our own auth-guarded file route (/files/…) */
const frameSrc = (url: string) =>
  url.startsWith("/files/") && !url.includes("..") && !/[\\\s]/.test(url) ? url : null;

function textOf(content: unknown): string {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks
    .map((b) =>
      b && typeof b === "object" && (b as Json).type === "text" && typeof (b as Json).text === "string"
        ? ((b as Json).text as string)
        : ""
    )
    .join("\n")
    .trim();
}

/** `/api/mcp/call` → MCP CallToolResult */
function toCallToolResult(r: Json): Json {
  const out = r.output;
  return {
    content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out ?? "") }],
    ...(r.structured && typeof r.structured === "object" ? { structuredContent: r.structured } : {}),
    isError: r.ok === false
  };
}

function ExpandGlyph({ full }: { full: boolean }) {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {full ? (
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      ) : (
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      )}
    </svg>
  );
}

const iconBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors duration-150 hover:bg-neutral-200/60 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep";

export const McpAppFrame = memo(function McpAppFrame({
  app,
  call
}: {
  app: McpApp;
  /** the tool call that produced this view — feeds tool-input / tool-result */
  call?: ToolCall;
}) {
  const { send, streaming } = useContext(ChatActions);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [height, setHeight] = useState(280);
  const [full, setFull] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const titleId = useId();
  const src = frameSrc(app.url);

  // latest values for the long-lived message listener
  const live = useRef({ send, streaming, call, full });
  useLayoutEffect(() => {
    live.current = { send, streaming, call, full };
  });
  const initialized = useRef(false);
  const sentResult = useRef(false);

  const post = (msg: Json) =>
    // opaque-origin frame: "*" is the only target that reaches it; source is pinned by ref
    frameRef.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...msg }, "*");

  const sendToolData = () => {
    const c = live.current.call;
    if (!c) return;
    post({
      method: "ui/notifications/tool-input",
      params: { arguments: c.args && typeof c.args === "object" ? c.args : {} }
    });
    if (c.status !== "running" && !sentResult.current) {
      sentResult.current = true;
      post({
        method: "ui/notifications/tool-result",
        params: toCallToolResult({ ok: c.status === "ok", output: c.output ?? "" })
      });
    }
  };

  useEffect(() => {
    initialized.current = false;
    sentResult.current = false;
    const onMessage = async (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data as Json;
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") return;
      const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;
      const hasId = m.id != null;
      const reply = (result: Json) => hasId && post({ id: m.id, result });
      const fail = (code: number, message: string) =>
        hasId && post({ id: m.id, error: { code, message } });

      switch (m.method) {
        case "ui/initialize": {
          const el = frameRef.current;
          reply({
            protocolVersion:
              typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
            hostInfo: { name: "bloop", version: "3" },
            hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
            hostContext: {
              theme: "light",
              displayMode: live.current.full ? "fullscreen" : "inline",
              availableDisplayModes: ["inline", "fullscreen"],
              containerDimensions: {
                width: el?.clientWidth ?? 640,
                maxHeight: live.current.full ? window.innerHeight : INLINE_MAX
              },
              locale: navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              platform: "web",
              toolInfo: { id: app.id, tool: { name: app.tool } },
              styles: {
                variables: {
                  "--color-background-primary": "#ffffff",
                  "--color-background-secondary": "#f2f2f2",
                  "--color-text-primary": "#262626",
                  "--color-text-secondary": "#737373",
                  "--color-border-primary": "#e5e5e5",
                  "--color-ring-primary": "#5c8a2c",
                  "--font-sans": "Inter, ui-sans-serif, system-ui, sans-serif"
                }
              }
            }
          });
          setStatus("ready");
          break;
        }
        case "ui/notifications/initialized":
          initialized.current = true;
          setStatus("ready");
          sendToolData();
          break;
        case "ping":
          reply({});
          break;
        case "tools/call": {
          const name = params.name;
          if (typeof name !== "string" || !name) return fail(-32602, "tool name required");
          try {
            const res = await fetch("/api/mcp/call", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              // bridge is pinned to the server that rendered this view
              body: JSON.stringify({ server: app.server, tool: name, arguments: params.arguments ?? {} })
            });
            const body = (await res.json().catch(() => null)) as Json | null;
            if (!res.ok || !body) {
              return fail(-32000, (body?.error as string) ?? `tool call failed (${res.status})`);
            }
            reply(toCallToolResult(body));
          } catch {
            fail(-32000, "network error");
          }
          break;
        }
        case "ui/message": {
          const text = textOf(params.content);
          if (!text) return fail(-32602, "text content required");
          if (live.current.streaming) return fail(-32000, "bloop is busy — try again when this run finishes");
          live.current.send(text);
          reply({});
          break;
        }
        case "ui/open-link": {
          const url = safeHttpUrl(params.url);
          if (!url) return fail(-32602, "only http(s) links can be opened");
          window.open(url, "_blank", "noopener,noreferrer");
          reply({});
          break;
        }
        case "ui/notifications/size-changed": {
          const h = Number(params.height);
          if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(Math.ceil(h), 60), 4000));
          break;
        }
        case "ui/request-display-mode": {
          const mode = params.mode === "fullscreen" ? "fullscreen" : "inline";
          setFull(mode === "fullscreen");
          reply({ mode });
          break;
        }
        case "ui/update-model-context":
          reply({});
          break;
        case "notifications/message":
          break;
        default:
          fail(-32601, `method not found: ${m.method}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, app.server, app.tool, attempt]);

  // tool finished after the view initialized → push the result
  useEffect(() => {
    if (initialized.current && call && call.status !== "running") sendToolData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.status]);

  // display mode changes → tell the view; Esc leaves full screen
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    if (initialized.current) {
      post({
        method: "ui/notifications/host-context-changed",
        params: { displayMode: full ? "fullscreen" : "inline" }
      });
    }
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  // no load event in time → error fallback
  useEffect(() => {
    if (status !== "loading") return;
    const t = window.setTimeout(() => setStatus("error"), LOAD_TIMEOUT);
    return () => window.clearTimeout(t);
  }, [status, attempt]);

  if (!src) {
    return (
      <p className="my-3 flex items-center gap-2 border border-neutral-200 border-l-2 border-l-red-500 bg-white px-3 py-2 text-xs text-neutral-600">
        <AlertIcon className="h-3.5 w-3.5 text-red-600" />
        this app view has an invalid address
      </p>
    );
  }

  return (
    <>
      {full && (
        <div
          className="fixed inset-0 z-[60] bg-neutral-900/40"
          aria-hidden="true"
          onClick={() => setFull(false)}
        />
      )}
      <section
        aria-labelledby={titleId}
        role={full ? "dialog" : undefined}
        aria-modal={full || undefined}
        className={cx(
          "flex flex-col border border-neutral-200 border-l-2 border-l-bloop bg-white",
          full ? "fixed inset-2 z-[61] shadow-2xl sm:inset-6" : "my-3"
        )}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-100 pl-3 pr-1.5">
          <AppLogo name={app.server} className="h-4 w-4" />
          <h3 id={titleId} className="min-w-0 flex-1 truncate text-xs">
            <span className="font-semibold text-neutral-800">{app.tool}</span>
            <span className="text-neutral-400"> · {app.server} app</span>
          </h3>
          {status === "loading" && (
            <span className="text-[10px] font-medium text-neutral-400">loading…</span>
          )}
          <button
            type="button"
            onClick={() => setFull((f) => !f)}
            aria-label={full ? "exit full screen" : "open full screen"}
            title={full ? "exit full screen (esc)" : "open full screen"}
            className={iconBtn}
          >
            <ExpandGlyph full={full} />
          </button>
          {full && (
            <button type="button" onClick={() => setFull(false)} aria-label="close" className={iconBtn}>
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </header>

        <div className={cx("relative min-h-0", full && "flex-1")}>
          {status === "error" ? (
            <div className="flex flex-wrap items-center gap-3 px-3 py-4 text-xs text-neutral-600">
              <AlertIcon className="h-4 w-4 text-red-600" />
              <span className="min-w-0 flex-1">couldn&rsquo;t load this app view.</span>
              <button
                type="button"
                onClick={() => {
                  setStatus("loading");
                  setAttempt((a) => a + 1);
                }}
                className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs font-semibold text-neutral-700 transition-colors duration-150 hover:border-bloop hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
              >
                retry
              </button>
            </div>
          ) : (
            <>
              <iframe
                key={attempt}
                ref={frameRef}
                src={src}
                title={`${app.tool} app from ${app.server}`}
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                loading="lazy"
                onLoad={() => setStatus((s) => (s === "loading" ? "ready" : s))}
                style={full ? undefined : { height: Math.min(height, INLINE_MAX) }}
                className={cx(
                  "block w-full border-0 bg-white transition-opacity duration-200",
                  full && "h-full",
                  status === "loading" && "opacity-0"
                )}
              />
              {status === "loading" && (
                <div className="absolute inset-0 space-y-2.5 p-3" aria-hidden="true">
                  <div className="h-3 w-1/3 bg-neutral-200 motion-safe:animate-pulse" />
                  <div className="h-3 w-2/3 bg-neutral-200 motion-safe:animate-pulse" />
                  <div className="h-20 w-full bg-page motion-safe:animate-pulse" />
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
});
