// Regression set (howtoeval: "turn important failures into tests; 20 high-signal cases beats 200").
//
// When a held-out buyer's email fails a check we care about (it ignored the buyer's stated concern,
// or was pushy), that buyer becomes a regression case. Every later candidate must pass the same
// pass/fail check on those buyers before it can ship, on top of beating the noise band.
// Cases are the buyer persona plus the check that failed; nothing about outcomes is stored, so a
// regression is a deterministic yes/no about the email, not a lucky roll.

import { Persona, SimResult } from "./sim";
import { store, uid } from "./store";

export type RegressionCase = {
  _id: string;
  kind: "regression";
  pipeline: string;
  stage: string;
  persona: Persona;
  check: "addresses_objection" | "not_pushy";
  why: string;
  from: string; // round convoId or playbook id that produced the failure
  at: string;
};

const MAX_CASES = 20;

export async function regressionCases(pipeline: string, stage: string): Promise<RegressionCase[]> {
  return (await store.list<RegressionCase>("evals")).filter((e) => e.kind === "regression" && e.pipeline === pipeline && e.stage === stage);
}

/** Failures from the current playbook on held-out buyers that are worth never repeating. */
export async function recordFailures(pipeline: string, stage: string, run: SimResult, from: string) {
  const existing = await regressionCases(pipeline, stage);
  const seen = new Set(existing.map((c) => `${c.persona.id}:${c.check}`));
  let room = MAX_CASES - existing.length;
  const added: RegressionCase[] = [];
  for (const t of run.transcripts) {
    if (room <= 0) break;
    const fails: [RegressionCase["check"], string][] = [];
    if (t.persona.objection !== "none" && !t.checks.addresses_objection) fails.push(["addresses_objection", `ignored a ${t.persona.objection} concern`]);
    if (t.checks.pushy) fails.push(["not_pushy", "used pressure or urgency"]);
    for (const [check, why] of fails) {
      if (seen.has(`${t.persona.id}:${check}`) || room <= 0) continue;
      const c: RegressionCase = { _id: uid("reg"), kind: "regression", pipeline, stage, persona: t.persona, check, why, from, at: new Date().toISOString() };
      await store.upsert("evals", c);
      seen.add(`${t.persona.id}:${check}`);
      added.push(c);
      room--;
    }
  }
  return added;
}

/** Pass/fail on each regression case. `results` are the candidate's transcripts on those buyers. */
export function scoreRegressions(cases: RegressionCase[], results: SimResult) {
  const failed = cases.filter((c, i) => {
    const t = results.transcripts[i];
    return c.check === "addresses_objection" ? !t.checks.addresses_objection : t.checks.pushy;
  });
  return { passed: cases.length - failed.length, total: cases.length, failed };
}
