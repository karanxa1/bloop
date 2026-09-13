import { LOGOS } from "../logos";
import type { BrandLogo } from "../logos";
import { cx } from "../lib";

/** server name/url → brand key */
const HOST_HINTS: [RegExp, string][] = [
  [/higgsfield/i, "higgsfield"],
  [/github|githubcopilot/i, "github"],
  [/cloudflare|cf-docs|workers/i, "cloudflare"],
  [/zapier/i, "zapier"],
  [/slack/i, "slack"],
  [/notion/i, "notion"],
  [/gmail|google/i, "gmail"],
  [/linear/i, "linear"],
  [/huggingface|hf\.co/i, "huggingface"],
  [/gitlab/i, "gitlab"],
  [/figma/i, "figma"],
  [/jira|atlassian/i, "jira"],
  [/sentry/i, "sentry"],
  [/openai|azure/i, "openai"]
];

function brandKey(name: string, url: string): string | null {
  const hay = `${name} ${url}`;
  for (const [re, key] of HOST_HINTS) if (re.test(hay)) return key;
  return null;
}

/** explicit catalog `logo` (brand key) wins, then name/url hints */
export function resolveBrand(name: string, url = "", logo?: string): BrandLogo | null {
  if (logo && LOGOS[logo.toLowerCase()]) return LOGOS[logo.toLowerCase()];
  const key = brandKey(name, url);
  return (key && LOGOS[key]) || LOGOS[name.toLowerCase()] || null;
}

const isImageUrl = (s?: string) => !!s && /^(https:\/\/|data:image\/)/i.test(s);

function Glyph({ logo, className }: { logo: BrandLogo; className?: string }) {
  return (
    <svg
      viewBox={logo.viewBox ?? "0 0 24 24"}
      className={className}
      fill={logo.color}
      aria-hidden="true"
    >
      {logo.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

interface ServerLogoProps {
  name: string;
  url: string;
  /** catalog logo: brand key or https/data image url */
  logo?: string;
  className?: string;
}

/**
 * Real brand logo for a server when we recognise it (or the catalog ships an
 * image), otherwise a letter monogram in bloop lime.
 */
export function ServerLogo({ name, url, logo, className }: ServerLogoProps) {
  const brand = resolveBrand(name, url, logo);

  if (brand) {
    return (
      <span
        className={cx(
          "flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-200 bg-white",
          className
        )}
        style={brand.bg ? { backgroundColor: brand.bg, borderColor: brand.bg } : undefined}
        aria-hidden="true"
      >
        <Glyph logo={brand} className="h-1/2 w-1/2" />
      </span>
    );
  }

  if (isImageUrl(logo)) {
    return (
      <span
        className={cx(
          "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden border border-neutral-200 bg-white",
          className
        )}
        aria-hidden="true"
      >
        <img src={logo} alt="" className="h-3/5 w-3/5 object-contain" loading="lazy" />
      </span>
    );
  }

  return (
    <span
      className={cx(
        "flex h-9 w-9 shrink-0 items-center justify-center bg-bloop/15 font-wordmark text-sm font-bold text-bloop-deep",
        className
      )}
      aria-hidden="true"
    >
      {(name.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

/**
 * Bare brand glyph (no tile) for inline use next to an app name —
 * e.g. the app chip on tool-call cards. Falls back to nothing for
 * unknown apps (the chip text is enough).
 */
export function AppLogo({ name, className }: { name: string; className?: string }) {
  const logo = resolveBrand(name);
  if (!logo) return null;
  return <Glyph logo={logo} className={cx("h-3.5 w-3.5", className)} />;
}
