import { useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  addServer,
  errMsg,
  listInstalledServers,
  listServerCatalog,
  listServerTools,
  patchServer,
  removeServer,
  startOauth,
  testServer
} from "../../api/marketplace";
import { AlertIcon, CheckIcon, ExternalIcon, PencilIcon, PlusIcon, WrenchIcon, XIcon } from "../../icons";
import { cx, safeHttpUrl } from "../../lib";
import { isOauthResult } from "../../types/marketplace";
import type { AddServerOk, CatalogServer, InstalledServer, ServerAuth } from "../../types/marketplace";
import { ServerLogo } from "../ServerLogo";
import { CustomServerForm, HeadersEditor, headersProblem, newRow, rowsToHeaders } from "./CustomServerForm";
import type { HeaderRow, ServerFormMode } from "./CustomServerForm";
import {
  AuthBadge,
  Badge,
  Chips,
  ConfirmRemove,
  ERROR_KIND,
  EmptyState,
  ErrorState,
  Overlay,
  RefreshIcon,
  SectionHeader,
  SkeletonCards,
  SkeletonRows,
  Spinner,
  StateDot,
  Switch,
  btnDark,
  btnIcon,
  btnPrimary,
  btnSecondary,
  btnSmallPrimary,
  cardCls,
  inputCls,
  labelCls,
  matches,
  stateAccent,
  useLoad,
  useToast
} from "./ui";

/** known header names so the headers editor starts pre-filled */
const HEADER_HINTS: Record<string, string> = { context7: "CONTEXT7_API_KEY", exa: "x-api-key" };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const sameApp = (c: CatalogServer, s: InstalledServer) =>
  s.url === c.url || (!!s.logo && s.logo === c.logo) || s.name.toLowerCase() === c.name.toLowerCase();

interface AppsTabProps {
  query: string;
  installedOnly: boolean;
  connectedId: string | null;
  onChanged?: () => void;
  onClearFilters: () => void;
}

export function AppsTab({ query, installedOnly, connectedId, onChanged, onClearFilters }: AppsTabProps) {
  const toast = useToast();
  const catalog = useLoad(listServerCatalog);
  const installed = useLoad(listInstalledServers);
  const [category, setCategory] = useState("all");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectTarget, setConnectTarget] = useState<CatalogServer | null>(null);
  const [form, setForm] = useState<ServerFormMode | null>(null);
  const [toolsOf, setToolsOf] = useState<InstalledServer | null>(null);
  const [testing, setTesting] = useState<Set<string>>(() => new Set());
  const [bannerOpen, setBannerOpen] = useState(true);

  const markCatalog = (pred: (c: CatalogServer) => boolean, flag: boolean) =>
    catalog.setData((xs) => xs && xs.map((c) => (pred(c) ? { ...c, installed: flag } : c)));
  const patchRow = (id: string, patch: Partial<InstalledServer>) =>
    installed.setData((xs) => xs && xs.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  // ── connect ──
  const finishConnect = (app: CatalogServer, r: AddServerOk) => {
    markCatalog((c) => c.slug === app.slug, true);
    installed.setData((xs) => [
      ...(xs ?? []).filter((s) => s.id !== r.id),
      {
        id: r.id,
        name: r.name,
        url: r.url,
        source: "user",
        state: r.state,
        tool_count: r.tool_count,
        transport: "auto",
        auth_type: app.auth,
        enabled: true,
        oauth_status: null,
        logo: app.logo
      }
    ]);
    void installed.reload(true);
    onChanged?.();
    if (r.state === "error")
      toast({ tone: "error", text: `${app.name} was added but isn't responding — retest it under your apps.` });
    else toast({ tone: "ok", text: `${app.name} connected · ${plural(r.tool_count, "tool")}` });
  };

  const oneClick = async (app: CatalogServer) => {
    setConnecting(app.slug);
    markCatalog((c) => c.slug === app.slug, true); // optimistic
    try {
      const r = await addServer({ name: app.name, url: app.url, catalog_slug: app.slug, auth: { type: "none" } });
      if (isOauthResult(r)) {
        startOauth(r.authorize_url);
        return;
      }
      finishConnect(app, r);
    } catch (e) {
      markCatalog((c) => c.slug === app.slug, false);
      toast({
        tone: "error",
        text: `couldn't connect ${app.name} — ${errMsg(e, "try again")}`,
        action: { label: "retry", run: () => void oneClick(app) }
      });
    } finally {
      setConnecting(null);
    }
  };

  const connect = (app: CatalogServer) => {
    if (app.auth === "none") void oneClick(app);
    else setConnectTarget(app);
  };

  // ── installed row actions ──
  const toggle = async (s: InstalledServer, next: boolean) => {
    patchRow(s.id, { enabled: next });
    try {
      await patchServer(s.id, { enabled: next });
      onChanged?.();
    } catch (e) {
      patchRow(s.id, { enabled: !next });
      toast({
        tone: "error",
        text: `couldn't ${next ? "enable" : "disable"} ${s.name} — ${errMsg(e, "try again")}. reverted.`,
        action: { label: "retry", run: () => void toggle(s, next) }
      });
    }
  };

  const retest = async (s: InstalledServer) => {
    setTesting((t) => new Set(t).add(s.id));
    try {
      const r = await testServer(s.id);
      patchRow(s.id, { state: r.state, tool_count: r.tool_count, error: r.error });
      if (r.state === "ok") toast({ tone: "ok", text: `${s.name} is healthy · ${plural(r.tool_count, "tool")}` });
      else
        toast({
          tone: "error",
          text: `${s.name}: ${r.error ?? r.state}${r.error_kind ? ` (${ERROR_KIND[r.error_kind]?.label ?? r.error_kind})` : ""}`
        });
      onChanged?.();
    } catch (e) {
      toast({ tone: "error", text: `couldn't test ${s.name} — ${errMsg(e, "try again")}` });
    } finally {
      setTesting((t) => {
        const n = new Set(t);
        n.delete(s.id);
        return n;
      });
    }
  };

  const remove = async (s: InstalledServer) => {
    const idx = (installed.data ?? []).findIndex((x) => x.id === s.id);
    const pred = (c: CatalogServer) => sameApp(c, s);
    installed.setData((xs) => xs && xs.filter((x) => x.id !== s.id));
    markCatalog(pred, false);
    try {
      await removeServer(s.id);
      onChanged?.();
      toast({ tone: "info", text: `removed ${s.name}` });
    } catch (e) {
      installed.setData((xs) => {
        if (!xs) return xs;
        const next = [...xs];
        next.splice(Math.max(0, idx), 0, s);
        return next;
      });
      markCatalog(pred, true);
      toast({ tone: "error", text: `couldn't remove ${s.name} — ${errMsg(e, "try again")}` });
    }
  };

  // ── derived ──
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of catalog.data ?? []) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    return [
      { value: "all", label: "all" },
      ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, label: value, count }))
    ];
  }, [catalog.data]);

  const browsing = !query.trim() && category === "all" && !installedOnly;
  const featured = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((c) => c.featured)
        .sort((a, b) => Number(b.slug === "higgsfield") - Number(a.slug === "higgsfield"))
        .slice(0, 3),
    [catalog.data]
  );
  const catalogList = (catalog.data ?? []).filter(
    (c) =>
      (category === "all" || c.category === category) &&
      (!installedOnly || c.installed) &&
      matches(query, c.name, c.description, c.category)
  );
  const installedList = (installed.data ?? []).filter((s) => matches(query, s.name, s.url));
  const connected = connectedId ? (installed.data ?? []).find((s) => s.id === connectedId) : undefined;

  return (
    <div className="space-y-7">
      {connected && bannerOpen && (
        <div role="status" className={cx(cardCls, "motion-safe:rise flex items-center gap-3 border-l-bloop-deep bg-bloop/10 px-3.5 py-3")}>
          <ServerLogo name={connected.name} url={connected.url} logo={connected.logo} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 font-wordmark text-sm font-bold text-neutral-900">
              <CheckIcon className="h-4 w-4 text-bloop-deep" /> {connected.name} connected
            </p>
            <p className="text-xs text-neutral-700">
              {connected.state === "ok"
                ? `${plural(connected.tool_count, "tool")} ready — just ask bloop to use ${connected.name}.`
                : "authorized, but the server isn't healthy yet — retest it below."}
            </p>
          </div>
          <button type="button" onClick={() => setBannerOpen(false)} aria-label="dismiss" className={btnIcon}>
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* featured */}
      {browsing && (catalog.status === "loading" || featured.length > 0) && (
        <section aria-labelledby="mk-featured">
          <SectionHeader id="mk-featured" title="featured" />
          {catalog.status === "loading" ? (
            <SkeletonCards count={3} />
          ) : (
            <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 scroll-thin sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-4">
              {featured.map((c, i) => (
                <CatalogCard
                  key={c.slug}
                  app={c}
                  index={i}
                  hero={i === 0}
                  busy={connecting === c.slug}
                  onConnect={() => connect(c)}
                  className={cx("w-[85%] shrink-0 snap-start sm:w-auto", i === 0 && "sm:col-span-2")}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* installed */}
      <section aria-labelledby="mk-installed">
        <SectionHeader id="mk-installed" title="your apps" count={installed.data ? installedList.length : undefined}>
          <button type="button" onClick={() => setForm({ kind: "new" })} className={btnSecondary}>
            <PlusIcon className="h-3.5 w-3.5" /> custom mcp
          </button>
        </SectionHeader>
        {installed.status === "loading" ? (
          <SkeletonRows count={2} />
        ) : installed.status === "error" ? (
          <ErrorState text={`couldn't load your apps. ${installed.error}`} onRetry={() => void installed.reload()} />
        ) : installedList.length === 0 ? (
          query.trim() ? (
            <p className="py-3 text-xs text-neutral-500">none of your apps match &ldquo;{query.trim()}&rdquo;.</p>
          ) : (
            <EmptyState icon={<WrenchIcon className="h-4 w-4" />} title="no apps connected yet">
              connect one from the catalog below, or add any remote mcp server with <strong>custom mcp</strong>.
            </EmptyState>
          )
        ) : (
          <ul className="space-y-2">
            {installedList.map((s) => (
              <InstalledRow
                key={s.id}
                server={s}
                testing={testing.has(s.id)}
                onToggle={(v) => void toggle(s, v)}
                onRetest={() => void retest(s)}
                onTools={() => setToolsOf(s)}
                onEdit={() => setForm({ kind: "edit", server: s })}
                onRemove={() => void remove(s)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* catalog */}
      <section aria-labelledby="mk-catalog">
        <SectionHeader id="mk-catalog" title="catalog" count={catalog.data ? catalogList.length : undefined} />
        <div className="mb-3">
          <Chips label="filter apps by category" options={categories} value={category} onChange={setCategory} />
        </div>
        {catalog.status === "loading" ? (
          <SkeletonCards count={6} />
        ) : catalog.status === "error" ? (
          <ErrorState text={`couldn't load the catalog. ${catalog.error}`} onRetry={() => void catalog.reload()} />
        ) : catalogList.length === 0 ? (
          <EmptyState
            title={query.trim() ? `no apps match “${query.trim()}”` : "nothing here"}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => {
                    setCategory("all");
                    onClearFilters();
                  }}
                  className={btnSecondary}
                >
                  clear filters
                </button>
                <button type="button" onClick={() => setForm({ kind: "new" })} className={btnSmallPrimary}>
                  add custom mcp
                </button>
              </>
            }
          >
            don&rsquo;t see your app? any remote mcp server works — paste its url.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {catalogList.map((c, i) => (
              <CatalogCard key={c.slug} app={c} index={i} busy={connecting === c.slug} onConnect={() => connect(c)} />
            ))}
          </ul>
        )}
      </section>

      {connectTarget && (
        <ConnectOverlay
          app={connectTarget}
          onClose={() => setConnectTarget(null)}
          onConnected={(r) => {
            const app = connectTarget;
            setConnectTarget(null);
            finishConnect(app, r);
          }}
        />
      )}
      {form && (
        <CustomServerForm
          mode={form}
          onClose={() => setForm(null)}
          onSaved={({ name, created }) => {
            setForm(null);
            void installed.reload(true);
            void catalog.reload(true);
            onChanged?.();
            toast({ tone: "ok", text: created ? `${name} added` : `saved ${name}` });
          }}
        />
      )}
      {toolsOf && <ToolsDrawer server={toolsOf} onClose={() => setToolsOf(null)} />}
    </div>
  );
}

// ── catalog card ─────────────────────────────────────────────────
function CatalogCard({
  app,
  index,
  hero,
  busy,
  onConnect,
  className
}: {
  app: CatalogServer;
  index: number;
  hero?: boolean;
  busy: boolean;
  onConnect: () => void;
  className?: string;
}) {
  const docs = safeHttpUrl(app.docs_url);
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      className={cx(
        cardCls,
        "motion-safe:rise flex flex-col p-3.5 transition-shadow duration-150 hover:shadow-md",
        app.installed ? "border-l-bloop" : "border-l-neutral-300",
        hero && "sm:p-5",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <ServerLogo name={app.name} url={app.url} logo={app.logo} className={hero ? "h-14 w-14" : "h-10 w-10"} />
        <div className="min-w-0 flex-1">
          <h4 className={cx("truncate font-wordmark font-bold leading-tight text-neutral-900", hero ? "text-xl" : "text-sm")}>
            {app.name}
          </h4>
          <div className="mt-1 flex flex-wrap gap-1">
            <AuthBadge auth={app.auth} />
            <Badge>{app.category}</Badge>
            {hero && <Badge tone="lime">featured</Badge>}
          </div>
        </div>
      </div>
      <p className={cx("mt-2.5 flex-1 text-xs leading-relaxed text-neutral-600", hero ? "line-clamp-3 sm:text-sm" : "line-clamp-2")}>
        {app.description}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        {docs ? (
          <a
            href={docs}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full text-[11px] font-medium text-neutral-500 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep"
          >
            docs <ExternalIcon className="h-3 w-3" />
            <span className="sr-only">for {app.name} (opens in a new tab)</span>
          </a>
        ) : (
          <span />
        )}
        {app.installed ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-800">
            <CheckIcon className="h-3.5 w-3.5 text-bloop-deep" /> installed
          </span>
        ) : (
          <button type="button" onClick={onConnect} disabled={busy} aria-label={`connect ${app.name}`} className={btnSmallPrimary}>
            {busy ? (
              <>
                <Spinner className="h-3 w-3" /> connecting…
              </>
            ) : (
              "connect"
            )}
          </button>
        )}
      </div>
    </li>
  );
}

// ── installed row ────────────────────────────────────────────────
function InstalledRow({
  server: s,
  testing,
  onToggle,
  onRetest,
  onTools,
  onEdit,
  onRemove
}: {
  server: InstalledServer;
  testing: boolean;
  onToggle: (v: boolean) => void;
  onRetest: () => void;
  onTools: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const user = s.source === "user";
  const needsOauth = s.oauth_status === "required";
  return (
    <li className={cx(cardCls, stateAccent(s.state), "motion-safe:rise px-3.5 py-3", !s.enabled && "bg-neutral-50")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ServerLogo name={s.name} url={s.url} logo={s.logo} className={cx(!s.enabled && "opacity-50 grayscale")} />
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-wordmark text-sm font-bold text-neutral-900">{s.name}</span>
            <StateDot state={s.state} showLabel />
            <Badge>{plural(s.tool_count, "tool")}</Badge>
            {user ? <AuthBadge auth={s.auth_type} /> : <Badge tone="lime">built in</Badge>}
            {!s.enabled && <Badge>off</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">{s.url}</p>
        </div>
        <div className="flex w-full items-center justify-end gap-1 sm:w-auto">
          <button type="button" onClick={onTools} disabled={needsOauth} className={btnSecondary} aria-label={`view ${s.name} tools`}>
            <WrenchIcon className="h-3.5 w-3.5" /> tools
          </button>
          <button type="button" onClick={onRetest} disabled={testing} className={btnIcon} aria-label={`retest ${s.name}`} title="retest connection">
            {testing ? <Spinner /> : <RefreshIcon className="h-3.5 w-3.5" />}
          </button>
          {user && (
            <button type="button" onClick={onEdit} className={btnIcon} aria-label={`edit ${s.name}`} title="edit">
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          )}
          {user && <ConfirmRemove label={s.name} onConfirm={onRemove} />}
          <span className="ml-1">
            <Switch checked={s.enabled} onChange={onToggle} label={`${s.enabled ? "disable" : "enable"} ${s.name}`} />
          </span>
        </div>
      </div>
      {(s.error || needsOauth) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <AlertIcon className="h-3.5 w-3.5 shrink-0 text-red-600" />
          <span className="min-w-0 flex-1 text-red-800">{needsOauth ? "finish signing in to use this app." : s.error}</span>
          {needsOauth && (
            <button
              type="button"
              onClick={() => startOauth(`/api/servers/${encodeURIComponent(s.id)}/oauth/start`)}
              className={btnSmallPrimary}
            >
              connect with {s.name}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// ── connect overlay (bearer · headers · oauth) ───────────────────
function ConnectOverlay({
  app,
  onClose,
  onConnected
}: {
  app: CatalogServer;
  onClose: () => void;
  onConnected: (r: AddServerOk) => void;
}) {
  const formId = useId();
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>(() => [newRow(HEADER_HINTS[app.slug] ?? "")]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tried, setTried] = useState(false);
  const docs = safeHttpUrl(app.docs_url);

  const problem =
    app.auth === "bearer" ? (token.trim() ? null : "paste a token to continue") : app.auth === "headers" ? headersProblem(rows, true) : null;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setError("");
    try {
      const auth: ServerAuth =
        app.auth === "bearer"
          ? { type: "bearer", token: token.trim() }
          : app.auth === "headers"
            ? { type: "headers", headers: rowsToHeaders(rows) }
            : { type: app.auth };
      const r = await addServer({ name: app.name, url: app.url, catalog_slug: app.slug, auth });
      if (isOauthResult(r)) {
        if (!startOauth(r.authorize_url)) {
          setError("the sign-in link looked unsafe, so bloop didn't open it.");
          setBusy(false);
        }
        return; // navigating away
      }
      setToken("");
      onConnected(r);
    } catch (err) {
      setError(errMsg(err, `couldn't connect ${app.name}.`));
      setBusy(false);
    }
  };

  const oauth = app.auth === "oauth";
  return (
    <Overlay
      size="dialog"
      title={`connect ${app.name}`}
      subtitle={<span className="font-mono">{app.url}</span>}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={btnSecondary}>
            cancel
          </button>
          {oauth ? (
            <button type="submit" form={formId} disabled={busy} className={btnDark} data-autofocus>
              {busy ? <Spinner /> : <ServerLogo name={app.name} url={app.url} logo={app.logo} className="h-5 w-5 border-0" />}
              connect with {app.name}
            </button>
          ) : (
            <button type="submit" form={formId} disabled={busy} className={btnPrimary}>
              {busy && <Spinner />} connect
            </button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <div className="flex items-start gap-3">
          <ServerLogo name={app.name} url={app.url} logo={app.logo} className="h-12 w-12" />
          <p className="text-xs leading-relaxed text-neutral-600">{app.description}</p>
        </div>

        {app.auth === "bearer" && (
          <div>
            <label htmlFor={`${formId}-token`} className={labelCls}>
              api token
            </label>
            <input
              id={`${formId}-token`}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder="paste token"
              data-autofocus
              aria-invalid={tried && !!problem}
              aria-describedby={`${formId}-hint`}
              className={cx(inputCls, "font-mono text-xs")}
            />
            <p id={`${formId}-hint`} className={cx("mt-1 text-[11px]", tried && problem ? "font-medium text-red-700" : "text-neutral-500")}>
              {tried && problem ? problem : "stored encrypted on the server and never shown again."}
            </p>
          </div>
        )}

        {app.auth === "headers" && (
          <>
            <HeadersEditor rows={rows} onChange={setRows} error={tried ? problem : null} autoFocus />
            <p className="text-[11px] text-neutral-500">header values are stored encrypted and never shown again.</p>
          </>
        )}

        {oauth && (
          <p className={cx(cardCls, "border-l-amber-400 px-3 py-2.5 text-xs leading-relaxed text-neutral-700")}>
            you&rsquo;ll be sent to {app.name} to approve access, then brought straight back here. bloop never sees your
            password.
          </p>
        )}

        {docs && (
          <a
            href={docs}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
          >
            {app.auth === "oauth" ? `about the ${app.name} mcp server` : "where do i find this?"} <ExternalIcon className="h-3 w-3" />
          </a>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </form>
    </Overlay>
  );
}

// ── tools drawer ─────────────────────────────────────────────────
const ANNOTATION_BADGES: { key: "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"; label: string; tone: "neutral" | "red" | "sky" }[] = [
  { key: "readOnlyHint", label: "read only", tone: "neutral" },
  { key: "destructiveHint", label: "destructive", tone: "red" },
  { key: "idempotentHint", label: "idempotent", tone: "neutral" },
  { key: "openWorldHint", label: "open world", tone: "sky" }
];

function ToolsDrawer({ server, onClose }: { server: InstalledServer; onClose: () => void }) {
  const tools = useLoad(() => listServerTools(server.id));
  const [filter, setFilter] = useState("");
  const list = (tools.data ?? []).filter((t) => matches(filter, t.name, t.description, t.annotations?.title));
  const uiCount = (tools.data ?? []).filter((t) => t.has_ui).length;

  return (
    <Overlay
      title={`${server.name} tools`}
      subtitle={
        tools.data ? (
          <>
            {plural(tools.data.length, "tool")}
            {uiCount > 0 && ` · ${uiCount} with app ui`}
          </>
        ) : (
          server.url
        )
      }
      onClose={onClose}
    >
      {tools.status === "loading" ? (
        <SkeletonRows count={4} />
      ) : tools.status === "error" ? (
        <ErrorState text={`couldn't list tools. ${tools.error}`} onRetry={() => void tools.reload()} />
      ) : (
        <>
          {(tools.data?.length ?? 0) > 6 && (
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter tools…"
              aria-label={`filter ${server.name} tools`}
              className={cx(inputCls, "mb-3")}
              data-autofocus
            />
          )}
          {list.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-500">no tools to show.</p>
          ) : (
            <ul className="space-y-2">
              {list.map((t) => (
                <li key={t.name} className={cx(cardCls, t.annotations?.destructiveHint ? "border-l-red-400" : t.has_ui ? "border-l-bloop" : "border-l-neutral-300", "px-3 py-2.5")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="break-all font-mono text-xs font-semibold text-neutral-900">{t.name}</span>
                    {t.has_ui && <Badge tone="lime">app ui</Badge>}
                    {ANNOTATION_BADGES.filter((a) => t.annotations?.[a.key]).map((a) => (
                      <Badge key={a.key} tone={a.tone}>
                        {a.label}
                      </Badge>
                    ))}
                  </div>
                  {t.annotations?.title && <p className="mt-1 text-xs font-medium text-neutral-800">{t.annotations.title}</p>}
                  {t.description && <p className="mt-0.5 text-xs leading-relaxed text-neutral-600">{t.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Overlay>
  );
}
