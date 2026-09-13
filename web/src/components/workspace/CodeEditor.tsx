import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorHandle } from "./cm";
import { SpinnerIcon } from "../../icons";

export interface EditorFile {
  path: string;
  value: string;
  readOnly: boolean;
}

interface CodeEditorProps {
  /** null keeps whatever was last shown (e.g. while a binary tab is active) */
  file: EditorFile | null;
  openPaths: readonly string[];
  onChange: (path: string, doc: string) => void;
  onSave: (path: string) => void;
}

export function CodeEditor({ file, openPaths, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const latest = useRef({ file, onChange, onSave });
  useLayoutEffect(() => {
    latest.current = { file, onChange, onSave };
  });

  // mount once — CodeMirror is fetched on demand
  useEffect(() => {
    let dead = false;
    import("./cm")
      .then((m) => {
        if (dead || !host.current) return;
        const h = m.mountEditor(host.current, {
          onChange: (p, d) => latest.current.onChange(p, d),
          onSave: (p) => latest.current.onSave(p)
        });
        handle.current = h;
        const f = latest.current.file;
        if (f) h.open(f.path, f.value, f.readOnly);
        setPhase("ready");
      })
      .catch(() => {
        if (!dead) setPhase("error");
      });
    return () => {
      dead = true;
      handle.current?.destroy();
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    if (file) handle.current?.open(file.path, file.value, file.readOnly);
  }, [file, phase]);

  useEffect(() => {
    handle.current?.retain(openPaths);
  }, [openPaths]);

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full" />
      {phase !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-xs text-neutral-500">
          {phase === "loading" ? (
            <span className="inline-flex items-center gap-2">
              <SpinnerIcon className="h-3.5 w-3.5 motion-safe:animate-spin" />
              loading editor…
            </span>
          ) : (
            <span role="alert">couldn&rsquo;t load the editor — reload to try again.</span>
          )}
        </div>
      )}
    </div>
  );
}
