import { ReactNode, useEffect, useState } from "react";
import { Check, Lock, Plug, RefreshCw } from "lucide-react";
import { lastHubspotSync } from "../lib/hubspot";
import { CollectionSchema } from "../lib/schema";
import { api, AtlasCluster, AtlasProject } from "../lib/api";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MongoLeaf } from "./Setup";

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

export default function Connect({ atlasReady, storeReady, linking, linkErr, hubspotLinked, syncing, crm, onSync, onConnect }: { atlasReady: boolean; storeReady: boolean; linking: string | null; linkErr: string; hubspotLinked: boolean; syncing: boolean; crm: CollectionSchema[]; onSync: () => void; onConnect: (project: string, cluster: string) => void }) {
  const [lastSync, setLastSync] = useState<string | null>(null);
  useEffect(() => {
    if (storeReady) lastHubspotSync().then((s) => setLastSync(s?.at ?? null)).catch(() => {});
  }, [storeReady, syncing]);
  const [projects, setProjects] = useState<AtlasProject[] | null>(null);
  const [clusters, setClusters] = useState<AtlasCluster[] | null>(null);
  const [project, setProject] = useState("");
  const [cluster, setCluster] = useState("");
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


  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 px-8 py-12">
        <div className="rise">
          <h1 className="text-3xl font-semibold tracking-tight">Meet Harry, <span className="text-brand-2">your best sales rep.</span></h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">Your tools come in through Composio and are kept in sync in Harry's knowledge base on MongoDB Atlas. Harry reads them, drafts follow-ups for your approval, and never edits or deletes your records.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Option highlight icon={<Plug />} title="Data source" tag={<Pill tone="brand">Composio</Pill>} desc="HubSpot companies, contacts and deals sync automatically. Only records changed since the last sync are checked for; nothing is duplicated.">
            {!storeReady ? (
              <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">{linking ? <span className="inline-flex items-center gap-2"><Spinner /> {linking}</span> : atlasReady ? "Couldn't set up Harry's store. Pick a cluster on the right." : "Sign in to MongoDB in Setup first; Harry keeps its work there."}</div>
            ) : !hubspotLinked ? (
              <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">Link HubSpot in Setup (<code>composio link hubspot</code>) to start syncing.</div>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1 text-xs text-muted-foreground">
                  {crm.filter((c) => c.count).map((c) => <div key={c.name} className="flex justify-between"><span>{c.name}</span><span className="tabular-nums">{c.count}</span></div>)}
                  <div>{syncing ? "Checking HubSpot for changes…" : lastSync ? `Last synced ${new Date(lastSync).toLocaleString()}` : "Not synced yet"}</div>
                </div>
                <Button className="w-full" variant="outline" disabled={syncing} onClick={onSync}>
                  {syncing ? <Spinner /> : <RefreshCw />} Sync now
                </Button>
              </div>
            )}
          </Option>

          <Option icon={<MongoLeaf />} title="Knowledge base" tag={<Pill><Lock className="size-3" /> harry database only</Pill>} desc="Harry keeps synced records, memory and its work in its own harry database on your Atlas cluster, and has no access to any other database.">
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
                <Button className="w-full" variant="outline" disabled={!cluster || !!linking} onClick={() => onConnect(project, cluster)}>
                  {linking ? <><Spinner /> {linking}</> : storeReady ? <><Check /> Switch cluster</> : <><Check /> Connect</>}
                </Button>
              </div>
            )}
          </Option>
        </div>


        <ErrorBox>{err || linkErr}</ErrorBox>
      </div>
    </div>
  );
}
