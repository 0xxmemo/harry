// Data sources Harry can query: the bundled demo CRM, a live cluster (via mongosh), and
// tabular files from granted folders. Local sources run pipelines with mingo after the same
// Rust policy gate that guards live clusters.

import { aggregate } from "mingo";
import { api, FileEntry } from "./api";
import { parseDelimited } from "./csv";
import { CollectionSchema, inferFields } from "./schema";
import reps from "../../demo-crm/reps.json";
import accounts from "../../demo-crm/accounts.json";
import deals from "../../demo-crm/deals.json";
import activities from "../../demo-crm/activities.json";
import contacts from "../../demo-crm/contacts.json";

type Doc = Record<string, unknown>;

export type Doc_ = Doc;
export type Note = { origin: string; text: string };

export type SourceSet = {
  kind: "demo" | "mongo";
  label: string;
  schemas: CollectionSchema[];
  local: Map<string, Doc[]>; // key "db.collection"
  notes: Note[];
};

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;
const reviveDates = (rows: Doc[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && ISO.test(v) ? new Date(v) : v])));

export function demoSources(): SourceSet {
  const local = new Map<string, Doc[]>();
  const data: Record<string, Doc[]> = { reps, accounts, contacts, deals, activities } as Record<string, Doc[]>;
  const schemas: CollectionSchema[] = [];
  for (const [name, rows] of Object.entries(data)) {
    local.set(`crm.${name}`, reviveDates(rows));
    schemas.push({ db: "crm", name, count: rows.length, fields: inferFields(rows.slice(0, 60)), source: "demo" });
  }
  return { kind: "demo", label: "Demo CRM", schemas, local, notes: [] };
}

export async function mongoSources(label: string): Promise<SourceSet> {
  const dbs = await api.mongoSample();
  const schemas: CollectionSchema[] = dbs.flatMap((d) =>
    d.collections.map((c) => ({ db: d.name, name: c.name, count: c.count, fields: inferFields(c.samples), source: "mongo" as const })),
  );
  return { kind: "mongo", label, schemas, local: new Map(), notes: [] };
}

const slug = (s: string) => s.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();

/** Load granted-folder files: tables become queryable collections under db "files", text becomes notes. */
export async function loadFiles(roots: string[]): Promise<{ schemas: CollectionSchema[]; local: Map<string, Doc[]>; notes: Note[]; files: FileEntry[] }> {
  const schemas: CollectionSchema[] = [];
  const local = new Map<string, Doc[]>();
  const notes: Note[] = [];
  const files: FileEntry[] = [];
  for (const root of roots) {
    const entries = await api.scanFolder(root).catch(() => [] as FileEntry[]);
    files.push(...entries);
    for (const f of entries.slice(0, 60)) {
      const text = await api.readSource(f.path).catch(() => "");
      if (!text) continue;
      let rows: Doc[] | null = null;
      if (f.ext === "csv") rows = parseDelimited(text, ",");
      else if (f.ext === "tsv") rows = parseDelimited(text, "\t");
      else if (f.ext === "json") {
        try {
          const v = JSON.parse(text);
          if (Array.isArray(v) && v.every((x) => x && typeof x === "object")) rows = v;
        } catch {
          /* not tabular */
        }
      }
      if (rows && rows.length) {
        const name = slug(f.rel);
        local.set(`files.${name}`, reviveDates(rows));
        schemas.push({ db: "files", name, count: rows.length, fields: inferFields(rows.slice(0, 60)), source: "file", origin: f.rel });
      } else if (f.ext === "md" || f.ext === "txt") {
        notes.push({ origin: f.rel, text: text.slice(0, 6000) });
      }
    }
  }
  return { schemas, local, notes, files };
}

export function mergeFiles(base: SourceSet, extra: Awaited<ReturnType<typeof loadFiles>>): SourceSet {
  const local = new Map(base.local);
  extra.local.forEach((v, k) => local.set(k, v));
  return {
    ...base,
    schemas: [...base.schemas.filter((s) => s.source !== "file"), ...extra.schemas],
    local,
    notes: extra.notes,
  };
}

/** Run a pipeline on whichever source owns the collection. Gate first, always. */
export async function runPipeline(src: SourceSet, db: string, collection: string, pipeline: unknown[]): Promise<Doc[]> {
  const key = `${db}.${collection}`;
  const localRows = src.local.get(key);
  if (localRows) {
    const checked = await api.gateCheck(pipeline);
    const res = aggregate(localRows, checked as Doc[], {
      collectionResolver: (name: string) => src.local.get(`${db}.${name}`) ?? [],
    });
    return res as Doc[];
  }
  if (src.kind !== "mongo") throw new Error(`Unknown collection ${key}`);
  return api.mongoAggregate(db, collection, pipeline);
}

/** Pick notes that share words with the question, for grounding. */
export function relevantNotes(notes: Note[], q: string, n = 3): Note[] {
  const words = new Set(q.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  return notes
    .map((note) => ({ note, score: note.text.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.note);
}
