// Headless learning loop: runs the app's own improvement rounds (src/lib/improve.ts) with memory in
// Atlas, and prints the numbers for the improvement chart.
//
//   source ~/.harry/atlas.env
//   bun --preload ./scripts/loop/shim.ts scripts/loop/run.ts --stage reply --rounds 3 --n 20 [--fresh]

import { close, db, llmCalls, raindrop, raindropEvents, traces } from "./shim";
import { PIPELINES } from "../../src/lib/pipeline";
import { rounds, runRound } from "../../src/lib/improve";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const pipeline = PIPELINES[arg("pipeline", "saas")];
const stage = pipeline.stages.find((s) => s.id === arg("stage", "reply"))!;
const n = Number(arg("n", "20"));
const total = Number(arg("rounds", "3"));
const pct = (x: number) => `${Math.round(x * 100)}%`;

if (process.argv.includes("--fresh")) {
  for (const c of ["playbooks", "evals"]) await db.collection(c).deleteMany({ pipeline: pipeline.id });
  console.log("fresh start: cleared playbooks and evals for", pipeline.id);
}

const t0 = Date.now();
for (let i = 1; i <= total; i++) {
  console.log(`\n=== Round ${i}/${total} · ${pipeline.name} · stage "${stage.name}" · ${n} buyers per run`);
  let last = "";
  const r = await runRound(pipeline, stage, n, ({ phase, detail }) => {
    if (phase === last && /^\d+\/\d+$/.test(detail ?? "")) return;
    last = phase;
    console.log(`  ${phase}${detail ? `: ${detail}` : ""}`);
  });
  if (r.candidate?.diff.added.length) console.log(`  + ${r.candidate.diff.added.join("\n  + ")}`);
  if (r.candidate?.diff.removed.length) console.log(`  - ${r.candidate.diff.removed.join("\n  - ")}`);
  console.log(`  held-out: current ${pct(r.testBaseline)} · candidate ${pct(r.testCandidate)} · random edit ${pct(r.testRandom)} · noise ±${pct(r.noise)} → ${r.kept ? "KEPT" : "ROLLED BACK"}`);
}

console.log("\n=== History (stored in Atlas: harry.playbooks, harry.evals)");
for (const r of await rounds(pipeline.id)) {
  if (r.stage !== stage.id) continue;
  console.log(`  v${r.baseline.version}→v${r.candidate?.version ?? "-"}  current ${pct(r.testBaseline)}  candidate ${pct(r.testCandidate)}  random ${pct(r.testRandom)}  ±${pct(r.noise)}  ${r.kept ? "kept" : "rolled back"}  (seed ${r.seed}, commit ${r.commit.slice(0, 10)})`);
}
const byModel = traces.reduce<Record<string, number>>((m, t) => ((m[t.model] = (m[t.model] ?? 0) + 1), m), {});
await db.collection("traces").insertOne({ kind: "loop_run", pipeline: pipeline.id, stage: stage.id, n, rounds: total, llmCalls, byModel, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() });
console.log(raindrop ? `Raindrop: ${raindropEvents.events} events, ${raindropEvents.signals} signals sent` : "Raindrop: off (no RAINDROP_WRITE_KEY)");
console.log(`\n${llmCalls} LLM calls (${Object.entries(byModel).map(([m, c]) => `${m}: ${c}`).join(", ")}) in ${Math.round((Date.now() - t0) / 1000)}s`);
await close();
