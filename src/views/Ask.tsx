import { useEffect, useRef, useState } from "react";
import { Answer, ask, learnCorrection, Step } from "../lib/agent";
import { Memory, saveMemory } from "../lib/memory";
import { SourceSet } from "../lib/sources";
import { Chart, Table } from "../components/ResultView";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";

const STARTERS = [
  { icon: "📉", label: "Pipeline at risk", q: "Which open deals over $50k have stalled, and who owns them?" },
  { icon: "🏆", label: "Rep leaderboard", q: "Rank reps by win rate, with deals won, average deal size and average cycle length in days." },
  { icon: "🔮", label: "Forecast check", q: "For open deals, compare total committed vs best case vs pipeline amount by expected close month." },
  { icon: "🧊", label: "Churn radar", q: "Which accounts have falling weekly active users over the last 30 days? Show tier and owner." },
  { icon: "⚡", label: "Speed to lead", q: "How does win rate change with how fast we first touch a deal? Bucket first touch hours." },
  { icon: "🌎", label: "Revenue by region", q: "Total won revenue by rep region this year." },
];

type Turn = { q: string; steps: Step[]; answer?: Answer; error?: string; corrected?: string };

export default function Ask({ src, memory, onMemory }: { src: SourceSet; memory: Memory; onMemory: () => void }) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [turns]);

  const update = (i: number, patch: Partial<Turn>) => setTurns((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async (q: string) => {
    if (!q.trim() || busy) return;
    setInput("");
    setBusy(true);
    const i = turns.length;
    setTurns((t) => [...t, { q, steps: [] }]);
    try {
      const answer = await ask(q, src, memory, (steps) => update(i, { steps }));
      update(i, { answer, steps: answer.steps });
    } catch (e) {
      update(i, { error: errText(e) });
    } finally {
      await saveMemory(memory);
      onMemory();
      setBusy(false);
    }
  };

  const correct = async (i: number, text: string) => {
    const turn = turns[i];
    try {
      const saved = await learnCorrection(memory, turn.q, text);
      update(i, { corrected: saved ?? "The policy gate rejected that rule." });
      await saveMemory(memory);
      onMemory();
      if (saved) submit(turn.q);
    } catch (e) {
      update(i, { corrected: errText(e) });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-8 pt-6 pb-4">
        {turns.length === 0 && (
          <div className="rise mx-auto mt-10 max-w-3xl">
            <h2 className="text-3xl font-semibold tracking-tight">What do you want to know?</h2>
            <p className="mt-1 text-mute">
              Connected to <span className="text-white">{src.label}</span> · {src.schemas.length} collections
              {src.notes.length ? ` · ${src.notes.length} notes from your folders` : ""}
            </p>
            <div className="mt-6 grid grid-cols-3 gap-3">
              {STARTERS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => submit(s.q)}
                  className="group rounded-xl border border-line bg-panel p-4 text-left transition hover:-translate-y-0.5 hover:border-brand/50"
                >
                  <div className="text-2xl">{s.icon}</div>
                  <div className="mt-2 font-medium">{s.label}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-mute">{s.q}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mx-auto max-w-5xl space-y-8">
          {turns.map((t, i) => (
            <TurnView key={i} turn={t} onCorrect={(text) => correct(i, text)} onFollow={submit} />
          ))}
        </div>
        <div ref={endRef} />
      </div>
      <div className="border-t border-line bg-ink/80 px-8 py-4 backdrop-blur">
        <form
          className="mx-auto flex max-w-5xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about deals, reps, accounts, revenue…"
            className="flex-1 rounded-xl border border-line bg-panel px-4 py-3 outline-none focus:border-brand"
          />
          <Button disabled={busy || !input.trim()} className="px-5">
            {busy ? <Spinner /> : "Ask"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function TurnView({ turn, onCorrect, onFollow }: { turn: Turn; onCorrect: (t: string) => void; onFollow: (q: string) => void }) {
  const [showPipe, setShowPipe] = useState(false);
  const [fix, setFix] = useState("");
  const [fixing, setFixing] = useState(false);
  const a = turn.answer;
  return (
    <div className="rise space-y-3">
      <div className="flex justify-end">
        <div className="max-w-2xl rounded-2xl rounded-br-sm bg-brand/15 px-4 py-2.5 text-brand-2">{turn.q}</div>
      </div>
      <div className="grid grid-cols-[1fr_260px] gap-4">
        <div className="space-y-3">
          {!a && !turn.error && (
            <Card className="flex items-center gap-3 p-4 text-sm text-mute">
              <Spinner className="text-brand" /> {turn.steps.at(-1)?.label ?? "Thinking"}…
            </Card>
          )}
          <ErrorBox>{turn.error}</ErrorBox>
          {a && (
            <>
              <Card className="p-5">
                <p className="selectable leading-relaxed">{a.summary}</p>
                {a.actions.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {a.actions.map((x, k) => (
                      <li key={k} className="flex gap-2 text-sm text-mute">
                        <span className="text-brand">→</span>
                        <span className="selectable">{x}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              {a.chart && a.rows.length > 1 && (
                <Card className="p-4">
                  <Chart rows={a.rows} {...a.chart} />
                </Card>
              )}
              <Card>
                <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-mute">
                  <span>
                    {a.rows.length} rows · {a.citations.join(" · ")}
                  </span>
                  <button className="hover:text-white" onClick={() => setShowPipe(!showPipe)}>
                    {showPipe ? "hide" : "show"} pipeline
                  </button>
                </div>
                {showPipe && <pre className="selectable max-h-64 overflow-auto border-b border-line bg-black/30 p-3 font-mono text-[11px] text-mute">{JSON.stringify(a.pipeline, null, 2)}</pre>}
                <Table rows={a.rows} />
              </Card>
              <div className="flex items-center gap-2">
                {!fixing ? (
                  <>
                    <Button variant="ghost" className="text-xs" onClick={() => setFixing(true)}>
                      ✎ Not quite? Teach Harry
                    </Button>
                    {turn.corrected && <span className="text-xs text-brand-2">Learned: {turn.corrected}</span>}
                  </>
                ) : (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      onCorrect(fix);
                      setFixing(false);
                      setFix("");
                    }}
                  >
                    <input
                      autoFocus
                      value={fix}
                      onChange={(e) => setFix(e.target.value)}
                      placeholder='e.g. "stalled means no activity for 14+ days, not stage changes"'
                      className="flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <Button disabled={!fix.trim()}>Teach & re-ask</Button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
        <Trace steps={turn.steps} answer={a} onFollow={onFollow} />
      </div>
    </div>
  );
}

function Trace({ steps, answer }: { steps: Step[]; answer?: Answer; onFollow: (q: string) => void }) {
  return (
    <Card className="h-fit p-4">
      <div className="mb-3 text-[11px] font-medium tracking-wide text-mute uppercase">Trace</div>
      <ol className="space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5 text-xs">
            <span
              className={cx(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]",
                s.status === "ok" && "bg-brand/20 text-brand-2",
                s.status === "fail" && "bg-red-500/20 text-red-300",
                s.status === "learn" && "bg-amber-400/20 text-amber-300",
                s.status === "run" && "text-brand",
              )}
            >
              {s.status === "run" ? <Spinner className="h-3 w-3" /> : s.status === "ok" ? "✓" : s.status === "fail" ? "✕" : "★"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-2">
                <span className={s.status === "learn" ? "text-amber-200" : ""}>{s.label}</span>
                {s.ms != null && <span className="font-mono text-mute">{(s.ms / 1000).toFixed(1)}s</span>}
              </div>
              {s.detail && <div className="selectable mt-0.5 break-words text-mute">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      {answer && (
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-3">
          <Pill>{(answer.ms / 1000).toFixed(1)}s</Pill>
          <Pill>{answer.tokens.toLocaleString()} tok</Pill>
          <Pill>{answer.model}</Pill>
          {answer.learned.length > 0 && <Pill tone="warn">+{answer.learned.length} lesson</Pill>}
        </div>
      )}
    </Card>
  );
}
