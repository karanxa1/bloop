import { memo, useEffect, useId, useRef, useState } from "react";
import { AlertIcon, CheckIcon, ChevronIcon, CodeIcon, ExternalIcon, ImageIcon, XIcon } from "../icons";
import { cx } from "../lib";
import { CopyButton, LongText } from "./ToolCallCard";

interface ImagePartProps {
  url: string;
  prompt?: string;
  /** small thumbnail for the trace feed */
  compact?: boolean;
}

/** relative app urls (/files/…) or absolute http(s) — never javascript:/data: hrefs */
const linkable = (url: string) =>
  (url.startsWith("/") && !url.startsWith("//")) || /^https?:\/\//i.test(url);

function DownloadGlyph() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16" />
    </svg>
  );
}

/** in-app download via fetch + blob (works for auth-guarded /files urls) */
async function downloadImage(url: string) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const ext = (blob.type.split("/")[1] ?? "png").split("+")[0] || "png";
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `bloop-image-${Date.now().toString(36)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 2000);
  } catch {
    if (linkable(url)) window.open(url, "_blank", "noopener,noreferrer");
  }
}

const roundBtn =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-600 transition-colors duration-150 hover:bg-neutral-200/70 hover:text-bloop-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep";

/** native <dialog> lightbox: focus trap, Esc and top layer for free */
function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={`image: ${alt}`}
      className="m-auto max-h-[94dvh] w-auto max-w-[min(94vw,1100px)] overflow-hidden bg-transparent p-0 backdrop:bg-neutral-900/80 open:motion-safe:animate-[tool-in_200ms_cubic-bezier(.22,1,.36,1)_both]"
    >
      <div className="flex max-h-[94dvh] flex-col border-l-2 border-l-bloop bg-white">
        <div className="flex h-11 shrink-0 items-center gap-1 pl-3 pr-1.5">
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-bloop-deep" />
          <p className="min-w-0 flex-1 truncate text-xs text-neutral-600">{alt}</p>
          <button type="button" onClick={() => void downloadImage(url)} aria-label="download image" title="download" className={roundBtn}>
            <DownloadGlyph />
          </button>
          {linkable(url) && (
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label="open image in a new tab" title="open in new tab" className={roundBtn}>
              <ExternalIcon className="h-3.5 w-3.5" />
            </a>
          )}
          <button type="button" onClick={onClose} aria-label="close" autoFocus className={roundBtn}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <img src={url} alt={alt} className="block max-h-[calc(94dvh-2.75rem)] w-auto min-w-0 bg-page object-contain" />
      </div>
    </dialog>
  );
}

export const ImagePart = memo(function ImagePart({ url, prompt, compact }: ImagePartProps) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [zoom, setZoom] = useState(false);
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
    <figure className="motion-safe:tool-in group/img my-3 max-w-md">
      <div className="relative overflow-hidden bg-page">
        <button
          type="button"
          onClick={() => setZoom(true)}
          disabled={state !== "ok"}
          aria-label={`enlarge image: ${alt}`}
          className="block w-full cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep disabled:cursor-progress"
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
              "block h-auto w-full border border-neutral-200 object-contain",
              "motion-safe:transition-[filter,opacity,transform] motion-safe:duration-500 motion-safe:ease-out",
              state === "loading" ? "scale-[1.03] opacity-0 blur-lg" : "scale-100 opacity-100 blur-0"
            )}
          />
        </button>
        {state === "loading" && (
          <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-neutral-200 via-page to-neutral-200 motion-safe:animate-pulse" aria-hidden="true">
            <ImageIcon className="h-6 w-6 text-neutral-300" />
          </span>
        )}
        {state === "ok" && (
          <button
            type="button"
            onClick={() => void downloadImage(url)}
            aria-label="download image"
            title="download"
            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm transition-[opacity,color] duration-150 hover:text-bloop-deep focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bloop-deep group-hover/img:opacity-100 [@media(hover:hover)]:opacity-0"
          >
            <DownloadGlyph />
          </button>
        )}
      </div>
      {prompt && (
        <figcaption className="mt-1 flex items-start gap-1.5 text-[11px] text-neutral-400">
          <ImageIcon className="mt-px h-3 w-3" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{prompt}</span>
        </figcaption>
      )}
      {zoom && <Lightbox url={url} alt={alt} onClose={() => setZoom(false)} />}
    </figure>
  );
});

interface CodePartProps {
  language: string;
  source: string;
  output?: string;
  ok?: boolean;
  /** start collapsed (used in the trace feed and step timeline) */
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
    <div className="my-1.5 overflow-hidden border border-neutral-200 border-l-2 border-l-bloop-deep bg-white text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-page focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep"
      >
        <CodeIcon className="h-3.5 w-3.5 text-bloop-deep" />
        <span className="text-[13px] font-medium text-neutral-800">ran code</span>
        <span className="font-mono text-[10px] text-neutral-400">{language || "code"}</span>
        <span className="ml-auto flex items-center gap-2">
          {ok === true && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-bloop-deep">
              <CheckIcon className="h-3 w-3" /> ok
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
            <div className="group/code relative">
              <pre className="max-h-64 overflow-auto bg-neutral-900 px-3 py-2 pr-9 font-mono text-[11px] leading-relaxed text-neutral-100 scroll-thin">
                {source}
              </pre>
              <CopyButton
                text={source}
                label="copy code"
                className="absolute right-1.5 top-1.5 text-neutral-400 hover:bg-white/10 hover:text-bloop"
              />
            </div>
            {output != null && output !== "" && (
              <div className="border-t border-neutral-100 bg-page px-3 py-2">
                <div className="text-[10px] font-semibold text-neutral-400">output</div>
                <LongText text={output} tone={ok === false ? "error" : "normal"} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
