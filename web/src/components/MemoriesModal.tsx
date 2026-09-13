import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  addMemory,
  deleteMemory,
  getUserFile,
  listMemories,
  putUserFile
} from "../api";
import type { Memory, UserFileKind } from "../types";
import { Modal } from "./Modal";
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

  return (
    <Modal title="what bloop knows" onClose={onClose}>
      <div
        role="tablist"
        aria-label="knowledge"
        className="flex gap-1.5 border-b border-neutral-200 px-5 pt-3 pb-2.5"
      >
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            onClick={() => setTab(t)}
            className={cx(
              "rounded-full px-3.5 py-1.5 font-wordmark text-sm font-bold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-bloop-deep",
              tab === t
                ? "bg-bloop text-neutral-900"
                : "text-neutral-500 hover:bg-neutral-100 hover:text-bloop-deep"
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "memories" ? (
          <MemoriesPanel tick={tick} />
        ) : (
          <FilePanel key={tab} kind={tab} tick={tick} />
        )}
      </div>
    </Modal>
  );
}

function MemoriesPanel({ tick }: { tick: number }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listMemories()
      .then((m) => {
        if (!cancelled) setMemories(m);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

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
      /* leave the draft in place */
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteMemory(id);
      setMemories((ms) => ms.filter((m) => m.id !== id));
    } catch {
      /* keep the row */
    }
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
          className="flex-1 border border-neutral-300 bg-page px-3 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40"
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          className="rounded-full bg-bloop px-4 py-2 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:opacity-40"
        >
          add
        </button>
      </form>

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-neutral-400">
            <SpinnerIcon className="h-4 w-4" /> loading memories…
          </div>
        ) : memories.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-400">
            nothing stored yet — a blank little mind.
          </p>
        ) : (
          <ul className="space-y-2">
            {memories.map((m) => (
              <li
                key={m.id}
                className="group flex items-start gap-2.5 border border-neutral-200 border-l-2 border-l-bloop-deep bg-white px-3 py-2"
              >
                <BrainIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bloop-deep" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug text-neutral-700">
                    {m.content}
                  </p>
                  <p className="mt-0.5 text-[10px] text-neutral-400">
                    {relTime(m.created_at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(m.id)}
                  aria-label="forget this memory"
                  className="rounded-full p-1.5 text-neutral-400 opacity-0 transition-all duration-150 hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-bloop-deep group-hover:opacity-100"
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
        setSaved(f.content);
        // don't clobber unsaved edits when the agent touches the file mid-edit
        setDraft((d) => (d === saved || loading ? f.content : d));
        setUpdatedAt(f.updated_at);
      })
      .catch(() => {})
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
        <div className="flex items-center gap-2 py-6 text-xs text-neutral-400">
          <SpinnerIcon className="h-4 w-4" /> loading {kind}…
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
            className="mt-3 h-64 w-full resize-y border border-neutral-300 bg-page px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40 scroll-thin"
          />
          <div className="mt-2 flex items-center gap-3">
            <span className="text-[10px] text-neutral-400">
              {draft.length.toLocaleString()} chars
              {updatedAt && ` · saved ${relTime(updatedAt)}`}
            </span>
            {status === "saved" && !dirty && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-bloop-deep">
                <CheckIcon className="h-3 w-3" /> saved
              </span>
            )}
            {status === "error" && (
              <span className="text-[10px] font-medium text-red-600">{error}</span>
            )}
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(saved)}
                className="ml-auto text-[11px] font-medium text-neutral-500 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
              >
                discard
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || status === "saving"}
              className={cx(
                "flex items-center gap-1.5 rounded-full bg-bloop px-4 py-1.5 font-wordmark text-sm font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:opacity-40",
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
