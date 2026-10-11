import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, AudioLines, Check, Lightbulb, MessageSquareQuote, Plus, Trash2, Upload, X } from "lucide-react";
import { analyzeCall, Call, deleteCall, importCall, matchDeal, openDeals, suggestDeals } from "../lib/calls";
import { SourceSet } from "../lib/sources";
import { store } from "../lib/store";
import { go } from "../lib/nav";
import { Button, Card, cx, errText, Pill, SectionLabel, Spinner } from "../components/ui";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Doc = Record<string, unknown>;

export default function Calls({ src, onChange }: { src: SourceSet; onChange: () => void }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [insights, setInsights] = useState<Doc[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [consent, setConsent] = useState(false);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState<Call | null>(null);

  const load = async () => {
    const [c, i] = await Promise.all([store.list<Call>("calls"), store.list<Doc>("insights")]);
    setCalls(c.sort((a, b) => b.importedAt.localeCompare(a.importedAt)));
    setInsights(i.filter((x) => x.kind === "call_rule"));
  };
  useEffect(() => {
    load();
  }, []);

  const ingest = async (paths: string[], skipConsent = false) => {
    if (!consent && !skipConsent) return toast.error("Confirm that everyone was told the call was recorded.");
    setBusy("import");
    for (const p of paths) {
      try {
        const { call, duplicate } = await importCall(p, true, true);
        if (duplicate) toast.message(`${call.file} is already here`);
        setSel(call._id);
        setAdding(false);
      } catch (e) {
        toast.error(errText(e));
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
        ingest(e.payload.paths);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [consent]);

  const call = calls.find((c) => c._id === sel) ?? null;

  const remove = async (c: Call) => {
    setBusy("delete");
    try {
      await deleteCall(c._id);
      if (sel === c._id) setSel(null);
      toast.success(`Deleted ${c.file}`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
      setRemoving(null);
      await load();
      onChange();
    }
  };

  const confirmRemove = (
    <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this transcript?</DialogTitle>
          <DialogDescription>
            {removing?.file} and its scorecard will be removed, along with its unsent follow-up draft and any playbook rule you haven't approved. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy === "delete"} onClick={() => removing && remove(removing)}>{busy === "delete" ? <Spinner /> : <Trash2 />} Delete transcript</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const importer = (
    <div className="mx-auto max-w-xl py-16">
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border bg-card text-primary"><AudioLines className="size-5" /></div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Learn from a sales call</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Drop in a transcript. Harry matches the deal, scores the call with quotes, drafts the follow-up, and spots answers worth adding to the playbook.</p>
      </div>

      <label className="mt-8 flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
        Everyone on the call was told it was being recorded
      </label>

      <button
        disabled={!consent || !!busy}
        onClick={async () => {
          const f = await open({ multiple: true, filters: [{ name: "Transcripts", extensions: ["txt", "vtt", "srt", "docx", "json"] }] });
          if (f) ingest(Array.isArray(f) ? f : [f]);
        }}
        className={cx("mt-3 flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 transition-colors", consent ? "hover:border-primary/60 hover:bg-primary/5" : "opacity-50", hover && "border-primary bg-primary/10")}
      >
        {busy === "import" ? <Spinner className="size-6 text-primary" /> : <Upload className="size-6 text-muted-foreground" />}
        <div className="text-sm font-medium">{consent ? "Drop a transcript here, or click to choose" : "Tick the box above first"}</div>
        <div className="text-xs text-muted-foreground">Meet · Zoom · Teams · Otter · Fireflies · Fathom · Gong</div>
      </button>

    </div>
  );

  if (calls.length === 0) return <div className="h-full overflow-y-auto px-8">{importer}{confirmRemove}</div>;

  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-10 pb-3">
          <div className="text-sm font-medium">Calls</div>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(true); setSel(null); }}><Plus /> Add</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {calls.map((c) => (
            <div key={c._id} className={cx("group relative transition-colors", sel === c._id ? "bg-accent" : "hover:bg-accent/40")}>
              <button onClick={() => { setSel(c._id); setAdding(false); }} className="block w-full py-3 pr-10 pl-4 text-left">
                {sel === c._id && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
                <div className="truncate text-sm font-medium">{c.dealName?.split(" — ")[0] ?? c.file}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {c.status === "analyzed" ? <><Check className="size-3 text-primary" /> {c.score?.filter((s) => s.met).length}/{c.score?.length} on checklist</> : <span className="text-amber-300">Pick the deal</span>}
                </div>
              </button>
              <button
                aria-label={`Delete ${c.file}`}
                title="Delete transcript"
                disabled={!!busy}
                onClick={() => setRemoving(c)}
                className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto px-8">
        {adding || !call ? importer : <CallView key={call._id} call={call} src={src} insight={insights.find((i) => i.callId === call._id)} busy={busy} setBusy={setBusy} onDelete={() => setRemoving(call)} reload={async () => { await load(); onChange(); }} />}
      </div>
      {confirmRemove}
    </div>
  );
}

function CallView({ call, src, insight, busy, setBusy, onDelete, reload }: { call: Call; src: SourceSet; insight?: Doc; busy: string; setBusy: (s: string) => void; onDelete: () => void; reload: () => Promise<void> }) {
  const suggestions = suggestDeals(call, src);
  const others = openDeals(src).filter((d) => !suggestions.some((s) => s.deal._id === d._id));
  const [other, setOther] = useState("");
  const speakers = [...new Set(call.turns.map((t) => t.speaker))];
  const reps = ((src.local.get("crm.reps") ?? []) as Doc[]).map((r) => String(r.name));
  const rep = call.repName ?? speakers.find((s) => reps.includes(s)) ?? speakers[0];
  const buyer = call.buyerName ?? speakers.find((s) => s !== rep) ?? "";
  const act = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
      await reload();
    }
  };

  const link = (deal: Doc | null) => act("match", async () => { await matchDeal(call, deal, rep, buyer); await analyzeCall(call, src); }, "Call analyzed");

  if (!call.dealId && call.status !== "analyzed") {
    return (
      <div className="mx-auto max-w-xl py-14">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-xs text-muted-foreground">{call.file} · {call.turns.length} turns</div>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={onDelete}><Trash2 /> Delete</Button>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Which deal was this call about?</h1>
        <p className="mt-1 text-sm text-muted-foreground">{rep} talking with {buyer}. Harry ranked these from names and companies in the transcript.</p>
        <div className="mt-6 space-y-2">
          {suggestions.map((s, i) => (
            <button key={String(s.deal._id)} disabled={!!busy} onClick={() => link(s.deal)}
              className={cx("flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-primary/60", i === 0 && "border-primary/40")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">{String(s.deal.name)} {i === 0 && <Pill tone="brand">best match</Pill>}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Matched on {s.why.join(", ")}</div>
              </div>
              {busy === "match" ? <Spinner className="text-primary" /> : <ArrowRight className="size-4 text-muted-foreground" />}
            </button>
          ))}
          {suggestions.length === 0 && <div className="text-sm text-muted-foreground">No open deal in the CRM matches the names or companies in this transcript.</div>}
        </div>
        <div className="mt-6 space-y-3 rounded-xl border bg-card p-4">
          {others.length > 0 && (
            <div className="flex gap-2">
              <Select value={other} onValueChange={setOther} disabled={!!busy}>
                <SelectTrigger size="sm" className="min-w-0 flex-1"><SelectValue placeholder="Pick another open deal" /></SelectTrigger>
                <SelectContent>{others.map((d) => <SelectItem key={String(d._id)} value={String(d._id)}>{String(d.name)}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={!other || !!busy} onClick={() => link(others.find((d) => d._id === other) ?? null)}>Use this deal</Button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">Not in the CRM? Harry still scores the call and coaches the rep, but won't draft a follow-up.</div>
            <Button size="sm" variant="ghost" className="shrink-0" disabled={!!busy} onClick={() => link(null)}>Analyze without a deal</Button>
          </div>
        </div>
        {busy === "match" && <div className="mt-4 text-center text-sm text-muted-foreground">Reading the call, scoring it and drafting a follow-up…</div>}
      </div>
    );
  }

  if (call.status !== "analyzed") {
    return <div className="py-24 text-center"><Button disabled={!!busy} onClick={() => act("analyze", () => analyzeCall(call, src), "Call analyzed")}>{busy === "analyze" ? <Spinner /> : null} Analyze this call</Button></div>;
  }

  const met = call.score?.filter((s) => s.met).length ?? 0;
  const total = call.score?.length ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-10">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-xs text-muted-foreground">{call.repName} with {call.buyerName} · {call.file}</div>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={onDelete}><Trash2 /> Delete</Button>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{call.dealName ?? call.file}</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">{call.summary}</p>
        {call.objections?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{call.objections.map((o) => <Pill key={o} tone="warn">{o}</Pill>)}</div> : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {call.dealId ? (
          <Card className="flex flex-col p-4">
            <div className="text-sm font-medium">Follow-up email is drafted</div>
            <div className="mt-1 flex-1 text-xs text-muted-foreground">Written from what was actually said on the call.</div>
            <Button size="sm" variant="outline" className="mt-3 self-start" onClick={() => go("pipeline")}>Review it <ArrowRight /></Button>
          </Card>
        ) : (
          <Card className="p-4"><div className="text-sm font-medium">No follow-up drafted</div><div className="mt-1 text-xs text-muted-foreground">This call isn't linked to a CRM deal, so there's no contact to write to.</div></Card>
        )}
        {insight ? (
          <Card className={cx("flex flex-col p-4", insight.status === "proposed" && "border-amber-400/40 bg-amber-400/5")}>
            <div className="flex items-center gap-1.5 text-sm font-medium"><Lightbulb className="size-4 text-amber-300" /> {call.repName} found a winning answer</div>
            <div className="mt-1 flex-1 text-xs text-muted-foreground">{String(insight.rule)}</div>
            {insight.status === "proposed" ? (
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => act("ins", () => store.upsert("insights", { _id: String(insight._id), status: "approved", approvedAt: new Date().toISOString() }), "Rule approved for testing")}>Add to playbook</Button>
                <Button size="sm" variant="ghost" onClick={() => act("ins", () => store.upsert("insights", { _id: String(insight._id), status: "rejected" }))}>Dismiss</Button>
              </div>
            ) : insight.status === "approved" ? (
              <Button size="sm" variant="outline" className="mt-3 self-start" onClick={() => go("improve")}>Test it on buyers <ArrowRight /></Button>
            ) : <div className="mt-3 text-xs text-muted-foreground">Dismissed</div>}
          </Card>
        ) : (
          <Card className="p-4"><div className="text-sm font-medium">No new playbook rule</div><div className="mt-1 text-xs text-muted-foreground">Nothing stood out as a reusable answer on this call.</div></Card>
        )}
      </div>

      <Tabs defaultValue="score">
        <TabsList>
          <TabsTrigger value="score">Scorecard {met}/{total}</TabsTrigger>
          <TabsTrigger value="coach">Coaching</TabsTrigger>
          <TabsTrigger value="next">Next call</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
        </TabsList>
        <TabsContent value="score" className="mt-4 space-y-2">
          {call.score?.map((s) => (
            <Card key={s.item} className="p-4">
              <div className="flex items-center gap-2 text-sm font-medium">{s.met ? <Check className="size-4 text-primary" /> : <X className="size-4 text-destructive" />}{s.item}</div>
              <div className="mt-1 ml-6 text-sm text-muted-foreground">{s.note}</div>
              {s.quote && <div className="selectable mt-2 ml-6 flex gap-2 text-sm italic"><MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-primary/70" />“{s.quote}”</div>}
            </Card>
          ))}
          <div className="text-xs text-muted-foreground">Visible to the rep and their manager. Coaching, not ranking.</div>
        </TabsContent>
        <TabsContent value="coach" className="mt-4 space-y-2">
          {call.coaching?.map((c, i) => <Card key={i} className="selectable p-4 text-sm">{c}</Card>)}
        </TabsContent>
        <TabsContent value="next" className="mt-4">
          <Card className="p-5">
            <SectionLabel className="mb-3">Ask on the next call</SectionLabel>
            <ol className="selectable list-decimal space-y-2 pl-5 text-sm">{call.brief?.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            {call.brief?.cares_about.length ? <><SectionLabel className="mt-5 mb-2">They care about</SectionLabel><div className="flex flex-wrap gap-1.5">{call.brief.cares_about.map((c) => <Pill key={c}>{c}</Pill>)}</div></> : null}
          </Card>
        </TabsContent>
        <TabsContent value="transcript" className="mt-4">
          <Card className="selectable space-y-3 p-5 text-sm">
            {call.turns.map((t, i) => (
              <div key={i} className="grid grid-cols-[48px_1fr] gap-3">
                <span className="pt-0.5 font-mono text-xs text-muted-foreground">{t.start}</span>
                <div><div className={cx("text-xs font-medium", t.speaker === call.repName ? "text-brand-2" : "text-foreground")}>{t.speaker}</div><div className="mt-0.5 text-muted-foreground">{t.text}</div></div>
              </div>
            ))}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
