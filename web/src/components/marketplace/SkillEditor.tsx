import { useId, useState } from "react";
import type { FormEvent } from "react";
import { cx } from "../../lib";
import type { SkillDraft } from "../../types/marketplace";
import { MarkdownText } from "../MarkdownText";
import { Overlay, btnPrimary, btnSecondary, cardCls, inputCls, labelCls } from "./ui";

export const SKILL_TEMPLATE = "# my skill\n\n## when to use\n- \n\n## steps\n1. \n";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

interface SkillEditorProps {
  initial: SkillDraft;
  isNew: boolean;
  /** other skills' names (for duplicate checks) */
  takenNames: string[];
  onCancel: () => void;
  onSave: (draft: SkillDraft) => void;
}

export function SkillEditor({ initial, isNew, takenNames, onCancel, onSave }: SkillEditorProps) {
  const ids = useId();
  const formId = `${ids}-form`;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  const [view, setView] = useState<"write" | "preview">("write");
  const [tried, setTried] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const dirty = name !== initial.name || description !== initial.description || body !== initial.body;
  const n = name.trim();
  const errors = {
    name: !n
      ? "name the skill"
      : n.length > 64
        ? "keep it under 64 characters"
        : !NAME_RE.test(n)
          ? "use lowercase letters, numbers and dashes"
          : takenNames.includes(n)
            ? `you already have a skill called ${n}`
            : null,
    description: !description.trim()
      ? "say what it does and when bloop should use it"
      : description.trim().length > 200
        ? "keep it under 200 characters"
        : null,
    body: !body.trim() ? "write the instructions" : null
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : null);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    onSave({ name: n, description: description.trim(), body });
  };
  const requestClose = () => {
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onCancel();
  };

  const err = (k: keyof typeof errors) =>
    show(k) ? (
      <p id={`${ids}-${k}-err`} className="mt-1 text-[11px] font-medium text-red-700">
        {show(k)}
      </p>
    ) : null;

  return (
    <Overlay
      size="wide"
      title={isNew ? "new skill" : `edit ${initial.name}`}
      subtitle="a short playbook bloop follows whenever a task matches the description."
      onClose={requestClose}
      footer={
        confirmDiscard ? (
          <>
            <span role="alert" className="mr-auto text-xs font-semibold text-neutral-800">
              discard your changes?
            </span>
            <button type="button" onClick={() => setConfirmDiscard(false)} className={btnSecondary}>
              keep editing
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
            >
              discard
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={requestClose} className={btnSecondary}>
              cancel
            </button>
            <button type="submit" form={formId} className={btnPrimary}>
              {isNew ? "create skill" : "save"}
            </button>
          </>
        )
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <label htmlFor={`${ids}-name`} className={labelCls}>
              name
            </label>
            <input
              id={`${ids}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="weekly-update"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              aria-invalid={!!show("name")}
              aria-describedby={show("name") ? `${ids}-name-err` : undefined}
              className={cx(inputCls, "font-mono text-xs")}
            />
            {err("name")}
          </div>
          <div>
            <label htmlFor={`${ids}-desc`} className={labelCls}>
              description
              <span className={cx("float-right font-normal tabular-nums", description.trim().length > 200 ? "text-red-700" : "text-neutral-500")}>
                {description.trim().length}/200
              </span>
            </label>
            <input
              id={`${ids}-desc`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="turn a week of activity into a crisp status post"
              aria-invalid={!!show("description")}
              aria-describedby={show("description") ? `${ids}-description-err` : undefined}
              className={inputCls}
            />
            {err("description")}
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor={`${ids}-body`} className={cx(labelCls, "mb-0")}>
              instructions <span className="font-normal text-neutral-500">· markdown</span>
            </label>
            <div role="group" aria-label="editor view" className="inline-flex rounded-full border border-neutral-300 bg-white p-0.5 lg:hidden">
              {(["write", "preview"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    "rounded-full px-3 py-1 text-xs font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-bloop-deep",
                    view === v ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <textarea
              id={`${ids}-body`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              aria-invalid={!!show("body")}
              aria-describedby={show("body") ? `${ids}-body-err` : undefined}
              className={cx(
                inputCls,
                "min-h-[16rem] resize-y font-mono text-xs leading-relaxed lg:h-[24rem]",
                view !== "write" && "hidden lg:block"
              )}
            />
            <div
              aria-label="preview"
              role="region"
              className={cx(
                cardCls,
                "min-h-[16rem] overflow-y-auto border-l-bloop px-4 py-3 text-sm scroll-thin lg:h-[24rem]",
                view !== "preview" && "hidden lg:block"
              )}
            >
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">preview</p>
              <MarkdownText text={body.trim() ? body : "_nothing to preview yet._"} />
            </div>
          </div>
          {err("body")}
        </div>
      </form>
    </Overlay>
  );
}
