import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { analyzeCall, Call, importCall, matchDeal, suggestDeals } from "../lib/calls";
import { SourceSet } from "../lib/sources";
import { store } from "../lib/store";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";

type Doc = Record<string, unknown>;

export default function Calls({ src, onChange }: { src: SourceSet; onChange: () => void }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [insights, setInsights] = useState<Doc[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    const [c, i] = await Promise.all([store.list<Call>("calls"), store.list<Doc>("insights")]);
    setCalls(c.sort((a, b) => b.importedAt.localeCompare(a.importedAt)));
    setInsights(i.filter((x) => x.kind === "call_rule"));
  };
  useEffect(() => {
    load();
  }, []);

  const ingest = async (paths: string[], dropped: boolean) => {
    setErr("");
    setNote("");
    for (const p of paths) {
      setBusy("import");
      try {
        const { call, duplicate } = await importCall(p, dropped, consent);
        setNote(duplicate ? `${call.file} was already imported (same file hash). Nothing changed.` : `Imported ${call.file}: ${call.turns.length} turns`);
        setSel(call._id);
      } catch (e) {
        setErr(errText(e));
      }
    }
    setBusy("");
    load();
  };

  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "over" || e.payload.type === "enter") setHover(true);
      else if (e.payload.type === "leave") setHover(false);
      else if (e.payload.type === "drop") {
        setHover(false);
        ingest(e.payload.paths, true);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [consent]);

  const call = calls.find((c) => c._id === sel) ?? null;

  return (
    <div className="relative grid h-full grid-cols-[320px_1fr] overflow-hidden">
      {hover && (
        <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand bg-brand/10 text-xl text-brand-2">
          {consent ? "Drop the transcript" : "Tick the recording-consent box first"}
        </div>
      )}
      <div className="flex flex-col overflow-hidden border-r border-line">
        <div className="space-y-3 border-b border-line p-5">
          <div className="text-sm font-medium">Call transcripts</div>
          <div className="text-xs text-mute">Drop exports from Meet (.docx/.txt), Zoom (.vtt), Teams, Otter, Fireflies, Fathom, or Gong (.json).</div>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            Participants were told this call was recorded
          </label>
          <Button
            variant="outline"
            className="w-full"
            disabled={!consent || !!busy}
            onClick={async () => {
              const f = await open({ multiple: true, filters: [{ name: "Transcripts", extensions: ["txt", "vtt", "srt", "docx", "json"] }] });
              if (f) ingest(Array.isArray(f) ? f : [f], true);
            }}
          >
            {busy === "import" ? <Spinner /> : "+"} Import transcript
          </Button>
          {note && <div className="text-xs text-brand-2">{note}</div>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {calls.map((c) => (
            <button key={c._id} onClick={() => setSel(c._id)} className={cx("block w-full border-b border-line/60 px-5 py-3 text-left", sel === c._id ? "bg-brand/10" : "hover:bg-white/[0.03]")}>
              <div className="truncate text-sm">{c.dealName ?? c.file}</div>
              <div className="mt-1 flex gap-1.5">
                <Pill>{c.format}</Pill>
                <Pill tone={c.status === "analyzed" ? "brand" : "mute"}>{c.status}</Pill>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-y-auto p-8">
        <ErrorBox>{err}</ErrorBox>
        {!call && (
          <div className="flex h-full flex-col items-center justify-center text-center text-mute">
            <div className="text-5xl">🎧</div>
            <div className="mt-3 text-lg text-white">Drag a call transcript onto Harry</div>
            <div className="mt-1 max-w-md text-sm">He matches the deal, scores the call against your checklist with quotes, drafts the follow-up, and turns great objection handling into a playbook rule.</div>
            <div className="mt-3 text-xs">Samples: <span className="selectable font-mono">harry/demo-crm/calls/</span></div>
          </div>
        )}
        {call && <CallView key={call._id} call={call} src={src} insight={insights.find((i) => i.callId === call._id)} busy={busy} setBusy={setBusy} setErr={setErr} reload={async () => { await load(); onChange(); }} />}
      </div>
    </div>
  );
}

function CallView({ call, src, insight, busy, setBusy, setErr, reload }: { call: Call; src: SourceSet; insight?: Doc; busy: string; setBusy: (s: string) => void; setErr: (s: string) => void; reload: () => Promise<void> }) {
  const suggestions = suggestDeals(call, src);
  const speakers = [...new Set(call.turns.map((t) => t.speaker))];
  const reps = ((src.local.get("crm.reps") ?? []) as Doc[]).map((r) => String(r.name));
  const [rep, setRep] = useState(call.repName ?? speakers.find((s) => reps.includes(s)) ?? speakers[0]);
  const buyer = call.buyerName ?? speakers.find((s) => s !== rep) ?? "";
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
      await reload();
    }
  };

  return (
    <div className="rise mx-auto max-w-4xl space-y-4">
      <div>
        <div className="text-xs text-mute">{call.file}</div>
        <h2 className="text-2xl font-semibold">{call.dealName ?? "Which deal is this?"}</h2>
      </div>

      {!call.dealId && (
        <Card className="p-5">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-mute">Rep on the call:</span>
            <select value={rep} onChange={(e) => setRep(e.target.value)} className="rounded-md border border-line bg-black/30 px-2 py-1">
              {speakers.map((s) => <option key={s}>{s}</option>)}
            </select>
            {!reps.includes(rep) && <Pill tone="warn">not on the rep roster, please confirm</Pill>}
          </div>
          <div className="mt-4 space-y-2">
            {suggestions.length === 0 && <div className="text-sm text-mute">No matching deal found.</div>}
            {suggestions.map((s) => (
              <div key={String(s.deal._id)} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                <div>
                  <div className="text-sm">{String(s.deal.name)}</div>
                  <div className="text-xs text-mute">matched on {s.why.join(", ")}</div>
                </div>
                <Button className="py-1.5 text-xs" disabled={!!busy} onClick={() => act("match", async () => {
                  await matchDeal(call, s.deal, rep, buyer);
                  await analyzeCall(call, src);
                })}>
                  {busy === "match" ? <Spinner /> : "This one"}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {call.dealId && call.status !== "analyzed" && (
        <Button disabled={!!busy} onClick={() => act("analyze", () => analyzeCall(call, src))}>{busy === "analyze" ? <Spinner /> : null} Analyze call</Button>
      )}

      {call.status === "analyzed" && (
        <>
          <Card className="p-5">
            <p className="selectable">{call.summary}</p>
            {call.objections?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{call.objections.map((o) => <Pill key={o} tone="warn">{o}</Pill>)}</div> : null}
          </Card>
          <div className="grid grid-cols-2 gap-4">
            <Card className="p-5">
              <div className="mb-3 text-[11px] font-medium tracking-wide text-mute uppercase">Scorecard · {call.repName}</div>
              <div className="space-y-3">
                {call.score?.map((s) => (
                  <div key={s.item} className="text-sm">
                    <div className="flex items-center gap-2"><span className={s.met ? "text-brand" : "text-red-300"}>{s.met ? "✓" : "✕"}</span>{s.item}</div>
                    {s.quote && <div className="selectable mt-1 ml-5 border-l-2 border-line pl-2 text-xs text-mute italic">“{s.quote}”</div>}
                    <div className="mt-0.5 ml-5 text-xs text-mute">{s.note}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-[11px] text-mute">Visible to the rep and their manager only. Coaching, not ranking.</div>
            </Card>
            <div className="space-y-4">
              <Card className="p-5">
                <div className="mb-2 text-[11px] font-medium tracking-wide text-mute uppercase">Coaching</div>
                <ul className="space-y-2 text-sm">{call.coaching?.map((c, i) => <li key={i} className="selectable">• {c}</li>)}</ul>
              </Card>
              <Card className="p-5">
                <div className="mb-2 text-[11px] font-medium tracking-wide text-mute uppercase">Brief for the next call</div>
                <ul className="selectable space-y-1 text-sm">{call.brief?.questions.map((q, i) => <li key={i}>? {q}</li>)}</ul>
              </Card>
            </div>
          </div>
          {insight && (
            <Card className="border-amber-400/40 bg-amber-400/5 p-5">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-medium tracking-wide text-amber-300 uppercase">Proposed playbook rule · from {String(insight.rep)}</div>
                <Pill tone={insight.status === "approved" ? "brand" : insight.status === "rejected" ? "bad" : "warn"}>{String(insight.status)}</Pill>
              </div>
              <div className="selectable mt-2 font-medium">{String(insight.rule)}</div>
              <div className="selectable mt-2 border-l-2 border-amber-400/40 pl-2 text-sm text-mute italic">“{String(insight.quote)}”</div>
              {insight.status === "proposed" && (
                <div className="mt-3 flex gap-2">
                  <Button onClick={() => act("ins", () => store.upsert("insights", { _id: String(insight._id), status: "approved", approvedAt: new Date().toISOString() }))}>Approve for testing</Button>
                  <Button variant="ghost" onClick={() => act("ins", () => store.upsert("insights", { _id: String(insight._id), status: "rejected" }))}>Dismiss</Button>
                </div>
              )}
              {insight.status === "approved" && <div className="mt-2 text-xs text-mute">Queued. It ships only if it beats the current playbook on held-out buyers (Improve tab).</div>}
            </Card>
          )}
          <div className="text-sm text-brand-2">A follow-up recapping this call is waiting in the Pipeline outbox.</div>
        </>
      )}

      <Card className="p-5">
        <div className="mb-2 text-[11px] font-medium tracking-wide text-mute uppercase">Transcript</div>
        <div className="selectable max-h-96 space-y-2 overflow-y-auto text-sm">
          {call.turns.map((t, i) => (
            <div key={i}><span className="font-mono text-xs text-mute">{t.start}</span> <span className={t.speaker === (call.repName ?? rep) ? "text-brand-2" : "text-white"}>{t.speaker}:</span> {t.text}</div>
          ))}
        </div>
      </Card>
    </div>
  );
}
