import { memo, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import type { WorkspaceFile } from "../../types/workspace";
import { ChevronIcon, PencilIcon, PlusIcon, TrashIcon } from "../../icons";
import { cx } from "../../lib";
import { badgeFor, fmtBytes, validPath } from "./util";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  bytes: number;
  children: Node[];
}

function buildTree(files: WorkspaceFile[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, bytes: 0, children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let parent = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        parent.children.push({ name: part, path: acc, dir: false, bytes: f.bytes, children: [] });
        return;
      }
      let d = dirs.get(acc);
      if (!d) {
        d = { name: part, path: acc, dir: true, bytes: 0, children: [] };
        dirs.set(acc, d);
        parent.children.push(d);
      }
      parent = d;
    });
  }
  const finish = (n: Node): number => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    if (n.dir) n.bytes = n.children.reduce((s, c) => s + finish(c), 0);
    return n.bytes;
  };
  finish(root);
  return root.children;
}

type Row = { node: Node; depth: number };

function flatten(nodes: Node[], collapsed: ReadonlySet<string>, depth = 0, out: Row[] = []): Row[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.dir && !collapsed.has(node.path)) flatten(node.children, collapsed, depth + 1, out);
  }
  return out;
}

const hasPrefix = (set: ReadonlySet<string>, dir: string) => {
  for (const p of set) if (p.startsWith(`${dir}/`)) return true;
  return false;
};

interface FileTreeProps {
  files: WorkspaceFile[];
  status: "idle" | "loading" | "ready" | "error";
  activePath: string | null;
  flash: ReadonlySet<string>;
  writing: ReadonlySet<string>;
  disabled: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => Promise<boolean>;
  onRename: (from: string, to: string) => Promise<boolean>;
  onDelete: (path: string) => void;
  onRetry: () => void;
}

type Editing = { kind: "new" } | { kind: "rename"; path: string } | null;

function FileTreeImpl({
  files,
  status,
  activePath,
  flash,
  writing,
  disabled,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onRetry
}: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(files), [files]);
  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);

  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">explorer</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setConfirming(null);
            setEditing({ kind: "new" });
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] font-medium text-neutral-700 transition-colors hover:border-bloop hover:bg-bloop/10 focus-visible:outline-2 focus-visible:outline-bloop-deep disabled:opacity-40"
        >
          <PlusIcon className="h-3 w-3" />
          new file
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {editing?.kind === "new" && (
          <PathInput
            label="new file path"
            initial=""
            onCancel={() => setEditing(null)}
            onSubmit={async (p) => {
              const ok = await onCreate(p);
              if (ok) setEditing(null);
              return ok;
            }}
          />
        )}

        {status === "loading" && files.length === 0 && (
          <div className="space-y-2 px-3 py-2" aria-label="loading files">
            {[70, 50, 85, 40].map((w) => (
              <div key={w} className="h-3 bg-neutral-100 motion-safe:animate-pulse" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}

        {status === "error" && files.length === 0 && (
          <div role="alert" className="mx-3 my-2 border border-neutral-200 border-l-2 border-l-red-500 px-3 py-2 text-xs text-neutral-700">
            couldn&rsquo;t load files.{" "}
            <button type="button" onClick={onRetry} className="font-semibold text-bloop-deep underline underline-offset-2">
              retry
            </button>
          </div>
        )}

        {status === "ready" && files.length === 0 && editing?.kind !== "new" && (
          <div className="mx-3 my-3 border border-dashed border-neutral-300 border-l-2 border-l-bloop px-3 py-4 text-center text-xs leading-relaxed text-neutral-600">
            ask bloop to build something — files appear here
          </div>
        )}

        {rows.length > 0 && (
          <ul aria-label="files">
            {rows.map(({ node, depth }) => {
              const isOpen = node.dir && !collapsed.has(node.path);
              const lit = node.dir ? !isOpen && hasPrefix(flash, node.path) : flash.has(node.path);
              const busy = node.dir ? hasPrefix(writing, node.path) : writing.has(node.path);
              const active = node.path === activePath;
              const pad = { paddingLeft: `${10 + depth * 12}px` };

              if (editing?.kind === "rename" && editing.path === node.path) {
                return (
                  <li key={node.path}>
                    <PathInput
                      label={`rename ${node.path}`}
                      initial={node.path}
                      onCancel={() => setEditing(null)}
                      onSubmit={async (p) => {
                        const ok = await onRename(node.path, p);
                        if (ok) setEditing(null);
                        return ok;
                      }}
                    />
                  </li>
                );
              }

              if (confirming === node.path) {
                return (
                  <li key={node.path} className="flex items-center gap-2 border-l-2 border-l-red-500 bg-red-50 py-1 pr-2 text-xs text-neutral-800" style={pad}>
                    <span className="min-w-0 flex-1 truncate">
                      delete <span className="font-mono">{node.name}</span>?
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(null);
                        onDelete(node.path);
                      }}
                      className="rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-700"
                    >
                      delete
                    </button>
                    <button
                      type="button"
                      autoFocus
                      onClick={() => setConfirming(null)}
                      className="rounded-full border border-neutral-300 bg-white px-2.5 py-0.5 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-bloop-deep"
                    >
                      cancel
                    </button>
                  </li>
                );
              }

              const [badge, badgeCls] = badgeFor(node.name);
              return (
                <li
                  key={node.path}
                  className={cx(
                    "group relative flex items-center border-l-2 transition-colors duration-700",
                    active ? "border-l-bloop bg-neutral-100" : "border-l-transparent hover:bg-neutral-50",
                    lit && "bg-bloop/25 duration-150"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => (node.dir ? toggle(node.path) : onOpen(node.path))}
                    aria-expanded={node.dir ? isOpen : undefined}
                    aria-current={active ? "true" : undefined}
                    title={node.path}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left text-[13px] text-neutral-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
                    style={pad}
                  >
                    {node.dir ? (
                      <ChevronIcon
                        className={cx(
                          "h-3.5 w-3.5 shrink-0 text-neutral-500 motion-safe:transition-transform motion-safe:duration-150",
                          isOpen && "rotate-90"
                        )}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className={cx("inline-flex h-4 w-6 shrink-0 items-center justify-center font-mono text-[9px] font-bold", badgeCls)}
                      >
                        {badge}
                      </span>
                    )}
                    <span className={cx("truncate", node.dir && "font-medium")}>{node.name}</span>
                    {busy && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-bloop motion-safe:animate-pulse" role="img" aria-label="bloop is editing" />
                    )}
                    <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-neutral-500">
                      {fmtBytes(node.bytes)}
                    </span>
                  </button>
                  {!node.dir && !disabled && (
                    <div className="flex shrink-0 items-center pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                      <button
                        type="button"
                        aria-label={`rename ${node.path}`}
                        onClick={() => {
                          setConfirming(null);
                          setEditing({ kind: "rename", path: node.path });
                        }}
                        className="rounded-full p-1 text-neutral-500 hover:bg-white hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
                      >
                        <PencilIcon className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`delete ${node.path}`}
                        onClick={() => {
                          setEditing(null);
                          setConfirming(node.path);
                        }}
                        className="rounded-full p-1 text-neutral-500 hover:bg-white hover:text-red-600 focus-visible:outline-2 focus-visible:outline-bloop-deep"
                      >
                        <TrashIcon className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function PathInput({
  label,
  initial,
  onSubmit,
  onCancel
}: {
  label: string;
  initial: string;
  onSubmit: (path: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = validPath(value);
    if (!p) {
      setError("enter a relative path like src/app.ts");
      return;
    }
    if (p === initial) return onCancel();
    setBusy(true);
    const ok = await onSubmit(p);
    setBusy(false);
    if (!ok) setError("couldn’t do that — check the path");
  };

  return (
    <form onSubmit={submit} className="border-l-2 border-l-bloop bg-bloop/5 px-3 py-1.5">
      <input
        autoFocus
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={value}
        disabled={busy}
        placeholder="path/to/file.py"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onFocus={(e) => {
          const dot = e.target.value.lastIndexOf(".");
          const slash = e.target.value.lastIndexOf("/");
          if (dot > slash + 1) e.target.setSelectionRange(slash + 1, dot);
        }}
        className="w-full border border-neutral-300 bg-white px-2 py-1 font-mono text-[12px] text-neutral-900 focus-visible:border-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
      />
      <p className={cx("mt-1 text-[10px]", error ? "text-red-700" : "text-neutral-500")} role={error ? "alert" : undefined}>
        {error ?? "enter to confirm · esc to cancel"}
      </p>
    </form>
  );
}

export const FileTree = memo(FileTreeImpl);
