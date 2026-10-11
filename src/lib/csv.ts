// Minimal RFC-4180 CSV/TSV parser with numeric/boolean coercion.

export function parseDelimited(text: string, sep = ","): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h, i) => h.trim() || `col${i + 1}`);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, coerce(r[i])])));
}

function coerce(v: string | undefined): unknown {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  if (/^-?\$?[\d,]+(\.\d+)?$/.test(t)) return Number(t.replace(/[$,]/g, ""));
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  return t;
}
