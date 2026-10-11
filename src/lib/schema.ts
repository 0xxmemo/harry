// Infers a compact schema from sampled documents. This is what Harry shows in the schema map
// and what it sends to the model as context.

export type Field = { path: string; types: string[]; examples: string[]; presence: number };
export type CollectionSchema = { db: string; name: string; count: number; fields: Field[]; source: "mongo" | "crm" | "file"; origin?: string };

const typeOf = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$date" in o) return "date";
    if ("$oid" in o) return "objectId";
    if ("$numberDecimal" in o || "$numberLong" in o) return "number";
    return "object";
  }
  if (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return "date";
  return typeof v;
};

const show = (v: unknown) => {
  const t = typeOf(v);
  if (t === "date") return String((v as { $date?: string }).$date ?? v).slice(0, 10);
  if (t === "objectId") return "ObjectId";
  if (t === "object" || t === "array") return t === "array" ? `[${(v as unknown[]).length}]` : "{…}";
  return String(v).slice(0, 40);
};

export function inferFields(docs: Record<string, unknown>[]): Field[] {
  const map = new Map<string, { types: Set<string>; examples: Set<string>; seen: number }>();
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const t = typeOf(v);
      const e = map.get(path) ?? { types: new Set(), examples: new Set(), seen: 0 };
      e.types.add(t);
      e.seen++;
      if (e.examples.size < 3 && t !== "null") e.examples.add(show(v));
      map.set(path, e);
      if (t === "object" && depth < 2) walk(v as Record<string, unknown>, path, depth + 1);
    }
  };
  docs.forEach((d) => walk(d, "", 0));
  return [...map.entries()].map(([path, e]) => ({
    path,
    types: [...e.types],
    examples: [...e.examples],
    presence: docs.length ? e.seen / docs.length : 0,
  }));
}

export function schemaPrompt(schemas: CollectionSchema[]): string {
  return schemas
    .map((s) => {
      const fields = s.fields
        .map((f) => {
          const mixed = f.types.length > 1 ? ` MIXED(${f.types.join("|")})` : ` ${f.types[0]}`;
          const sparse = f.presence < 0.9 ? ` present ${Math.round(f.presence * 100)}%` : "";
          return `  ${f.path}:${mixed}${sparse} e.g. ${f.examples.join(", ")}`;
        })
        .join("\n");
      return `${s.db}.${s.name} (${s.count} docs${s.source === "file" ? `, from file ${s.origin}` : ""})\n${fields}`;
    })
    .join("\n\n");
}
