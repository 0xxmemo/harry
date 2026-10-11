// Harry's learning loop: glossary (team vocabulary), skills (queries that worked), scars (what
// went wrong and the lesson), voice (edits to drafts), and a versioned log of every change.

import { api } from "./api";

export type GlossaryTerm = { term: string; definition: string; createdAt: string };
export type Skill = { question: string; db: string; collection: string; pipeline: unknown[]; uses: number; createdAt: string };
export type Scar = { question: string; error: string; lesson: string; createdAt: string };
export type VoiceSample = { platform: "linkedin" | "x"; before: string; after: string; createdAt: string };
export type Version = { v: number; at: string; change: string; kind: "glossary" | "skill" | "scar" | "voice" | "rule"; gate: "approved" | "rejected"; reason?: string };
export type Trace = { at: string; question: string; ms: number; tokens: number; rows: number; ok: boolean; retries: number; model: string };

export type Memory = {
  glossary: GlossaryTerm[];
  skills: Skill[];
  scars: Scar[];
  voice: VoiceSample[];
  versions: Version[];
  traces: Trace[];
  posts: { id: string; platform: string; text: string; likes?: number; impressions?: number; at: string }[];
};

export const emptyMemory = (): Memory => ({ glossary: [], skills: [], scars: [], voice: [], versions: [], traces: [], posts: [] });

export async function loadMemory(): Promise<Memory> {
  const m = (await api.memLoad().catch(() => null)) as Partial<Memory> | null;
  return { ...emptyMemory(), ...(m ?? {}) };
}

export const saveMemory = (m: Memory) => api.memSave(m).catch(() => undefined);

const now = () => new Date().toISOString();

/** Deterministic checks on anything Harry wants to add to its own harness. */
function gateRule(text: string): string | null {
  if (text.trim().length < 3) return "empty";
  if (text.length > 600) return "too long";
  if (/\$(out|merge|where|function)|drop|delete|ignore (all|previous)|system prompt/i.test(text)) return "unsafe instruction";
  return null;
}

function record(m: Memory, kind: Version["kind"], change: string, reason: string | null) {
  m.versions.push({ v: m.versions.length + 1, at: now(), change, kind, gate: reason ? "rejected" : "approved", reason: reason ?? undefined });
}

export function addTerm(m: Memory, term: string, definition: string): boolean {
  const reason = gateRule(`${term} ${definition}`);
  record(m, "glossary", `"${term}" = ${definition}`, reason);
  if (reason) return false;
  m.glossary = [...m.glossary.filter((g) => g.term.toLowerCase() !== term.toLowerCase()), { term, definition, createdAt: now() }];
  return true;
}

export function addSkill(m: Memory, s: Omit<Skill, "uses" | "createdAt">) {
  const existing = m.skills.find((k) => k.question.toLowerCase() === s.question.toLowerCase());
  if (existing) {
    existing.uses++;
    existing.pipeline = s.pipeline;
    return;
  }
  m.skills.push({ ...s, uses: 1, createdAt: now() });
  record(m, "skill", `learned query for "${s.question.slice(0, 70)}"`, null);
}

export function addScar(m: Memory, question: string, error: string, lesson: string) {
  const reason = gateRule(lesson);
  record(m, "scar", lesson, reason);
  if (!reason) m.scars.push({ question, error: error.slice(0, 300), lesson, createdAt: now() });
}

export function addVoice(m: Memory, v: Omit<VoiceSample, "createdAt">) {
  if (v.before.trim() === v.after.trim()) return;
  m.voice.push({ ...v, createdAt: now() });
  m.voice = m.voice.slice(-12);
  record(m, "voice", `learned from your ${v.platform === "x" ? "X" : "LinkedIn"} edit`, null);
}

const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
const overlap = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  a.forEach((w) => b.has(w) && n++);
  return n / Math.max(1, Math.min(a.size, b.size));
};

export function recall(m: Memory, question: string) {
  const q = words(question);
  const skills = m.skills
    .map((s) => ({ s, score: overlap(q, words(s.question)) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.s);
  const scars = m.scars
    .map((s) => ({ s, score: overlap(q, words(s.question + " " + s.lesson)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.s);
  return { glossary: m.glossary, skills, scars };
}

export function knowledgeCount(m: Memory) {
  return m.glossary.length + m.skills.length + m.scars.length + (m.voice.length ? 1 : 0);
}
