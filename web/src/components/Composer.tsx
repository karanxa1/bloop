import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import type { ChatMode } from "../types";
import { EDIT_LAST_EVENT } from "../chatActions";
import { AlertIcon, ImageIcon, SendIcon, StopIcon, XIcon } from "../icons";
import { cx } from "../lib";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  fmtBytes,
  pickedFromDrop,
  pickedFromList,
  rawUrl,
  uploadFile,
  type Attachment,
  type PickedFile
} from "../api/attachments";

const MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "default", label: "default", hint: "quick, everyday tasks" },
  { id: "think", label: "think", hint: "reasons longer before acting" },
  { id: "deep", label: "deep", hint: "multi-step research with subagents" }
];

const PLACEHOLDER: Record<ChatMode, string> = {
  default: "tell bloop what to do…",
  think: "think it through…",
  deep: "research anything — bloop will cite sources…"
};

const CONCURRENCY = 3;

/** attachment as sent with a message; `url` is a client-side preview link */
export type SentAttachment = Attachment & { url?: string };

interface Chip {
  id: string;
  label: string;
  folder: boolean;
  count: number;
  bytes: number;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
  results: SentAttachment[];
  /** object url for image thumbnails */
  preview?: string;
}

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const typingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

let chipSeq = 0;

function ClipGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
    </svg>
  );
}

function FileGlyph({ folder }: { folder?: boolean }) {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {folder ? (
        <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z" />
      ) : (
        <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5" />
      )}
    </svg>
  );
}

export { FileGlyph };

interface ComposerProps {
  streaming: boolean;
  onSend: (text: string, attachments?: SentAttachment[]) => void;
  onStop: () => void;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  /** returns the active conversation id, creating one if needed (uploads need it) */
  ensureConversation?: () => Promise<string | null>;
}

export const Composer = memo(function Composer({
  streaming,
  onSend,
  onStop,
  mode,
  onModeChange,
  ensureConversation
}: ComposerProps) {
  const [value, setValue] = useState("");
  /** drafted while a run streams — sent as soon as it ends */
  const [queued, setQueued] = useState<{ text: string; attachments: SentAttachment[] } | null>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const aborts = useRef(new Map<string, (() => void)[]>());
  const removed = useRef(new Set<string>());
  const active = useRef(0);
  const waiting = useRef<(() => void)[]>([]);
  const hintId = useId();
  const menuId = useId();
  const mod = isMac() ? "⌘" : "ctrl";

  // grow with content (capped), shrink back after send
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  // flush the queue once the run ends
  useEffect(() => {
    if (streaming || queued == null) return;
    onSend(queued.text, queued.attachments.length ? queued.attachments : undefined);
    setQueued(null);
  }, [streaming, queued, onSend]);

  // revoke thumbnails on unmount
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  useEffect(
    () => () => {
      for (const c of chipsRef.current) if (c.preview) URL.revokeObjectURL(c.preview);
      for (const list of aborts.current.values()) list.forEach((a) => a());
    },
    []
  );

  // ── uploads ───────────────────────────────────────────────────────
  const runLimited = (task: () => Promise<void>) => {
    const start = () => {
      active.current++;
      void task().finally(() => {
        active.current--;
        waiting.current.shift()?.();
      });
    };
    if (active.current < CONCURRENCY) start();
    else waiting.current.push(start);
  };

  const patchChip = (id: string, fn: (c: Chip) => Chip) =>
    setChips((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));

  const addFiles = useCallback(
    async (picked: PickedFile[]) => {
      if (picked.length === 0) return;
      setNotice(null);
      if (picked.length > MAX_FILES) {
        setNotice(`only the first ${MAX_FILES} files were added — that's the limit per message.`);
        picked = picked.slice(0, MAX_FILES);
      }
      const conv = ensureConversation ? await ensureConversation() : null;
      if (!conv) {
        setNotice("couldn't start a conversation for these files — try again.");
        return;
      }

      // folders collapse into one chip; loose files get their own
      const groups = new Map<string, PickedFile[]>();
      for (const p of picked) {
        const key = p.path.includes("/") ? `dir:${p.path.split("/")[0]}` : `file:${++chipSeq}`;
        groups.set(key, [...(groups.get(key) ?? []), p]);
      }

      for (const [key, files] of groups) {
        const id = `chip-${++chipSeq}`;
        const folder = key.startsWith("dir:");
        const ok = files.filter((f) => f.file.size <= MAX_FILE_BYTES);
        const tooBig = files.length - ok.length;
        const bytes = ok.reduce((a, f) => a + f.file.size, 0);
        const first = files[0].file;
        const chip: Chip = {
          id,
          label: folder ? key.slice(4) : first.name,
          folder,
          count: files.length,
          bytes: folder ? bytes : first.size,
          progress: 0,
          status: ok.length ? "uploading" : "error",
          error: ok.length
            ? tooBig
              ? `${tooBig} over 25 mb skipped`
              : undefined
            : "too large (max 25 mb)",
          results: [],
          preview:
            !folder && ok.length && /^image\//.test(first.type) ? URL.createObjectURL(first) : undefined
        };
        setChips((cs) => [...cs, chip]);
        if (!ok.length) continue;

        const loaded = new Map<string, number>();
        let remaining = ok.length;
        let failures = 0;
        aborts.current.set(id, []);
        for (const f of ok) {
          runLimited(async () => {
            if (removed.current.has(id)) return;
            const handle = uploadFile(conv, f, (fr) => {
              loaded.set(f.path, fr * f.file.size);
              const sum = [...loaded.values()].reduce((a, b) => a + b, 0);
              patchChip(id, (c) => ({ ...c, progress: bytes ? Math.min(1, sum / bytes) : 1 }));
            });
            aborts.current.get(id)?.push(handle.abort);
            try {
              const res = await handle.promise;
              const withUrl = res.map((r) => ({ ...r, url: rawUrl(conv, r.path) }));
              patchChip(id, (c) => ({ ...c, results: [...c.results, ...withUrl] }));
            } catch (e) {
              if (e instanceof DOMException && e.name === "AbortError") return;
              failures++;
              const msg = e instanceof Error ? e.message : "upload failed";
              patchChip(id, (c) => ({ ...c, error: folder ? `${failures} failed — ${msg}` : msg }));
            } finally {
              remaining--;
              if (remaining === 0 && !removed.current.has(id)) {
                aborts.current.delete(id);
                patchChip(id, (c) => ({
                  ...c,
                  progress: 1,
                  status: c.results.length ? "done" : "error"
                }));
              }
            }
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ensureConversation]
  );
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const removeChip = (id: string) => {
    removed.current.add(id);
    aborts.current.get(id)?.forEach((a) => a());
    aborts.current.delete(id);
    setChips((cs) => {
      const c = cs.find((x) => x.id === id);
      if (c?.preview) URL.revokeObjectURL(c.preview);
      return cs.filter((x) => x.id !== id);
    });
  };

  // drag & drop anywhere (files + folders); skip drops a panel already handled
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      void pickedFromDrop(e.dataTransfer!).then((p) => addFilesRef.current(p));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // paperclip menu: close on outside click / Esc
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  // global: "/" focuses the composer, Esc stops a run
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typingTarget(e.target)) {
        e.preventDefault();
        taRef.current?.focus();
        return;
      }
      if (
        e.key === "Escape" &&
        streaming &&
        !document.querySelector("dialog[open], [role='dialog']") &&
        (!typingTarget(e.target) || e.target === taRef.current)
      ) {
        onStop();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [streaming, onStop]);

  const uploading = chips.some((c) => c.status === "uploading");
  const ready = chips.flatMap((c) => (c.status === "done" ? c.results : []));

  /** interrupt: ⌘/ctrl+enter while streaming = stop, then send */
  const submit = (interrupt = false) => {
    const text = value.trim();
    if ((!text && ready.length === 0) || uploading) return;
    const message = text || "see the attached files";
    const attachments = ready;
    setValue("");
    for (const c of chips) if (c.preview) URL.revokeObjectURL(c.preview);
    setChips([]);
    setNotice(null);
    if (streaming) {
      setQueued({ text: message, attachments });
      if (interrupt) onStop();
      return;
    }
    onSend(message, attachments.length ? attachments : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(true);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      if (streaming) {
        e.preventDefault();
        onStop();
      } else if (queued != null) setQueued(null);
    } else if (e.key === "ArrowUp" && value === "" && !streaming) {
      e.preventDefault();
      window.dispatchEvent(new Event(EDIT_LAST_EVENT));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    if (!e.clipboardData.getData("text")) e.preventDefault();
    const stamp = Date.now().toString(36);
    void addFiles(
      images.map((f, i) => {
        const ext = f.type.split("/")[1]?.split("+")[0] || "png";
        const name = `pasted-${stamp}${i ? `-${i}` : ""}.${ext}`;
        return { file: new File([f], name, { type: f.type }), path: name };
      })
    );
  };

  // radiogroup keyboard model: arrows move + select, home/end jump
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % MODES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + MODES.length) % MODES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = MODES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onModeChange(MODES[next].id);
    radios.current[next]?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      menuRef.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      items[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
    }
  };

  const pick = (input: HTMLInputElement | null) => {
    setMenuOpen(false);
    input?.click();
  };

  const hasContent = value.trim() !== "" || ready.length > 0;
  const menuItem =
    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-neutral-700 transition-colors duration-100 hover:bg-page focus-visible:bg-page focus-visible:outline-none";

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-2 z-[70] flex items-center justify-center border-2 border-dashed border-bloop bg-bloop/10 backdrop-blur-[1px]"
        >
          <span className="rounded-full bg-white px-4 py-2 font-wordmark text-base font-bold text-bloop-deep shadow-sm">
            drop files for bloop
          </span>
        </div>
      )}

      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center gap-2">
          <div
            role="radiogroup"
            aria-label="reasoning mode"
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-neutral-100 p-0.5"
          >
            {MODES.map((m, i) => {
              const selected = mode === m.id;
              const tipId = `mode-tip-${m.id}`;
              return (
                <span key={m.id} className="group relative">
                  <button
                    ref={(el) => {
                      radios.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-describedby={tipId}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onModeChange(m.id)}
                    onKeyDown={(e) => onRadioKey(e, i)}
                    className={cx(
                      "rounded-full px-3 py-1 text-[11px] font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep",
                      selected
                        ? "bg-bloop text-neutral-900 shadow-sm"
                        : "text-neutral-500 hover:text-neutral-800"
                    )}
                  >
                    {m.label}
                  </button>
                  <span
                    role="tooltip"
                    id={tipId}
                    className={cx(
                      "pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap bg-neutral-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100",
                      i === 0 ? "left-0" : "left-1/2 -translate-x-1/2"
                    )}
                  >
                    {m.hint}
                  </span>
                </span>
              );
            })}
          </div>
          <p id={hintId} className="ml-auto hidden truncate text-[10px] text-neutral-400 sm:block">
            {streaming
              ? `enter to queue · ${mod}+enter to stop & send · esc to stop`
              : "enter to send · shift+enter for a new line · ↑ to edit last"}
          </p>
        </div>

        {queued != null && (
          <div className="motion-safe:tool-in mb-2 flex max-w-full items-center gap-2 rounded-full border border-bloop/40 bg-bloop/10 py-1 pl-3 pr-1 text-[11px] text-neutral-600">
            <span className="shrink-0 font-semibold text-bloop-deep">queued</span>
            <span className="min-w-0 flex-1 truncate normal-case">
              {queued.text}
              {queued.attachments.length > 0 && ` · ${queued.attachments.length} files`}
            </span>
            <span className="shrink-0 text-neutral-400 max-sm:hidden">sends when bloop finishes</span>
            <button
              type="button"
              onClick={() => {
                setValue((v) => v || queued.text);
                setQueued(null);
              }}
              aria-label="cancel queued message"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors duration-150 hover:bg-white hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-bloop-deep"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
        )}

        {chips.length > 0 && (
          <ul aria-label="attachments" className="mb-2 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <li
                key={c.id}
                className={cx(
                  "motion-safe:tool-in relative flex h-14 max-w-[15rem] items-center overflow-hidden border bg-white",
                  c.status === "error" ? "border-red-300" : "border-neutral-200"
                )}
              >
                {c.preview ? (
                  <img src={c.preview} alt="" className="h-14 w-14 shrink-0 object-cover" />
                ) : (
                  <span
                    className={cx(
                      "flex h-14 w-11 shrink-0 items-center justify-center",
                      c.status === "error" ? "text-red-500" : "text-bloop-deep"
                    )}
                  >
                    {c.status === "error" ? <AlertIcon className="h-4 w-4" /> : <FileGlyph folder={c.folder} />}
                  </span>
                )}
                <span className="min-w-0 flex-1 py-1 pl-2 pr-7">
                  <span className="block truncate text-xs font-medium normal-case text-neutral-800">
                    {c.label}
                  </span>
                  <span
                    className={cx(
                      "block truncate text-[10px]",
                      c.error ? "text-red-600" : "text-neutral-400"
                    )}
                  >
                    {c.error ??
                      (c.status === "uploading"
                        ? `uploading · ${Math.round(c.progress * 100)}%`
                        : c.folder
                          ? `folder · ${c.count} files · ${fmtBytes(c.bytes)}`
                          : fmtBytes(c.bytes))}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeChip(c.id)}
                  aria-label={`remove ${c.label}`}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep"
                >
                  <XIcon className="h-3 w-3" />
                </button>
                {c.status === "uploading" && (
                  <span
                    role="progressbar"
                    aria-label={`uploading ${c.label}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(c.progress * 100)}
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-neutral-100"
                  >
                    <span
                      className="block h-full bg-bloop transition-[width] duration-150"
                      style={{ width: `${Math.max(4, c.progress * 100)}%` }}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {notice && (
          <p role="alert" className="mb-2 flex items-center gap-1.5 text-[11px] text-red-600">
            <AlertIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="dismiss"
              className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-bloop-deep"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </p>
        )}

        <div className="flex items-end gap-2">
          {ensureConversation && (
            <div ref={menuRef} className="relative shrink-0" onKeyDown={onMenuKey}>
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                aria-label="attach files"
                title="attach files, a folder or images"
                className={cx(
                  "flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep",
                  menuOpen ? "bg-bloop/20 text-bloop-deep" : "text-neutral-500 hover:bg-neutral-100 hover:text-bloop-deep"
                )}
              >
                <ClipGlyph />
              </button>
              {menuOpen && (
                <div
                  id={menuId}
                  role="menu"
                  aria-label="attach"
                  className="motion-safe:tool-in absolute bottom-full left-0 z-30 mb-2 w-44 border border-neutral-200 border-l-2 border-l-bloop bg-white py-1 shadow-md"
                >
                  <button type="button" role="menuitem" className={menuItem} onClick={() => pick(fileInput.current)}>
                    <FileGlyph /> files
                  </button>
                  <button type="button" role="menuitem" className={menuItem} onClick={() => pick(folderInput.current)}>
                    <FileGlyph folder /> folder
                  </button>
                  <button type="button" role="menuitem" className={menuItem} onClick={() => pick(imageInput.current)}>
                    <ImageIcon className="h-4 w-4 shrink-0" /> image
                  </button>
                </div>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(pickedFromList(e.target.files));
                  e.target.value = "";
                }}
              />
              <input
                ref={(el) => {
                  folderInput.current = el;
                  el?.setAttribute("webkitdirectory", "");
                }}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(pickedFromList(e.target.files));
                  e.target.value = "";
                }}
              />
              <input
                ref={imageInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(pickedFromList(e.target.files));
                  e.target.value = "";
                }}
              />
            </div>
          )}
          <label htmlFor="composer" className="sr-only">
            message bloop
          </label>
          <textarea
            id="composer"
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={streaming ? "draft your next message…" : PLACEHOLDER[mode]}
            enterKeyHint={streaming ? "enter" : "send"}
            aria-describedby={hintId}
            aria-keyshortcuts="/"
            className="max-h-[200px] min-w-0 flex-1 resize-none border border-neutral-300 bg-page px-3.5 py-2.5 text-base text-neutral-800 transition-colors duration-150 placeholder:text-neutral-400 focus:border-bloop-deep focus:bg-white focus:outline-none focus:ring-2 focus:ring-bloop/30 sm:text-sm"
          />
          {streaming && hasContent && (
            <button
              type="button"
              onClick={() => submit()}
              disabled={uploading}
              aria-label="queue message — sends when bloop finishes"
              title="queue (enter)"
              className="motion-safe:pop flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-bloop bg-white text-bloop-deep transition-colors duration-150 hover:bg-bloop/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:opacity-40"
            >
              <SendIcon />
            </button>
          )}
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="stop generating"
              aria-keyshortcuts="Escape"
              title="stop (esc)"
              className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bloop-deep text-white transition-[transform,background-color] duration-150 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep motion-safe:hover:-translate-y-px"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -inset-[3px] rounded-full border-2 border-bloop/30 border-t-bloop motion-safe:animate-spin"
              />
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={!hasContent || uploading}
              aria-label={uploading ? "waiting for uploads" : "send message"}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bloop text-neutral-900 transition-[transform,background-color,color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep disabled:cursor-not-allowed disabled:opacity-40 motion-safe:enabled:hover:-translate-y-px"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
