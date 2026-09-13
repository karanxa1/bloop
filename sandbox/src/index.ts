import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
	SANDBOX_TOKEN: string;
}

const EXEC_TIMEOUT_S = 30;
// Backstop for the in-container `timeout` wrapper — should never be hit first.
const EXEC_TIMEOUT_MS = (EXEC_TIMEOUT_S + 15) * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const TRUNCATED = "\n...[truncated]";

const LANGUAGES: Record<string, { ext: string; cmd: string }> = {
	python: { ext: "py", cmd: "python3" },
	javascript: { ext: "js", cmd: "node" },
	bash: { ext: "sh", cmd: "bash" },
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** Cap stdout + stderr to MAX_OUTPUT_BYTES combined, keeping the tail-visible
 *  early bytes of each stream. Each stream is guaranteed at least half the
 *  budget; a small stream leaves its unused share to the larger one. */
function capOutput(stdout: string, stderr: string): { stdout: string; stderr: string } {
	if (stdout.length + stderr.length <= MAX_OUTPUT_BYTES) {
		return { stdout, stderr };
	}
	const half = MAX_OUTPUT_BYTES / 2;
	const stdoutBudget = stderr.length <= half ? MAX_OUTPUT_BYTES - stderr.length : half;
	const stderrBudget = stdout.length <= half ? MAX_OUTPUT_BYTES - stdout.length : half;
	return {
		stdout: stdout.length > stdoutBudget ? stdout.slice(0, stdoutBudget) + TRUNCATED : stdout,
		stderr: stderr.length > stderrBudget ? stderr.slice(0, stderrBudget) + TRUNCATED : stderr,
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
			return json({ ok: true });
		}

		if (url.pathname === "/run") {
			if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

			const expected = `Bearer ${env.SANDBOX_TOKEN ?? ""}`;
			if (!env.SANDBOX_TOKEN || request.headers.get("authorization") !== expected) {
				return json({ error: "unauthorized" }, 401);
			}

			let body: { code?: unknown; language?: unknown };
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid JSON body" }, 400);
			}
			if (typeof body.code !== "string" || body.code.length === 0) {
				return json({ error: "code must be a non-empty string" }, 400);
			}
			const language = typeof body.language === "string" ? body.language : "python";
			const lang = LANGUAGES[language];
			if (!lang) {
				return json({ error: `unsupported language: ${language}` }, 400);
			}

			const started = Date.now();
			try {
				const sandbox = getSandbox(env.Sandbox, "default");
				// Unique path per request so concurrent runs can't clobber each other.
				const path = `/tmp/snippet-${crypto.randomUUID()}.${lang.ext}`;
				await sandbox.writeFile(path, body.code);
				// `timeout` kills the process at 30s (exit 124) so partial output is
				// preserved; the SDK timeout above is only a backstop.
				const result = await sandbox.exec(
					`timeout --signal=TERM --kill-after=5 ${EXEC_TIMEOUT_S} ${lang.cmd} ${path}`,
					{ timeout: EXEC_TIMEOUT_MS },
				);
				const { stdout, stderr } = capOutput(result.stdout ?? "", result.stderr ?? "");
				return json({
					stdout,
					stderr: result.exitCode === 124 ? `${stderr}\n[timed out after ${EXEC_TIMEOUT_S}s]` : stderr,
					exit_code: result.exitCode,
					ms: Date.now() - started,
				});
			} catch (err) {
				return json(
					{ error: `execution failed: ${err instanceof Error ? err.message : String(err)}` },
					500,
				);
			}
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
