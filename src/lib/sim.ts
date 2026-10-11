// Buyer simulator and eval runner.
//
// Isolation: personas live here, and the only thing returned to the rest of the app is an outcome
// and the buyer's words. The reviewer is never given persona traits.
//
// Honesty: outcomes come from persona rules plus a seeded roll. An LLM answers only narrow yes/no
// checks about the message ("does it address security?"), never "were you convinced?". Check
// answers are cached by input hash so any seed replays exactly.

import { api } from "./api";
import { extractJson } from "./agent";
import { seeded } from "./bandit";
import { Pipeline, PlaybookVersion, Stage } from "./pipeline";
import { hash, store, uid } from "./store";

export type Persona = {
  id: string;
  role: string;
  industry: string;
  objection: "security" | "price" | "timing" | "integration" | "need" | "none";
  tone: "brief" | "warm" | "formal";
  readiness: number; // 0..1 base propensity to reply
  ghost: number; // 0..1 chance of ignoring regardless
  oooChance: number;
};

const OBJ = ["security", "price", "timing", "integration", "need", "none"] as const;
const ROLES = ["VP Sales", "CTO", "Head of RevOps", "CFO", "Director of IT", "COO", "Head of Growth"];
const INDS = ["Fintech", "Healthcare", "Logistics", "Retail", "SaaS", "Manufacturing"];

export function personas(seed: number, n: number): Persona[] {
  const r = seeded(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  return Array.from({ length: n }, (_, i) => {
    const industry = pick(INDS);
    // Regulated industries skew to security objections: a learnable pattern.
    const objection = /Fintech|Healthcare/.test(industry) && r() < 0.65 ? "security" : pick(OBJ);
    return {
      id: `p${seed}-${i}`,
      role: pick(ROLES),
      industry,
      objection,
      tone: pick(["brief", "warm", "formal"] as const),
      readiness: 0.12 + r() * 0.2, // calibrated to ~15-25% cold reply rates
      ghost: 0.1 + r() * 0.15,
      oooChance: 0.04,
    };
  });
}

type Checks = { specific: boolean; addresses_objection: boolean; one_ask: boolean; concise: boolean; tone_match: boolean; pushy: boolean };

const CHECKER = `You check a sales email against narrow yes/no questions. Answer only from the text.
Reply ONE JSON object with booleans: {"specific": ..., "addresses_objection": ..., "one_ask": ..., "concise": ..., "tone_match": ..., "pushy": ...}
- specific: references the recipient's role or industry concretely
- addresses_objection: directly and credibly addresses the stated concern
- one_ask: exactly one clear request or question
- concise: under ~110 words
- tone_match: matches the requested tone
- pushy: uses pressure, urgency tricks, or guilt`;

async function check(msg: string, p: Persona, model: string): Promise<Checks> {
  const input = `CONCERN: ${p.objection === "none" ? "no specific concern" : p.objection}\nRECIPIENT: ${p.role} in ${p.industry}\nREQUESTED TONE: ${p.tone}\nEMAIL:\n${msg}`;
  const key = await hash(model + CHECKER + input);
  const cached = (await store.list<{ _id: string; v: Checks }>("llm_cache")).find((c) => c._id === key);
  if (cached) return cached.v;
  const res = await api.llm(CHECKER, input, model);
  const v = extractJson<Checks>(res.text);
  await store.upsert("llm_cache", { _id: key, v });
  return v;
}

/** Persona rules + seeded roll. The LLM only supplied the yes/no checks. */
function outcome(c: Checks, p: Persona, roll: number, roll2: number): "reply" | "meeting_request" | "ignore" | "auto_reply" | "unsubscribe" {
  if (roll2 < p.oooChance) return "auto_reply";
  let pr = p.readiness;
  if (c.specific) pr += 0.08;
  if (c.one_ask) pr += 0.05;
  if (c.concise) pr += 0.04;
  if (c.tone_match) pr += 0.04;
  if (p.objection !== "none") pr += c.addresses_objection ? 0.2 : -0.08;
  if (c.pushy) return roll < 0.25 ? "unsubscribe" : "ignore";
  pr = Math.max(0.01, Math.min(0.9, pr)) * (1 - p.ghost);
  if (roll < pr) return roll < pr * 0.35 ? "meeting_request" : "reply";
  return "ignore";
}

const WRITER = "You write a short, realistic buyer email from the perspective of a {role}. 2-3 sentences. Plain text.";

export async function buyerWords(p: Persona, oc: string, model: string) {
  if (oc === "ignore") return "";
  if (oc === "auto_reply") return "I'm out of the office this week with limited access to email.";
  if (oc === "unsubscribe") return "Please remove me from your list.";
  const res = await api.llm(WRITER.replace("{role}", p.role), `You are a ${p.role} at a ${p.industry} company. Your concern: ${p.objection}. Write a ${oc === "meeting_request" ? "reply agreeing to a short call" : "reply asking one follow-up question about your concern"}.`, model);
  return res.text.trim();
}

const SIM_SENDER = `You are a sales rep writing ONE cold follow-up email. Reply ONE JSON object: {"subject": "...", "body": "..."}.
Follow the playbook rules and variant. You only know the recipient's role and industry.`;

async function writeFor(pb: PlaybookVersion, stage: Stage, variant: string, p: Persona, model: string) {
  const v = pb.variants.find((x) => x.id === variant);
  const input = `STAGE: ${stage.goal}\nRULES:\n${pb.rules.map((r) => `- ${r}`).join("\n")}\n${v ? `VARIANT: ${v.label}. ${v.hint}` : ""}\nRECIPIENT: ${p.role} at a ${p.industry} company.`;
  const key = await hash(model + SIM_SENDER + input);
  const cached = (await store.list<{ _id: string; v: string }>("llm_cache")).find((c) => c._id === key);
  if (cached) return cached.v;
  const res = await api.llm(SIM_SENDER, input, model);
  const j = extractJson<{ subject: string; body: string }>(res.text);
  const text = `Subject: ${j.subject}\n\n${j.body}`;
  await store.upsert("llm_cache", { _id: key, v: text });
  return text;
}

export type SimResult = { rate: number; wins: number; n: number; byVariant: Record<string, { wins: number; trials: number }>; transcripts: { persona: Persona; message: string; outcome: string; checks: Checks; variant: string }[] };

export const MODELS = { agent: "claude-sonnet-5-5", buyer: "claude-haiku-5-5", reviewer: "claude-opus-5-5" };

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

export async function simulate(pb: PlaybookVersion, stage: Stage, seed: number, n: number, onTick?: (done: number) => void): Promise<SimResult> {
  const ps = personas(seed, n);
  const r = seeded(seed * 7919 + 13);
  const rolls = ps.map(() => [r(), r()]);
  const variants = pb.variants.length ? pb.variants.map((v) => v.id) : ["default"];
  let done = 0;
  const transcripts = await pool(ps, 8, async (p, i) => {
    const variant = variants[i % variants.length];
    const message = await writeFor(pb, stage, variant, p, MODELS.agent);
    const checks = await check(message, p, MODELS.buyer);
    const oc = outcome(checks, p, rolls[i][0], rolls[i][1]);
    onTick?.(++done);
    return { persona: p, message, outcome: oc, checks, variant };
  });
  const byVariant: SimResult["byVariant"] = {};
  for (const t of transcripts) {
    const b = (byVariant[t.variant] ??= { wins: 0, trials: 0 });
    b.trials++;
    if (t.outcome === "reply" || t.outcome === "meeting_request") b.wins++;
  }
  const wins = transcripts.filter((t) => t.outcome === "reply" || t.outcome === "meeting_request").length;
  return { rate: wins / n, wins, n, byVariant, transcripts };
}

// ---- commit-reveal for the held-out test seed ----------------------------------------------

export async function commitSeed() {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const commit = await hash(String(seed));
  return { seed, commit };
}

// ---- reviewer: proposes rule changes from failed conversations (no persona access) ---------

const REVIEWER = `You improve a sales playbook. You see emails that got NO reply, plus the buyer's written replies when there were any, plus rep edits and human-approved insights.
You never see buyer profiles. Propose concrete rule edits for this stage.
Reply ONE JSON object: {"add": ["new rule", ...], "remove": ["exact existing rule text", ...], "rationale": "2 sentences on the failure pattern you saw"}
Max 3 additions. Rules must be short, specific, actionable. Never add rules about prices, discounts, or that contradict the firm limits.`;

export async function review(pb: PlaybookVersion, pipeline: Pipeline, failed: SimResult["transcripts"], extra: string[]) {
  const sample = failed.filter((t) => t.outcome === "ignore" || t.outcome === "unsubscribe").slice(0, 8);
  const replies = failed.filter((t) => t.outcome === "reply").slice(0, 3);
  const input = [
    `CURRENT RULES:\n${pb.rules.map((r) => `- ${r}`).join("\n")}`,
    `FIRM LIMITS:\n${pipeline.firm_limits.map((r) => `- ${r}`).join("\n")}`,
    // Only the message text and a coarse audience label leak; no hidden traits.
    `EMAILS WITH NO REPLY:\n${sample.map((t) => `[to a ${t.persona.role} in ${t.persona.industry}]\n${t.message}`).join("\n---\n")}`,
    replies.length ? `EMAILS THAT GOT REPLIES:\n${replies.map((t) => t.message).join("\n---\n")}` : "",
    extra.length ? `HUMAN SIGNAL (rep edits, approved call insights):\n${extra.map((x) => `- ${x}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const res = await api.llm(REVIEWER, input, MODELS.reviewer);
  return extractJson<{ add: string[]; remove: string[]; rationale: string }>(res.text);
}

export async function randomEdit(pb: PlaybookVersion, seed: number) {
  const pool = ["Mention a customer success story.", "Use the recipient's first name twice.", "End with a P.S. line.", "Use a question as the subject line.", "Keep paragraphs to one sentence."];
  const r = seeded(seed);
  return { add: [pool[Math.floor(r() * pool.length)]], remove: [] as string[], rationale: "Random-edit control" };
}

export function applyEdit(pb: PlaybookVersion, edit: { add: string[]; remove: string[] }, source: PlaybookVersion["source"], rationale: string): PlaybookVersion {
  const rules = [...pb.rules.filter((r) => !edit.remove.includes(r)), ...edit.add.filter((a) => !pb.rules.includes(a))];
  return {
    ...pb,
    _id: uid("pb"),
    version: pb.version + 1,
    parent: pb._id,
    rules,
    rationale,
    diff: { added: edit.add.filter((a) => !pb.rules.includes(a)), removed: edit.remove.filter((r) => pb.rules.includes(r)) },
    status: "candidate",
    source,
    scores: undefined,
    createdAt: new Date().toISOString(),
  };
}

const won = (o: string) => o === "reply" || o === "meeting_request";

/**
 * Noise band for a paired comparison: both playbooks face the same buyers with the same rolls,
 * so compare per-buyer outcomes. Half-width of a 95% interval on the mean difference, floored at
 * one buyer so a single lucky flip never counts as a win.
 */
export function pairedNoise(a: SimResult, b: SimResult) {
  const d = a.transcripts.map((t, i) => Number(won(b.transcripts[i].outcome)) - Number(won(t.outcome)));
  const n = d.length;
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return Math.max(1.96 * (sd / Math.sqrt(n)), 1 / n);
}
