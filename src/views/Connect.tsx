import { ReactNode, useEffect, useState } from "react";
import { ArrowRight, Check, Lock, Plug } from "lucide-react";
import { hubspotSources } from "../lib/hubspot";
import { SourceSet } from "../lib/sources";
import { api, AtlasCluster, AtlasProject } from "../lib/api";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";
import { Input } from "@/components/ui/input";
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

export default function Connect({ atlasReady, hubspotLinked, onConnected, onImported }: { atlasReady: boolean; hubspotLinked: boolean; onConnected: (label: string) => Promise<void>; onImported: (s: SourceSet) => void }) {
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 px-8 py-12">
        <div className="rise">
          <h1 className="text-3xl font-semibold tracking-tight">Meet Harry, <span className="text-brand-2">your best sales rep.</span></h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">Choose where your deals live. Harry reads them, drafts follow-ups for your approval, and never edits or deletes your records.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Option highlight icon={<Plug />} title="HubSpot" tag={<Pill tone="brand">via Composio</Pill>} desc="Pull companies, contacts and deals live through your Composio connection. Read-only.">
            {!hubspotLinked ? (
              <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">Run <code>composio link hubspot</code> in Setup to use this.</div>
            ) : (
              <Button className="w-full" disabled={!!busy} onClick={() => go("hubspot", async () => onImported(await hubspotSources()))}>
                {busy === "hubspot" ? <Spinner /> : null} Pull from HubSpot <ArrowRight />
              </Button>
            )}
          </Option>

          <Option icon={<MongoLeaf />} title="Atlas cluster" tag={<Pill><Lock className="size-3" /> CRM read-only</Pill>} desc="Ask questions about live data and keep Harry's outbox, runs and playbooks in its own harry database. Your other data is never written.">
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
                  {busy === "atlas" ? <><Spinner /> Creating database user…</> : <><Check /> Connect</>}
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
