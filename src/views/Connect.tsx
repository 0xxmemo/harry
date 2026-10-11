import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ReactNode, useEffect, useState } from "react";
import { ArrowRight, Check, FileSpreadsheet, Lock, Sparkles } from "lucide-react";
import { guessMapping, readCsv, Target, TARGETS, toSources } from "../lib/crmImport";
import { SourceSet } from "../lib/sources";
import { api, AtlasCluster, AtlasProject } from "../lib/api";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MongoLeaf } from "./Setup";

const LABELS: Record<Target, string> = {
  deal: "Deal name", company: "Company", contact: "Contact name", email: "Contact email", amount: "Amount", stage: "Stage",
  owner: "Owner / rep", lastActivity: "Last activity", created: "Created", closed: "Close date", title: "Job title", industry: "Industry",
};
const REQUIRED: Target[] = ["company", "email", "stage"];

function Option({ icon, title, tag, desc, children, highlight }: { icon: ReactNode; title: string; tag?: ReactNode; desc: string; children: ReactNode; highlight?: boolean }) {
  return (
    <Card className={cx("rise flex flex-col p-6", highlight && "border-primary/40 bg-gradient-to-b from-primary/10 to-transparent")}>
      <div className="flex size-9 items-center justify-center rounded-lg border bg-background/60 text-muted-foreground [&_svg]:size-4">{icon}</div>
      <div className="mt-4 flex items-center gap-2 font-medium">{title} {tag}</div>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
      <div className="mt-5 flex flex-1 flex-col justify-end">{children}</div>
    </Card>
  );
}

export default function Connect({ atlasReady, onDemo, onConnected, onImported }: { atlasReady: boolean; onDemo: () => void; onConnected: (label: string) => Promise<void>; onImported: (s: SourceSet) => void }) {
  const [csv, setCsv] = useState<{ name: string; rows: Record<string, unknown>[]; columns: string[]; map: Partial<Record<Target, string>> } | null>(null);
  const [projects, setProjects] = useState<AtlasProject[] | null>(null);
  const [clusters, setClusters] = useState<AtlasCluster[] | null>(null);
  const [project, setProject] = useState("");
  const [cluster, setCluster] = useState("");
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!atlasReady) return;
    api.atlasProjects().then((p) => { setProjects(p); if (p.length === 1) setProject(p[0].id); }).catch((e) => setErr(errText(e)));
  }, [atlasReady]);

  useEffect(() => {
    if (!project) return;
    setClusters(null);
    setCluster("");
    api.atlasClusters(project).then((c) => { setClusters(c); if (c.length === 1) setCluster(c[0].name); }).catch((e) => setErr(errText(e)));
  }, [project]);

  const go = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr("");
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(""); }
  };

  if (csv) {
    const missing = REQUIRED.filter((t) => !csv.map[t]);
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-8 pt-14 pb-12">
          <div>
            <button onClick={() => setCsv(null)} className="text-xs text-muted-foreground hover:text-foreground">← Back</button>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Match your columns</h1>
            <p className="mt-1 text-sm text-muted-foreground">{csv.name} · {csv.rows.length} rows. Harry guessed the matches below; fix any that are wrong.</p>
          </div>
          <Card className="divide-y">
            {TARGETS.map((t) => (
              <div key={t} className="grid grid-cols-[180px_1fr_1fr] items-center gap-4 px-5 py-2.5">
                <div className="text-sm">{LABELS[t]} {REQUIRED.includes(t) && <span className="text-destructive">*</span>}</div>
                <Select value={csv.map[t] ?? "__none"} onValueChange={(v) => setCsv({ ...csv, map: { ...csv.map, [t]: v === "__none" ? undefined : v } })}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Not in this file</SelectItem>
                    {csv.columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="truncate text-xs text-muted-foreground">{csv.map[t] ? `e.g. ${String(csv.rows[0][csv.map[t]!] ?? "—")}` : ""}</div>
              </div>
            ))}
          </Card>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{missing.length ? `Still needed: ${missing.map((m) => LABELS[m]).join(", ")}` : "Ready to import"}</span>
            <Button disabled={missing.length > 0} onClick={() => onImported(toSources(csv.rows, csv.map, csv.name))}>Import {csv.rows.length} rows <ArrowRight /></Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 px-8 py-12">
        <div className="rise">
          <h1 className="text-3xl font-semibold tracking-tight">Meet Harry, <span className="text-brand-2">your best sales rep.</span></h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">Choose where your deals live. Harry reads them, drafts follow-ups for your approval, and never edits or deletes your records.</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Option highlight icon={<Sparkles />} title="Demo CRM" tag={<Pill tone="brand">start here</Pill>} desc="339 deals, 113 contacts and two recorded calls, deliberately messy. Every feature works with it.">
            <Button className="w-full" onClick={onDemo}>Open demo CRM <ArrowRight /></Button>
          </Option>

          <Option icon={<FileSpreadsheet />} title="Import a CRM export" desc="A CSV from HubSpot, Salesforce, Pipedrive or a spreadsheet. You'll match columns next.">
            <Button variant="outline" className="w-full" disabled={!!busy} onClick={() => go("csv", async () => {
              const f = await open({ filters: [{ name: "CSV", extensions: ["csv", "tsv"] }] });
              if (typeof f !== "string") return;
              const { rows, columns } = readCsv(await invoke<string>("read_picked", { path: f }));
              if (!rows.length) throw new Error("No rows found in that file");
              setCsv({ name: f.split("/").pop()!, rows, columns, map: guessMapping(columns) });
            })}>
              {busy === "csv" ? <Spinner /> : null} Choose CSV…
            </Button>
          </Option>

          <Option icon={<MongoLeaf />} title="Atlas cluster" tag={<Pill><Lock className="size-3" /> read-only</Pill>} desc="Ask questions about live data. Harry creates a temporary read-only user that Atlas deletes in 24h.">
            {!atlasReady ? (
              <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">Sign in to MongoDB in Setup to use this.</div>
            ) : (
              <div className="space-y-2">
                <Select value={project} onValueChange={setProject}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue placeholder={projects ? "Project" : "Loading projects…"} /></SelectTrigger>
                  <SelectContent>{projects?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={cluster} onValueChange={setCluster} disabled={!clusters?.length}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue placeholder={!project ? "Cluster" : clusters ? (clusters.length ? "Cluster" : "No clusters") : "Loading…"} /></SelectTrigger>
                  <SelectContent>{clusters?.map((c) => <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
                <Button className="w-full" variant="outline" disabled={!cluster || !!busy} onClick={() => go("atlas", async () => { await api.atlasConnect(project, cluster); await onConnected(cluster); })}>
                  {busy === "atlas" ? <><Spinner /> Creating read-only user…</> : <><Check /> Connect</>}
                </Button>
              </div>
            )}
          </Option>
        </div>

        <details className="rise group text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Have a connection string instead?</summary>
          <form className="mt-3 flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); go("uri", async () => { await api.mongoSetUri(uri); await onConnected(uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?]/)[0]); }); }}>
            <Input type="password" value={uri} onChange={(e) => setUri(e.target.value)} placeholder="mongodb+srv://…" className="font-mono text-xs" />
            <Button type="submit" variant="outline" disabled={!uri || !!busy}>{busy === "uri" ? <Spinner /> : "Connect"}</Button>
          </form>
        </details>

        <ErrorBox>{err}</ErrorBox>
      </div>
    </div>
  );
}
