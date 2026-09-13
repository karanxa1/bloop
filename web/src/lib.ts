/** tiny classname joiner */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** returns the URL only if it is an absolute http(s) link — blocks javascript:/data: */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** "www.example.com" → "example.com" */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const faviconUrl = (host: string) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;

/** keep only http(s) sources, de-duplicated by url */
export function cleanSources(raw: unknown): { url: string; title?: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { url: string; title?: string }[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const url = safeHttpUrl(rec.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : undefined
    });
  }
  return out;
}

/** 340 → "340ms", 1234 → "1.2s", 12345 → "12s" */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Run a state update inside a same-document view transition when the
 * browser supports it and the user hasn't asked for reduced motion.
 * `update` must commit synchronously (callers wrap React updates in flushSync).
 */
export function withViewTransition(update: () => void): void {
  if (
    typeof document === "undefined" ||
    !("startViewTransition" in document) ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }
  try {
    document.startViewTransition(update);
  } catch {
    update();
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date */
export function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

/**
 * Same-origin `/files/…` path or null. Rejects protocol-relative (`//evil.com`),
 * absolute cross-origin, `javascript:` and anything outside /files/.
 */
export function sameOriginPath(raw: unknown): string | null {
  if (typeof raw !== "string" || typeof window === "undefined") return null;
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin || !u.pathname.startsWith("/files/")) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}
