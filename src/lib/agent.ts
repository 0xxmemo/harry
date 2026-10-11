// The ask loop: question → plan (pipeline) → policy gate → run → on failure, repair and record a
// scar → summarize. Everything the model sees is assembled here so it can be shown in the trace.

import { api } from "./api";
import { addScar, addSkill, addTerm, Memory, recall } from "./memory";
import { schemaPrompt } from "./schema";
import { relevantNotes, runPipeline, SourceSet } from "./sources";

type Doc = Record<string, unknown>;

type Plan = { db: string; collection: string; pipeline: unknown[]; chart?: Answer["chart"] | null; explain?: string };

export type Step = { label: string; detail?: string; status: "run" | "ok" | "fail" | "learn"; ms?: number };

export type Answer = {
  question: string;
  db: string;
  collection: string;
  pipeline: unknown[];
  rows: Doc[];
  summary: string;
  chart?: { type: "bar" | "line"; x: string; y: string };
  actions: string[];
  citations: string[];
  steps: Step[];
  ms: number;
  tokens: number;
  model: string;
  learned: string[];
};

const PLANNER = `You are Harry, a sales analyst that writes MongoDB aggregation pipelines.
Reply with ONE JSON object and nothing else:
{"db": "...", "collection": "...", "pipeline": [...], "chart": {"type":"bar"|"line","x":"field","y":"field"} | null, "explain": "one sentence"}
Rules:
- Use only collections and fields from the schema. Read-only stages only ($match $group $project $sort $limit $lookup $unwind $addFields $set $count $facet $bucket $sortByCount $replaceRoot $setWindowFields).
- Data is messy: stage labels vary in case and wording (e.g. "Closed Won", "closed-won", "Won"); use $regex with "i" or $in. Numbers may be strings; use $convert when needed.
- Dates are real dates. For "now" use the "$$NOW" variable, e.g. {"$subtract": ["$$NOW", "$lastActivityAt"]} gives milliseconds; one day is 86400000 ms.
- Prefer $lookup to show names instead of ids (reps.name, accounts.name). Keep output columns readable and few (≤ 7). Round money and ratios.
- End with $limit (≤ 50) unless the result is an aggregate.
- If no collection in the schema can answer the question, reply {"db": null, "collection": null, "pipeline": [], "explain": "what data is missing"}.
- Apply the team glossary definitions exactly; they override your defaults.`;

const SUMMARIZER = `You are Harry, a sharp sales analyst. Given a question and query results, reply with ONE JSON object:
{"summary": "2-3 sentences with the key numbers, plain English, no fluff", "actions": ["up to 3 concrete next actions for a sales team"]}
Only state numbers that appear in the results. If results are empty, say so and suggest why.`;

export function extractJson<T = Doc>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("model did not return JSON");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** Strings like {"$date": ...} from the model become real dates for local engines. */
function reviveDates(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveDates);
  if (v && typeof v === "object") {
    const o = v as Doc;
    if (Object.keys(o).length === 1 && typeof o.$date === "string") return new Date(o.$date);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, reviveDates(x)]));
  }
  return v;
}

function memoryContext(m: Memory, q: string) {
  const { glossary, skills, scars } = recall(m, q);
  const parts: string[] = [];
  if (glossary.length) parts.push("TEAM GLOSSARY (must follow):\n" + glossary.map((g) => `- ${g.term}: ${g.definition}`).join("\n"));
  if (skills.length)
    parts.push("PROVEN QUERIES for similar questions:\n" + skills.map((s) => `- "${s.question}" → ${s.db}.${s.collection} ${JSON.stringify(s.pipeline)}`).join("\n"));
  if (scars.length) parts.push("PAST MISTAKES to avoid:\n" + scars.map((s) => `- ${s.lesson}`).join("\n"));
  return parts.join("\n\n");
}

export async function ask(
  question: string,
  src: SourceSet,
  memory: Memory,
  onStep: (steps: Step[]) => void,
): Promise<Answer> {
  const started = performance.now();
  const steps: Step[] = [];
  const push = (s: Step) => {
    steps.push(s);
    onStep([...steps]);
    return steps.length - 1;
  };
  const done = (i: number, patch: Partial<Step>) => {
    steps[i] = { ...steps[i], ...patch };
    onStep([...steps]);
  };
  let tokens = 0;
  let model = "";
  const learned: string[] = [];

  const recalled = recall(memory, question);
  if (recalled.glossary.length || recalled.skills.length || recalled.scars.length)
    push({ label: "Recalled memory", detail: `${recalled.glossary.length} terms · ${recalled.skills.length} skills · ${recalled.scars.length} lessons`, status: "ok" });

  const notes = relevantNotes(src.notes, question);
  const context = [
    "SCHEMA:\n" + schemaPrompt(src.schemas),
    memoryContext(memory, question),
    notes.length ? "NOTES FROM USER FILES:\n" + notes.map((n) => `[${n.origin}]\n${n.text.slice(0, 1500)}`).join("\n\n") : "",
    `TODAY: ${new Date().toISOString().slice(0, 10)}`,
    `QUESTION: ${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!src.schemas.length) throw new Error("There's no data to query yet: the connected cluster has no collections besides Harry's own.");

  let plan = null as Plan | null;
  let rows: Doc[] = [];
  let lastError = "";
  let attempt = 0;

  while (attempt < 3) {
    attempt++;
    const i = push({ label: attempt === 1 ? "Planning query" : `Repairing query (try ${attempt})`, status: "run" });
    const t0 = performance.now();
    const prompt = attempt === 1 ? context : `${context}\n\nYOUR PREVIOUS PIPELINE FAILED:\n${JSON.stringify(plan)}\nERROR: ${lastError}\nFix it.`;
    const res = await api.llm(PLANNER, prompt);
    tokens += res.prompt_tokens + res.completion_tokens;
    model = res.model;
    try {
      plan = reviveDates(extractJson(res.text)) as Plan;
      if ((plan.db || plan.collection) && (typeof plan.db !== "string" || typeof plan.collection !== "string" || !Array.isArray(plan.pipeline) || !src.schemas.some((c) => c.db === plan!.db && c.name === plan!.collection))) {
        throw new Error(`Plan must use a db and collection from the schema; got ${JSON.stringify({ db: plan.db, collection: plan.collection })}`);
      }
      if (plan.db) done(i, { status: "ok", ms: Math.round(performance.now() - t0), detail: `${plan!.db}.${plan!.collection} · ${plan!.pipeline.length} stages` });
    } catch (e) {
      lastError = String(e);
      done(i, { status: "fail", detail: lastError });
      continue;
    }
    if (!plan!.db && !plan!.collection) {
      done(i, { status: "fail", detail: "No collection fits this question" });
      throw new Error(plan!.explain || "None of your collections can answer this question.");
    }
    const g = push({ label: "Policy gate", status: "run" });
    try {
      await api.gateCheck(plan!.pipeline);
      done(g, { status: "ok", detail: "read-only · row cap 500" });
    } catch (e) {
      lastError = String(e);
      done(g, { status: "fail", detail: lastError });
      continue;
    }
    const r = push({ label: src.kind === "mongo" ? "Running on Atlas (mongosh)" : "Running query", status: "run" });
    const t1 = performance.now();
    try {
      rows = await runPipeline(src, plan!.db, plan!.collection, plan!.pipeline);
      done(r, { status: "ok", ms: Math.round(performance.now() - t1), detail: `${rows.length} rows` });
      if (rows.length === 0 && attempt < 3) {
        lastError = "the pipeline returned 0 rows; filters are probably too strict or label values don't match the data";
        done(r, { status: "fail", detail: "0 rows" });
        continue;
      }
      break;
    } catch (e) {
      lastError = String(e);
      done(r, { status: "fail", detail: lastError.slice(0, 160) });
    }
  }

  if (!plan) throw new Error(lastError || "Harry could not plan a query");
  const final: Plan = plan;

  if (attempt > 1 && rows.length) {
    const lesson = await learnLesson(question, lastError, final.pipeline).catch(() => null);
    if (lesson) {
      addScar(memory, question, lastError, lesson);
      learned.push(lesson);
      push({ label: "Learned from failure", detail: lesson, status: "learn" });
    }
  }
  if (rows.length) addSkill(memory, { question, db: final.db, collection: final.collection, pipeline: final.pipeline });

  const s = push({ label: "Writing answer", status: "run" });
  const t2 = performance.now();
  const sum = await api.llm(SUMMARIZER, `QUESTION: ${question}\nRESULTS (${rows.length} rows, first 40):\n${JSON.stringify(rows.slice(0, 40))}`);
  tokens += sum.prompt_tokens + sum.completion_tokens;
  let summary = sum.text;
  let actions: string[] = [];
  try {
    const j = extractJson<{ summary: string; actions: string[] }>(sum.text);
    summary = j.summary;
    actions = j.actions ?? [];
  } catch {
    /* keep raw text */
  }
  done(s, { status: "ok", ms: Math.round(performance.now() - t2) });

  const ms = Math.round(performance.now() - started);
  memory.traces.push({ at: new Date().toISOString(), question, ms, tokens, rows: rows.length, ok: rows.length > 0, retries: attempt - 1, model });
  memory.traces = memory.traces.slice(-200);

  const citations = [
    `${final.db}.${final.collection}`,
    ...src.schemas.filter((x) => x.source === "file" && x.db === final.db && x.name === final.collection).map((x) => `file: ${x.origin}`),
    ...notes.map((n) => `note: ${n.origin}`),
  ];

  return {
    question,
    db: final.db,
    collection: final.collection,
    pipeline: final.pipeline,
    rows,
    summary,
    chart: final.chart ?? undefined,
    actions,
    citations: [...new Set(citations)],
    steps,
    ms,
    tokens,
    model,
    learned,
  };
}

async function learnLesson(question: string, error: string, fixed: unknown[]): Promise<string> {
  const res = await api.llm(
    "Write ONE short, general lesson (max 25 words) a query writer should remember next time, based on a failure and its fix. Plain text only, no preamble.",
    `QUESTION: ${question}\nFAILURE: ${error}\nWORKING PIPELINE: ${JSON.stringify(fixed)}`,
  );
  return res.text.trim().replace(/^["-\s]+|["\s]+$/g, "").slice(0, 300);
}

/** Turn a user correction into a glossary term. Returns the saved term or null if the gate refused it. */
export async function learnCorrection(memory: Memory, question: string, correction: string): Promise<string | null> {
  const res = await api.llm(
    'Extract the business term the user is defining or correcting. Reply ONE JSON object: {"term": "short term", "definition": "precise definition in terms of data fields where possible"}',
    `ORIGINAL QUESTION: ${question}\nUSER CORRECTION: ${correction}`,
  );
  const j = extractJson<{ term: string; definition: string }>(res.text);
  return addTerm(memory, j.term, j.definition) ? `${j.term}: ${j.definition}` : null;
}
