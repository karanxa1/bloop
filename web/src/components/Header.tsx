import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ModelInfo } from "../types";
import { ChevronIcon, MenuIcon, PencilIcon, TraceIcon } from "../icons";
import { cx } from "../lib";

export type HealthState =
  | { status: "loading" }
  | { status: "ok"; model?: string; servers: number }
  | { status: "down" };

interface HeaderProps {
  health: HealthState;
  title: string;
  /** whether a persisted conversation is active (title becomes editable) */
  canRename: boolean;
  onRename: (title: string) => void;
  models: ModelInfo[];
  model: string;
  onModelChange: (id: string) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  traceOpen: boolean;
  onToggleTrace: () => void;
}

export function Header({
  health,
  title,
  canRename,
  onRename,
  models,
  model,
  onModelChange,
  sidebarOpen,
  onToggleSidebar,
  traceOpen,
  onToggleTrace
}: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 sm:px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "hide sidebar" : "show sidebar"}
        aria-expanded={sidebarOpen}
        className="rounded-full p-2 text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <MenuIcon className="h-4.5 w-4.5" />
      </button>

      <TitleEditor
        title={title}
        canRename={canRename}
        onRename={onRename}
      />

      <div className="ml-auto flex items-center gap-2">
        <ModelPicker models={models} value={model} onChange={onModelChange} />
        <HealthPill health={health} />
        <button
          type="button"
          onClick={onToggleTrace}
          aria-expanded={traceOpen}
          aria-label="toggle proof trace"
          className={cx(
            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-bloop-deep",
            traceOpen
              ? "bg-bloop text-white"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
          )}
        >
          <TraceIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">proof</span>
        </button>
      </div>
    </header>
  );
}

function TitleEditor({
  title,
  canRename,
  onRename
}: {
  title: string;
  canRename: boolean;
  onRename: (t: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(title), [title]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== title) onRename(t);
    else setDraft(title);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setDraft(title);
      setEditing(false);
    }
  };

  if (!canRename) {
    return (
      <h1 className="min-w-0 truncate font-wordmark text-base font-bold text-neutral-700">
        {title || "new chat"}
      </h1>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        aria-label="conversation title"
        className="min-w-0 max-w-[16rem] flex-1 border-b-2 border-bloop bg-transparent font-wordmark text-base font-bold text-neutral-800 outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="rename conversation"
      className="group flex min-w-0 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-bloop-deep"
    >
      <h1 className="min-w-0 truncate font-wordmark text-base font-bold text-neutral-800">
        {title || "untitled"}
      </h1>
      <PencilIcon className="h-3 w-3 shrink-0 text-neutral-300 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

function ModelPicker({
  models,
  value,
  onChange
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (models.length === 0) return null;
  return (
    <div className="relative">
      <label htmlFor="model-picker" className="sr-only">
        model
      </label>
      <select
        id="model-picker"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-full border border-neutral-300 bg-white py-1.5 pl-3 pr-7 text-[11px] font-semibold text-neutral-700 transition-colors duration-150 hover:border-bloop focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label || m.id}
          </option>
        ))}
      </select>
      <ChevronIcon
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 rotate-90 text-neutral-400"
      />
    </div>
  );
}

function HealthPill({ health }: { health: HealthState }) {
  return (
    <div
      className="hidden items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 text-[11px] font-medium text-neutral-600 md:flex"
      role="status"
      aria-label="backend status"
    >
      <span
        className={cx(
          "h-1.5 w-1.5 rounded-full",
          health.status === "ok"
            ? "bg-bloop motion-safe:animate-pulse"
            : health.status === "down"
              ? "bg-red-400"
              : "bg-neutral-400"
        )}
      />
      {health.status === "ok" ? (
        <span>
          {health.servers} {health.servers === 1 ? "app" : "apps"} connected
        </span>
      ) : health.status === "down" ? (
        <span className="text-red-600">offline</span>
      ) : (
        <span>connecting…</span>
      )}
    </div>
  );
}
