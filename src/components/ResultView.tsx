import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Doc = Record<string, unknown>;

export const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === "object") {
    const o = v as Doc;
    if (typeof o.$date === "string") return o.$date.slice(0, 10);
    return JSON.stringify(v);
  }
  const s = String(v);
  return /^\d{4}-\d\d-\d\dT/.test(s) ? s.slice(0, 10) : s;
};

const flatten = (row: Doc): Doc => {
  const out: Doc = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !("$date" in (v as Doc))) {
      for (const [k2, v2] of Object.entries(v as Doc)) out[`${k}.${k2}`] = v2;
    } else out[k] = v;
  }
  return out;
};

export function Table({ rows }: { rows: Doc[] }) {
  const flat = rows.slice(0, 200).map(flatten);
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))].slice(0, 9);
  if (!rows.length) return <div className="p-6 text-center text-sm text-mute">No rows</div>;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="selectable w-full text-left text-sm">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b border-line px-3 py-2 text-[11px] font-medium tracking-wide text-mute uppercase">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flat.map((r, i) => (
            <tr key={i} className="border-b border-line/50 hover:bg-white/[0.02]">
              {cols.map((c) => (
                <td key={c} className={"max-w-64 truncate px-3 py-1.5 " + (typeof r[c] === "number" ? "text-right font-mono tabular-nums" : "")}>
                  {fmt(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Chart({ rows, x, y, type }: { rows: Doc[]; x: string; y: string; type: "bar" | "line" }) {
  const data = rows.slice(0, 30).map((r) => {
    const f = flatten(r);
    return { x: fmt(f[x]), y: Number(f[y]) };
  });
  if (!data.length || data.every((d) => !Number.isFinite(d.y))) return null;
  const common = (
    <>
      <CartesianGrid stroke="#1f2a25" vertical={false} />
      <XAxis dataKey="x" stroke="#7f8f87" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" />
      <YAxis stroke="#7f8f87" fontSize={11} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
      <Tooltip contentStyle={{ background: "#121815", border: "1px solid #1f2a25", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "#ffffff08" }} />
    </>
  );
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        {type === "line" ? (
          <LineChart data={data}>
            {common}
            <Line dataKey="y" name={y} stroke="#10b981" strokeWidth={2} dot={false} />
          </LineChart>
        ) : (
          <BarChart data={data}>
            {common}
            <Bar dataKey="y" name={y} fill="#10b981" radius={[4, 4, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
