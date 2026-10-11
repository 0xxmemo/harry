// Call transcripts: parse (Rust) → match to a deal → score against the stage checklist →
// coaching notes with quotes → follow-up draft → propose the rep's best answer as a playbook rule.

import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { extractJson } from "./agent";
import { PIPELINE } from "./pipeline";
import { SourceSet } from "./sources";
import { getSettings, store, uid } from "./store";

type Doc = Record<string, unknown>;
export type Turn = { speaker: string; start: string; text: string };
export type Parsed = { file: string; hash: string; format: string; turns: Turn[] };

export type Call = {
  _id: string; // file hash
  file: string;
  format: string;
  turns: Turn[];
  dealId: string | null;
  dealName?: string;
  repName?: string;
  buyerName?: string;
  consent: boolean;
  status: "parsed" | "analyzed";
  summary?: string;
  objections?: string[];
  score?: { item: string; met: boolean; quote: string; note: string }[];
  coaching?: string[];
  brief?: { past_objections: string[]; cares_about: string[]; questions: string[] };
  importedAt: string;
};

export const parseTranscript = (path: string, dropped: boolean) => invoke<Parsed>("parse_transcript", { path, dropped });

export async function importCall(path: string, dropped: boolean, consent: boolean): Promise<{ call: Call; duplicate: boolean }> {
  if (!consent) throw new Error("Confirm that participants were told the call was recorded.");
  const p = await parseTranscript(path, dropped);
  const existing = (await store.list<Call>("calls")).find((c) => c._id === p.hash);
  if (existing) return { call: existing, duplicate: true };
  const call: Call = { _id: p.hash, file: p.file, format: p.format, turns: p.turns, dealId: null, consent, status: "parsed", importedAt: new Date().toISOString() };
  await store.upsert("calls", call);
  return { call, duplicate: false };
}

/** Rank deals by speaker names, company names in the file name/text, and contact names. */
export function suggestDeals(call: Call, src: SourceSet) {
  const get = (c: string) => (src.local.get(`crm.${c}`) ?? []) as Doc[];
  const contacts = get("contacts"), reps = get("reps"), accounts = get("accounts");
  const text = (call.file + " " + call.turns.map((t) => `${t.speaker} ${t.text}`).join(" ")).toLowerCase().replace(/[-_]/g, " ");
  const speakers = [...new Set(call.turns.map((t) => t.speaker.toLowerCase()))];
  return get("deals")
    .filter((d) => !d.closedAt)
    .map((d) => {
      const acct = accounts.find((a) => a._id === d.accountId);
      const contact = contacts.find((c) => c._id === d.contactId);
      const rep = reps.find((r) => r._id === d.ownerId);
      let score = 0;
      const why: string[] = [];
      if (acct && text.includes(String(acct.name).toLowerCase())) (score += 3), why.push(String(acct.name));
      if (contact && speakers.includes(String(contact.name).toLowerCase())) (score += 3), why.push(String(contact.name));
      if (rep && speakers.includes(String(rep.name).toLowerCase())) (score += 2), why.push(`rep ${rep.name}`);
      const kind = String(d.name).split(" — ")[1]?.toLowerCase();
      if (kind && text.includes(kind)) (score += 1), why.push(kind);
      return { deal: d, rep, contact, score, why };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.deal.amount) - Number(a.deal.amount))
    .slice(0, 4);
}

export async function matchDeal(call: Call, deal: Doc, repName?: string, buyerName?: string) {
  Object.assign(call, { dealId: String(deal._id), dealName: String(deal.name), repName, buyerName });
  await store.upsert("calls", { _id: call._id, dealId: call.dealId, dealName: call.dealName, repName, buyerName });
  return call;
}

const ANALYST = `You are a sales coach reviewing a call transcript. Every claim must quote the transcript.
Reply ONE JSON object:
{"summary": "2 sentences",
 "objections": ["buyer objections raised"],
 "score": [{"item": "<checklist item>", "met": true|false, "quote": "exact short quote from the transcript or empty", "note": "1 sentence"}],
 "coaching": ["up to 3 specific coaching notes, each quoting the rep"],
 "brief": {"past_objections": [...], "cares_about": [...], "questions": ["3 questions the rep should ask next call"]},
 "best_moment": {"exists": true|false, "objection": "...", "rep_quote": "exact quote where the rep handled an objection well", "rule": "a short reusable playbook rule generalizing what the rep did"},
 "followup": {"subject": "...", "body": "follow-up email from the rep that recaps what was actually said and the agreed next step; no prices"}}`;

export async function analyzeCall(call: Call, src: SourceSet) {
  const pipeline = PIPELINE;
  const stage = pipeline.stages.find((s) => s.checklist.length) ?? pipeline.stages[0];
  const transcript = call.turns.map((t) => `[${t.start}] ${t.speaker}: ${t.text}`).join("\n");
  const res = await api.llm(
    ANALYST,
    `REP: ${call.repName ?? "unknown"}\nBUYER: ${call.buyerName ?? "unknown"}\nDEAL: ${call.dealName ?? "unknown"}\nCHECKLIST (${stage.name}):\n${stage.checklist.map((c) => `- ${c}`).join("\n")}\nFIRM LIMITS:\n${pipeline.firm_limits.map((f) => `- ${f}`).join("\n")}\n\nTRANSCRIPT:\n${transcript}`,
  );
  const j = extractJson<{
    summary: string;
    objections: string[];
    score: Call["score"];
    coaching: string[];
    brief: Call["brief"];
    best_moment: { exists: boolean; objection: string; rep_quote: string; rule: string };
    followup: { subject: string; body: string };
  }>(res.text);

  // Quotes must actually appear in the transcript; drop any that don't.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const hay = norm(transcript);
  const real = (q: string) => !q || hay.includes(norm(q).slice(0, 60));
  const score = (j.score ?? []).map((s) => (real(s.quote) ? s : { ...s, quote: "", note: s.note + " (quote not found in transcript)" }));

  Object.assign(call, { status: "analyzed", summary: j.summary, objections: j.objections, score, coaching: j.coaching, brief: j.brief });
  await store.upsert("calls", { _id: call._id, status: "analyzed", summary: j.summary, objections: j.objections, score, coaching: j.coaching, brief: j.brief });

  let insight: Doc | null = null;
  if (j.best_moment?.exists && real(j.best_moment.rep_quote)) {
    insight = {
      _id: `ins_${call._id.slice(0, 12)}`,
      kind: "call_rule",
      callId: call._id,
      dealId: call.dealId,
      rep: call.repName,
      objection: j.best_moment.objection,
      quote: j.best_moment.rep_quote,
      rule: j.best_moment.rule,
      stage: pipeline.stages[0].id,
      status: "proposed",
      at: new Date().toISOString(),
    };
    await store.upsert("insights", insight as { _id: string });
  }

  let draftId: string | null = null;
  if (call.dealId && j.followup?.body) {
    const deal = ((src.local.get("crm.deals") ?? []) as Doc[]).find((d) => d._id === call.dealId);
    const contact = ((src.local.get("crm.contacts") ?? []) as Doc[]).find((c) => c._id === deal?.contactId);
    const settings = await getSettings();
    draftId = `ob_call_${call._id.slice(0, 12)}`;
    await store.upsert("outbox", {
      _id: draftId,
      runId: "call",
      dealId: call.dealId,
      contactId: String(contact?._id ?? ""),
      contactName: String(contact?.name ?? call.buyerName ?? ""),
      company: String(call.dealName ?? "").split(" — ")[0],
      stage: "close",
      variant: "call_recap",
      playbookId: "",
      to: settings.recipientOverride || String(contact?.email ?? ""),
      originalTo: String(contact?.email ?? ""),
      timezone: String(contact?.timezone ?? "America/Los_Angeles"),
      subject: j.followup.subject,
      body: j.followup.body,
      original: j.followup,
      threadId: null,
      status: "draft",
      reasoning: `Drafted from the call "${call.file}"`,
      createdAt: new Date().toISOString(),
    });
  }
  await store.upsert("traces", { _id: uid("tr"), kind: "call", callId: call._id, ms: res.ms, tokens: res.prompt_tokens + res.completion_tokens, model: res.model, at: new Date().toISOString() });
  return { call, insight, draftId };
}
