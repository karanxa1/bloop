import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  addServer,
  errMsg,
  patchServer,
  removeServer,
  startOauth,
  testServer
} from "../../api/marketplace";
import { AlertIcon, PlusIcon, XIcon } from "../../icons";
import { cx } from "../../lib";
import { isOauthResult } from "../../types/marketplace";
import type {
  AddServerOk,
  AuthType,
  InstalledServer,
  PatchServerBody,
  ServerAuth,
  TestResult,
  Transport
} from "../../types/marketplace";
import {
  Badge,
  ERROR_KIND,
  Overlay,
  RefreshIcon,
  Spinner,
  StateDot,
  btnDark,
  btnIcon,
  btnPrimary,
  btnSecondary,
  cardCls,
  inputCls,
  labelCls,
  stateAccent
} from "./ui";

// ── headers editor ───────────────────────────────────────────────
export interface HeaderRow {
  id: number;
  key: string;
  value: string;
}
let rowSeq = 0;
export const newRow = (key = ""): HeaderRow => ({ id: ++rowSeq, key, value: "" });

/** RFC 9110 token characters */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function headersProblem(rows: HeaderRow[], required: boolean): string | null {
  const filled = rows.filter((r) => r.key.trim() || r.value);
  if (!filled.length) return required ? "add at least one header" : null;
  const seen = new Set<string>();
  for (const r of filled) {
    const k = r.key.trim();
    if (!k) return "every header needs a name";
    if (!HEADER_NAME.test(k)) return `“${k}” isn't a valid header name`;
    if (!r.value) return `add a value for ${k}`;
    if (seen.has(k.toLowerCase())) return `${k} is listed twice`;
    seen.add(k.toLowerCase());
  }
  return null;
}

export const rowsToHeaders = (rows: HeaderRow[]) =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

export function HeadersEditor({
  rows,
  onChange,
  error,
  valuePlaceholder = "value",
  autoFocus
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  error?: string | null;
  valuePlaceholder?: string;
  autoFocus?: boolean;
}) {
  const errId = useId();
  const set = (id: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <fieldset aria-describedby={error ? errId : undefined}>
      <legend className={labelCls}>headers</legend>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.id} className="flex items-center gap-2">
            <input
              value={r.key}
              onChange={(e) => set(r.id, { key: e.target.value })}
              placeholder="x-api-key"
              aria-label={`header ${i + 1} name`}
              autoComplete="off"
              spellCheck={false}
              data-autofocus={autoFocus && i === 0 && !r.key ? true : undefined}
              className={cx(inputCls, "flex-[2] font-mono text-xs")}
            />
            <input
              value={r.value}
              onChange={(e) => set(r.id, { value: e.target.value })}
              type="password"
              placeholder={valuePlaceholder}
              aria-label={`header ${i + 1} value`}
              autoComplete="new-password"
              spellCheck={false}
              data-autofocus={autoFocus && i === 0 && r.key ? true : undefined}
              className={cx(inputCls, "flex-[3] font-mono text-xs")}
            />
            <button
              type="button"
              className={btnIcon}
              aria-label={`remove header ${i + 1}`}
              disabled={rows.length === 1 && !r.key && !r.value}
              onClick={() => onChange(rows.length === 1 ? [newRow()] : rows.filter((x) => x.id !== r.id))}
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...rows, newRow()])}
        className="mt-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <PlusIcon className="h-3.5 w-3.5" /> add header
      </button>
      {error && (
        <p id={errId} className="mt-1 text-[11px] font-medium text-red-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}

// ── custom server form ───────────────────────────────────────────
export function urlProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "enter the server url";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "that doesn't look like a url";
  }
  if (u.protocol !== "https:") return "use an https:// url";
  if (!u.hostname.includes(".")) return "use a public hostname, e.g. mcp.example.com";
  if (u.username || u.password) return "don't put credentials in the url — use auth below";
  return null;
}

const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: "auto", label: "auto-detect" },
  { value: "streamable-http", label: "streamable http" },
  { value: "sse", label: "sse (legacy)" }
];
const AUTH_OPTS: { value: AuthType; label: string }[] = [
  { value: "none", label: "none" },
  { value: "bearer", label: "bearer token" },
  { value: "headers", label: "headers" },
  { value: "oauth", label: "oauth" }
];

export type ServerFormMode = { kind: "new" } | { kind: "edit"; server: InstalledServer };

interface Resolved {
  id: string;
  fresh?: AddServerOk;
  oauth?: string;
}

export function CustomServerForm({
  mode,
  onClose,
  onSaved
}: {
  mode: ServerFormMode;
  onClose: () => void;
  onSaved: (info: { id: string; name: string; created: boolean }) => void;
}) {
  const editing = mode.kind === "edit" ? mode.server : null;
  const ids = useId();
  const formId = `${ids}-form`;
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [transport, setTransport] = useState<Transport>(editing?.transport ?? "auto");
  const [authType, setAuthType] = useState<AuthType>(editing?.auth_type ?? "none");
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>(() => [newRow()]);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<"idle" | "testing" | "saving">("idle");
  const [result, setResult] = useState<TestResult | null>(null);
  const [testedSig, setTestedSig] = useState("");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const draft = useRef<{ id: string; sig: string; oauth?: string } | null>(null);
  const saved = useRef(false);

  const connSig = JSON.stringify([url.trim(), transport, authType]);
  const fullSig = JSON.stringify([name.trim(), connSig, token, rows.map((r) => [r.key, r.value])]);
  const stale = result !== null && testedSig !== fullSig;

  const errors = {
    name: !name.trim() ? "give it a name" : name.trim().length > 40 ? "keep it under 40 characters" : null,
    url: editing ? null : urlProblem(url),
    token: authType === "bearer" && !editing && !token.trim() ? "paste the bearer token" : null,
    headers: authType === "headers" ? headersProblem(rows, !editing) : null
  };
  const invalid = Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (tried ? errors[k] : null);

  const authPayload = (): ServerAuth =>
    authType === "bearer"
      ? { type: "bearer", token: token.trim() }
      : authType === "headers"
        ? { type: "headers", headers: rowsToHeaders(rows) }
        : { type: authType };

  const secretPatch = (): PatchServerBody => ({
    ...(authType === "bearer" && token.trim() ? { token: token.trim() } : {}),
    ...(authType === "headers" && rows.some((r) => r.key.trim()) ? { headers: rowsToHeaders(rows) } : {})
  });

  /** create / update the server behind this form and return its id */
  const resolveServer = async (): Promise<Resolved> => {
    if (editing) {
      const patch = { ...secretPatch(), ...(name.trim() !== editing.name ? { name: name.trim() } : {}) };
      if (Object.keys(patch).length) await patchServer(editing.id, patch);
      return { id: editing.id };
    }
    if (draft.current && draft.current.sig !== connSig) {
      // url / transport / auth type changed — those can't be patched, so start over
      const old = draft.current.id;
      draft.current = null;
      setOauthUrl(null);
      void removeServer(old).catch(() => {});
    }
    if (draft.current) {
      await patchServer(draft.current.id, { name: name.trim(), ...secretPatch() });
      return { id: draft.current.id, oauth: draft.current.oauth };
    }
    const r = await addServer({ name: name.trim(), url: url.trim(), transport, auth: authPayload() });
    if (isOauthResult(r)) {
      draft.current = { id: r.id, sig: connSig, oauth: r.authorize_url };
      setOauthUrl(r.authorize_url);
      return { id: r.id, oauth: r.authorize_url };
    }
    draft.current = { id: r.id, sig: connSig };
    return { id: r.id, fresh: r };
  };

  const test = async () => {
    setTried(true);
    if (invalid || phase !== "idle") return;
    const sig = fullSig;
    setPhase("testing");
    setFormError("");
    try {
      const res = await resolveServer();
      let r: TestResult;
      if (res.oauth)
        r = { state: "error", tool_count: 0, tools: [], error: "authorize with oauth to finish connecting", error_kind: "auth" };
      else if (res.fresh && res.fresh.state === "ok")
        r = { state: "ok", tool_count: res.fresh.tool_count, tools: res.fresh.tools };
      else r = await testServer(res.id);
      setResult(r);
      setTestedSig(sig);
    } catch (e) {
      setFormError(errMsg(e, "couldn't run the test — try again."));
    } finally {
      setPhase("idle");
    }
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (invalid || phase !== "idle") return;
    setPhase("saving");
    setFormError("");
    try {
      const res = await resolveServer();
      saved.current = true;
      if (res.oauth) {
        if (startOauth(res.oauth)) return; // leaving the page
        saved.current = false;
        setFormError("the sign-in link looked unsafe, so bloop didn't open it.");
        setPhase("idle");
        return;
      }
      onSaved({ id: res.id, name: name.trim(), created: !editing });
    } catch (err) {
      setFormError(errMsg(err, "couldn't save this server."));
      setPhase("idle");
    }
  };

  const cancel = () => {
    if (!saved.current && draft.current) void removeServer(draft.current.id).catch(() => {});
    onClose();
  };

  const field = (k: string) => `${ids}-${k}`;
  const errText = (k: keyof typeof errors) =>
    show(k) ? (
      <p id={field(`${k}-err`)} className="mt-1 text-[11px] font-medium text-red-700">
        {show(k)}
      </p>
    ) : null;

  return (
    <Overlay
      title={editing ? `edit ${editing.name}` : "custom mcp server"}
      subtitle={
        editing
          ? "secrets are write-only — leave them blank to keep what's saved."
          : "connect any remote mcp server by url."
      }
      onClose={cancel}
      footer={
        <>
          <button type="button" onClick={cancel} className={btnSecondary}>
            cancel
          </button>
          <button type="button" onClick={() => void test()} disabled={phase !== "idle"} className={btnSecondary}>
            {phase === "testing" ? <Spinner /> : <RefreshIcon className="h-3.5 w-3.5" />}
            test connection
          </button>
          <button type="submit" form={formId} disabled={phase !== "idle"} className={btnPrimary}>
            {phase === "saving" && <Spinner />}
            {editing ? "save changes" : authType === "oauth" ? "save & authorize" : "save"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={save} noValidate className="space-y-4">
        <div>
          <label htmlFor={field("name")} className={labelCls}>
            name
          </label>
          <input
            id={field("name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. internal-crm"
            autoComplete="off"
            data-autofocus
            aria-invalid={!!show("name")}
            aria-describedby={show("name") ? field("name-err") : undefined}
            className={inputCls}
          />
          {errText("name")}
        </div>

        <div>
          <label htmlFor={field("url")} className={labelCls}>
            server url
          </label>
          <input
            id={field("url")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            inputMode="url"
            placeholder="https://mcp.example.com/mcp"
            autoComplete="off"
            spellCheck={false}
            disabled={!!editing}
            aria-invalid={!!show("url")}
            aria-describedby={show("url") ? field("url-err") : editing ? field("url-hint") : undefined}
            className={cx(inputCls, "font-mono text-xs")}
          />
          {editing && (
            <p id={field("url-hint")} className="mt-1 text-[11px] text-neutral-500">
              the url can&rsquo;t change — remove the server and add it again to move it.
            </p>
          )}
          {errText("url")}
        </div>

        <div>
          <label htmlFor={field("transport")} className={labelCls}>
            transport
          </label>
          <select
            id={field("transport")}
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            disabled={!!editing}
            className={cx(inputCls, "appearance-auto")}
          >
            {TRANSPORTS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset disabled={!!editing}>
          <legend className={labelCls}>authentication</legend>
          <div className="flex flex-wrap gap-1.5">
            {AUTH_OPTS.map((o) => {
              const on = authType === o.value;
              return (
                <label
                  key={o.value}
                  className={cx(
                    "cursor-pointer rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-bloop-deep has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                    on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400"
                  )}
                >
                  <input
                    type="radio"
                    name={field("auth")}
                    value={o.value}
                    checked={on}
                    onChange={() => setAuthType(o.value)}
                    className="sr-only"
                  />
                  {o.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {authType === "bearer" && (
          <div>
            <label htmlFor={field("token")} className={labelCls}>
              bearer token
            </label>
            <input
              id={field("token")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={editing ? "•••••• saved — paste to replace" : "paste token"}
              aria-invalid={!!show("token")}
              aria-describedby={show("token") ? field("token-err") : undefined}
              className={cx(inputCls, "font-mono text-xs")}
            />
            {errText("token")}
          </div>
        )}
        {authType === "headers" && (
          <HeadersEditor
            rows={rows}
            onChange={setRows}
            error={show("headers")}
            valuePlaceholder={editing ? "•••••• saved — type to replace" : "value"}
          />
        )}
        {authType === "oauth" && (
          <p className={cx(cardCls, "border-l-amber-400 px-3 py-2.5 text-xs leading-relaxed text-neutral-700")}>
            bloop will send you to the server&rsquo;s sign-in page and bring you back here once you approve access.
          </p>
        )}

        {formError && (
          <div role="alert" className="flex items-start gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        <div aria-live="polite">
          {phase === "testing" && (
            <p className="flex items-center gap-2 text-xs text-neutral-600">
              <Spinner /> connecting and listing tools…
            </p>
          )}
          {result && phase !== "testing" && (
            <section className={cx(cardCls, stateAccent(result.state), "p-3", stale && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <StateDot state={result.state} showLabel />
                {result.state !== "error" && (
                  <Badge>
                    {result.tool_count} {result.tool_count === 1 ? "tool" : "tools"}
                  </Badge>
                )}
                {result.error_kind && <Badge tone={result.error_kind === "auth" ? "amber" : "red"}>{ERROR_KIND[result.error_kind]?.label ?? result.error_kind}</Badge>}
                {stale && <span className="text-[11px] font-medium text-neutral-600">fields changed — test again</span>}
              </div>
              {result.error && <p className="mt-1.5 text-xs text-red-800">{result.error}</p>}
              {result.error_kind && <p className="mt-1 text-[11px] text-neutral-600">{ERROR_KIND[result.error_kind]?.hint}</p>}
              {oauthUrl && (
                <button type="button" onClick={() => startOauth(oauthUrl)} className={cx(btnDark, "mt-2.5")}>
                  connect with {name.trim() || "oauth"}
                </button>
              )}
              {result.tools.length > 0 && (
                <ul className="mt-2.5 max-h-52 space-y-1.5 overflow-y-auto scroll-thin border-t border-neutral-100 pt-2.5">
                  {result.tools.map((t) => (
                    <li key={t.name} className="text-xs">
                      <span className="font-mono font-semibold text-neutral-900">{t.name}</span>
                      {t.description && <span className="text-neutral-600"> — {t.description}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </form>
    </Overlay>
  );
}
