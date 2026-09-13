import { useMemo, useState } from "react";
import { errMsg } from "../../api/marketplace";
import {
  createSkill,
  deleteSkill,
  installCatalogSkill,
  listSkillCatalog,
  listSkills,
  updateSkill
} from "../../api/skills";
import { CheckIcon, PencilIcon, PlusIcon } from "../../icons";
import { cx, relTime } from "../../lib";
import type { CatalogSkill, Skill, SkillDraft, SkillSource } from "../../types/marketplace";
import { MarkdownText } from "../MarkdownText";
import { SKILL_TEMPLATE, SkillEditor } from "./SkillEditor";
import {
  Badge,
  BookIcon,
  Chips,
  ConfirmRemove,
  EmptyState,
  ErrorState,
  SectionHeader,
  SkeletonCards,
  SparkIcon,
  Spinner,
  Switch,
  btnSecondary,
  btnSmallPrimary,
  cardCls,
  matches,
  useLoad,
  useToast
} from "./ui";
import type { BadgeTone } from "./ui";

const SOURCE: Record<SkillSource, { label: string; tone: BadgeTone }> = {
  user: { label: "yours", tone: "neutral" },
  agent: { label: "made by bloop", tone: "lime" },
  catalog: { label: "catalog", tone: "sky" }
};

const isPending = (s: Skill) => s.id.startsWith("tmp_");

export function SkillsTab({ query, installedOnly, onClearFilters }: { query: string; installedOnly: boolean; onClearFilters: () => void }) {
  const toast = useToast();
  const mine = useLoad(listSkills);
  const catalog = useLoad(listSkillCatalog);
  const [category, setCategory] = useState("all");
  const [editor, setEditor] = useState<{ skill: Skill | null; draft?: SkillDraft } | null>(null);

  const patchSkill = (id: string, patch: Partial<Skill>) =>
    mine.setData((xs) => xs && xs.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const flagCatalog = (pred: (c: CatalogSkill) => boolean, installed: boolean) =>
    catalog.setData((xs) => xs && xs.map((c) => (pred(c) ? { ...c, installed } : c)));

  const toggle = async (s: Skill, next: boolean) => {
    patchSkill(s.id, { enabled: next });
    try {
      await updateSkill(s.id, { enabled: next });
    } catch (e) {
      patchSkill(s.id, { enabled: !next });
      toast({
        tone: "error",
        text: `couldn't ${next ? "enable" : "disable"} ${s.name} — ${errMsg(e, "try again")}. reverted.`,
        action: { label: "retry", run: () => void toggle(s, next) }
      });
    }
  };

  const remove = async (s: Skill) => {
    const idx = (mine.data ?? []).findIndex((x) => x.id === s.id);
    mine.setData((xs) => xs && xs.filter((x) => x.id !== s.id));
    const fromCatalog = (c: CatalogSkill) => s.source === "catalog" && c.name === s.name;
    flagCatalog(fromCatalog, false);
    try {
      await deleteSkill(s.id);
      toast({ tone: "info", text: `deleted ${s.name}` });
      void catalog.reload(true);
    } catch (e) {
      mine.setData((xs) => {
        if (!xs) return xs;
        const next = [...xs];
        next.splice(Math.max(0, idx), 0, s);
        return next;
      });
      flagCatalog(fromCatalog, true);
      toast({ tone: "error", text: `couldn't delete ${s.name} — ${errMsg(e, "try again")}` });
    }
  };

  const install = async (c: CatalogSkill) => {
    flagCatalog((x) => x.slug === c.slug, true); // optimistic
    try {
      const s = await installCatalogSkill(c.slug);
      if (s && typeof s === "object" && "id" in s) {
        mine.setData((xs) => [s, ...(xs ?? []).filter((x) => x.id !== s.id)]);
        toast({ tone: "ok", text: `installed ${c.name} — bloop will use it when a task fits`, action: { label: "edit", run: () => setEditor({ skill: s }) } });
      } else {
        void mine.reload(true);
        toast({ tone: "ok", text: `installed ${c.name}` });
      }
    } catch (e) {
      flagCatalog((x) => x.slug === c.slug, false);
      toast({
        tone: "error",
        text: `couldn't install ${c.name} — ${errMsg(e, "try again")}`,
        action: { label: "retry", run: () => void install(c) }
      });
    }
  };

  const save = async (draft: SkillDraft, existing: Skill | null) => {
    setEditor(null);
    if (existing) {
      patchSkill(existing.id, { ...draft, updated_at: new Date().toISOString() });
      try {
        const s = await updateSkill(existing.id, draft);
        if (s && typeof s === "object" && "id" in s) mine.setData((xs) => xs && xs.map((x) => (x.id === s.id ? s : x)));
        toast({ tone: "ok", text: `saved ${draft.name}` });
      } catch (e) {
        mine.setData((xs) => xs && xs.map((x) => (x.id === existing.id ? existing : x)));
        toast({
          tone: "error",
          text: `couldn't save ${draft.name} — ${errMsg(e, "try again")}. changes reverted.`,
          action: { label: "reopen", run: () => setEditor({ skill: existing, draft }) }
        });
      }
      return;
    }
    const tmp: Skill = { id: `tmp_${Date.now()}`, ...draft, source: "user", enabled: true, updated_at: new Date().toISOString() };
    mine.setData((xs) => [tmp, ...(xs ?? [])]);
    try {
      const s = await createSkill(draft);
      mine.setData((xs) => xs && xs.map((x) => (x.id === tmp.id ? s : x)));
      toast({ tone: "ok", text: `created ${s.name} — bloop will reach for it when it fits` });
    } catch (e) {
      mine.setData((xs) => xs && xs.filter((x) => x.id !== tmp.id));
      toast({
        tone: "error",
        text: `couldn't create ${draft.name} — ${errMsg(e, "try again")}`,
        action: { label: "reopen", run: () => setEditor({ skill: null, draft }) }
      });
    }
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of catalog.data ?? []) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    return [
      { value: "all", label: "all" },
      ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, label: value, count }))
    ];
  }, [catalog.data]);

  const myList = (mine.data ?? []).filter((s) => matches(query, s.name, s.description));
  const catalogList = (catalog.data ?? []).filter(
    (c) => (category === "all" || c.category === category) && matches(query, c.name, c.description, c.category)
  );
  const hasSkills = (mine.data?.length ?? 0) > 0;
  const scrollToCatalog = () => document.getElementById("sk-catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-7">
      <section aria-labelledby="sk-mine">
        <SectionHeader id="sk-mine" title="my skills" count={mine.data ? myList.length : undefined}>
          <button type="button" onClick={() => setEditor({ skill: null })} className={btnSmallPrimary}>
            <PlusIcon className="h-3.5 w-3.5" /> new skill
          </button>
        </SectionHeader>

        {mine.status === "loading" ? (
          <SkeletonCards count={3} />
        ) : mine.status === "error" ? (
          <ErrorState text={`couldn't load your skills. ${mine.error}`} onRetry={() => void mine.reload()} />
        ) : !hasSkills ? (
          <EmptyState
            icon={<BookIcon className="h-4 w-4" />}
            title="no skills yet"
            actions={
              <>
                <button type="button" onClick={() => setEditor({ skill: null })} className={btnSmallPrimary}>
                  <PlusIcon className="h-3.5 w-3.5" /> write one
                </button>
                {!installedOnly && (
                  <button type="button" onClick={scrollToCatalog} className={btnSecondary}>
                    browse the catalog
                  </button>
                )}
              </>
            }
          >
            skills are short playbooks bloop follows when a task matches — like &ldquo;weekly update&rdquo; or &ldquo;code review&rdquo;.
            bloop can also create skills itself: when it works out a repeatable workflow in chat, it saves it here marked{" "}
            <strong>made by bloop</strong>.
          </EmptyState>
        ) : myList.length === 0 ? (
          <p className="py-3 text-xs text-neutral-500">
            none of your skills match &ldquo;{query.trim()}&rdquo;.{" "}
            <button type="button" onClick={onClearFilters} className="font-semibold text-neutral-800 underline underline-offset-2">
              clear search
            </button>
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {myList.map((s, i) => (
              <SkillCard
                key={s.id}
                skill={s}
                index={i}
                onToggle={(v) => void toggle(s, v)}
                onEdit={() => setEditor({ skill: s })}
                onRemove={() => void remove(s)}
              />
            ))}
          </ul>
        )}
        {hasSkills && (
          <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-neutral-600">
            <SparkIcon className="mt-px h-3.5 w-3.5 shrink-0 text-bloop-deep" />
            bloop writes skills too — after a good run, say &ldquo;save that as a skill&rdquo;, or let it notice a repeatable workflow on its own.
          </p>
        )}
      </section>

      {!installedOnly && (
        <section aria-labelledby="sk-catalog" id="sk-catalog" className="scroll-mt-4">
          <SectionHeader id="sk-catalog-title" title="catalog" count={catalog.data ? catalogList.length : undefined} />
          <div className="mb-3">
            <Chips label="filter skills by category" options={categories} value={category} onChange={setCategory} />
          </div>
          {catalog.status === "loading" ? (
            <SkeletonCards count={6} />
          ) : catalog.status === "error" ? (
            <ErrorState text={`couldn't load the skill catalog. ${catalog.error}`} onRetry={() => void catalog.reload()} />
          ) : catalogList.length === 0 ? (
            <EmptyState
              title="no catalog skills match"
              actions={
                <>
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
                  <button type="button" className={btnSmallPrimary} onClick={() => setEditor({ skill: null })}>
                    write your own
                  </button>
                </>
              }
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catalogList.map((c, i) => (
                <CatalogSkillCard key={c.slug} skill={c} index={i} onInstall={() => void install(c)} />
              ))}
            </ul>
          )}
        </section>
      )}

      {editor && (
        <SkillEditor
          key={editor.skill?.id ?? "new"}
          isNew={!editor.skill}
          initial={editor.draft ?? (editor.skill ? { name: editor.skill.name, description: editor.skill.description, body: editor.skill.body } : { name: "", description: "", body: SKILL_TEMPLATE })}
          takenNames={(mine.data ?? []).filter((s) => s.id !== editor.skill?.id).map((s) => s.name)}
          onCancel={() => setEditor(null)}
          onSave={(d) => void save(d, editor.skill)}
        />
      )}
    </div>
  );
}

function SkillCard({
  skill: s,
  index,
  onToggle,
  onEdit,
  onRemove
}: {
  skill: Skill;
  index: number;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const pending = isPending(s);
  const src = SOURCE[s.source] ?? SOURCE.user;
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      className={cx(cardCls, "motion-safe:rise flex flex-col p-3.5", s.enabled ? "border-l-bloop" : "border-l-neutral-300", !s.enabled && "bg-neutral-50")}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="truncate font-mono text-sm font-semibold text-neutral-900">{s.name}</h4>
            <Badge tone={src.tone}>
              {s.source === "agent" && <SparkIcon className="h-2.5 w-2.5" />}
              {src.label}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-600">{s.description}</p>
        </div>
        <Switch checked={s.enabled} onChange={onToggle} disabled={pending} label={`${s.enabled ? "disable" : "enable"} ${s.name}`} />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <span className="text-[11px] text-neutral-500">
          {pending ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="h-3 w-3" /> saving…
            </span>
          ) : (
            `updated ${relTime(s.updated_at)}`
          )}
        </span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onEdit} disabled={pending} className={btnSecondary} aria-label={`edit ${s.name}`}>
            <PencilIcon className="h-3.5 w-3.5" /> edit
          </button>
          <ConfirmRemove label={s.name} onConfirm={onRemove} disabled={pending} />
        </div>
      </div>
    </li>
  );
}

function CatalogSkillCard({ skill: c, index, onInstall }: { skill: CatalogSkill; index: number; onInstall: () => void }) {
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      className={cx(cardCls, "motion-safe:rise flex flex-col p-3.5", c.installed ? "border-l-bloop" : "border-l-neutral-300")}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="truncate font-mono text-sm font-semibold text-neutral-900">{c.name}</h4>
        <Badge>{c.category}</Badge>
      </div>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-neutral-600">{c.description}</p>
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full text-[11px] font-semibold text-neutral-600 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-bloop-deep [&::-webkit-details-marker]:hidden">
          <span className="motion-safe:transition-transform group-open:rotate-90" aria-hidden="true">
            ›
          </span>
          peek at instructions
        </summary>
        <div className="mt-2 max-h-48 overflow-y-auto border-t border-neutral-100 pt-2 text-xs scroll-thin">
          <MarkdownText text={c.body} />
        </div>
      </details>
      <div className="mt-3 flex justify-end">
        {c.installed ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-800">
            <CheckIcon className="h-3.5 w-3.5 text-bloop-deep" /> installed
          </span>
        ) : (
          <button type="button" onClick={onInstall} className={btnSmallPrimary} aria-label={`install ${c.name}`}>
            install
          </button>
        )}
      </div>
    </li>
  );
}
