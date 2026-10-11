import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { guessMapping, readCsv, Target, TARGETS, toSources } from "../lib/crmImport";
import { SourceSet } from "../lib/sources";
import { api, AtlasCluster, AtlasProject } from "../lib/api";
import { Button, Card, ErrorBox, errText, Spinner } from "../components/ui";
import { MongoLeaf } from "./Setup";

export default function Connect({
  atlasReady,
  onDemo,
  onConnected,
  onImported,
}: {
  atlasReady: boolean;
  onDemo: () => void;
  onConnected: (label: string) => Promise<void>;
  onImported: (s: SourceSet) => void;
}) {
  const [csv, setCsv] = useState<{ name: string; rows: Record<string, unknown>[]; columns: string[]; map: Partial<Record<Target, string>> } | null>(null);
  const [projects, setProjects] = useState<AtlasProject[] | null>(null);
  const [clusters, setClusters] = useState<AtlasCluster[] | null>(null);
  const [project, setProject] = useState("");
  const [cluster, setCluster] = useState("");
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!atlasReady) return;
    api.atlasProjects().then((p) => {
      setProjects(p);
      if (p.length === 1) setProject(p[0].id);
    }).catch((e) => setErr(errText(e)));
  }, [atlasReady]);

  useEffect(() => {
    if (!project) return;
    setClusters(null);
    setCluster("");
    api.atlasClusters(project).then((c) => {
      setClusters(c);
      if (c.length === 1) setCluster(c[0].name);
    }).catch((e) => setErr(errText(e)));
  }, [project]);

  const go = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const select = "w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col justify-center gap-6 px-8 pb-10">
      <div className="rise">
        <h1 className="text-4xl font-semibold tracking-tight">
          Meet Harry, <span className="text-brand">your best sales rep.</span>
        </h1>
        <p className="mt-2 text-mute">Connect your CRM. Harry reads it, drafts follow-ups for your approval, and never edits or deletes your records.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card className="rise p-6">
          <div className="flex items-center gap-2 font-medium">
            <MongoLeaf className="h-5 w-5 text-brand" /> Your Atlas cluster
          </div>
          {!atlasReady ? (
            <p className="mt-3 text-sm text-mute">Sign in to MongoDB in Setup first.</p>
          ) : (
            <div className="mt-4 space-y-3">
              <select className={select} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{projects ? "Choose a project" : "Loading projects…"}</option>
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select className={select} value={cluster} onChange={(e) => setCluster(e.target.value)} disabled={!clusters}>
                <option value="">{!project ? "—" : clusters ? (clusters.length ? "Choose a cluster" : "No clusters in this project") : "Loading clusters…"}</option>
                {clusters?.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} {c.stateName && c.stateName !== "IDLE" ? `(${c.stateName})` : ""}
                  </option>
                ))}
              </select>
              <Button
                className="w-full"
                disabled={!cluster || !!busy}
                onClick={() =>
                  go("atlas", async () => {
                    const c = await api.atlasConnect(project, cluster);
                    setNote(`Created read-only user ${c.username}, auto-deleted ${c.expires.slice(0, 16).replace("T", " ")} UTC`);
                    await onConnected(cluster);
                  })
                }
              >
                {busy === "atlas" ? <Spinner /> : null} Connect read-only
              </Button>
              <p className="text-xs text-mute">Harry creates a temporary read-only database user and access-list entry. Atlas deletes both in 24h.</p>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="rise flex-1 border-brand/40 bg-gradient-to-br from-brand/10 to-transparent p-6">
            <div className="font-medium">Try the demo CRM</div>
            <p className="mt-1 text-sm text-mute">339 deals, 113 contacts, 8 reps, sample call transcripts. Messy on purpose.</p>
            <Button className="mt-4 w-full" onClick={onDemo}>
              Open demo CRM
            </Button>
          </Card>
          <Card className="rise p-6">
            <div className="text-sm font-medium">Import a CRM export (CSV)</div>
            <p className="mt-1 text-xs text-mute">HubSpot, Salesforce, Pipedrive, or any spreadsheet.</p>
            {!csv ? (
              <Button
                variant="outline"
                className="mt-3 w-full"
                onClick={() =>
                  go("csv", async () => {
                    const f = await open({ filters: [{ name: "CSV", extensions: ["csv", "tsv"] }] });
                    if (typeof f !== "string") return;
                    const { rows, columns } = readCsv(await invoke<string>("read_picked", { path: f }));
                    if (!rows.length) throw new Error("No rows found in that file");
                    setCsv({ name: f.split("/").pop()!, rows, columns, map: guessMapping(columns) });
                  })
                }
              >
                Choose CSV…
              </Button>
            ) : (
              <div className="mt-3 space-y-1.5">
                <div className="text-xs text-mute">{csv.name} · {csv.rows.length} rows · map your columns</div>
                <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto">
                  {TARGETS.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-xs">
                      <span className="w-20 text-mute">{t}</span>
                      <select
                        value={csv.map[t] ?? ""}
                        onChange={(e) => setCsv({ ...csv, map: { ...csv.map, [t]: e.target.value || undefined } })}
                        className="min-w-0 flex-1 rounded border border-line bg-black/30 px-1 py-0.5"
                      >
                        <option value="">—</option>
                        {csv.columns.map((c) => <option key={c}>{c}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <Button className="w-full" disabled={!csv.map.company && !csv.map.deal} onClick={() => onImported(toSources(csv.rows, csv.map, csv.name))}>
                  Import {csv.rows.length} rows
                </Button>
              </div>
            )}
          </Card>
          <Card className="rise p-6">
            <div className="text-sm font-medium">Or paste a connection string</div>
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="mongodb+srv://…"
                className="flex-1 rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-xs outline-none focus:border-brand"
              />
              <Button
                variant="outline"
                disabled={!uri || !!busy}
                onClick={() =>
                  go("uri", async () => {
                    await api.mongoSetUri(uri);
                    await onConnected(uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?]/)[0]);
                  })
                }
              >
                {busy === "uri" ? <Spinner /> : null} Connect
              </Button>
            </div>
          </Card>
        </div>
      </div>
      {note && <div className="text-sm text-brand-2">{note}</div>}
      <ErrorBox>{err}</ErrorBox>
    </div>
  );
}
