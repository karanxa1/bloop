import { useMemo, useState } from "react";
import { errMsg } from "../../api/marketplace";
import { listTools, setToolEnabled } from "../../api/tools";
import { cx } from "../../lib";
import type { BuiltinTool, ToolCategory } from "../../types/marketplace";
import {
  Chips,
  EmptyState,
  ErrorState,
  LockIcon,
  SkeletonRows,
  Switch,
  Tip,
  btnSecondary,
  cardCls,
  matches,
  useLoad,
  useToast
} from "./ui";

const GROUPS: { id: ToolCategory; blurb: string }[] = [
  { id: "core", blurb: "the loop bloop always runs" },
  { id: "web", blurb: "search and browse the live web" },
  { id: "code", blurb: "run code in a sandboxed workspace" },
  { id: "media", blurb: "images and audio" },
  { id: "memory", blurb: "what bloop remembers about you" },
  { id: "agents", blurb: "subagents and self-written skills" }
];

export function ToolsTab({ query, installedOnly, onClearFilters }: { query: string; installedOnly: boolean; onClearFilters: () => void }) {
  const toast = useToast();
  const tools = useLoad(listTools);
  const [category, setCategory] = useState("all");

  const setEnabled = (name: string, enabled: boolean) =>
    tools.setData((xs) => xs && xs.map((t) => (t.name === name ? { ...t, enabled } : t)));

  const toggle = async (t: BuiltinTool, next: boolean) => {
    if (t.locked) return;
    setEnabled(t.name, next); // optimistic
    try {
      await setToolEnabled(t.name, next);
    } catch (e) {
      setEnabled(t.name, !next);
      toast({
        tone: "error",
        text: `couldn't turn ${next ? "on" : "off"} ${t.label} — ${errMsg(e, "try again")}. reverted.`,
        action: { label: "retry", run: () => void toggle({ ...t, enabled: !next }, next) }
      });
    }
  };

  const all = tools.data ?? [];
  const options = useMemo(
    () => [
      { value: "all", label: "all" },
      ...GROUPS.filter((g) => all.some((t) => t.category === g.id)).map((g) => ({
        value: g.id,
        label: g.id,
        count: all.filter((t) => t.category === g.id).length
      }))
    ],
    [all]
  );
  const visible = all.filter(
    (t) =>
      (category === "all" || t.category === category) &&
      (!installedOnly || t.enabled) &&
      matches(query, t.label, t.name, t.description, t.category)
  );
  const onCount = all.filter((t) => t.enabled).length;

  if (tools.status === "loading")
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        <SkeletonRows count={3} />
        <SkeletonRows count={3} />
      </div>
    );
  if (tools.status === "error")
    return <ErrorState text={`couldn't load built-in tools. ${tools.error}`} onRetry={() => void tools.reload()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-600">
          <span className="font-semibold tabular-nums text-neutral-900">
            {onCount} of {all.length}
          </span>{" "}
          built-in tools on · changes apply from your next message
        </p>
      </div>
      <Chips label="filter tools by category" options={options} value={category} onChange={setCategory} />

      {visible.length === 0 ? (
        <EmptyState
          title="no tools match"
          actions={
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                setCategory("all");
                onClearFilters();
              }}
            >
              clear filters
            </button>
          }
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          {GROUPS.map((g) => {
            const items = visible.filter((t) => t.category === g.id);
            if (!items.length) return null;
            const on = all.filter((t) => t.category === g.id && t.enabled).length;
            const total = all.filter((t) => t.category === g.id).length;
            return (
              <section key={g.id} aria-labelledby={`tools-${g.id}`} className="motion-safe:rise">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <div>
                    <h3 id={`tools-${g.id}`} className="font-wordmark text-base font-bold leading-none text-neutral-900">
                      {g.id}
                    </h3>
                    <p className="mt-1 text-[11px] text-neutral-500">{g.blurb}</p>
                  </div>
                  <span className="text-[11px] tabular-nums text-neutral-500">
                    {on}/{total} on
                  </span>
                </div>
                <ul className={cx(cardCls, on > 0 ? "border-l-bloop" : "border-l-neutral-300", "divide-y divide-neutral-100")}>
                  {items.map((t) => (
                    <li key={t.name} className="flex items-center gap-3 px-3.5 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-semibold text-neutral-900">{t.label}</span>
                          <span className="font-mono text-[10.5px] text-neutral-500">{t.name}</span>
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-neutral-600">{t.description}</p>
                      </div>
                      {t.locked ? (
                        <Tip text={`bloop needs ${t.label} to work, so it's always on.`}>
                          <span className="inline-flex items-center gap-1.5">
                            <LockIcon className="h-3.5 w-3.5 text-neutral-400" />
                            <Switch checked={t.enabled} onChange={() => {}} disabled label={`${t.label} (always on)`} />
                          </span>
                        </Tip>
                      ) : (
                        <Switch
                          checked={t.enabled}
                          onChange={(v) => void toggle(t, v)}
                          label={`${t.enabled ? "turn off" : "turn on"} ${t.label}`}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
