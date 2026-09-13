import { createAzure } from "@ai-sdk/azure";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type ToolSet
} from "ai";
import { z } from "zod";

declare global {
  interface Env {
    AZURE_OPENAI_API_KEY: string;
    AZURE_OPENAI_ENDPOINT: string;
    AZURE_OPENAI_API_VERSION?: string;
    AGENT_MODEL?: string;
    AGENT_MODEL_FALLBACK?: string;
    GITHUB_TOKEN?: string;
    COMPOSIO_MCP_URL?: string;
    COMPOSIO_API_KEY?: string;
  }
}

// ── Types ────────────────────────────────────────────────────────────

export type PlanStep = {
  title: string;
  status: "pending" | "active" | "done" | "failed";
};

export type TraceEvent = {
  id: string;
  ts: number;
  kind:
    | "run_start"
    | "plan"
    | "tool_call"
    | "tool_result"
    | "verification"
    | "error";
  title: string;
  detail?: string;
  app?: string;
  mutating?: boolean;
  verified?: boolean;
  ms?: number;
  hash?: string;
};

export type SwarmState = {
  plan: PlanStep[];
  trace: TraceEvent[];
  ledger: { hash: string; claim: string; evidence: string; ts: number }[];
  headHash: string;
  runId: string | null;
};

const MUTATING =
  /create|update|delete|send|post|comment|merge|close|add|remove|set|write|upload|invite|reply|resolve|assign|label|move|patch/i;

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const GENESIS = "bloop";

function summarize(value: unknown, max = 800): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Agent ────────────────────────────────────────────────────────────

export class ChatAgent extends AIChatAgent<Env, SwarmState> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  initialState: SwarmState = {
    plan: [],
    trace: [],
    ledger: [],
    headHash: GENESIS,
    runId: null
  };

  async onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });

    // Auto-connect built-in MCP servers. Stored rows can go stale across
    // DO hibernation/reloads, so we always do a clean re-add.
    if (this.env.GITHUB_TOKEN) {
      try {
        await this.mcp.removeServer("github");
      } catch {
        // not present — fine
      }
      try {
        await this.addMcpServer("github", GITHUB_MCP_URL, {
          id: "github",
          transport: {
            headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}` }
          }
        });
      } catch (e) {
        console.error("Failed to connect GitHub MCP:", e);
      }
    }

    const connected = new Set(
      (this.mcp.listServers() ?? []).map((r) => r.id)
    );

    if (this.env.COMPOSIO_MCP_URL && !connected.has("composio")) {
      try {
        await this.addMcpServer("composio", this.env.COMPOSIO_MCP_URL, {
          id: "composio",
          transport: this.env.COMPOSIO_API_KEY
            ? {
                headers: { Authorization: `Bearer ${this.env.COMPOSIO_API_KEY}` }
              }
            : undefined
        });
      } catch (e) {
        console.error("Failed to connect Composio MCP:", e);
      }
    }
  }

  // ── Trace helpers ────────────────────────────────────────────────

  private log(event: Omit<TraceEvent, "id" | "ts">) {
    const entry: TraceEvent = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...event
    };
    const trace = [...(this.state?.trace ?? []), entry].slice(-300);
    this.setState({ ...(this.state ?? this.initialState), trace });
  }

  private beginRun() {
    this.setState({
      ...(this.state ?? this.initialState),
      plan: [],
      trace: [
        {
          id: crypto.randomUUID(),
          ts: Date.now(),
          kind: "run_start",
          title: "Run started"
        }
      ],
      runId: crypto.randomUUID()
    });
  }

  private wrapWithTrace(tools: ToolSet): ToolSet {
    const wrapped: ToolSet = {};
    for (const [name, t] of Object.entries(tools)) {
      if (!t.execute) {
        wrapped[name] = t;
        continue;
      }
      const execute = t.execute.bind(t);
      const app = name.includes("__") ? name.split("__")[0] : "local";
      wrapped[name] = {
        ...t,
        execute: async (args: unknown, opts: unknown) => {
          const start = Date.now();
          this.log({
            kind: "tool_call",
            title: name,
            app,
            detail: summarize(args, 400),
            mutating: MUTATING.test(name)
          });
          try {
            const result = await (
              execute as (a: unknown, o: unknown) => Promise<unknown>
            )(args, opts);
            this.log({
              kind: "tool_result",
              title: name,
              app,
              detail: summarize(result),
              mutating: MUTATING.test(name),
              ms: Date.now() - start
            });
            return result;
          } catch (e) {
            this.log({
              kind: "error",
              title: name,
              app,
              detail: String(e),
              ms: Date.now() - start
            });
            throw e;
          }
        }
      } as ToolSet[string];
    }
    return wrapped;
  }

  // ── Shared agent config ──────────────────────────────────────────

  private model() {
    const azure = createAzure({
      baseURL: `${this.env.AZURE_OPENAI_ENDPOINT}/openai`,
      apiKey: this.env.AZURE_OPENAI_API_KEY,
      apiVersion: this.env.AZURE_OPENAI_API_VERSION ?? "preview"
    });
    return azure.chat(this.env.AGENT_MODEL ?? "gpt-6-astra");
  }

  private connectedAppNames(): string {
    const conns = (this.mcp.mcpConnections ?? {}) as Record<
      string,
      { connectionState?: string; state?: string; options?: { name?: string } }
    >;
    const names = Object.entries(conns)
      .filter(
        ([, c]) =>
          (c as { connectionState?: string }).connectionState === "ready" ||
          (c as { state?: string }).state === "ready"
      )
      .map(([id]) => id);
    return names.join(", ") || "none yet";
  }

  private systemPrompt(): string {
    return `You are bloop, a general-purpose agent that takes real actions across external apps. You are connected to live MCP servers: ${this.connectedAppNames()}.

Operating discipline — this is non-negotiable:
1. PLAN: For any multi-step request, first call updatePlan with the steps. Mark each step active/done/failed as you go.
2. ACT: Use MCP tools to take real actions in the connected apps.
3. VERIFY: After ANY action that mutates external state (create, update, send, post, delete...), you MUST verify it landed with an independent read-back call (e.g. fetch the issue you created, list the message you posted). Then call attest with the claim and the evidence you observed. Never claim something is done without verification.
4. REPORT: End with a concise report: what was done, what was verified, links/ids for each artifact, and anything that failed.

Keep replies tight. Prefer parallel tool calls when steps are independent.

${getSchedulePrompt({ date: new Date() })}
If the user asks to schedule a task, use the scheduleTask tool.`;
  }

  private buildTools(): ToolSet {
    return {
      ...this.wrapWithTrace(this.mcp.getAITools()),

      updatePlan: tool({
        description:
          "Set or update the step-by-step plan for the current task. Call at the start of multi-step work and update as steps complete.",
        inputSchema: z.object({
          steps: z
            .array(
              z.object({
                title: z.string(),
                status: z.enum(["pending", "active", "done", "failed"])
              })
            )
            .describe("The full plan with current status per step")
        }),
        execute: async ({ steps }) => {
          this.setState({ ...(this.state ?? this.initialState), plan: steps });
          this.log({
            kind: "plan",
            title: "Plan updated",
            detail: steps.map((s) => `[${s.status}] ${s.title}`).join("\n")
          });
          return { ok: true, steps };
        }
      }),

      attest: tool({
        description:
          "Attest that an external action was verified by an independent read-back. Call after you have confirmed a mutation landed. Provide the claim and the concrete evidence (id, url, fetched content) that proves it.",
        inputSchema: z.object({
          claim: z
            .string()
            .describe(
              "What was verified, e.g. 'GitHub issue #42 created in karanxa1/repo'"
            ),
          evidence: z
            .string()
            .describe(
              "Concrete proof observed in the read-back: id, url, excerpt"
            ),
          app: z
            .string()
            .optional()
            .describe("Which app, e.g. github, notion, slack")
        }),
        execute: async ({ claim, evidence, app }) => {
          const entry = { claim, evidence, app: app ?? "unknown" };
          const prev = this.state?.headHash ?? GENESIS;
          const hash = await sha256Hex(prev + JSON.stringify(entry));
          const ledger = [
            ...(this.state?.ledger ?? []),
            { hash, claim, evidence, ts: Date.now() }
          ].slice(-200);
          this.setState({
            ...(this.state ?? this.initialState),
            ledger,
            headHash: hash
          });
          this.log({
            kind: "verification",
            title: claim,
            detail: evidence,
            app,
            verified: true,
            hash
          });
          return { recorded: true, hash };
        }
      }),

      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
        inputSchema: z.object({})
      }),

      scheduleTask: tool({
        description:
          "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
        inputSchema: scheduleSchema,
        execute: async ({ when, description }) => {
          if (when.type === "no-schedule") {
            return "Not a valid schedule input";
          }
          const input =
            when.type === "scheduled"
              ? when.date
              : when.type === "delayed"
                ? when.delayInSeconds
                : when.type === "cron"
                  ? when.cron
                  : null;
          if (!input) return "Invalid schedule type";
          try {
            this.schedule(input, "executeTask", description, {
              idempotent: true
            });
            return `Task scheduled: "${description}" (${when.type}: ${input})`;
          } catch (error) {
            return `Error scheduling task: ${error}`;
          }
        }
      }),

      getScheduledTasks: tool({
        description: "List all tasks that have been scheduled",
        inputSchema: z.object({}),
        execute: async () => {
          const tasks = this.getSchedules();
          return tasks.length > 0 ? tasks : "No scheduled tasks found.";
        }
      }),

      cancelScheduledTask: tool({
        description: "Cancel a scheduled task by its ID",
        inputSchema: z.object({
          taskId: z.string().describe("The ID of the task to cancel")
        }),
        execute: async ({ taskId }) => {
          try {
            this.cancelSchedule(taskId);
            return `Task ${taskId} cancelled.`;
          } catch (error) {
            return `Error cancelling task: ${error}`;
          }
        }
      })
    };
  }

  // ── HTTP API (same SSE contract as the Rust core) ────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const servers = Object.entries(this.mcp.listServers() ?? {}).map(
        ([id, s]) => {
          const srv = s as { name?: string; state?: string };
          return { id, name: srv.name, state: srv.state };
        }
      );
      // Force discovery on any connected-but-undiscovered servers
      const conns = (this.mcp.mcpConnections ?? {}) as Record<
        string,
        {
          connectionState?: string;
          state?: string;
          options?: { name?: string };
        }
      >;
      for (const [id, c] of Object.entries(conns)) {
        const st = c.connectionState ?? c.state;
        if (st === "connected") {
          try {
            await this.mcp.discoverIfConnected(id);
          } catch (e) {
            console.error(`discover ${id}:`, e);
          }
        }
      }
      const connStates = Object.fromEntries(
        Object.entries(conns).map(([id, c]) => [
          id,
          c.connectionState ?? c.state
        ])
      );
      return Response.json({
        ok: true,
        model: this.env.AGENT_MODEL ?? "gpt-6-astra",
        servers,
        connStates,
        toolNames: Object.keys(this.mcp.getAITools()).slice(0, 50),
        toolCount: Object.keys(this.mcp.getAITools()).length
      });
    }

    if (url.pathname === "/api/mcp/reconnect") {
      const results: Record<string, unknown> = {};
      try {
        await this.mcp.removeServer("github");
      } catch (e) {
        results.removeError = String(e);
      }
      try {
        const r = await this.addMcpServer("github", GITHUB_MCP_URL, {
          id: "github",
          transport: {
            headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}` }
          }
        });
        results.add = r;
      } catch (e) {
        results.addError = String(e);
      }
      await this.mcp.waitForConnections({ timeout: 20000 });
      const conns = (this.mcp.mcpConnections ?? {}) as Record<
        string,
        { connectionState?: string; state?: string }
      >;
      return Response.json({
        results,
        connStates: Object.fromEntries(
          Object.entries(conns).map(([id, c]) => [
            id,
            c.connectionState ?? c.state
          ])
        ),
        toolCount: Object.keys(this.mcp.getAITools()).length
      });
    }

    if (url.pathname === "/api/ledger") {
      return Response.json({
        head: this.state?.headHash ?? GENESIS,
        entries: this.state?.ledger ?? []
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = (await request.json()) as {
        messages: { role: string; content: string }[];
      };
      this.beginRun();

      // Wait for in-flight MCP connections to finish connecting/discovering
      await this.mcp.waitForConnections({ timeout: 15000 });

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const send = (type: string, data: unknown) =>
            controller.enqueue(encoder.encode(sseEvent(type, data)));

          (async () => {
            try {
              const toolCalls = new Map<
                string,
                { name: string; input: unknown }
              >();
              const result = streamText({
                model: this.model(),
                system: this.systemPrompt(),
                messages: body.messages as ModelMessage[],
                tools: this.buildTools(),
                stopWhen: stepCountIs(30),
                providerOptions: {
                  azure: { reasoningEffort: "none" }
                },
                onError: ({ error }) => {
                  send("error", { message: String(error) });
                }
              });

              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  send("delta", { text: part.text });
                } else if (part.type === "tool-call") {
                  const name = part.toolName;
                  const input =
                    (part as { input?: unknown }).input ??
                    (part as { args?: unknown }).args;
                  toolCalls.set(part.toolCallId, { name, input });
                  send("tool_call", {
                    id: part.toolCallId,
                    name,
                    app: name.includes("__") ? name.split("__")[0] : "local",
                    args: input
                  });
                  if (name === "updatePlan") {
                    send("plan", {
                      steps: (input as { steps?: PlanStep[] })?.steps ?? []
                    });
                  }
                } else if (part.type === "tool-result") {
                  const meta = toolCalls.get(part.toolCallId);
                  const output = (part as { output?: unknown }).output;
                  send("tool_result", {
                    id: part.toolCallId,
                    name: part.toolName,
                    app: part.toolName.includes("__")
                      ? part.toolName.split("__")[0]
                      : "local",
                    ok: true,
                    output: summarize(output)
                  });
                  if (part.toolName === "attest") {
                    const inp = (meta?.input ?? {}) as {
                      claim?: string;
                      evidence?: string;
                      app?: string;
                    };
                    send("verify", {
                      claim: inp.claim,
                      evidence: inp.evidence,
                      app: inp.app,
                      hash: (output as { hash?: string })?.hash
                    });
                  }
                } else if (part.type === "tool-error" || part.type === "error") {
                  send("error", { message: summarize(part, 400) });
                }
              }
              send("done", {});
            } catch (e) {
              send("error", { message: String(e) });
              send("done", {});
            } finally {
              controller.close();
            }
          })().catch((e) => {
            send("error", { message: String(e) });
            controller.close();
          });
        }
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*"
        }
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    return super.fetch(request);
  }

  // ── RPC ──────────────────────────────────────────────────────────

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  // ── Chat (WebSocket path) ────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // New run when the last message is a fresh user submission
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") this.beginRun();

    const result = streamText({
      model: this.model(),
      system: this.systemPrompt(),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: this.buildTools(),
      stopWhen: stepCountIs(30),
      providerOptions: { azure: { reasoningEffort: "none" } },
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // HTTP API → dedicated "default" agent instance (shares MCP connections)
    if (url.pathname.startsWith("/api/")) {
      const id = env.ChatAgent.idFromName("default");
      const agent = env.ChatAgent.get(id);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type"
          }
        });
      }
      return agent.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
