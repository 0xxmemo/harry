// Bun preload that lets the app's own learning-loop code (src/lib/sim.ts, improve.ts) run headless.
// It stands in for the two Tauri pieces the loop touches:
//   - `@tauri-apps/api/core` invoke: llm_complete -> openllm CLI, store_* -> MongoDB Atlas,
//     gate_playbook -> a TS port of gate.rs::gate_playbook (same regex, same rules)
//   - Vite's `?raw` imports (pipeline YAML)
// Harry's memory lives in Atlas db `harry` (HARRY_ATLAS_URI), one collection per store collection.

import { plugin } from "bun";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { MongoClient } from "mongodb";

const uri = process.env.HARRY_ATLAS_URI;
if (!uri) throw new Error("Set HARRY_ATLAS_URI (source ~/.harry/atlas.env)");
const client = new MongoClient(uri, { appName: "harry-loop" });
export const db = client.db(process.env.HARRY_DB ?? "harry");
export const close = () => client.close();

const COLLECTIONS = ["settings", "outbox", "interactions", "runs", "calls", "insights", "playbooks", "evals", "llm_cache", "optouts", "traces"];

// The gateway returns HTML error pages under bursty load, so cap concurrency and retry with backoff.
const MAX_PARALLEL = Number(process.env.HARRY_LLM_PARALLEL ?? 8);
let active = 0;
const waiting: (() => void)[] = [];
async function openllm(system: string, prompt: string, model: string): Promise<string> {
  while (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await openllmOnce(system, prompt, model);
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt * (0.5 + Math.random())));
      }
    }
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function openllmOnce(system: string, prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("openllm", ["-p", "-", "-m", model, "-s", system, "--no-stream"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`openllm ${model} exit ${code}: ${(err.match(/<title>(.*?)<\/title>/)?.[1] ?? err.trim().split("\n").filter((l) => !l.startsWith("<"))[0] ?? "").slice(0, 200)}`))));
    p.stdin.end(prompt);
  });
}

// Port of src-tauri/src/gate.rs::gate_playbook. Keep in sync.
function gatePlaybook(firmLimits: string[], rules: string[]) {
  const joined = rules.join("\n").toLowerCase();
  const m = /ignore (the )?(firm|policy|limit|rule)|override|bypass|offer (a )?discount|\$\s?\d|\d+\s?% off/i.exec(joined);
  if (m) throw new Error(`Policy gate: proposed rule contains "${m[0]}"`);
  for (const limit of firmLimits) if (joined.includes(`not ${limit.toLowerCase()}`)) throw new Error(`Policy gate: contradicts firm limit "${limit}"`);
  if (rules.some((r) => r.length > 400)) throw new Error("Policy gate: rules must be short");
}

export let llmCalls = 0;
export const traces: { model: string; ms: number; system: string; promptChars: number }[] = [];

async function invoke(cmd: string, args: Record<string, any> = {}): Promise<any> {
  switch (cmd) {
    case "llm_complete": {
      const model = args.model ?? "claude-sonnet-5-5";
      const t0 = Date.now();
      const text = await openllm(args.system, args.prompt, model);
      llmCalls++;
      traces.push({ model, ms: Date.now() - t0, system: args.system.slice(0, 60), promptChars: args.prompt.length });
      return { text, model, ms: Date.now() - t0, prompt_tokens: Math.ceil((args.system.length + args.prompt.length) / 4), completion_tokens: Math.ceil(text.length / 4) };
    }
    case "store_list": {
      if (!COLLECTIONS.includes(args.coll)) throw new Error(`unknown collection ${args.coll}`);
      return db.collection(args.coll).find({}).toArray();
    }
    case "store_upsert": {
      const { _id, ...rest } = args.doc;
      const r = await db.collection(args.coll).findOneAndUpdate({ _id }, { $set: { ...rest, updatedAt: new Date().toISOString() } }, { upsert: true, returnDocument: "after" });
      return r;
    }
    case "store_reset": {
      for (const c of args.colls) await db.collection(c).deleteMany({});
      return null;
    }
    case "gate_playbook":
      return gatePlaybook(args.firmLimits, args.rules);
    default:
      throw new Error(`headless shim: ${cmd} is not available outside the app`);
  }
}

plugin({
  name: "harry-headless",
  setup(build) {
    build.module("@tauri-apps/api/core", () => ({ exports: { invoke }, loader: "object" }));
    build.onResolve({ filter: /\?raw$/ }, (a) => ({ path: new URL(a.path.replace(/\?raw$/, ""), "file://" + a.importer).pathname }));
    build.onLoad({ filter: /\.ya?ml$/ }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))};`, loader: "js" }));
  },
});
