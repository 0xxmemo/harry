// One workspace: CRM records synced from Composio (mirrored into Harry's crm_* collections), Harry's
// knowledge base on Atlas (queried live via mongosh), and tabular files from granted folders.
// Local rows run pipelines with mingo after the same Rust policy gate that guards the cluster.

import { aggregate } from "mingo";
import { api, FileEntry } from "./api";
import { parseDelimited } from "./csv";
import { CollectionSchema, inferFields } from "./schema";
import { store, CrmColl } from "./store";

type Doc = Record<string, unknown>;

export type Doc_ = Doc;
export type Note = { origin: string; text: string };

export type SourceSet = {
  label: string;
  schemas: CollectionSchema[];
  local: Map<string, Doc[]>; // key "db.collection"
  notes: Note[];
};

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;
const reviveDates = (rows: Doc[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && ISO.test(v) ? new Date(v) : v])));

const CRM = ["accounts", "contacts", "reps", "deals", "activities"] as const;
// Relaxed Extended JSON from the store encodes dates as { $date: "..." }.
const reviveExt = (v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v) && "$date" in (v as object) ? new Date((v as { $date: string }).$date) : v;

/** Build the workspace from what's stored: synced CRM records plus the knowledge base on the cluster. */
export async function workspaceSources(label: string): Promise<SourceSet> {
  const schemas: CollectionSchema[] = [];
  const local = new Map<string, Doc[]>();
  for (const name of CRM) {
    const docs = (await store.list<Doc>(`crm_${name}` as CrmColl)).map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, reviveExt(v)])));
    local.set(`crm.${name}`, docs);
    schemas.push({ db: "crm", name, count: docs.length, fields: inferFields(docs.slice(0, 60)), source: "crm" });
  }
  const dbs = await api.mongoSample().catch(() => []);
  for (const d of dbs)
    for (const c of d.collections) {
      if (c.name.startsWith("crm_")) continue; // already exposed above as crm.*
      schemas.push({ db: d.name, name: c.name, count: c.count, fields: inferFields(c.samples), source: "mongo" });
    }
  return { label, schemas, local, notes: [] };
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
