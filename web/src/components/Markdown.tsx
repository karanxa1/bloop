// Heavy (react-markdown + remark-gfm + micromark) — only ever imported
// lazily via MarkdownText so it stays out of the main bundle.
import { useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Cite } from "./AgentParts";
import { ImageIcon } from "../icons";
import { hostOf } from "../lib";

const plugins = [remarkGfm];

const CITE_HREF = "#cite-";

/** links: http/https/mailto only (plus internal citation anchors) */
const safeHref = (href?: string) =>
  href && (/^(https?:\/\/|mailto:)/i.test(href) || href.startsWith(CITE_HREF)) ? href : null;

/** images auto-load only from our origin (/files/…) or inline data — no exfiltration beacons */
const autoLoadable = (src: string) => src.startsWith("/files/") || /^data:image\//i.test(src);

// keep data:image through react-markdown's sanitizer; everything else uses the default rules
const urlTransform = (url: string) =>
  /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

/** external image: click-to-load placeholder, then no-referrer */
function ExternalImage({ src, alt }: { src: string; alt: string }) {
  const [load, setLoad] = useState(false);
  const host = hostOf(src);
  if (load) {
    return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
  }
  return (
    <button
      type="button"
      onClick={() => setLoad(true)}
      title={src}
      className="my-1 inline-flex max-w-full items-center gap-2 border border-neutral-200 border-l-2 border-l-neutral-300 bg-white px-3 py-2 text-left align-middle text-xs not-italic text-neutral-600 transition-colors duration-150 hover:border-l-bloop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
    >
      <ImageIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      <span className="min-w-0 truncate">
        image from {host}
        {alt && <span className="text-neutral-400"> — {alt}</span>}
      </span>
      <span className="shrink-0 rounded-full bg-bloop/15 px-2 py-0.5 text-[11px] font-semibold text-bloop-deep">
        load
      </span>
    </button>
  );
}

const components: Components = {
  a(props) {
    const { node, href, children, title, ...rest } = props;
    void node;
    if (href?.startsWith(CITE_HREF)) {
      const n = Number(href.slice(CITE_HREF.length));
      if (Number.isInteger(n) && n > 0) return <Cite n={n} />;
    }
    const safe = safeHref(href);
    if (!safe) return <span>{children}</span>;
    const hint = safe.startsWith("mailto:") ? safe.slice(7) : hostOf(safe);
    return (
      <a
        {...rest}
        href={safe}
        title={title ? `${title} — ${hint}` : hint}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {children}
      </a>
    );
  },
  img(props) {
    const src = typeof props.src === "string" ? props.src : "";
    const alt = props.alt ?? "";
    if (autoLoadable(src)) return <img src={src} alt={alt} loading="lazy" decoding="async" />;
    if (/^https?:\/\//i.test(src)) return <ExternalImage src={src} alt={alt} />;
    return alt ? <span className="text-neutral-400">[{alt}]</span> : null;
  }
};

/**
 * `[n]` citation markers → `[n](#cite-n)` links, rendered as source pills.
 * Skips fenced and inline code, `arr[1]`-style indexing, images and real links.
 */
function linkCitations(md: string): string {
  if (!/\[\d{1,3}\]/.test(md)) return md;
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((seg, i) =>
      i % 2 === 1 ? seg : seg.replace(/(?<![!\\\w])\[(\d{1,3})\](?![(:])/g, `[$1](${CITE_HREF}$1)`)
    )
    .join("");
}

export default function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {linkCitations(text)}
    </ReactMarkdown>
  );
}
