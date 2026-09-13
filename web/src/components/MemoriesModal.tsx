import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { addMemory, deleteMemory, listMemories } from "../api";
import type { Memory } from "../types";
import { Modal } from "./Modal";
import { BrainIcon, SpinnerIcon, TrashIcon } from "../icons";
import { relTime } from "../lib";

interface MemoriesModalProps {
  onClose: () => void;
  /** bump to force a refetch (e.g. after a memory SSE event) */
  tick: number;
}

export function MemoriesModal({ onClose, tick }: MemoriesModalProps) {
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
    <Modal title="what bloop remembers" onClose={onClose}>
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
    </Modal>
  );
}
