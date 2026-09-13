import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, addServer, deleteServer, listServers } from "../api";
import type { McpServer } from "../types";
import { Modal } from "./Modal";
import {
  AlertIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon
} from "../icons";
import { cx } from "../lib";

const CATEGORIES = ["all", "productivity", "dev tools", "files", "data"];

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

  useEffect(() => {
    let cancelled = false;
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
  }, []);

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
    try {
      await deleteServer(id);
      setServers((s) => s.filter((x) => x.id !== id));
      onChanged?.();
    } catch {
      /* leave the card in place */
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
            <div className="flex items-center gap-2 py-8 text-xs text-neutral-400">
              <SpinnerIcon className="h-4 w-4" /> loading servers…
            </div>
          ) : loadError ? (
            <p className="flex items-center gap-2 py-8 text-xs text-red-600">
              <AlertIcon className="h-4 w-4" /> could not load servers.
            </p>
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
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-bloop/15 text-bloop-deep">
                      <PlugIcon className="h-4.5 w-4.5" />
                    </span>
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
                        aria-label={`remove ${s.name}`}
                        className="rounded-full p-1.5 text-neutral-400 transition-colors duration-150 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-bloop-deep"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
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
