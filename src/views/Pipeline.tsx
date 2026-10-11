import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { approve, continueRun, OutboxItem, Run, startRun, unfinishedRun } from "../lib/followup";
import { Pipeline as P } from "../lib/pipeline";
import { SourceSet } from "../lib/sources";
import { getSettings, saveSettings, Settings, store } from "../lib/store";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";

type Doc = Record<string, unknown>;

export default function Pipeline({ src, pipeline, onChange }: { src: SourceSet; pipeline: P; onChange: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [interactions, setInteractions] = useState<Doc[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [killed, setKilled] = useState(false);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    const [o, i, s, r] = await Promise.all([store.list<OutboxItem>("outbox"), store.list<Doc>("interactions"), getSettings(), unfinishedRun()]);
    setOutbox(o.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setInteractions(i);
    setSettings(s);
    setRun((cur) => (cur && cur.status === "running" && !killed ? cur : r ?? cur));
  }, [killed]);

  useEffect(() => {
    load();
  }, [load]);

  const go = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
      await load();
      onChange();
    }
  };

  const drive = async (r: Run) => {
    stopRef.current = false;
    setKilled(false);
    await continueRun(r, src, pipeline, (x) => {
      setRun(x);
      store.list<OutboxItem>("outbox").then((o) => setOutbox(o.sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
    }, () => stopRef.current);
  };

  const kill = () => {
    stopRef.current = true;
    setKilled(true);
  };

  const funnel = pipeline.stages.map((s) => {
    const sent = outbox.filter((o) => o.stage === s.id && o.status === "sent");
    const won = sent.filter((o) => interactions.some((i) => i.outboxId === o._id && ["reply", "meeting_request"].includes(String(i.outcome))));
    return { stage: s, drafts: outbox.filter((o) => o.stage === s.id && o.status === "draft").length, sent: sent.length, won: won.length };
  });

  const item = outbox.find((o) => o._id === sel) ?? null;

  return (
    <div className="grid h-full grid-cols-[1fr_440px] overflow-hidden">
      <div className="overflow-y-auto px-8 pt-8 pb-10">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-xs tracking-wide text-mute uppercase">{pipeline.name} pipeline</div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Harry is working your deals</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!!busy} onClick={() => go("replies", api.fetchReplies)}>
              {busy === "replies" ? <Spinner /> : "↻"} Check replies
            </Button>
            {run?.status === "running" && !killed ? (
              <Button variant="danger" onClick={kill}>
                ■ Kill mid-run
              </Button>
            ) : run && run.status !== "done" ? (
              <Button onClick={() => go("run", async () => { run.resumedCount++; await drive(run); })}>{busy === "run" ? <Spinner /> : "▶"} Resume from checkpoint</Button>
            ) : (
              <Button disabled={!!busy} onClick={() => go("run", async () => drive(await startRun(src, pipeline, 6)))}>
                {busy === "run" ? <Spinner /> : "▶"} Run follow-ups
              </Button>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-3" style={{ gridTemplateColumns: `repeat(${pipeline.stages.length}, minmax(0, 1fr))` }}>
          {funnel.map(({ stage, drafts, sent, won }) => (
            <Card key={stage.id} className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{stage.name}</span>
                <Pill tone={stage.owner === "agent" ? "brand" : stage.owner === "human" ? "mute" : "warn"}>{stage.owner.replace("_", "-")}</Pill>
              </div>
              <div className="mt-1 text-xs text-mute">{stage.goal}</div>
              {stage.owner !== "human" ? (
                <div className="mt-3 flex gap-4 text-xs">
                  <div><span className="text-lg font-semibold text-white tabular-nums">{drafts}</span> drafts</div>
                  <div><span className="text-lg font-semibold text-white tabular-nums">{sent}</span> sent</div>
                  <div><span className="text-lg font-semibold text-brand-2 tabular-nums">{won}</span> replies</div>
                </div>
              ) : (
                <div className="mt-3 text-xs text-mute">Rep-owned. Harry briefs and scores calls.</div>
              )}
            </Card>
          ))}
        </div>

        {run && (
          <Card className="mt-6 p-5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                Run <span className="font-mono text-mute">{run._id.slice(-8)}</span>
                {run.resumedCount > 0 && <Pill tone="warn">resumed {run.resumedCount}×</Pill>}
              </div>
              <Pill tone={run.status === "done" ? "brand" : run.status === "paused" ? "warn" : "mute"}>{killed && run.status === "running" ? "stopping after this step…" : run.status}</Pill>
            </div>
            <div className="mt-3 space-y-1.5">
              {run.steps.map((s) => (
                <div key={s.dealId} className="flex items-center gap-3 text-sm">
                  <span className={cx("w-4 text-center", s.status === "done" && "text-brand", s.status === "failed" && "text-red-300", s.status === "pending" && "text-mute")}>
                    {s.status === "done" ? "✓" : s.status === "failed" ? "✕" : s.status === "skipped" ? "–" : "○"}
                  </span>
                  <span className="flex-1">{s.deal}</span>
                  {s.note && <span className="text-xs text-mute">{s.note}</span>}
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-mute">Every step is checkpointed. Kill the run (or quit the app) and resume: finished deals are skipped and nothing is drafted or sent twice.</div>
          </Card>
        )}

        {settings && (
          <Card className="mt-6 p-5">
            <div className="text-sm font-medium">Send safety</div>
            <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={settings.demoMode} onChange={async (e) => { await saveSettings({ demoMode: e.target.checked }); load(); }} /> Demo mode (allowlist only)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={settings.businessHours} onChange={async (e) => { await saveSettings({ businessHours: e.target.checked }); load(); }} /> Business hours in contact's timezone
              </label>
              <div>
                <div className="text-xs text-mute">Allowlist (your own inboxes)</div>
                <input
                  defaultValue={settings.allowlist.join(", ")}
                  onBlur={async (e) => { await saveSettings({ allowlist: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); load(); }}
                  placeholder="you@company.com, teammate@company.com"
                  className="mt-1 w-full rounded-lg border border-line bg-black/30 px-3 py-1.5 text-xs outline-none focus:border-brand"
                />
              </div>
              <div>
                <div className="text-xs text-mute">Send demo drafts to (overrides placeholder contact emails)</div>
                <input
                  defaultValue={settings.recipientOverride ?? ""}
                  onBlur={async (e) => { await saveSettings({ recipientOverride: e.target.value.trim() }); load(); }}
                  placeholder="teammate@company.com"
                  className="mt-1 w-full rounded-lg border border-line bg-black/30 px-3 py-1.5 text-xs outline-none focus:border-brand"
                />
              </div>
              <div className="col-span-2 text-xs text-mute">
                Caps: {settings.perContactPerWeek} per contact / week, {settings.perMailboxPerDay} per mailbox / day. No prices or discounts. Opt-outs always honored. Enforced in Rust right before every Composio call.
              </div>
            </div>
          </Card>
        )}
        <div className="mt-4"><ErrorBox>{err}</ErrorBox></div>
      </div>

      <div className="flex flex-col overflow-hidden border-l border-line">
        <div className="border-b border-line px-5 py-4">
          <div className="text-sm font-medium">Outbox</div>
          <div className="text-xs text-mute">Nothing leaves Harry until you approve it.</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {outbox.length === 0 && <div className="p-5 text-sm text-mute">Run follow-ups to fill the outbox.</div>}
          {outbox.map((o) => (
            <button key={o._id} onClick={() => setSel(o._id)} className={cx("block w-full border-b border-line/60 px-5 py-3 text-left", sel === o._id ? "bg-brand/10" : "hover:bg-white/[0.03]")}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{o.contactName} · {o.company}</span>
                <Pill tone={o.status === "sent" ? "brand" : o.status === "draft" ? "mute" : "warn"}>{o.status}</Pill>
              </div>
              <div className="mt-0.5 truncate text-xs text-mute">{o.subject}</div>
              <div className="mt-1 flex gap-1.5">
                <Pill>{o.stage}</Pill>
                <Pill>{o.variant}</Pill>
                {interactions.some((i) => i.outboxId === o._id) && <Pill tone="brand">replied</Pill>}
              </div>
            </button>
          ))}
        </div>
        {item && <OutboxEditor key={item._id + item.status} item={item} busy={busy} onSend={(id) => go("send", () => api.outboxSend(id))} onApprove={(it) => go("approve", () => approve(it))} interactions={interactions} />}
      </div>
    </div>
  );
}

function OutboxEditor({ item, busy, onApprove, onSend, interactions }: { item: OutboxItem; busy: string; onApprove: (i: OutboxItem) => void; onSend: (id: string) => void; interactions: Doc[] }) {
  const [draft, setDraft] = useState(item);
  const editable = item.status === "draft";
  const replies = interactions.filter((i) => i.outboxId === item._id);
  return (
    <div className="max-h-[60%] overflow-y-auto border-t border-line bg-panel p-5">
      <div className="space-y-2 text-sm">
        <input disabled={!editable} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="w-full rounded-md border border-line bg-black/30 px-2 py-1 text-xs outline-none focus:border-brand" />
        <input disabled={!editable} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} className="w-full rounded-md border border-line bg-black/30 px-2 py-1.5 font-medium outline-none focus:border-brand" />
        <textarea disabled={!editable} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={9} className="w-full resize-none rounded-md border border-line bg-black/30 px-2 py-1.5 leading-relaxed outline-none focus:border-brand" />
      </div>
      <div className="mt-2 text-xs text-mute">Why: {item.reasoning}</div>
      {draft.originalTo !== draft.to && <div className="mt-1 text-xs text-amber-300">CRM address {draft.originalTo} replaced for the demo</div>}
      <div className="mt-3 flex gap-2">
        {item.status === "draft" && <Button disabled={!!busy} onClick={() => onApprove(draft)}>{busy === "approve" ? <Spinner /> : "✓"} Approve</Button>}
        {(item.status === "approved" || item.status === "sending") && <Button disabled={!!busy} onClick={() => onSend(item._id)}>{busy === "send" ? <Spinner /> : "↗"} {item.status === "sending" ? "Retry safely" : "Send via Composio"}</Button>}
      </div>
      {replies.map((r) => (
        <div key={String(r._id)} className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3 text-sm">
          <div className="mb-1 text-xs text-brand-2">Reply · {String(r.outcome)}</div>
          <div className="selectable whitespace-pre-wrap">{String(r.text).slice(0, 600)}</div>
        </div>
      ))}
    </div>
  );
}
