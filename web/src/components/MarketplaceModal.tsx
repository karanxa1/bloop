import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, addServer, deleteServer, listServers } from "../api";
import type { McpServer } from "../types";
import { Modal } from "./Modal";
import { ServerLogo } from "./ServerLogo";
import {
  AlertIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon
} from "../icons";
import { cx } from "../lib";

const CATEGORIES = ["all", "productivity", "dev tools", "files", "data"];

/** well-known MCP servers users can add in one click */
const POPULAR: { name: string; url: string; blurb: string }[] = [
  { name: "zapier", url: "https://mcp.zapier.com", blurb: "slack · gmail · notion · 8k apps" },
  { name: "github", url: "https://api.githubcopilot.com/mcp/", blurb: "issues, prs, code search" },
  { name: "huggingface", url: "https://hf.co/mcp", blurb: "models, datasets, spaces" },
  { name: "linear", url: "https://mcp.linear.app/mcp", blurb: "issues + projects" },
  { name: "notion", url: "https://mcp.notion.com/mcp", blurb: "docs + databases" },
  { name: "sentry", url: "https://mcp.sentry.dev/mcp", blurb: "errors + traces" },
  { name: "figma", url: "https://mcp.figma.com/mcp", blurb: "designs + components" },
  { name: "cloudflare", url: "https://docs.mcp.cloudflare.com/mcp", blurb: "workers docs" }
];

interface MarketplaceModalProps {
  onClose: () => void;
  /** fired whenever the server list changes so the header count can refresh */
  onChanged?: () => void;
}

const inputCls =
  "w-full border border-neutral-300 bg-page px-3 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40";

export function MarketplaceModal({ onClose, onChanged }: MarketplaceModalProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeErrorId, setRemoveErrorId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    listServers()
      .then((s) => {
        if (!cancelled) setServers(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q)
    );
  }, [servers, query]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError("");
    setBusy(true);
    try {
      const created = await addServer(name.trim(), url.trim(), token.trim() || undefined);
      setServers((s) => [created, ...s]);
      setName("");
      setUrl("");
      setToken("");
      setFormOpen(false);
      onChanged?.();
    } catch (err) {
      if (err instanceof ApiError && err.message) setFormError(err.message);
      else setFormError("could not add that server.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (removingId) return;
    setRemovingId(id);
    setRemoveErrorId(null);
    try {
      await deleteServer(id);
      setServers((s) => s.filter((x) => x.id !== id));
      onChanged?.();
    } catch {
      setRemoveErrorId(id); // leave the card in place with an inline note
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Modal title="tools" onClose={onClose} wide>
      <div className="px-5 py-4">
        {/* search + decorative categories */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search connected servers…"
            aria-label="search servers"
            className="w-full border border-neutral-300 bg-page py-2 pl-9 pr-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40"
          />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5" aria-hidden="true">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              tabIndex={-1}
              onClick={() => setCategory(c)}
              className={cx(
                "rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors duration-150",
                category === c
                  ? "bg-bloop text-white"
                  : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
              )}
            >
              {c}
            </button>
          ))}
        </div>

        {/* server grid */}
        <div className="mt-4">
          {loading ? (
            <div aria-busy="true">
              <span className="sr-only">loading servers…</span>
              <ul className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <li key={i} className="border border-neutral-200 bg-white p-3.5">
                    <div className="flex items-start gap-2.5">
                      <span className="h-9 w-9 shrink-0 bg-neutral-100 motion-safe:animate-pulse" />
                      <span className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                        <span className="block h-3 w-1/2 bg-neutral-200 motion-safe:animate-pulse" />
                        <span className="block h-2 w-4/5 bg-neutral-100 motion-safe:animate-pulse" />
                      </span>
                    </div>
                    <div className="mt-3 flex gap-1.5">
                      <span className="h-4 w-12 rounded-full bg-neutral-100 motion-safe:animate-pulse" />
                      <span className="h-4 w-14 rounded-full bg-neutral-100 motion-safe:animate-pulse" />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : loadError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 border border-neutral-200 border-l-2 border-l-red-500 bg-white px-3 py-2.5 text-xs text-neutral-700"
            >
              <AlertIcon className="h-4 w-4 text-red-600" />
              <span className="flex-1">could not load servers.</span>
              <button
                type="button"
                onClick={() => setReloadTick((t) => t + 1)}
                className="rounded-full bg-bloop px-3 py-1 font-wordmark text-xs font-bold text-neutral-900 transition-colors duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
              >
                retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-xs text-neutral-400">
              {query ? `nothing matches “${query}”.` : "no servers connected yet."}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {filtered.map((s, i) => (
                <li
                  key={s.id}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="motion-safe:rise border border-neutral-200 bg-white p-3.5"
                >
                  <div className="flex items-start gap-2.5">
                    <ServerLogo name={s.name} url={s.url} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-wordmark text-sm font-bold text-neutral-800">
                          {s.name}
                        </span>
                        <span
                          className={cx(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            s.state === "ok" ? "bg-bloop" : "bg-red-400"
                          )}
                          title={s.state === "ok" ? "connected" : "error"}
                        />
                      </div>
                      <span className="block truncate font-mono text-[10px] text-neutral-400">
                        {s.url}
                      </span>
                    </div>
                    {s.source === "user" && (
                      <button
                        type="button"
                        onClick={() => remove(s.id)}
                        disabled={removingId === s.id}
                        aria-label={`remove ${s.name}`}
                        className="rounded-full p-1.5 text-neutral-400 transition-colors duration-150 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:opacity-60"
                      >
                        {removingId === s.id ? (
                          <SpinnerIcon className="h-3.5 w-3.5" />
                        ) : (
                          <TrashIcon className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                  {removeErrorId === s.id && (
                    <p role="alert" className="mt-2 text-[11px] text-red-600">
                      couldn&rsquo;t remove this server — try again.
                    </p>
                  )}
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
                      {s.tool_count} {s.tool_count === 1 ? "tool" : "tools"}
                    </span>
                    <span
                      className={cx(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        s.source === "global"
                          ? "bg-bloop/15 text-bloop-deep"
                          : "bg-neutral-900 text-white"
                      )}
                    >
                      {s.source === "global" ? "built in" : "yours"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* popular catalog — click prefills the add form */}
        {!query && (
          <div className="mt-4">
            <p className="mb-2 font-wordmark text-xs font-bold text-bloop-deep/70">
              popular servers
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {POPULAR.map((p) => {
                const added = servers.some(
                  (s) => s.name.toLowerCase() === p.name || s.url === p.url
                );
                return (
                  <li key={p.name}>
                    <button
                      type="button"
                      disabled={added}
                      onClick={() => {
                        setName(p.name);
                        setUrl(p.url);
                        setFormOpen(true);
                      }}
                      className={cx(
                        "flex w-full items-center gap-2.5 border border-neutral-200 bg-white p-2.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-bloop-deep",
                        added ? "opacity-45" : "hover:border-bloop/60 hover:bg-bloop/5"
                      )}
                    >
                      <ServerLogo name={p.name} url={p.url} className="h-8 w-8" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-wordmark text-xs font-bold text-neutral-800">
                          {p.name}
                        </span>
                        <span className="block truncate text-[10px] text-neutral-400">
                          {p.blurb}
                        </span>
                      </span>
                      {added ? (
                        <span className="text-[10px] font-semibold text-bloop-deep">added</span>
                      ) : (
                        <PlusIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* add server */}
        <div className="mt-4 border-t border-neutral-100 pt-4">
          {!formOpen ? (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-bloop px-4 py-2 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-bloop-deep motion-safe:hover:-translate-y-px"
            >
              <PlusIcon className="h-4 w-4" />
              add mcp server
            </button>
          ) : (
            <form onSubmit={submit} className="space-y-2.5">
              <p className="font-wordmark text-sm font-bold text-bloop-deep">
                add mcp server
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="name — e.g. linear"
                  aria-label="server name"
                  className={inputCls}
                />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                  type="url"
                  placeholder="url — https://mcp.example.com/sse"
                  aria-label="server url"
                  className={inputCls}
                />
              </div>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder="token (optional)"
                aria-label="server token, optional"
                className={inputCls}
              />
              {formError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                >
                  <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-full bg-bloop px-4 py-2 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:opacity-50"
                >
                  {busy && <SpinnerIcon className="h-3.5 w-3.5" />}
                  connect
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFormOpen(false);
                    setFormError("");
                  }}
                  className="rounded-full px-4 py-2 text-sm font-medium text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-bloop-deep"
                >
                  cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}
