import type { EditorTab } from "../../types/workspace";

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

export const extOf = (p: string) => {
  const name = baseName(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kb`;
  return `${(n / 1024 / 1024).toFixed(1)} mb`;
}

export const isDirty = (t: EditorTab) => t.status === "ready" && t.content !== t.saved;

/** reject empty, absolute-escaping, or parent-traversing paths */
export function validPath(p: string): string | null {
  const clean = p.trim().replace(/^\.?\/+/, "").replace(/\/{2,}/g, "/");
  if (!clean || clean.endsWith("/")) return null;
  if (clean.split("/").some((s) => s === ".." || s === ".")) return null;
  return clean;
}

const BADGES: Record<string, [string, string]> = {
  ts: ["ts", "bg-blue-50 text-blue-700"],
  tsx: ["tsx", "bg-blue-50 text-blue-700"],
  js: ["js", "bg-amber-50 text-amber-800"],
  jsx: ["jsx", "bg-amber-50 text-amber-800"],
  mjs: ["js", "bg-amber-50 text-amber-800"],
  cjs: ["js", "bg-amber-50 text-amber-800"],
  json: ["{}", "bg-neutral-100 text-neutral-700"],
  css: ["#", "bg-sky-50 text-sky-700"],
  html: ["<>", "bg-orange-50 text-orange-700"],
  htm: ["<>", "bg-orange-50 text-orange-700"],
  md: ["md", "bg-neutral-100 text-neutral-700"],
  py: ["py", "bg-bloop/20 text-[#3f6b1a]"],
  rs: ["rs", "bg-orange-50 text-orange-800"],
  png: ["img", "bg-violet-50 text-violet-700"],
  jpg: ["img", "bg-violet-50 text-violet-700"],
  jpeg: ["img", "bg-violet-50 text-violet-700"],
  gif: ["img", "bg-violet-50 text-violet-700"],
  webp: ["img", "bg-violet-50 text-violet-700"],
  svg: ["svg", "bg-violet-50 text-violet-700"],
  txt: ["txt", "bg-neutral-100 text-neutral-600"],
  sh: ["sh", "bg-neutral-800 text-neutral-100"],
  toml: ["cfg", "bg-neutral-100 text-neutral-600"],
  yml: ["cfg", "bg-neutral-100 text-neutral-600"],
  yaml: ["cfg", "bg-neutral-100 text-neutral-600"]
};

export const badgeFor = (p: string): [string, string] =>
  BADGES[extOf(p)] ?? ["·", "bg-neutral-100 text-neutral-500"];
