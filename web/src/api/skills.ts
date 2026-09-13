import { mreq } from "./marketplace";
import type { CatalogSkill, Skill, SkillDraft } from "../types/marketplace";

export const listSkills = () => mreq<Skill[]>("/api/skills");

export const createSkill = (draft: SkillDraft) =>
  mreq<Skill>("/api/skills", { method: "POST", json: draft });

export const updateSkill = (id: string, patch: Partial<SkillDraft> & { enabled?: boolean }) =>
  mreq<Skill>(`/api/skills/${encodeURIComponent(id)}`, { method: "PUT", json: patch });

export const deleteSkill = (id: string) =>
  mreq<unknown>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listSkillCatalog = () => mreq<CatalogSkill[]>("/api/skills/catalog");

export const installCatalogSkill = (slug: string) =>
  mreq<Skill | undefined>(`/api/skills/catalog/${encodeURIComponent(slug)}/install`, {
    method: "POST"
  });
