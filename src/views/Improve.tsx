import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, Check, ChevronDown, FlaskConical, Lightbulb, Lock, Minus, Plus, Undo2 } from "lucide-react";
import { RoundLog, RoundResult, rounds, runRound } from "../lib/improve";
import { activePlaybook, Pipeline, PlaybookVersion, playbookHistory } from "../lib/pipeline";
import { store } from "../lib/store";
import { Button, Card, cx, ErrorBox, errText, Pill, SectionLabel, Spinner } from "../components/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Doc = Record<string, unknown>;
const pct = (x: number) => `${Math.round(x * 100)}%`;

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
  const [advanced, setAdvanced] = useState(false);
  const stage = pipeline.stages.find((s) => s.id === stageId);

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

  const start = async (forced: string[] = [], ids: string[] = []) => {
    setBusy(true);
    setErr("");
    setLog([]);
    try {
      const r = await runRound(pipeline, stage!, n, (l) => setLog((x) => (x.at(-1)?.phase === l.phase ? [...x.slice(0, -1), l] : [...x, l])), forced);
      for (const id of ids) await store.upsert("insights", { _id: id, tested: true });
      r.kept ? toast.success(`Playbook upgraded to v${r.candidate?.version}`) : toast.message("Change didn't win, so Harry kept the current playbook");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      await load();
      onChange();
    }
  };

  if (!stage) return <div className="p-10 text-muted-foreground">This pipeline has no stages Harry runs on his own.</div>;
  const last = results.at(-1);
  const phases = ["Committed test seed", "Train run", "Reviewer", "Candidate", "Held-out test"];
  const step = Math.max(0, ...log.map((l) => phases.findIndex((p) => l.phase.startsWith(p.split(" ")[0]))));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-8 pt-10 pb-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Improve</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Can Harry write better follow-ups?</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">Harry proposes a change to his playbook and tests it on simulated buyers he has never seen. It's kept only if it clearly wins.</p>
          </div>
          {agentStages.length > 1 && (
            <Tabs value={stageId} onValueChange={setStageId}>
              <TabsList>{agentStages.map((s) => <TabsTrigger key={s.id} value={s.id}>{s.name}</TabsTrigger>)}</TabsList>
            </Tabs>
          )}
        </div>

        {insights.length > 0 && !busy && (
          <Card className="flex items-center gap-4 border-amber-400/30 bg-amber-400/5 p-4">
            <Lightbulb className="size-5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">A rule from a sales call is ready to test</div>
              <div className="truncate text-xs text-muted-foreground">{String(insights[0].rule)}</div>
            </div>
            <Button onClick={() => start(insights.map((i) => String(i.rule)), insights.map((i) => String(i._id)))}>Test this rule</Button>
          </Card>
        )}

        {/* Hero: the one thing to look at */}
        <Card className="overflow-hidden">
          {busy ? (
            <div className="p-8">
              <div className="flex items-center gap-3"><Spinner className="text-primary" /><div className="font-medium">{log.at(-1)?.phase ?? "Starting"}…</div></div>
              <div className="mt-1 ml-7 text-sm text-muted-foreground">{log.at(-1)?.detail}</div>
              <div className="mt-6 grid grid-cols-5 gap-2">
                {["Seal test set", "Practice run", "Propose change", "Safety check", "Final test"].map((t, i) => (
                  <div key={t}>
                    <div className={cx("h-1 rounded-full", i < step ? "bg-primary" : i === step ? "animate-pulse bg-primary/60" : "bg-muted")} />
                    <div className={cx("mt-2 text-xs", i <= step ? "text-foreground" : "text-muted-foreground")}>{t}</div>
                  </div>
                ))}
              </div>
              <div className="mt-6 text-xs text-muted-foreground">Takes a few minutes. Buyers are played by a separate model so Harry can't grade his own work.</div>
            </div>
          ) : last ? (
            <div className="p-8">
              <div className="flex items-center gap-2 text-sm">
                {last.kept ? <Pill tone="brand"><Check className="size-3" /> kept</Pill> : <Pill><Undo2 className="size-3" /> rolled back</Pill>}
                <span className="text-muted-foreground">Last test · {last.n} unseen buyers</span>
              </div>
              <div className="mt-5 flex items-end gap-10">
                <Stat label="Current playbook" value={pct(last.testBaseline)} />
                <ArrowRight className="mb-3 size-5 text-muted-foreground" />
                <Stat label="With the change" value={pct(last.testCandidate)} highlight={last.kept} />
                <div className="ml-auto text-right">
                  <div className="text-xs text-muted-foreground">Random change (control)</div>
                  <div className="text-lg font-medium tabular-nums text-muted-foreground">{pct(last.testRandom)}</div>
                </div>
              </div>
              <p className="mt-5 text-sm text-muted-foreground">{last.kept ? "The new playbook got more replies by more than chance would explain, so it's now live." : `The difference was within ±${Math.round(last.noise * 100)} points of chance, so Harry kept what already works.`}</p>
              {last.candidate && last.candidate.diff.added.length > 0 && (
                <div className="mt-4 space-y-1.5">
                  {last.candidate.diff.added.map((a) => <div key={a} className="flex gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm"><Plus className="mt-0.5 size-3.5 shrink-0 text-primary" />{a}</div>)}
                </div>
              )}
            </div>
          ) : (
            <div className="p-10 text-center">
              <FlaskConical className="mx-auto size-8 text-primary" />
              <div className="mt-3 font-medium">No tests yet for “{stage.name}”</div>
              <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Harry's current playbook has {active?.rules.length ?? 0} rules. Run a test to see if he can beat it.</div>
            </div>
          )}
          {!busy && (
            <div className="flex items-center justify-between border-t bg-muted/30 px-8 py-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Test on
                {[12, 24, 40].map((x) => <button key={x} onClick={() => setN(x)} className={cx("rounded-md px-2 py-1 tabular-nums", n === x ? "bg-background text-foreground" : "hover:text-foreground")}>{x}</button>)}
                buyers
              </div>
              <Button onClick={() => start()}><FlaskConical /> {last ? "Try another change" : "Run a test"}</Button>
            </div>
          )}
        </Card>
        <ErrorBox>{err}</ErrorBox>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Playbook in use for “{stage.name}”</div>
            {active && <Pill tone="brand">version {active.version}</Pill>}
          </div>
          <ol className="selectable mt-3 list-decimal space-y-1.5 pl-5 text-sm">{active?.rules.map((r) => <li key={r}>{r}</li>)}</ol>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {pipeline.firm_limits.map((f) => <Pill key={f}><Lock className="size-3" /> {f}</Pill>)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">Locked rules can't be changed by Harry's reviewer.</div>
        </Card>

        <button onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDown className={cx("size-4 transition-transform", !advanced && "-rotate-90")} /> Test history and method
        </button>
        {advanced && (
          <div className="space-y-4">
            {results.length > 0 && (
              <Card className="p-6">
                <SectionLabel className="mb-4">Reply rate per test</SectionLabel>
                <div className="h-56">
                  <ResponsiveContainer>
                    <BarChart data={results.map((r, i) => ({ t: `Test ${i + 1}`, current: Math.round(r.testBaseline * 100), change: Math.round(r.testCandidate * 100), random: Math.round(r.testRandom * 100) }))}>
                      <CartesianGrid stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="t" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} unit="%" width={36} />
                      <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "#ffffff08" }} />
                      <Bar dataKey="current" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="change" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="random" fill="var(--chart-3)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}
            <Card className="divide-y">
              {history.map((h) => (
                <div key={h._id} className="p-4 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{h.version}</span>
                    <Pill tone={h.status === "active" ? "brand" : h.status === "rejected" ? "bad" : "mute"}>{h.status === "rejected" ? "rolled back" : h.status}</Pill>
                    <span className="text-xs text-muted-foreground">{h.source.replace("_", " ")}{h.scores ? ` · ${pct(h.scores.baseline)} → ${pct(h.scores.candidate)}` : ""}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{h.rationale}</div>
                  {h.diff.added.map((a) => <div key={a} className="mt-1 flex gap-1.5 text-xs text-brand-2"><Plus className="mt-0.5 size-3 shrink-0" />{a}</div>)}
                  {h.diff.removed.map((a) => <div key={a} className="mt-1 flex gap-1.5 text-xs text-destructive"><Minus className="mt-0.5 size-3 shrink-0" />{a}</div>)}
                </div>
              ))}
            </Card>
            <Card className="p-5 text-sm text-muted-foreground">
              <div className="font-medium text-foreground">Why you can trust the result</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>The test buyers are picked from a seed that is locked (hashed) before the test starts.</li>
                <li>Buyers are played by a different model, and the reviewer never sees their hidden traits.</li>
                <li>A random change runs on the same buyers, so “any change helps” doesn't count as a win.</li>
                <li>Every buyer reply is cached, so any test can be replayed exactly.</li>
              </ul>
              {last && <div className="mt-3 font-mono text-xs">Last seed {last.seed} · commitment {last.commit.slice(0, 20)}…</div>}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cx("text-4xl font-semibold tracking-tight tabular-nums", highlight && "text-brand-2")}>{value}</div>
      <div className="text-xs text-muted-foreground">replied</div>
    </div>
  );
}
