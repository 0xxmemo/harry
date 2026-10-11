// The follow-up agent. A run walks a list of deals; each deal is one checkpointed step in `runs`.
// Restarting a run skips finished steps, and each outbox draft has a deterministic id, so a crash
// mid-run never produces a second draft (and the outbox never sends twice).

import { api } from "./api";
import { extractJson } from "./agent";
import { Arm, pickArm } from "./bandit";
import { activePlaybook, Pipeline, Stage, stageForDeal } from "./pipeline";
import { SourceSet } from "./sources";
import { getSettings, store, uid } from "./store";

type Doc = Record<string, unknown>;

export type OutboxItem = {
  _id: string;
  runId: string;
  dealId: string;
  contactId: string;
  contactName: string;
  company: string;
  stage: string;
  variant: string;
  playbookId: string;
  to: string;
  originalTo: string;
  timezone: string;
  subject: string;
  body: string;
  original: { subject: string; body: string };
  threadId: string | null;
  status: "draft" | "approved" | "sending" | "sent" | "skipped";
  reasoning: string;
  createdAt: string;
  sentAt?: string;
  approvedHash?: string;
};

export type RunStep = { dealId: string; deal: string; status: "pending" | "done" | "skipped" | "failed"; outboxId?: string; note?: string };
export type Run = {
  _id: string;
  pipeline: string;
  status: "running" | "paused" | "done";
  steps: RunStep[];
  startedAt: string;
  updatedAt: string;
  resumedCount: number;
};

const DRAFTER = `You are Harry, a top-performing sales rep writing ONE follow-up email.
Reply with ONE JSON object: {"subject": "...", "body": "...", "reasoning": "one sentence on why this message"}
- Follow the stage goal, the playbook rules, and the chosen variant.
- Use the contact's history: reference their real objections and last conversation, never invent facts about them.
- NEVER mention prices, discounts, or certifications/features that are not in FACTS.
- Plain text body, signed with the rep's first name. No placeholders like [Name].`;

export async function dealContext(src: SourceSet, dealId: string) {
  const get = (c: string) => (src.local.get(`crm.${c}`) ?? []) as Doc[];
  const deal = get("deals").find((d) => d._id === dealId)!;
  const account = get("accounts").find((a) => a._id === deal.accountId);
  const contact = get("contacts").find((c) => c._id === deal.contactId);
  const rep = get("reps").find((r) => r._id === deal.ownerId);
  const acts = get("activities").filter((a) => a.dealId === dealId).slice(-6);
  const interactions = (await store.list<Doc>("interactions")).filter((i) => i.dealId === dealId);
  const calls = (await store.list<Doc>("calls")).filter((c) => c.dealId === dealId);
  return { deal, account, contact, rep, acts, interactions, calls };
}

/** Deals the agent owns right now: open, at an agent-owned stage, with a contact. */
export async function eligibleDeals(src: SourceSet, pipeline: Pipeline, limit = 8) {
  const deals = (src.local.get("crm.deals") ?? []) as Doc[];
  const interactions = await store.list<Doc>("interactions");
  const replied = new Set(interactions.filter((i) => i.direction === "in").map((i) => i.dealId));
  return deals
    .filter((d) => d.contactId && !d.closedAt)
    .map((d) => ({ deal: d, stage: stageForDeal(pipeline, String(d.stage ?? ""), replied.has(d._id)) }))
    .filter((x): x is { deal: Doc; stage: Stage } => !!x.stage && x.stage.owner !== "human")
    .sort((a, b) => Number(b.deal.amount ?? 0) - Number(a.deal.amount ?? 0))
    .slice(0, limit);
}

export async function startRun(src: SourceSet, pipeline: Pipeline, limit = 6): Promise<Run> {
  const picks = await eligibleDeals(src, pipeline, limit);
  const run: Run = {
    _id: uid("run"),
    pipeline: pipeline.id,
    status: "running",
    steps: picks.map((p) => ({ dealId: String(p.deal._id), deal: String(p.deal.name), status: "pending" })),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resumedCount: 0,
  };
  await store.upsert("runs", run);
  return run;
}

export async function unfinishedRun(): Promise<Run | null> {
  const runs = await store.list<Run>("runs");
  return runs.filter((r) => r.status === "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

async function variantArms(pipeline: string, stage: string, variants: string[]): Promise<Arm[]> {
  const outbox = (await store.list<OutboxItem>("outbox")).filter((o) => o.status === "sent" && o.stage === stage);
  const interactions = await store.list<Doc>("interactions");
  const evals = (await store.list<Doc>("evals")).filter((e) => e.pipeline === pipeline && e.stage === stage && e.kind === "bandit");
  return variants.map((id) => {
    const sent = outbox.filter((o) => o.variant === id);
    const won = sent.filter((o) => interactions.some((i) => i.outboxId === o._id && ["reply", "meeting_request"].includes(String(i.outcome)))).length;
    const sim = evals.filter((e) => e.variant === id);
    return { id, trials: sent.length + sim.reduce((s, e) => s + Number(e.trials), 0), wins: won + sim.reduce((s, e) => s + Number(e.wins), 0) };
  });
}

/**
 * Advance a run. Each step: draft → write outbox (deterministic id) → checkpoint. `shouldStop` lets
 * the UI simulate a crash by killing between steps.
 */
export async function continueRun(
  run: Run,
  src: SourceSet,
  pipeline: Pipeline,
  onProgress: (r: Run) => void,
  shouldStop: () => boolean = () => false,
) {
  const settings = await getSettings();
  const existing = new Set((await store.list<OutboxItem>("outbox")).map((o) => o._id));
  for (const step of run.steps) {
    if (step.status !== "pending") continue;
    if (shouldStop()) {
      run.status = "paused";
      break;
    }
    const outboxId = `ob_${run._id}_${step.dealId}`;
    if (existing.has(outboxId)) {
      // Drafted before a crash but checkpoint wasn't written: don't redo the work.
      Object.assign(step, { status: "done", outboxId, note: "recovered from checkpoint" });
    } else {
      try {
        const item = await draftFollowUp(src, pipeline, step.dealId, run._id, outboxId, settings.recipientOverride);
        Object.assign(step, item ? { status: "done", outboxId } : { status: "skipped", note: "no agent-owned stage" });
      } catch (e) {
        Object.assign(step, { status: "failed", note: String(e).slice(0, 200) });
      }
    }
    run.updatedAt = new Date().toISOString();
    await store.upsert("runs", run);
    onProgress({ ...run, steps: [...run.steps] });
  }
  if (run.steps.every((s) => s.status !== "pending")) run.status = "done";
  run.updatedAt = new Date().toISOString();
  await store.upsert("runs", run);
  onProgress({ ...run });
  return run;
}

export async function draftFollowUp(src: SourceSet, pipeline: Pipeline, dealId: string, runId: string, outboxId: string, recipientOverride?: string) {
  const ctx = await dealContext(src, dealId);
  const interactions = await store.list<Doc>("interactions");
  const replied = interactions.some((i) => i.dealId === dealId && i.direction === "in");
  const stage = stageForDeal(pipeline, String(ctx.deal.stage ?? ""), replied);
  if (!stage || stage.owner === "human" || !ctx.contact) return null;
  const pb = await activePlaybook(pipeline, stage);
  const arms = await variantArms(pipeline.id, stage.id, pb.variants.map((v) => v.id));
  const variantId = arms.length ? pickArm(arms) : "default";
  const variant = pb.variants.find((v) => v.id === variantId);
  const lastOut = [...interactions].reverse().find((i) => i.dealId === dealId && i.threadId);

  const facts = [
    `Deal: ${ctx.deal.name}`,
    `Company: ${ctx.account?.name} (${ctx.account?.industry}, ${ctx.account?.tier})`,
    `Contact: ${ctx.contact.name}, ${ctx.contact.title}`,
    `Rep: ${ctx.rep?.name}`,
    `CRM stage: ${ctx.deal.stage}; last activity ${String(ctx.deal.lastActivityAt ?? "").slice(0, 10)}`,
    ctx.acts.length ? `Recent CRM activity:\n${ctx.acts.map((a) => `- ${String(a.at).slice(0, 10)} ${a.type}: ${a.note}`).join("\n")}` : "",
    ctx.interactions.length ? `Email history:\n${ctx.interactions.slice(-4).map((i) => `- ${i.direction === "in" ? "THEY" : "WE"}: ${String(i.text ?? i.body ?? "").slice(0, 300)}`).join("\n")}` : "",
    ctx.calls.length ? `Call notes:\n${ctx.calls.map((c) => `- ${c.summary ?? ""} Objections: ${(c.objections as string[] | undefined)?.join("; ") ?? ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  const prompt = [
    `PIPELINE: ${pipeline.name}`,
    `STAGE: ${stage.name}. Goal: ${stage.goal}`,
    `PLAYBOOK v${pb.version} RULES:\n${pb.rules.map((r) => `- ${r}`).join("\n")}`,
    `FIRM LIMITS (never break):\n${pipeline.firm_limits.map((r) => `- ${r}`).join("\n")}`,
    variant ? `VARIANT: ${variant.label}. ${variant.hint}` : "",
    `FACTS:\n${facts}`,
  ].filter(Boolean).join("\n\n");

  const res = await api.llm(DRAFTER, prompt);
  const j = extractJson<{ subject: string; body: string; reasoning: string }>(res.text);
  const item: OutboxItem = {
    _id: outboxId,
    runId,
    dealId,
    contactId: String(ctx.contact._id),
    contactName: String(ctx.contact.name),
    company: String(ctx.account?.name ?? ""),
    stage: stage.id,
    variant: variantId,
    playbookId: pb._id,
    to: recipientOverride || String(ctx.contact.email),
    originalTo: String(ctx.contact.email),
    timezone: String(ctx.contact.timezone ?? "America/Los_Angeles"),
    subject: j.subject,
    body: j.body,
    original: { subject: j.subject, body: j.body },
    threadId: (lastOut?.threadId as string) ?? null,
    status: "draft",
    reasoning: j.reasoning,
    createdAt: new Date().toISOString(),
  };
  await store.upsert("outbox", item);
  await store.upsert("traces", { _id: uid("tr"), kind: "draft", dealId, stage: stage.id, variant: variantId, playbook: pb.version, ms: res.ms, tokens: res.prompt_tokens + res.completion_tokens, cachedTokens: res.cached_tokens, model: res.model, resolvedModel: res.resolved_model, finish: res.finish_reason, at: new Date().toISOString() });
  return item;
}

/** Approve: record the rep's edit as reviewer signal, then let Rust freeze the content hash. */
export async function approve(item: OutboxItem) {
  await store.upsert("outbox", { _id: item._id, subject: item.subject, body: item.body, to: item.to });
  if (item.body !== item.original.body || item.subject !== item.original.subject) {
    await store.upsert("insights", {
      _id: uid("edit"),
      kind: "rep_edit",
      stage: item.stage,
      before: item.original,
      after: { subject: item.subject, body: item.body },
      status: "signal",
      at: new Date().toISOString(),
    });
  }
  return api.outboxApprove(item._id);
}
