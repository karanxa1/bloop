import puppeteer, { type Browser, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
// Browser builds of Readability + Turndown, bundled as text (see [[rules]] in
// wrangler.toml) and evaluated inside the rendered page.
import readabilitySrc from "@mozilla/readability/Readability.js";
import turndownSrc from "turndown/dist/turndown.js";
import turndownGfmSrc from "turndown-plugin-gfm/dist/turndown-plugin-gfm.js";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
	BROWSER: BrowserWorker;
	SANDBOX_TOKEN: string;
	/** Account that owns the Browser Rendering sessions (wrangler.toml [vars]). */
	CF_ACCOUNT_ID?: string;
	/** API token with Browser Rendering access; enables /browser/handoff. */
	CF_BROWSER_TOKEN?: string;
}

const EXEC_TIMEOUT_S = 30;
// Backstop for the in-container `timeout` wrapper — should never be hit first.
const EXEC_TIMEOUT_MS = (EXEC_TIMEOUT_S + 15) * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const TRUNCATED = "\n...[truncated]";

const NAV_TIMEOUT_MS = 20_000;
/** Documented maximum idle timeout for a Browser Rendering session (10 min). */
const KEEP_ALIVE_MS = 600_000;
const MAX_MARKDOWN_CHARS = 20_000;
const MAX_LINKS = 30;
const VIEWPORT = { width: 1280, height: 800 };

const LANGUAGES: Record<string, { ext: string; cmd: string }> = {
	python: { ext: "py", cmd: "python3" },
	javascript: { ext: "js", cmd: "node" },
	bash: { ext: "sh", cmd: "bash" },
};

type JsonBody = Record<string, unknown>;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Returns a 401 response unless the request carries the shared bearer token. */
function checkAuth(request: Request, env: Env): Response | null {
	const expected = `Bearer ${env.SANDBOX_TOKEN ?? ""}`;
	if (!env.SANDBOX_TOKEN || request.headers.get("authorization") !== expected) {
		return json({ error: "unauthorized" }, 401);
	}
	return null;
}

async function readJson(request: Request): Promise<JsonBody> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new HttpError(400, "JSON body must be an object");
	}
	return body as JsonBody;
}

function requireHttpUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new HttpError(400, "url must be a non-empty string");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new HttpError(400, "url is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new HttpError(400, "only http and https URLs are allowed");
	}
	return parsed.toString();
}

function requireSessionId(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new HttpError(400, "session_id must be a non-empty string");
	}
	return value.trim();
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

// ---------------------------------------------------------------------------
// /run
// ---------------------------------------------------------------------------

async function handleRun(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
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
		return json({ error: `execution failed: ${errorMessage(err)}` }, 500);
	}
}

// ---------------------------------------------------------------------------
// Browser Rendering
// ---------------------------------------------------------------------------

/** Map a Browser Rendering / puppeteer failure to an HTTP status + message. */
function browserFailure(err: unknown, context: string): HttpError {
	if (err instanceof HttpError) return err;
	const msg = errorMessage(err);
	if (/\b429\b|too many requests|rate limit|limit exceeded|time limit/i.test(msg)) {
		return new HttpError(
			429,
			`browser rendering limit reached (concurrent sessions or launch rate) — retry shortly: ${msg}`,
		);
	}
	return new HttpError(500, `${context}: ${msg}`);
}

/**
 * Run `fn` against a browser. With a session id we attach to that existing
 * (possibly user-logged-in) session and only disconnect afterwards so it stays
 * alive; otherwise we launch a fresh browser and always close it.
 */
async function withBrowser<T>(
	env: Env,
	sessionId: string | undefined,
	fn: (browser: Browser) => Promise<T>,
): Promise<T> {
	let browser: Browser;
	try {
		browser = sessionId
			? await puppeteer.connect(env.BROWSER, sessionId)
			: await puppeteer.launch(env.BROWSER);
	} catch (err) {
		const failure = browserFailure(err, sessionId ? "failed to connect to browser session" : "failed to launch browser");
		if (sessionId && failure.status === 500) {
			throw new HttpError(404, `browser session ${sessionId} not found or no longer available: ${errorMessage(err)}`);
		}
		throw failure;
	}
	try {
		return await fn(browser);
	} catch (err) {
		throw browserFailure(err, "browser operation failed");
	} finally {
		try {
			if (sessionId) await browser.disconnect();
			else await browser.close();
		} catch {
			// Best effort — the session may already be gone.
		}
	}
}

/**
 * Navigate, tolerating a network-idle timeout as long as the document itself
 * committed (busy pages with long-polling never go idle).
 */
async function navigate(page: Page, url: string): Promise<void> {
	try {
		await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
	} catch (err) {
		const msg = errorMessage(err);
		const timedOut = err instanceof Error && (err.name === "TimeoutError" || /timeout/i.test(msg));
		if (timedOut && page.url() !== "about:blank") return;
		if (timedOut) throw new HttpError(504, `navigation timed out after ${NAV_TIMEOUT_MS / 1000}s`);
		if (/net::ERR_|Protocol error|Navigation failed/i.test(msg)) {
			throw new HttpError(502, `navigation failed: ${msg}`);
		}
		throw err;
	}
}

/**
 * In-page extraction. Primary path: Mozilla Readability picks the main
 * content (serializer returns the element, so no HTML re-parse is needed —
 * this keeps it working under Trusted Types), Turndown + GFM converts it to
 * markdown. Fallback: a simple DOM walk for pages Readability rejects.
 */
const EXTRACT_SCRIPT = `(() => {
	const MAX = ${MAX_MARKDOWN_CHARS};
	const MAX_LINKS = ${MAX_LINKS};
	const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
	let markdown = "";

	try {
		const lib = {};
		(function () {
			${readabilitySrc}
			;lib.Readability = Readability;
		})();
		(function () {
			${turndownSrc}
			;lib.TurndownService = TurndownService;
		})();
		(function () {
			${turndownGfmSrc}
			;lib.gfm = turndownPluginGfm.gfm;
		})();

		const article = new lib.Readability(document.cloneNode(true), {
			serializer: (el) => el,
		}).parse();
		if (article && article.content && clean(article.textContent).length > 0) {
			const td = new lib.TurndownService({
				headingStyle: "atx",
				bulletListMarker: "-",
				codeBlockStyle: "fenced",
				hr: "---",
			});
			td.use(lib.gfm);
			td.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "form", "button"]);
			const body = td.turndown(article.content).trim();
			const title = clean(article.title);
			markdown = title && !body.slice(0, 300).includes(title) ? "# " + title + "\\n\\n" + body : body;
		}
	} catch (e) {
		markdown = "";
	}

	if (!markdown.trim() && document.body) {
		const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "SVG", "IFRAME", "TEMPLATE", "CANVAS", "FORM", "BUTTON", "ASIDE"]);
		const BLOCK = new Set(["P", "PRE", "BLOCKQUOTE", "DT", "DD", "FIGCAPTION", "TD", "TH"]);
		const out = [];
		const walk = (el) => {
			for (const node of el.childNodes) {
				if (node.nodeType === 3) {
					const t = clean(node.textContent);
					if (t && !BLOCK.has(el.tagName)) out.push(t);
					continue;
				}
				if (node.nodeType !== 1) continue;
				const tag = node.tagName.toUpperCase();
				if (SKIP.has(tag) || node.getAttribute("aria-hidden") === "true" || node.hidden) continue;
				const heading = /^H([1-6])$/.exec(tag);
				if (heading) {
					const t = clean(node.innerText || node.textContent);
					if (t) out.push("#".repeat(Number(heading[1])) + " " + t);
				} else if (tag === "LI") {
					const t = clean(node.innerText || node.textContent);
					if (t) out.push("- " + t);
				} else if (BLOCK.has(tag)) {
					const t = tag === "PRE" ? (node.textContent || "").trim() : clean(node.innerText || node.textContent);
					if (t) out.push(tag === "PRE" ? "\`\`\`\\n" + t + "\\n\`\`\`" : t);
				} else {
					walk(node);
				}
			}
		};
		walk(document.body);
		markdown = out.join("\\n\\n");
		if (!markdown.trim()) markdown = clean(document.body.innerText || document.body.textContent);
	}

	markdown = markdown.replace(/\\n{3,}/g, "\\n\\n");
	if (markdown.length > MAX) markdown = markdown.slice(0, MAX - 15) + "\\n\\n[truncated]";

	const links = [];
	const seen = new Set();
	for (const a of document.querySelectorAll("a[href]")) {
		if (links.length >= MAX_LINKS) break;
		const href = a.href;
		if (!/^https?:/i.test(href)) continue;
		const key = href.split("#")[0];
		const text = clean(a.innerText || a.textContent || a.getAttribute("aria-label") || a.title).slice(0, 200);
		if (!text || seen.has(key)) continue;
		seen.add(key);
		links.push({ text, href });
	}

	return { title: document.title || "", markdown, links };
})()`;

interface Extracted {
	title: string;
	markdown: string;
	links: { text: string; href: string }[];
}

async function handleBrowserFetch(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const url = requireHttpUrl(body.url);
	const mode = body.mode ?? "markdown";
	if (mode !== "markdown" && mode !== "screenshot") {
		throw new HttpError(400, 'mode must be "markdown" or "screenshot"');
	}
	const sessionId = body.session_id === undefined || body.session_id === null ? undefined : requireSessionId(body.session_id);

	const result = await withBrowser(env, sessionId, async (browser) => {
		const page = await browser.newPage();
		try {
			await page.setViewport(VIEWPORT);
			await page.setBypassCSP(true);
			await navigate(page, url);
			const finalUrl = page.url();

			if (mode === "screenshot") {
				const title = await page.title().catch(() => "");
				try {
					const screenshot = await page.screenshot({ type: "webp", quality: 80, encoding: "base64" });
					return { ok: true, url: finalUrl, title, screenshot, format: "webp" };
				} catch {
					const screenshot = await page.screenshot({ type: "png", encoding: "base64" });
					return { ok: true, url: finalUrl, title, screenshot, format: "png" };
				}
			}

			const extracted = (await page.evaluate(EXTRACT_SCRIPT)) as Extracted;
			return {
				ok: true,
				url: finalUrl,
				title: extracted.title,
				markdown: extracted.markdown,
				links: extracted.links,
			};
		} finally {
			// For a launched browser close() tears everything down anyway; for an
			// attached session, don't leave our tab behind in the user's browser.
			if (sessionId) await page.close().catch(() => {});
		}
	});
	return json(result);
}

async function handleBrowserSession(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const url = body.url === undefined || body.url === null || body.url === "" ? undefined : requireHttpUrl(body.url);

	let browser: Browser;
	try {
		browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
	} catch (err) {
		throw browserFailure(err, "failed to launch browser");
	}
	const sessionId = browser.sessionId();
	try {
		const page = await browser.newPage();
		await page.setViewport(VIEWPORT);
		if (url) {
			try {
				await navigate(page, url);
			} catch {
				// The session is still usable (e.g. for a login handoff) even if the
				// first navigation failed; the caller can navigate again.
			}
		}
	} catch (err) {
		await browser.close().catch(() => {});
		throw browserFailure(err, "failed to prepare browser session");
	}
	try {
		await browser.disconnect();
	} catch {
		// Disconnect failures don't kill the remote session.
	}
	return json({ session_id: sessionId });
}

interface DevtoolsTarget {
	id?: string;
	type?: string;
	url?: string;
	devtoolsFrontendUrl?: string;
}

async function handleBrowserHandoff(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const sessionId = requireSessionId(body.session_id);
	if (!env.CF_BROWSER_TOKEN || !env.CF_ACCOUNT_ID) {
		return json({ error: "live view not configured — set CF_BROWSER_TOKEN" }, 501);
	}

	const endpoint =
		`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}` +
		`/browser-rendering/devtools/browser/${encodeURIComponent(sessionId)}/json/list`;
	let res: Response;
	try {
		res = await fetch(endpoint, { headers: { Authorization: `Bearer ${env.CF_BROWSER_TOKEN}` } });
	} catch (err) {
		throw new HttpError(502, `live view lookup failed: ${errorMessage(err)}`);
	}
	const text = await res.text();
	if (!res.ok) {
		const status = res.status === 404 ? 404 : res.status === 429 ? 429 : res.status === 401 || res.status === 403 ? 502 : 502;
		const hint = res.status === 401 || res.status === 403 ? " (check CF_BROWSER_TOKEN permissions)" : "";
		throw new HttpError(status, `live view lookup failed with HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new HttpError(502, "live view lookup returned non-JSON");
	}
	// Docs show a bare array of targets; tolerate the v4 {result: [...]} envelope.
	const targets: DevtoolsTarget[] = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { result?: unknown })?.result)
			? ((parsed as { result: DevtoolsTarget[] }).result)
			: [];
	const withUrl = targets.filter((t) => typeof t.devtoolsFrontendUrl === "string");
	const target =
		withUrl.find((t) => t.type === "page" && t.url && t.url !== "about:blank") ??
		withUrl.find((t) => t.type === "page") ??
		withUrl[0];
	if (!target?.devtoolsFrontendUrl) {
		throw new HttpError(404, `no live-viewable page found in browser session ${sessionId}`);
	}
	return json({ url: target.devtoolsFrontendUrl, session_id: sessionId });
}

async function handleBrowserClose(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const sessionId = requireSessionId(body.session_id);
	try {
		const browser = await puppeteer.connect(env.BROWSER, sessionId);
		await browser.close();
		return json({ ok: true });
	} catch (err) {
		return json({ ok: true, note: `session already closed or not found: ${errorMessage(err)}` });
	}
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const POST_ROUTES: Record<string, (request: Request, env: Env) => Promise<Response>> = {
	"/run": handleRun,
	"/browser/fetch": handleBrowserFetch,
	"/browser/session": handleBrowserSession,
	"/browser/handoff": handleBrowserHandoff,
	"/browser/close": handleBrowserClose,
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/health") {
			if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
			return json({ ok: true });
		}

		const handler = POST_ROUTES[pathname];
		if (!handler) return json({ error: "not found" }, 404);
		if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

		const denied = checkAuth(request, env);
		if (denied) return denied;

		try {
			return await handler(request, env);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			return json({ error: `internal error: ${errorMessage(err)}` }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
