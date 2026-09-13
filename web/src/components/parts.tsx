import { useState } from "react";
import { CheckIcon, ChevronIcon, CodeIcon, ImageIcon, XIcon } from "../icons";
import { cx } from "../lib";

interface ImagePartProps {
  url: string;
  prompt?: string;
  /** small thumbnail for the trace feed */
  compact?: boolean;
}

export function ImagePart({ url, prompt, compact }: ImagePartProps) {
  if (compact) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <img
          src={url}
          alt={prompt || "generated image"}
          loading="lazy"
          className="h-16 w-16 border border-neutral-200 object-cover"
        />
      </a>
    );
  }
  return (
    <figure className="my-2">
      <img
        src={url}
        alt={prompt || "generated image"}
        loading="lazy"
        className="max-h-96 max-w-full border border-neutral-200 object-contain"
      />
      {prompt && (
        <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-400">
          <ImageIcon className="h-3 w-3" />
          {prompt}
        </figcaption>
      )}
    </figure>
  );
}

interface CodePartProps {
  language: string;
  source: string;
  output?: string;
  ok?: boolean;
  /** start collapsed (used in the trace feed) */
  collapsed?: boolean;
}

export function CodePart({
  language,
  source,
  output,
  ok,
  collapsed
}: CodePartProps) {
  const [open, setOpen] = useState(!collapsed);

  return (
    <div className="my-2 overflow-hidden border border-neutral-200 border-l-2 border-l-bloop-deep bg-white text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-page focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
      >
        <CodeIcon className="h-3.5 w-3.5 text-bloop-deep" />
        <span className="font-mono text-xs font-semibold text-neutral-800">
          {language || "code"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {ok === true && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-bloop-deep">
              <CheckIcon className="h-3 w-3" /> ran ok
            </span>
          )}
          {ok === false && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-red-600">
              <XIcon className="h-3 w-3" /> failed
            </span>
          )}
          <ChevronIcon
            className={cx(
              "h-3.5 w-3.5 text-neutral-400 transition-transform motion-safe:duration-150",
              open && "rotate-90"
            )}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-neutral-100">
          <pre className="max-h-64 overflow-auto bg-neutral-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-100 scroll-thin">
            {source}
          </pre>
          {output != null && output !== "" && (
            <div className="border-t border-neutral-100 bg-page px-3 py-2">
              <div className="text-[10px] font-semibold tracking-wide text-neutral-400">
                output
              </div>
              <pre
                className={cx(
                  "mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed scroll-thin",
                  ok === false ? "text-red-700" : "text-neutral-700"
                )}
              >
                {output.length > 1200 ? `${output.slice(0, 1200)}…` : output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
