// One improvement round for a stage:
//   train run on the fixed train seed → reviewer proposes edits (policy-gated) →
//   candidate vs current on a held-out seed committed before the round → keep only if the gain
//   clears the noise band and a downstream check doesn't regress. A random-edit control runs on
//   the same test seed so the chart shows the gain isn't just "any change helps".

import { api } from "./api";
import { activePlaybook, Pipeline, PlaybookVersion, Stage } from "./pipeline";
import { applyEdit, commitSeed, pairedNoise, randomEdit, review, simulate } from "./sim";
import { store, uid } from "./store";

export const TRAIN_SEED = 1001;

export type RoundLog = { phase: string; detail?: string };
export type RoundResult = {
  _id: string;
  pipeline: string;
  stage: string;
  baseline: PlaybookVersion;
  candidate: PlaybookVersion | null;
  train: number;
  testBaseline: number;
  testCandidate: number;
  testRandom: number;
  noise: number;
  kept: boolean;
  reason: string;
  commit: string;
  seed: number;
  n: number;
  at: string;
};

export async function approvedInsights(stage: string) {
  const all = await store.list<Record<string, unknown>>("insights");
  return all
    .filter((i) => (i.kind === "call_rule" && i.status === "approved" && (!i.stage || i.stage === stage)) || (i.kind === "rep_edit" && i.stage === stage))
    .map((i) => (i.kind === "call_rule" ? `Approved from a call: "${i.rule}" (quote: ${i.quote})` : `Rep rewrote "${(i.before as { body: string }).body.slice(0, 140)}" as "${(i.after as { body: string }).body.slice(0, 140)}"`));
}

export async function runRound(pipeline: Pipeline, stage: Stage, n: number, log: (l: RoundLog) => void, forcedRules: string[] = []): Promise<RoundResult> {
  const baseline = await activePlaybook(pipeline, stage);
  const { seed, commit } = await commitSeed();
  log({ phase: "Committed test seed", detail: `sha256 ${commit.slice(0, 16)}… (revealed after the round)` });
  const convoId = `round-${commit.slice(0, 12)}`;
  const traced = (run: string) => ({ convoId, run });

  log({ phase: "Train run", detail: `playbook v${baseline.version} on ${n} train buyers` });
  const train = await simulate(baseline, stage, TRAIN_SEED, n, (d) => log({ phase: "Train run", detail: `${d}/${n}` }), traced("train"));
  log({ phase: "Train result", detail: `${Math.round(train.rate * 100)}% replied` });

  log({ phase: "Reviewer", detail: "reading failed conversations and human signal" });
  const extra = await approvedInsights(stage.id);
  const edit = forcedRules.length ? { add: forcedRules, remove: [] as string[], rationale: "Manager-approved rule from a call", sourceEvents: [] as string[] } : await review(baseline, pipeline, train.transcripts, extra, traced("review"));
  try {
    await api.gatePlaybook(pipeline.firm_limits, [...baseline.rules.filter((r) => !edit.remove.includes(r)), ...edit.add]);
  } catch (e) {
    const reason = String(e);
    log({ phase: "Policy gate rejected the edit", detail: reason });
    const r = await save({ pipeline, stage, baseline, candidate: null, train: train.rate, testBaseline: 0, testCandidate: 0, testRandom: 0, noise: 0, kept: false, reason, commit, seed, n });
    await store.upsert("evals", { _id: uid("ev"), kind: "gate_reject", pipeline: pipeline.id, stage: stage.id, reason, at: new Date().toISOString() });
    return r;
  }
  const candidate = applyEdit(baseline, edit, forcedRules.length ? "call_insight" : "reviewer", edit.rationale);
  log({ phase: "Candidate", detail: `+${candidate.diff.added.length} / −${candidate.diff.removed.length} rules` });

  log({ phase: "Held-out test", detail: `seed revealed: ${seed}` });
  const [tb, tc, tr] = await Promise.all([
    simulate(baseline, stage, seed, n, undefined, traced("test_current")),
    simulate(candidate, stage, seed, n, undefined, traced("test_candidate")),
    simulate(applyEdit(baseline, await randomEdit(baseline, seed), "random_edit", "Random-edit control"), stage, seed, n, undefined, traced("test_random")),
  ]);
  const noise = pairedNoise(tb, tc);
  const gain = tc.rate - tb.rate;
  // Downstream guard: the candidate must not raise the unsubscribe rate.
  const unsub = (r: typeof tb) => r.transcripts.filter((t) => t.outcome === "unsubscribe").length / r.n;
  const hurtsDownstream = unsub(tc) > unsub(tb) + 0.05;
  const kept = gain > noise && !hurtsDownstream;
  const reason = kept
    ? `+${Math.round(gain * 100)} pts beats the ±${Math.round(noise * 100)} pt noise band`
    : hurtsDownstream
      ? "raised unsubscribes; rolled back"
      : `+${Math.round(gain * 100)} pts is inside the ±${Math.round(noise * 100)} pt noise band; rolled back`;
  log({ phase: kept ? "Kept" : "Rolled back", detail: reason });

  candidate.scores = { baseline: tb.rate, candidate: tc.rate, noise };
  // Raindrop draft events the reviewer read when proposing this version.
  (candidate as PlaybookVersion & { sourceEvents?: string[]; convoId?: string }).sourceEvents = edit.sourceEvents;
  (candidate as PlaybookVersion & { convoId?: string }).convoId = convoId;
  candidate.status = kept ? "active" : "rejected";
  await store.upsert("playbooks", candidate);
  if (kept) await store.upsert("playbooks", { ...baseline, status: "retired" });

  for (const [variant, b] of Object.entries(tc.byVariant)) {
    await store.upsert("evals", { _id: uid("ev"), kind: "bandit", pipeline: pipeline.id, stage: stage.id, variant, wins: b.wins, trials: b.trials, at: new Date().toISOString() });
  }
  return save({ pipeline, stage, baseline, candidate, train: train.rate, testBaseline: tb.rate, testCandidate: tc.rate, testRandom: tr.rate, noise, kept, reason, commit, seed, n });
}

async function save(r: Omit<RoundResult, "_id" | "at" | "pipeline" | "stage"> & { pipeline: Pipeline; stage: Stage }): Promise<RoundResult> {
  const doc: RoundResult = { ...r, _id: uid("round"), pipeline: r.pipeline.id, stage: r.stage.id, at: new Date().toISOString() };
  await store.upsert("evals", { ...doc, kind: "round" } as unknown as { _id: string });
  return doc;
}

export async function rounds(pipeline: string) {
  return (await store.list<RoundResult & { kind: string }>("evals")).filter((e) => e.kind === "round" && e.pipeline === pipeline).sort((a, b) => a.at.localeCompare(b.at));
}
