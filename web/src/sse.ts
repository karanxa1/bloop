export interface ServerEvent {
  /** event: line, e.g. "delta" | "tool_call" | "tool_result" | "plan" | "verify" | "error" | "done" */
  type: string;
  /** parsed JSON payload of the data: line(s), or raw string if not JSON */
  data: unknown;
}

/**
 * Minimal SSE parser over a fetch ReadableStream.
 * Events are separated by a blank line; each block may contain
 * `event: <type>` and one or more `data: <payload>` lines
 * (joined with "\n" per the SSE spec). Lines starting with ":"
 * are comments/heartbeats and are ignored.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: { end: number; after: number } | -1;
      // blocks are terminated by a blank line (\n\n or \r\n\r\n)
      while ((sep = findBlockEnd(buffer)) !== -1) {
        const block = buffer.slice(0, sep.end);
        buffer = buffer.slice(sep.after);
        const evt = parseBlock(block);
        if (evt) yield evt;
      }
    }
    // flush any trailing block without a terminating blank line
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function findBlockEnd(buf: string): { end: number; after: number } | -1 {
  const nn = buf.indexOf("\n\n");
  const rr = buf.indexOf("\r\n\r\n");
  if (nn === -1 && rr === -1) return -1;
  if (rr !== -1 && (nn === -1 || rr < nn)) return { end: rr, after: rr + 4 };
  return { end: nn, after: nn + 2 };
}

function parseBlock(block: string): ServerEvent | null {
  let type = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value.trim();
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // non-JSON payload — pass through as string
  }
  return { type, data };
}

export interface StreamChatOptions {
  signal?: AbortSignal;
  onEvent: (evt: ServerEvent) => void;
}

export interface ChatRequestBody {
  conversation_id: string;
  message: string;
  model: string;
  mode: "default" | "think" | "deep";
  /** workspace uploads (paths from POST /api/workspace/:conv/upload) */
  attachments?: { path: string; mime: string; bytes: number }[];
}

/** POST /api/chat and dispatch each SSE event to onEvent. Resolves on stream end. */
export async function streamChat(
  body: ChatRequestBody,
  { signal, onEvent }: StreamChatOptions
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `chat request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  if (!res.body) throw new Error("chat response had no body");
  for await (const evt of parseSSE(res.body)) {
    onEvent(evt);
  }
}

export async function fetchHealth(signal?: AbortSignal) {
  const res = await fetch("/api/health", { credentials: "include", signal });
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return (await res.json()) as {
    ok: boolean;
    model?: string;
    servers?: unknown[];
  };
}
