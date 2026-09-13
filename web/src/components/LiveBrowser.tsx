import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../lib";

const VIEW_W = 1280;
const VIEW_H = 800;

type Status = "connecting" | "live" | "ended";

/** Keys we forward as real key events; printable chars go through insertText. */
const SPECIAL_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Escape", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"
]);

/**
 * Interactive remote browser: CDP screencast frames rendered into an <img>,
 * pointer/keyboard events forwarded over the same socket. The remote page is
 * 1280x800 — pointer coords are scaled from the rendered box.
 */
export function LiveBrowser({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [meta, setMeta] = useState<{ url: string; title: string }>({ url: "", title: "" });
  const [nav, setNav] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/browser/view?session=${encodeURIComponent(sessionId)}`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      try {
        const m = JSON.parse(e.data) as {
          t?: string;
          url?: string;
          title?: string;
          msg?: string;
          data?: string;
        };
        if (m.t === "frame" && typeof m.data === "string") {
          const img = imgRef.current;
          if (img) img.src = `data:image/jpeg;base64,${m.data}`;
        } else if (m.t === "meta" && typeof m.url === "string") {
          setMeta({ url: m.url, title: typeof m.title === "string" ? m.title : "" });
        } else if (m.t === "error") {
          setErr(m.msg ?? "live view error");
        }
      } catch {
        /* ignore malformed */
      }
    };
    ws.onopen = () => setStatus("live");
    ws.onclose = () => {
      setStatus((s) => (s === "ended" ? s : "ended"));
      wsRef.current = null;
    };
    ws.onerror = () => setStatus("ended");
    return () => {
      ws.close(1000, "bye");
      wsRef.current = null;
    };
  }, [sessionId]);

  const send = useCallback((o: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  }, []);

  const coords = useCallback((e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * VIEW_W),
      y: Math.round(((e.clientY - r.top) / r.height) * VIEW_H)
    };
  }, []);

  const onPointer = (kind: "move" | "down" | "up") => (e: React.PointerEvent) => {
    if (status !== "live") return;
    e.preventDefault();
    const { x, y } = coords(e);
    send({ t: "mouse", key: kind, x, y, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
    if (kind === "down") boxRef.current?.focus();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (status !== "live") return;
    const { x, y } = coords(e);
    send({ t: "wheel", x, y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (status !== "live") return;
    if (e.metaKey || e.ctrlKey) return; // let browser shortcuts work
    e.preventDefault();
    if (e.key.length === 1) {
      send({ t: "text", text: e.key });
    } else if (SPECIAL_KEYS.has(e.key)) {
      send({ t: "key", key: e.key, code: e.code });
    }
  };

  const go = () => {
    const u = nav.trim();
    if (!u) return;
    send({ t: "nav", url: /^https?:\/\//i.test(u) ? u : `https://${u}` });
    setNav("");
  };

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-950">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2.5 py-1.5">
        <span
          className={cx(
            "h-2 w-2 shrink-0 rounded-full",
            status === "live" ? "bg-bloop" : status === "connecting" ? "animate-pulse bg-amber-400" : "bg-neutral-600"
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400" title={meta.url}>
          {meta.url || (status === "connecting" ? "connecting to browser…" : "browser session ended")}
        </span>
        <form
          className="flex shrink-0 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            value={nav}
            onChange={(e) => setNav(e.target.value)}
            placeholder="go to url…"
            aria-label="navigate the remote browser"
            className="w-36 rounded-full border border-neutral-700 bg-neutral-800 px-2.5 py-1 font-mono text-[11px] text-neutral-200 placeholder:text-neutral-500 focus:border-bloop focus:outline-none sm:w-48"
          />
        </form>
      </div>
      {/* viewport */}
      <div
        ref={boxRef}
        tabIndex={0}
        role="application"
        aria-label="live remote browser — click to control"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="relative aspect-[8/5] w-full cursor-text bg-neutral-950 outline-none focus-visible:ring-2 focus-visible:ring-bloop"
      >
        <img
          ref={imgRef}
          alt="live remote browser"
          draggable={false}
          onPointerMove={onPointer("move")}
          onPointerDown={onPointer("down")}
          onPointerUp={onPointer("up")}
          onWheel={onWheel}
          className="block h-full w-full select-none object-contain"
        />
        {status !== "live" && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-950/60">
            <span className="text-xs font-semibold text-neutral-400">
              {status === "connecting" ? "connecting…" : err ?? "view closed"}
            </span>
          </div>
        )}
      </div>
      <p className="px-2.5 py-1.5 text-[10px] leading-tight text-neutral-500">
        click to focus · type, scroll and click inside — it's a real browser
      </p>
    </div>
  );
}
