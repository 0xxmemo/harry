import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RoundLog, RoundResult, rounds, runRound } from "../lib/improve";
import { activePlaybook, Pipeline, PlaybookVersion, playbookHistory } from "../lib/pipeline";
import { store } from "../lib/store";
import { Button, Card, ErrorBox, errText, Pill, Spinner } from "../components/ui";

type Doc = Record<string, unknown>;

export default function Improve({ pipeline, onChange }: { pipeline: Pipeline; onChange: () => void }) {
  const agentStages = pipeline.stages.filter((s) => s.owner !== "human" && s.playbook.variants.length);
  const [stageId, setStageId] = useState(agentStages[0]?.id);
  const [active, setActive] = useState<PlaybookVersion | null>(null);
  const [history, setHistory] = useState<PlaybookVersion[]>([]);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [insights, setInsights] = useState<Doc[]>([]);
  const [log, setLog] = useState<RoundLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [n, setN] = useState(24);
  const stage = pipeline.stages.find((s) => s.id === stageId)!;

  const load = async () => {
    if (!stage) return;
    setActive(await activePlaybook(pipeline, stage));
    setHistory((await playbookHistory(pipeline.id)).filter((p) => p.stage === stage.id));
    setResults((await rounds(pipeline.id)).filter((r) => r.stage === stage.id));
    setInsights((await store.list<Doc>("insights")).filter((i) => i.kind === "call_rule" && i.status === "approved" && !i.tested));
  };
  useEffect(() => {
    load();
  }, [stageId, pipeline.id]);

  const go = async (forced: string[] = [], insightIds: string[] = []) => {
    setBusy(true);
    setErr("");
    setLog([]);
    try {
      await runRound(pipeline, stage, n, (l) => setLog((x) => (x.at(-1)?.phase === l.phase ? [...x.slice(0, -1), l] : [...x, l])), forced);
      for (const id of insightIds) await store.upsert("insights", { _id: id, tested: true });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      await load();
      onChange();
    }
  };

  const chart = results.map((r, i) => ({
    round: `R${i + 1}`,
    current: Math.round(r.testBaseline * 100),
    candidate: Math.round(r.testCandidate * 100),
    random: Math.round(r.testRandom * 100),
    lo: Math.round((r.testBaseline - r.noise) * 100),
    hi: Math.round((r.testBaseline + r.noise) * 100),
    kept: r.kept,
  }));

  if (!stage) return <div className="p-8 text-mute">This pipeline has no agent-owned stages with playbooks.</div>;

  return (
    <div className="h-full overflow-y-auto px-8 pt-8 pb-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-xs tracking-wide text-mute uppercase">Self-improvement</div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Every change is tested, kept only if it wins</h1>
          </div>
          <div className="flex items-center gap-2">
            <select value={stageId} onChange={(e) => setStageId(e.target.value)} className="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
              {agentStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={n} onChange={(e) => setN(Number(e.target.value))} className="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
              {[12, 24, 40].map((x) => <option key={x} value={x}>{x} buyers</option>)}
            </select>
            <Button disabled={busy} onClick={() => go()}>{busy ? <Spinner /> : "⟳"} Run improvement round</Button>
          </div>
        </div>

        {insights.length > 0 && (
          <Card className="mt-5 flex items-center justify-between border-amber-400/40 bg-amber-400/5 p-4">
            <div className="text-sm">
              <span className="text-amber-300">{insights.length} approved rule{insights.length > 1 ? "s" : ""} from calls</span> waiting to be tested: “{String(insights[0].rule).slice(0, 110)}…”
            </div>
            <Button disabled={busy} onClick={() => go(insights.map((i) => String(i.rule)), insights.map((i) => String(i._id)))}>Test it</Button>
          </Card>
        )}

        <div className="mt-5 grid grid-cols-[1fr_360px] gap-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium">Reply rate on held-out buyers</div>
              <div className="flex gap-3 text-xs text-mute">
                <span><span className="text-[#5b6b63]">■</span> current</span>
                <span><span className="text-brand">■</span> candidate</span>
                <span><span className="text-[#8b6d2f]">■</span> random-edit control</span>
                <span className="text-mute">shaded: noise band</span>
              </div>
            </div>
            {chart.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-mute">Run a round to see Harry test a playbook change against unseen buyers.</div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={chart}>
                    <CartesianGrid stroke="#1f2a25" vertical={false} />
                    <XAxis dataKey="round" stroke="#7f8f87" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="#7f8f87" fontSize={11} tickLine={false} axisLine={false} unit="%" />
                    <Tooltip contentStyle={{ background: "#121815", border: "1px solid #1f2a25", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "#ffffff08" }} />
                    {chart.map((c) => <ReferenceArea key={c.round} x1={c.round} x2={c.round} y1={Math.max(0, c.lo)} y2={c.hi} fill="#10b981" fillOpacity={0.06} />)}
                    <Bar dataKey="current" fill="#5b6b63" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="candidate" fill="#10b981" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="random" fill="#8b6d2f" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3 text-sm font-medium">Live round</div>
            {log.length === 0 && !busy && <div className="text-sm text-mute">Train on fixed buyers → reviewer proposes edits → policy gate → test on buyers drawn from a seed committed before the round.</div>}
            <ol className="space-y-2 text-xs">
              {log.map((l, i) => (
                <li key={i} className="flex gap-2">
                  <span className={l.phase === "Kept" ? "text-brand" : /Rolled|rejected/.test(l.phase) ? "text-red-300" : "text-mute"}>●</span>
                  <div><div className="text-white">{l.phase}</div>{l.detail && <div className="selectable text-mute">{l.detail}</div>}</div>
                </li>
              ))}
              {busy && <li className="flex items-center gap-2 text-mute"><Spinner /> working… (simulated buyers on a separate model)</li>}
            </ol>
            <ErrorBox>{err}</ErrorBox>
          </Card>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <Card className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">Active playbook · {stage.name}</div>
              {active && <Pill tone="brand">v{active.version}</Pill>}
            </div>
            <ul className="selectable space-y-1.5 text-sm">{active?.rules.map((r) => <li key={r}>• {r}</li>)}</ul>
            <div className="mt-4 text-[11px] font-medium tracking-wide text-mute uppercase">Firm limits (reviewer can't touch)</div>
            <ul className="mt-1 space-y-1 text-xs text-mute">{pipeline.firm_limits.map((f) => <li key={f}>🔒 {f}</li>)}</ul>
          </Card>
          <Card className="p-5">
            <div className="mb-2 text-sm font-medium">Version history</div>
            <div className="max-h-80 space-y-3 overflow-y-auto">
              {history.map((h) => (
                <div key={h._id} className="border-b border-line/60 pb-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono">v{h.version}</span>
                    <Pill tone={h.status === "active" ? "brand" : h.status === "rejected" ? "bad" : "mute"}>{h.status === "rejected" ? "rolled back" : h.status}</Pill>
                    <Pill>{h.source.replace("_", " ")}</Pill>
                    {h.scores && <span className="text-mute">{Math.round(h.scores.baseline * 100)}% → {Math.round(h.scores.candidate * 100)}% (±{Math.round(h.scores.noise * 100)})</span>}
                  </div>
                  <div className="mt-1 text-mute">{h.rationale}</div>
                  {h.diff.added.map((a) => <div key={a} className="selectable text-brand-2">+ {a}</div>)}
                  {h.diff.removed.map((a) => <div key={a} className="selectable text-red-300">− {a}</div>)}
                </div>
              ))}
            </div>
          </Card>
        </div>
        {results.length > 0 && (
          <div className="mt-3 text-xs text-mute">
            Last round: test seed {results.at(-1)!.seed}, commitment sha256 {results.at(-1)!.commit.slice(0, 24)}… published before the round. Buyer replies are cached by input hash, so any seed replays exactly.
          </div>
        )}
      </div>
    </div>
  );
}
