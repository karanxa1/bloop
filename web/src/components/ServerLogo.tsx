import { LOGOS } from "../logos";
import { cx } from "../lib";

/** server name/url → brand key */
const HOST_HINTS: [RegExp, string][] = [
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

interface ServerLogoProps {
  name: string;
  url: string;
  className?: string;
}

/**
 * Real brand logo for a connected server when we recognise it,
 * otherwise a letter monogram in bloop lime.
 */
export function ServerLogo({ name, url, className }: ServerLogoProps) {
  const key = brandKey(name, url);
  const logo = key ? LOGOS[key] : null;

  if (logo) {
    return (
      <span
        className={cx(
          "flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-200 bg-white",
          className
        )}
        title={key ?? name}
      >
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill={logo.color} aria-hidden="true">
          {logo.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
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
  const logo = LOGOS[brandKey(name, "") ?? ""] ?? LOGOS[name.toLowerCase()];
  if (!logo) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx("h-3.5 w-3.5", className)}
      fill={logo.color}
      aria-hidden="true"
    >
      {logo.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
