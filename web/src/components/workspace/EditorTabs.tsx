import { memo, useEffect, useRef } from "react";
import type { EditorTab } from "../../types/workspace";
import { SpinnerIcon, XIcon } from "../../icons";
import { cx } from "../../lib";
import { baseName, isDirty } from "./util";

interface EditorTabsProps {
  tabs: EditorTab[];
  activePath: string | null;
  writing: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onShowTree: () => void;
}

function EditorTabsImpl({ tabs, activePath, writing, onSelect, onClose, onShowTree }: EditorTabsProps) {
  const refs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (activePath) refs.current.get(activePath)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  return (
    <div className="flex shrink-0 items-stretch border-b border-neutral-200 bg-neutral-50">
      <button
        type="button"
        onClick={onShowTree}
        className="shrink-0 border-r border-neutral-200 px-3 text-[11px] font-semibold text-neutral-700 hover:bg-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep @xl:hidden"
      >
        ← files
      </button>
      <div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]" role="group" aria-label="open files">
        {tabs.map((t) => {
          const active = t.path === activePath;
          const dirty = isDirty(t);
          return (
            <div
              key={t.path}
              ref={(el) => {
                if (el) refs.current.set(t.path, el);
                else refs.current.delete(t.path);
              }}
              className={cx(
                "flex shrink-0 items-center border-r border-neutral-200 text-[12px]",
                active ? "bg-white text-neutral-900 shadow-[inset_0_2px_0_#8dc63f]" : "text-neutral-600 hover:bg-white"
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(t.path)}
                aria-pressed={active}
                title={t.path}
                className="flex items-center gap-1.5 py-2 pl-3 pr-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
              >
                <span className={cx("max-w-40 truncate font-mono", t.stale && "italic")}>{baseName(t.path)}</span>
                {t.saving ? (
                  <SpinnerIcon className="h-3 w-3 text-neutral-500 motion-safe:animate-spin" />
                ) : writing.has(t.path) ? (
                  <span className="h-2 w-2 rounded-full bg-bloop motion-safe:animate-pulse" role="img" aria-label="bloop is editing" />
                ) : dirty ? (
                  <span className="h-2 w-2 rounded-full bg-neutral-800" role="img" aria-label="unsaved changes" />
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => onClose(t.path)}
                aria-label={`close ${t.path}`}
                className="mr-1.5 rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-bloop-deep"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const EditorTabs = memo(EditorTabsImpl);
