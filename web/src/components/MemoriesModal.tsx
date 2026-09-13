import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  addMemory,
  deleteMemory,
  getUserFile,
  listMemories,
  putUserFile
} from "../api";
import type { Memory, UserFileKind } from "../types";
import { Modal } from "./Modal";
import { toast } from "./Toast";
import { BrainIcon, CheckIcon, SpinnerIcon, TrashIcon } from "../icons";
import { cx, relTime } from "../lib";

type Tab = "memories" | UserFileKind;

const TABS: Tab[] = ["memories", "context", "lessons"];

const FILE_COPY: Record<UserFileKind, { blurb: string; placeholder: string }> = {
  context: {
    blurb:
      "standing background bloop reads in every chat — projects, stack, tone, constraints. markdown. bloop can edit it when you ask.",
    placeholder:
      "## me\n- building bloop, a rust agent on cloudflare workers\n\n## how to work\n- prefer terse answers\n- default github org: karanxa1"
  },
  lessons: {
    blurb:
      "things bloop learned the hard way — it appends a line after working around a failure. the newest lessons are injected into every run.",
    placeholder: "- github search_issues needs repo:owner/name in the query"
  }
};

/** Mirrors db::FILE_MAX on the backend. */
const FILE_MAX = 20_000;

interface MemoriesModalProps {
  onClose: () => void;
  /** bump to force a refetch (e.g. after a memory / file SSE event) */
  tick: number;
  initialTab?: Tab;
}

export function MemoriesModal({ onClose, tick, initialTab = "memories" }: MemoriesModalProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [memCount, setMemCount] = useState<number | null>(null);
  const uid = useId();
  const tabId = (t: Tab) => `${uid}-tab-${t}`;
  const panelId = (t: Tab) => `${uid}-panel-${t}`;

  // roving tabindex: ←/→/home/end move and activate
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (i - 1 + TABS.length) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]);
    document.getElementById(tabId(TABS[next]))?.focus();
  };

  return (
    <Modal title="what bloop knows" onClose={onClose}>
      <div
        role="tablist"
        aria-label="knowledge"
        onKeyDown={onTabKey}
        className="sticky top-0 z-10 flex gap-1.5 border-b border-neutral-200 bg-white px-5 pb-2.5 pt-3"
      >
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            id={tabId(t)}
            aria-selected={tab === t}
            aria-controls={panelId(t)}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            className={cx(
              "flex h-8 items-center gap-1.5 rounded-full px-3.5 font-wordmark text-sm font-bold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep",
              tab === t
                ? "bg-bloop text-neutral-900"
                : "text-neutral-500 hover:bg-neutral-100 hover:text-bloop-deep"
            )}
          >
            {t}
            {t === "memories" && memCount != null && (
              <span
                className={cx(
                  "rounded-full px-1.5 font-sans text-[10px] font-semibold tabular-nums",
                  tab === t ? "bg-white/70 text-neutral-900" : "bg-neutral-100 text-neutral-500"
                )}
              >
                {memCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {tab === "memories" ? (
          <MemoriesPanel tick={tick} onCount={setMemCount} />
        ) : (
          <FilePanel key={tab} kind={tab} tick={tick} />
        )}
      </div>
    </Modal>
  );
}

function MemoriesPanel({ tick, onCount }: { tick: number; onCount: (n: number) => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listMemories()
      .then((m) => {
        if (!cancelled) setMemories(m);
      })
      .catch(() => {
        if (!cancelled) toast({ kind: "error", message: "couldn’t load memories" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const visible = useMemo(() => memories.filter((m) => !hidden.has(m.id)), [memories, hidden]);
  useEffect(() => {
    if (!loading) onCount(visible.length);
  }, [visible.length, loading, onCount]);

  const unhide = (id: string) =>
    setHidden((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const m = await addMemory(content);
      setMemories((ms) => [m, ...ms]);
      setDraft("");
    } catch {
      toast({ kind: "error", message: "couldn’t save that memory — try again" });
    } finally {
      setBusy(false);
    }
  };

  const remove = (m: Memory) => {
    setHidden((s) => new Set(s).add(m.id));
    toast({
      kind: "undo",
      message: "memory forgotten",
      action: { label: "undo", onClick: () => unhide(m.id) },
      onExpire: () => {
        deleteMemory(m.id)
          .then(() => setMemories((ms) => ms.filter((x) => x.id !== m.id)))
          .catch(() => {
            unhide(m.id);
            toast({ kind: "error", message: "couldn’t forget that memory" });
          });
      }
    });
  };

  return (
    <div className="px-5 py-4">
      <p className="text-xs leading-relaxed text-neutral-500">
        bloop keeps these across every chat. add one, or ask bloop to
        remember — or forget — in plain words.
      </p>

      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label htmlFor="memory-input" className="sr-only">
          new memory
        </label>
        <input
          id="memory-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. i prefer terse answers"
          className="h-10 min-w-0 flex-1 border border-neutral-300 bg-page px-3 text-base text-neutral-800 placeholder:text-neutral-400 focus:border-bloop-deep focus:outline-none focus:ring-2 focus:ring-bloop/40 sm:text-sm"
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          className="flex h-10 items-center gap-1.5 rounded-full bg-bloop px-4 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:opacity-40"
        >
          {busy && <SpinnerIcon className="h-3.5 w-3.5" />}
          add
        </button>
      </form>

      <div className="mt-4" aria-busy={loading || undefined}>
        {loading ? (
          <ul className="space-y-2" aria-hidden="true">
            {["80%", "55%", "70%"].map((w) => (
              <li key={w} className="border border-neutral-200 border-l-2 border-l-neutral-300 bg-white px-3 py-2.5">
                <span className="block h-2.5 bg-neutral-200 motion-safe:animate-pulse" style={{ width: w }} />
                <span className="mt-2 block h-2 w-12 bg-neutral-100" />
              </li>
            ))}
          </ul>
        ) : visible.length === 0 ? (
          <p className="border border-dashed border-neutral-300 py-6 text-center text-xs text-neutral-500">
            nothing stored yet — a blank little mind.
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((m) => (
              <li
                key={m.id}
                className="group flex items-start gap-2.5 border border-neutral-200 border-l-2 border-l-bloop-deep bg-white px-3 py-2"
              >
                <BrainIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bloop-deep" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug text-neutral-700 [overflow-wrap:anywhere]">
                    {m.content}
                  </p>
                  <p className="mt-0.5 text-[10px] text-neutral-400">{relTime(m.created_at)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(m)}
                  aria-label={`forget: ${m.content}`}
                  className="rounded-full p-1.5 text-neutral-400 opacity-0 transition-all duration-150 hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-bloop-deep group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilePanel({ kind, tick }: { kind: UserFileKind; tick: number }) {
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const dirty = draft !== saved;

  useEffect(() => {
    let cancelled = false;
    getUserFile(kind)
      .then((f) => {
        if (cancelled) return;
        setSaved((prevSaved) => {
          // don't clobber unsaved edits when the agent touches the file mid-edit
          setDraft((d) => (d === prevSaved ? f.content : d));
          return f.content;
        });
        setUpdatedAt(f.updated_at);
      })
      .catch(() => {
        if (!cancelled) toast({ kind: "error", message: `couldn’t load ${kind}` });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, tick]);

  const save = async () => {
    if (!dirty || status === "saving") return;
    setStatus("saving");
    setError("");
    try {
      const f = await putUserFile(kind, draft);
      setSaved(f.content);
      setUpdatedAt(f.updated_at);
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "save failed");
    }
  };

  const copy = FILE_COPY[kind];

  return (
    <div className="px-5 py-4">
      <p className="text-xs leading-relaxed text-neutral-500">{copy.blurb}</p>
      {loading ? (
        <div className="mt-3 h-64 border border-neutral-200 bg-page p-3" aria-busy="true">
          <span className="sr-only">loading {kind}…</span>
          {["60%", "85%", "40%", "70%"].map((w) => (
            <span key={w} aria-hidden="true" className="mb-2.5 block h-2 bg-neutral-200 motion-safe:animate-pulse" style={{ width: w }} />
          ))}
        </div>
      ) : (
        <>
          <label htmlFor={`file-${kind}`} className="sr-only">
            {kind} file
          </label>
          <textarea
            id={`file-${kind}`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (status !== "saving") setStatus("idle");
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                void save();
              }
            }}
            maxLength={FILE_MAX}
            spellCheck={false}
            placeholder={copy.placeholder}
            aria-describedby={`file-${kind}-meta`}
            className="mt-3 h-64 w-full resize-y border border-neutral-300 bg-page px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-bloop-deep focus:outline-none focus:ring-2 focus:ring-bloop/40 scroll-thin"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span id={`file-${kind}-meta`} className="text-[10px] text-neutral-500">
              {draft.length.toLocaleString()} / {FILE_MAX.toLocaleString()} chars
              {updatedAt && ` · saved ${relTime(updatedAt)}`} · ⌘s to save
            </span>
            <span aria-live="polite" className="contents">
              {status === "saved" && !dirty && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-bloop-deep">
                  <CheckIcon className="h-3 w-3" /> saved
                </span>
              )}
              {status === "error" && (
                <span role="alert" className="text-[10px] font-medium text-red-600">{error}</span>
              )}
            </span>
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(saved)}
                className="ml-auto rounded-full px-2 py-1 text-[11px] font-medium text-neutral-500 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
              >
                discard
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || status === "saving"}
              className={cx(
                "flex items-center gap-1.5 rounded-full bg-bloop px-4 py-1.5 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:opacity-40",
                !dirty && "ml-auto"
              )}
            >
              {status === "saving" && <SpinnerIcon className="h-3.5 w-3.5" />}
              save
            </button>
          </div>
        </>
      )}
    </div>
  );
}
