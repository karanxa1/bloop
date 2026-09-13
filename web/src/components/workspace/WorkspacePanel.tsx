import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import * as ws from "../../api/workspace";
import type { EditorTab, ExecResult, WorkspaceFile, WorkspaceSignal } from "../../types/workspace";
import { AlertIcon, CodeIcon, SpinnerIcon, XIcon } from "../../icons";
import { cx } from "../../lib";
import { FileTree } from "./FileTree";
import { EditorTabs } from "./EditorTabs";
import { CodeEditor, type EditorFile } from "./CodeEditor";
import { RunConsole } from "./RunConsole";
import { baseName, isDirty } from "./util";

export interface WorkspacePanelProps {
  conversationId: string | null;
  /** latest `workspace` SSE event */
  event: WorkspaceSignal | null;
  streaming: boolean;
  /** desktop (≥1280px) split width */
  width?: number;
  onResize?: (width: number) => void;
  onClose?: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();
const MIN_W = 380;

export const WorkspacePanel = memo(function WorkspacePanel(props: WorkspacePanelProps) {
  // keyed so every conversation starts from a clean slate
  return <Workspace key={props.conversationId ?? "none"} {...props} />;
});

function Workspace({ conversationId: conv, event, streaming, width, onResize, onClose }: WorkspacePanelProps) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [treeStatus, setTreeStatus] = useState<"idle" | "loading" | "ready" | "error">(conv ? "loading" : "idle");
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [flash, setFlash] = useState<ReadonlySet<string>>(EMPTY);
  const [writing, setWriting] = useState<ReadonlySet<string>>(EMPTY);
  const [showTree, setShowTree] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const tabsRef = useRef(tabs);
  const writingRef = useRef(writing);
  const filesRef = useRef(files);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    writingRef.current = writing;
    filesRef.current = files;
  });

  const timers = useRef(new Set<number>());
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
    return id;
  }, []);
  useEffect(() => {
    const set = timers.current;
    return () => set.forEach((id) => window.clearTimeout(id));
  }, []);

  // ── tree ──────────────────────────────────────────────────────
  const treeSeq = useRef(0);
  const refresh = useCallback(() => {
    if (!conv) return;
    const seq = ++treeSeq.current;
    ws.listFiles(conv)
      .then((fs) => {
        if (seq !== treeSeq.current) return;
        setFiles(fs.sort((a, b) => a.path.localeCompare(b.path)));
        setTreeStatus("ready");
      })
      .catch(() => {
        if (seq === treeSeq.current) setTreeStatus((s) => (s === "ready" ? s : "error"));
      });
  }, [conv]);
  useEffect(refresh, [refresh]);

  const refreshTimer = useRef(0);
  const refreshSoon = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    timers.current.delete(refreshTimer.current);
    refreshTimer.current = later(refresh, 250);
  }, [later, refresh]);

  const pulse = useCallback(
    (paths: string[]) => {
      if (!paths.length) return;
      setFlash((f) => new Set([...f, ...paths]));
      later(() => setFlash((f) => {
        const next = new Set(f);
        paths.forEach((p) => next.delete(p));
        return next.size ? next : EMPTY;
      }), 1400);
    },
    [later]
  );

  const noticeTimer = useRef(0);
  const say = useCallback(
    (msg: string) => {
      setNotice(msg);
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = later(() => setNotice(null), 5000);
    },
    [later]
  );

  // ── tabs ──────────────────────────────────────────────────────
  const patchTab = useCallback((path: string, fn: (t: EditorTab) => EditorTab) => {
    setTabs((ts) => {
      let hit = false;
      const next = ts.map((t) => {
        if (t.path !== path) return t;
        const u = fn(t);
        if (u !== t) hit = true;
        return u;
      });
      return hit ? next : ts;
    });
  }, []);

  /** fetch server copy; a dirty tab is only flagged stale unless forced */
  const loadContent = useCallback(
    (path: string, force = false) => {
      if (!conv) return;
      ws.readFile(conv, path)
        .then((content) =>
          patchTab(path, (t) =>
            !force && isDirty(t)
              ? t.content === content
                ? { ...t, saved: content, stale: undefined }
                : { ...t, stale: "changed" }
              : t.status === "ready" && t.saved === content && t.content === content && !t.stale
                ? t
                : { ...t, content, saved: content, status: "ready", stale: undefined, error: undefined }
          )
        )
        .catch((e: unknown) =>
          patchTab(path, (t) =>
            ws.isBinaryError(e)
              ? { ...t, status: "binary" }
              : t.status === "ready"
                ? t
                : { ...t, status: "error", error: ws.errText(e) }
          )
        );
    },
    [conv, patchTab]
  );

  const openFile = useCallback(
    (path: string) => {
      setActivePath(path);
      setShowTree(false);
      if (tabsRef.current.some((t) => t.path === path)) return;
      setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, content: "", saved: "", status: "loading" }]));
      loadContent(path);
    },
    [loadContent]
  );

  const closeTab = useCallback((path: string) => {
    const t = tabsRef.current.find((x) => x.path === path);
    if (t && isDirty(t) && !window.confirm(`discard unsaved changes to ${baseName(path)}?`)) return;
    setTabs((ts) => ts.filter((x) => x.path !== path));
    setActivePath((a) => {
      if (a !== path) return a;
      const rest = tabsRef.current.filter((x) => x.path !== path);
      return rest[rest.length - 1]?.path ?? null;
    });
  }, []);

  const onEdit = useCallback(
    (path: string, doc: string) => patchTab(path, (t) => (t.content === doc ? t : { ...t, content: doc })),
    [patchTab]
  );

  const save = useCallback(
    (path: string) => {
      const t = tabsRef.current.find((x) => x.path === path);
      if (!conv || !t || t.status !== "ready" || t.saving) return;
      if (writingRef.current.has(path)) {
        say("bloop is writing this file — save again in a moment.");
        return;
      }
      if (!isDirty(t) && !t.stale) return;
      const content = t.content;
      patchTab(path, (x) => ({ ...x, saving: true }));
      ws.writeFile(conv, path, content)
        .then(() => {
          patchTab(path, (x) => ({ ...x, saved: content, saving: false, stale: undefined }));
          refreshSoon();
        })
        .catch((e: unknown) => {
          patchTab(path, (x) => ({ ...x, saving: false }));
          say(`couldn’t save ${baseName(path)}: ${ws.errText(e)}`);
        });
    },
    [conv, patchTab, refreshSoon, say]
  );

  // ── remote changes (sse + console) ────────────────────────────
  const applyChanged = useCallback(
    (paths: string[]) => {
      for (const p of paths) if (tabsRef.current.some((t) => t.path === p)) loadContent(p);
    },
    [loadContent]
  );

  const applyDeleted = useCallback((paths: string[]) => {
    if (!paths.length) return;
    setTabs((ts) =>
      ts.flatMap((t) => (!paths.includes(t.path) ? [t] : isDirty(t) ? [{ ...t, stale: "deleted" as const }] : []))
    );
  }, []);

  const writeTimer = useRef(0);
  const releaseWriting = useCallback(
    (ms: number) => {
      window.clearTimeout(writeTimer.current);
      timers.current.delete(writeTimer.current);
      writeTimer.current = later(() => setWriting(EMPTY), ms);
    },
    [later]
  );

  const streamingRef = useRef(streaming);
  useLayoutEffect(() => {
    streamingRef.current = streaming;
  });
  useEffect(() => {
    if (!streaming && writingRef.current.size) releaseWriting(1200);
  }, [streaming, releaseWriting]);

  const lastSeq = useRef(event?.seq ?? 0);
  useEffect(() => {
    if (!event || !conv || event.seq <= lastSeq.current) return;
    lastSeq.current = event.seq;
    const paths = [...new Set(event.paths.map(ws.normPath).filter((p) => p && !p.endsWith("/")))];
    refreshSoon();
    pulse(paths);
    if (event.action === "write") {
      if (paths.length) {
        setWriting((w) => new Set([...w, ...paths]));
        releaseWriting(streamingRef.current ? 4000 : 1500);
      }
      applyChanged(paths);
      const target = paths[paths.length - 1];
      if (target && !tabsRef.current.some(isDirty)) openFile(target);
    } else if (event.action === "delete") {
      applyDeleted(paths);
    } else {
      applyChanged(paths);
    }
  }, [event, conv, refreshSoon, pulse, releaseWriting, applyChanged, applyDeleted, openFile]);

  const onExec = useCallback(
    (r: ExecResult) => {
      refreshSoon();
      pulse(r.changed);
      applyChanged(r.changed);
      applyDeleted(r.deleted);
    },
    [refreshSoon, pulse, applyChanged, applyDeleted]
  );

  // ── tree ops ──────────────────────────────────────────────────
  const exists = (p: string) => filesRef.current.some((f) => f.path === p);

  const createFile = useCallback(
    async (path: string) => {
      if (!conv) return false;
      if (exists(path)) {
        openFile(path);
        return true;
      }
      try {
        await ws.writeFile(conv, path, "");
        setFiles((fs) => [...fs, { path, bytes: 0, updated_at: new Date().toISOString() }]);
        refreshSoon();
        openFile(path);
        return true;
      } catch (e) {
        say(`couldn’t create ${path}: ${ws.errText(e)}`);
        return false;
      }
    },
    [conv, openFile, refreshSoon, say]
  );

  const renameFile = useCallback(
    async (from: string, to: string) => {
      if (!conv) return false;
      if (exists(to)) {
        say(`${to} already exists.`);
        return false;
      }
      const tab = tabsRef.current.find((t) => t.path === from);
      try {
        const content = tab?.status === "ready" ? tab.content : await ws.readFile(conv, from);
        await ws.writeFile(conv, to, content);
        await ws.deleteFile(conv, from);
        setTabs((ts) => ts.map((t) => (t.path === from ? { ...t, path: to, content, saved: content, stale: undefined } : t)));
        setActivePath((a) => (a === from ? to : a));
        setFiles((fs) => fs.map((f) => (f.path === from ? { ...f, path: to } : f)));
        pulse([to]);
        refreshSoon();
        return true;
      } catch (e) {
        say(
          ws.isBinaryError(e)
            ? `binary files can’t be renamed here — try \`mv ${from} ${to}\` in the console.`
            : `couldn’t rename ${baseName(from)}: ${ws.errText(e)}`
        );
        return false;
      }
    },
    [conv, pulse, refreshSoon, say]
  );

  const deleteFile = useCallback(
    (path: string) => {
      if (!conv) return;
      const prev = filesRef.current;
      setFiles((fs) => fs.filter((f) => f.path !== path));
      setTabs((ts) => ts.filter((t) => t.path !== path));
      ws.deleteFile(conv, path)
        .then(refreshSoon)
        .catch((e: unknown) => {
          setFiles(prev);
          say(`couldn’t delete ${baseName(path)}: ${ws.errText(e)}`);
        });
    },
    [conv, refreshSoon, say]
  );

  // ── render ────────────────────────────────────────────────────
  const activeTab = tabs.find((t) => t.path === activePath) ?? tabs[tabs.length - 1] ?? null;
  const activeLocked = activeTab ? writing.has(activeTab.path) : false;
  const openPaths = useMemo(() => tabs.map((t) => t.path), [tabs]);
  const editorFile = useMemo<EditorFile | null>(
    () =>
      activeTab?.status === "ready"
        ? { path: activeTab.path, value: activeTab.content, readOnly: activeLocked }
        : null,
    [activeTab?.status, activeTab?.path, activeTab?.content, activeLocked]
  );
  const narrow = activeTab && !showTree ? "editor" : "tree";
  const writingList = [...writing];

  return (
    <div className="@container relative flex h-full min-h-0 flex-col bg-white">
      {onResize && width != null && <ResizeHandle width={width} onResize={onResize} />}

      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-bloop/10 px-4 py-3">
        <CodeIcon className="h-4 w-4 text-bloop-deep" />
        <h2 className="font-wordmark text-base font-bold leading-none text-bloop-deep">workspace</h2>
        {writingList.length > 0 && (
          <span
            aria-hidden="true"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-bloop bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-800"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-bloop motion-safe:animate-pulse" />
            <span className="shrink-0">bloop is editing</span>
            <span className="max-w-28 truncate font-mono text-neutral-600">{baseName(writingList[writingList.length - 1])}</span>
          </span>
        )}
        <span className="sr-only" role="status">
          {writingList.length ? `bloop is editing ${writingList.join(", ")}` : ""}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-neutral-500">
          {conv && treeStatus === "ready" ? `${files.length} file${files.length === 1 ? "" : "s"}` : ""}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="close workspace"
            className="rounded-full p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep lg:hidden"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </header>

      {notice && (
        <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-neutral-200 border-l-2 border-l-amber-500 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900">
          <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="dismiss" className="rounded-full p-0.5 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-bloop-deep">
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      )}

      {!conv ? (
        <div className="flex min-h-0 flex-1 items-start p-4">
          <div className="w-full border border-neutral-200 border-l-2 border-l-neutral-300 bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600">
            no workspace yet — start a conversation and ask bloop to build something. its files and a run console show up here.
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="workspace files"
            className={cx(
              "min-h-0 w-full @xl:flex @xl:w-56 @xl:shrink-0 @xl:border-r @xl:border-neutral-200",
              narrow === "tree" ? "flex flex-col" : "hidden"
            )}
          >
            <FileTree
              files={files}
              status={treeStatus}
              activePath={activeTab?.path ?? null}
              flash={flash}
              writing={writing}
              disabled={false}
              onOpen={openFile}
              onCreate={createFile}
              onRename={renameFile}
              onDelete={deleteFile}
              onRetry={refresh}
            />
          </nav>

          <section
            aria-label="editor"
            className={cx("min-w-0 flex-1 flex-col @xl:flex", narrow === "editor" ? "flex" : "hidden")}
          >
            {tabs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500">
                pick a file to open it here
              </div>
            ) : (
              <>
                <EditorTabs
                  tabs={tabs}
                  activePath={activeTab?.path ?? null}
                  writing={writing}
                  onSelect={setActivePath}
                  onClose={closeTab}
                  onShowTree={() => setShowTree(true)}
                />

                {activeTab?.stale && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 border-l-2 border-l-bloop bg-bloop/10 px-3 py-1.5 text-[12px] text-neutral-800">
                    <span className="min-w-0 flex-1">
                      {activeTab.stale === "changed"
                        ? "bloop changed this file while you were editing."
                        : "this file was deleted — save to recreate it."}
                    </span>
                    {activeTab.stale === "changed" && (
                      <button
                        type="button"
                        onClick={() => loadContent(activeTab.path, true)}
                        className="rounded-full bg-bloop px-2.5 py-0.5 text-[11px] font-bold text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep"
                      >
                        load bloop&rsquo;s version
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => patchTab(activeTab.path, (t) => ({ ...t, stale: undefined }))}
                      className="rounded-full border border-neutral-300 bg-white px-2.5 py-0.5 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-bloop-deep"
                    >
                      keep mine
                    </button>
                  </div>
                )}

                <div className="relative min-h-0 flex-1 focus-within:shadow-[inset_2px_0_0_#8dc63f]">
                  <CodeEditor file={editorFile} openPaths={openPaths} onChange={onEdit} onSave={save} />
                  {activeTab && activeTab.status !== "ready" && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white p-6 text-center text-xs text-neutral-600">
                      {activeTab.status === "loading" && (
                        <span className="inline-flex items-center gap-2">
                          <SpinnerIcon className="h-3.5 w-3.5 motion-safe:animate-spin" /> opening {baseName(activeTab.path)}…
                        </span>
                      )}
                      {activeTab.status === "binary" && (
                        <div className="border border-neutral-200 border-l-2 border-l-neutral-400 bg-neutral-50 px-4 py-3">
                          <div className="font-mono text-neutral-800">{baseName(activeTab.path)}</div>
                          <div className="mt-1">binary file — can&rsquo;t be shown in the editor.</div>
                        </div>
                      )}
                      {activeTab.status === "error" && (
                        <div role="alert" className="border border-neutral-200 border-l-2 border-l-red-500 px-4 py-3">
                          couldn&rsquo;t open {baseName(activeTab.path)}: {activeTab.error}
                          <button
                            type="button"
                            onClick={() => {
                              patchTab(activeTab.path, (t) => ({ ...t, status: "loading" }));
                              loadContent(activeTab.path, true);
                            }}
                            className="ml-2 font-semibold text-bloop-deep underline underline-offset-2"
                          >
                            retry
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {activeTab && (
                  <div className="flex shrink-0 items-center gap-2 border-t border-neutral-200 bg-neutral-50 px-3 py-1 text-[11px] text-neutral-600">
                    <span className="min-w-0 truncate font-mono">{activeTab.path}</span>
                    {activeLocked && (
                      <span className="shrink-0 rounded-full bg-bloop/25 px-2 text-neutral-800">read-only · bloop is writing</span>
                    )}
                    <span className="ml-auto shrink-0">
                      {activeTab.saving ? "saving…" : isDirty(activeTab) ? "unsaved" : activeTab.status === "ready" ? "saved" : ""}
                    </span>
                    {activeTab.status === "ready" && (isDirty(activeTab) || activeTab.stale) && (
                      <button
                        type="button"
                        onClick={() => save(activeTab.path)}
                        disabled={activeLocked || activeTab.saving}
                        className="shrink-0 rounded-full bg-bloop px-2.5 py-0.5 text-[11px] font-bold text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep disabled:bg-neutral-200 disabled:text-neutral-500"
                      >
                        save <kbd className="font-sans font-medium">⌘S</kbd>
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      <RunConsole conversationId={conv} onResult={onExec} />
    </div>
  );
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const maxW = () => Math.max(MIN_W, Math.min(1100, window.innerWidth - 520));
  const clamp = (w: number) => Math.round(Math.min(maxW(), Math.max(MIN_W, w)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = width;
    el.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => onResize(clamp(startW + startX - ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="resize workspace panel"
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      aria-valuemax={1100}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(clamp(width + 32));
        else if (e.key === "ArrowRight") onResize(clamp(width - 32));
        else return;
        e.preventDefault();
      }}
      className="group absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none focus-visible:outline-none xl:block"
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-bloop group-focus-visible:bg-bloop-deep" />
    </div>
  );
}
