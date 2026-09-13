import { memo, useId, useState } from "react";
import { AlertIcon, CheckIcon, ChevronIcon, CodeIcon, ImageIcon, XIcon } from "../icons";
import { cx } from "../lib";

interface ImagePartProps {
  url: string;
  prompt?: string;
  /** small thumbnail for the trace feed */
  compact?: boolean;
}

/** relative app urls (/files/…) or absolute http(s) — never javascript:/data: hrefs */
const linkable = (url: string) => url.startsWith("/") || /^https?:\/\//i.test(url);

export const ImagePart = memo(function ImagePart({ url, prompt, compact }: ImagePartProps) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const alt = prompt || "generated image";

  if (compact) {
    return (
      <a
        href={linkable(url) ? url : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="block shrink-0 focus-visible:outline-2 focus-visible:outline-bloop-deep"
      >
        <img
          src={url}
          alt={alt}
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          className="h-16 w-16 border border-neutral-200 bg-page object-cover"
        />
      </a>
    );
  }

  if (state === "error") {
    return (
      <p className="my-2 flex items-center gap-2 border border-neutral-200 border-l-2 border-l-red-500 bg-white px-3 py-2 text-xs text-neutral-500">
        <AlertIcon className="h-3.5 w-3.5 text-red-600" />
        image unavailable
        {prompt && <span className="truncate text-neutral-400">— {prompt}</span>}
      </p>
    );
  }

  return (
    <figure className="motion-safe:tool-in my-2 max-w-md">
      <a
        href={linkable(url) ? url : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
        aria-label={`open image: ${alt}`}
      >
        {/* width/height reserve a square box before load (no layout jump); h-auto adopts the real ratio */}
        <img
          src={url}
          alt={alt}
          width={1024}
          height={1024}
          loading="lazy"
          decoding="async"
          onLoad={() => setState("ok")}
          onError={() => setState("error")}
          className={cx(
            "block h-auto w-full border border-neutral-200 object-contain transition-opacity duration-300",
            state === "loading" && "opacity-0"
          )}
        />
        {state === "loading" && (
          <span
            className="absolute inset-0 bg-neutral-200/60 motion-safe:animate-pulse"
            aria-hidden="true"
          />
        )}
      </a>
      {prompt && (
        <figcaption className="mt-1 flex items-start gap-1.5 text-[11px] text-neutral-400">
          <ImageIcon className="mt-px h-3 w-3" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{prompt}</span>
        </figcaption>
      )}
    </figure>
  );
});

interface CodePartProps {
  language: string;
  source: string;
  output?: string;
  ok?: boolean;
  /** start collapsed (used in the trace feed) */
  collapsed?: boolean;
}

export const CodePart = memo(function CodePart({
  language,
  source,
  output,
  ok,
  collapsed
}: CodePartProps) {
  const [open, setOpen] = useState(!collapsed);
  const bodyId = useId();

  return (
    <div className="my-2 overflow-hidden border border-neutral-200 border-l-2 border-l-bloop-deep bg-white text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
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
              "h-3.5 w-3.5 text-neutral-400 transition-transform motion-safe:duration-200",
              open && "rotate-90"
            )}
          />
        </span>
      </button>

      <div
        id={bodyId}
        inert={!open}
        className={cx(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
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
        </div>
      </div>
    </div>
  );
});
