import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Check, ChevronRight, CircleDashed, Inbox, Mail, MailCheck, Play, RefreshCw, RotateCcw, ShieldCheck, Square, X } from "lucide-react";
import { api } from "../lib/api";
import { approve, continueRun, OutboxItem, Run, startRun, unfinishedRun } from "../lib/followup";
import { Pipeline as P } from "../lib/pipeline";
import { SourceSet } from "../lib/sources";
import { getSettings, saveSettings, Settings, store } from "../lib/store";
import { go as nav } from "../lib/nav";
import { Button, cx, EmptyState, errText, Pill, SectionLabel, Spinner } from "../components/ui";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type Doc = Record<string, unknown>;

export default function Pipeline({ src, pipeline, onChange }: { src: SourceSet; pipeline: P; onChange: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [interactions, setInteractions] = useState<Doc[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    const [o, i, s, r] = await Promise.all([store.list<OutboxItem>("outbox"), store.list<Doc>("interactions"), getSettings(), unfinishedRun()]);
    const order = { draft: 0, approved: 1, sending: 1, sent: 2, skipped: 3 } as const;
    o.sort((a, b) => order[a.status] - order[b.status] || b.createdAt.localeCompare(a.createdAt));
    setOutbox(o);
    setInteractions(i);
    setSettings(s);
    setRun((cur) => (cur && cur.status === "running" ? cur : r ?? cur));
    setSel((cur) => cur ?? o.find((x) => x.status === "draft")?._id ?? o[0]?._id ?? null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
      await load();
      onChange();
    }
  };

  const drive = async (r: Run) => {
    stopRef.current = false;
    setStopping(false);
    await continueRun(r, src, pipeline, (x) => {
      setRun(x);
      load();
    }, () => stopRef.current);
    setStopping(false);
  };

  const running = busy === "run";
  const drafts = outbox.filter((o) => o.status === "draft");
  const item = outbox.find((o) => o._id === sel) ?? null;
  const unfinished = run && run.status !== "done" && !running;

  // Approve the current item, then jump to the next draft.
  const nextDraft = (id: string) => drafts.find((d) => d._id !== id)?._id ?? id;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-8 pt-10 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{pipeline.name}</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {drafts.length ? `${drafts.length} follow-up${drafts.length > 1 ? "s" : ""} waiting for you` : running ? "Harry is drafting follow-ups…" : "Follow-ups"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {settings && <RulesDialog settings={settings} onSave={async (p) => { await saveSettings(p); await load(); }} />}
            <Button variant="outline" disabled={!!busy} onClick={() => act("replies", async () => { const r = await api.fetchReplies(); toast.message(r.length ? `${r.length} new repl${r.length > 1 ? "ies" : "y"}` : "No new replies"); })}>
              {busy === "replies" ? <Spinner /> : <RefreshCw />} Check replies
            </Button>
            {running ? (
              <Button variant="danger" disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); }}>
                <Square /> {stopping ? "Stopping…" : "Stop"}
              </Button>
            ) : unfinished ? (
              <Button onClick={() => act("run", async () => { run!.resumedCount++; await drive(run!); }, "Resumed from checkpoint. Finished deals were skipped.")}>
                <RotateCcw /> Resume run
              </Button>
            ) : (
              <Button onClick={() => act("run", async () => drive(await startRun(src, pipeline, 6)))}>
                <Play /> Draft follow-ups
              </Button>
            )}
          </div>
        </div>

        {/* Funnel strip */}
        <div className="mt-5 flex items-stretch gap-1.5">
          {pipeline.stages.map((s, i) => {
            const n = outbox.filter((o) => o.stage === s.id && o.status !== "sent").length;
            const sent = outbox.filter((o) => o.stage === s.id && o.status === "sent").length;
            return (
              <div key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5">
                <div className={cx("min-w-0 flex-1 rounded-lg border px-3 py-2", s.owner === "human" ? "border-dashed bg-transparent" : "bg-card")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {s.owner === "human" ? <span className="text-[11px] text-muted-foreground">you</span> : n > 0 && <Pill tone="warn">{n}</Pill>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{s.owner === "human" ? "Rep-led · Harry coaches" : `${sent} sent`}</div>
                </div>
                {i < pipeline.stages.length - 1 && <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />}
              </div>
            );
          })}
        </div>

        {run && (running || unfinished) && (
          <div className="mt-4 flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5 text-sm">
            {running ? <Spinner className="text-primary" /> : <RotateCcw className="size-4 text-amber-300" />}
            <span className="min-w-0 flex-1 truncate">
              {running ? `Drafting for ${run.steps.find((s) => s.status === "pending")?.deal ?? "…"}` : `Run paused after ${run.steps.filter((s) => s.status !== "pending").length} of ${run.steps.length} deals. Resume picks up where it stopped.`}
            </span>
            <Progress value={(run.steps.filter((s) => s.status !== "pending").length / run.steps.length) * 100} className="h-1.5 w-40" />
          </div>
        )}
      </div>

      {/* Body */}
      {outbox.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {running && run ? (
            <div className="mx-auto max-w-lg space-y-2 py-16">
              {run.steps.map((s) => (
                <div key={s.dealId} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
                  {s.status === "done" ? <Check className="size-4 text-primary" /> : s.status === "failed" ? <X className="size-4 text-destructive" /> : s === run.steps.find((x) => x.status === "pending") ? <Spinner className="text-primary" /> : <CircleDashed className="size-4 text-muted-foreground" />}
                  <span className="flex-1">{s.deal}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-24">
              <EmptyState icon={<Inbox />} title="Nothing to review yet" action={
                <div className="flex gap-2">
                  <Button onClick={() => act("run", async () => drive(await startRun(src, pipeline, 6)))}><Play /> Draft follow-ups</Button>
                  <Button variant="ghost" onClick={() => nav("calls")}>Start from a call</Button>
                </div>
              }>
                Harry picks your top open deals, writes the next message for each, and puts them here. You approve before anything is sent.
              </EmptyState>
            </div>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r">
            {(["draft", "approved", "sent"] as const).map((group) => {
              const list = outbox.filter((o) => (group === "approved" ? o.status === "approved" || o.status === "sending" : o.status === group));
              if (!list.length) return null;
              return (
                <div key={group}>
                  <div className="sticky top-0 z-[1] border-b bg-background/95 px-5 py-2 backdrop-blur">
                    <SectionLabel>{group === "draft" ? "Needs your review" : group === "approved" ? "Approved, ready to send" : "Sent"} · {list.length}</SectionLabel>
                  </div>
                  {list.map((o) => {
                    const replied = interactions.some((i) => i.outboxId === o._id);
                    return (
                      <button key={o._id} onClick={() => setSel(o._id)} className={cx("relative block w-full border-b px-5 py-3 text-left transition-colors", sel === o._id ? "bg-accent" : "hover:bg-accent/40")}>
                        {sel === o._id && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{o.contactName}</span>
                          {replied ? <Pill tone="brand">replied</Pill> : <span className="text-xs text-muted-foreground">{o.company}</span>}
                        </div>
                        <div className="mt-0.5 truncate text-sm text-muted-foreground">{o.subject}</div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {item ? (
            <Message key={item._id + item.status} item={item} busy={busy} settings={settings} interactions={interactions} stage={pipeline.stages.find((s) => s.id === item.stage)?.name ?? item.stage}
              onApprove={(it) => act("approve", async () => { await approve(it); setSel(nextDraft(it._id)); }, "Approved and locked")}
              onSend={(id) => act("send", () => api.outboxSend(id), "Sent from your mailbox")} />
          ) : <div />}
        </div>
      )}
    </div>
  );
}

function RulesDialog({ settings, onSave }: { settings: Settings; onSave: (p: Partial<Settings>) => Promise<void> }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost"><ShieldCheck /> Send rules</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send rules</DialogTitle>
          <DialogDescription>Checked in code right before every send. The model can't override them.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {[
            ["demoMode", "Demo mode", "Only send to the allowlist below"],
            ["businessHours", "Business hours only", "8am–6pm on weekdays, in the contact's timezone"],
          ].map(([k, l, d]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <div><Label>{l}</Label><div className="text-xs text-muted-foreground">{d}</div></div>
              <Switch checked={settings[k as "demoMode"]} onCheckedChange={(v) => onSave({ [k]: v })} />
            </div>
          ))}
          <div className="space-y-1.5">
            <Label className="text-xs">Allowlist (your own inboxes, comma-separated)</Label>
            <Input defaultValue={settings.allowlist.join(", ")} onBlur={(e) => onSave({ allowlist: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="you@company.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Send demo drafts to</Label>
            <Input defaultValue={settings.recipientOverride ?? ""} onBlur={(e) => onSave({ recipientOverride: e.target.value.trim() })} placeholder="teammate@company.com" />
            <div className="text-xs text-muted-foreground">Contacts with placeholder addresses get drafts sent here instead.</div>
          </div>
          <div className="flex flex-wrap gap-1.5 border-t pt-4">
            {[`Max ${settings.perContactPerWeek} per contact / week`, `Max ${settings.perMailboxPerDay} per day`, "No prices or discounts", "Unsubscribes honored", "Never changes deal stages"].map((r) => <Pill key={r}>{r}</Pill>)}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function checks(item: OutboxItem, settings: Settings | null) {
  const to = item.to.trim().toLowerCase();
  return [
    { label: "Real address", ok: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) && !to.endsWith("example.com"), fix: "This contact has a placeholder address. Set “Send demo drafts to” in Send rules, or edit the To field." },
    { label: "Allowed recipient", ok: !settings?.demoMode || settings.allowlist.some((a) => a.toLowerCase() === to), fix: "Demo mode is on. Add this address to the allowlist in Send rules." },
    { label: "No prices or discounts", ok: !/(\$\s?\d|\d+\s?% off|\bdiscount|\bfree month|\bpromo code)/i.test(item.body), fix: "Remove the price or discount from the message." },
  ];
}

function Message({ item, busy, settings, interactions, stage, onApprove, onSend }: { item: OutboxItem; busy: string; settings: Settings | null; interactions: Doc[]; stage: string; onApprove: (i: OutboxItem) => void; onSend: (id: string) => void }) {
  const [draft, setDraft] = useState(item);
  const editable = item.status === "draft";
  const edited = draft.body !== item.original.body || draft.subject !== item.original.subject;
  const replies = interactions.filter((i) => i.outboxId === item._id);
  const list = checks(draft, settings);
  const failing = list.filter((c) => !c.ok);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 px-8 py-6">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{item.contactName}</span>
            <span className="text-muted-foreground">at {item.company}</span>
            <span className="text-muted-foreground">·</span>
            <Pill>{stage}</Pill>
          </div>

          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="divide-y text-sm">
              <label className="flex items-center gap-3 px-4 py-2">
                <span className="w-14 text-xs text-muted-foreground">To</span>
                <input disabled={!editable} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="flex-1 bg-transparent outline-none disabled:opacity-80" />
              </label>
              <label className="flex items-center gap-3 px-4 py-2">
                <span className="w-14 text-xs text-muted-foreground">Subject</span>
                <input disabled={!editable} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} className="flex-1 bg-transparent font-medium outline-none disabled:opacity-80" />
              </label>
            </div>
            <Textarea disabled={!editable} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="field-sizing-content min-h-64 resize-none rounded-none border-0 border-t bg-transparent px-4 py-3 leading-relaxed focus-visible:ring-0 disabled:opacity-90" />
          </div>

          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Why this message: </span>{item.reasoning}
            {edited && editable && <div className="mt-1 text-xs text-brand-2">Your edits will teach Harry's playbook reviewer.</div>}
          </div>

          {replies.map((r) => (
            <div key={String(r._id)} className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-brand-2"><MailCheck className="size-3.5" /> {item.contactName} replied · {String(r.outcome).replace("_", " ")}</div>
              <div className="selectable whitespace-pre-wrap">{String(r.text).slice(0, 800)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t bg-card/60 px-8 py-4">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          {item.status === "draft" && (
            <>
              <div className="min-w-0 flex-1 text-xs">
                {failing.length ? (
                  <span className="text-amber-300">{failing[0].fix}</span>
                ) : (
                  <span className="flex items-center gap-1.5 text-muted-foreground"><ShieldCheck className="size-3.5 text-primary" /> Passes send rules. Caps and timing are rechecked at send.</span>
                )}
              </div>
              <Button disabled={!!busy || failing.length > 0} onClick={() => onApprove(draft)}>
                {busy === "approve" ? <Spinner /> : <Check />} Approve{edited ? " with edits" : ""} <ArrowRight />
              </Button>
            </>
          )}
          {(item.status === "approved" || item.status === "sending") && (
            <>
              <div className="flex-1 text-xs text-muted-foreground">Approved. The content is locked; changing it needs a new approval.</div>
              <Button disabled={!!busy} onClick={() => onSend(item._id)}>{busy === "send" ? <Spinner /> : <Mail />} {item.status === "sending" ? "Retry safely" : "Send now"}</Button>
            </>
          )}
          {item.status === "sent" && <div className="flex items-center gap-2 text-sm text-muted-foreground"><MailCheck className="size-4 text-primary" /> Sent {item.sentAt ? new Date(item.sentAt).toLocaleString() : ""}</div>}
        </div>
      </div>
    </div>
  );
}
