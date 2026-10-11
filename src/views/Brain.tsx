import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { BookOpen, Database, FolderOpen, FolderPlus, Play, ShieldAlert, ShieldX, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { api, FileEntry } from "../lib/api";
import { emptyMemory, knowledgeCount, Memory, saveMemory } from "../lib/memory";
import { SourceSet } from "../lib/sources";
import { askHarry } from "../lib/nav";
import { Button, Card, cx, EmptyState, ErrorBox, errText, Pill, SectionLabel } from "../components/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const KIND = {
  glossary: { icon: BookOpen, label: "Learned a term", tone: "text-sky-300 bg-sky-400/10" },
  scar: { icon: ShieldAlert, label: "Learned from a mistake", tone: "text-amber-300 bg-amber-400/10" },
  skill: { icon: Wand2, label: "Saved a query", tone: "text-primary bg-primary/10" },
  voice: { icon: Sparkles, label: "Learned your style", tone: "text-violet-300 bg-violet-400/10" },
  rule: { icon: Sparkles, label: "Changed a rule", tone: "text-primary bg-primary/10" },
} as const;

export default function Brain({ src, memory, roots, files, onRoots, onMemory }: { src: SourceSet; memory: Memory; roots: string[]; files: FileEntry[]; onRoots: (r: string[]) => void; onMemory: (m?: Memory) => void }) {
  const [err, setErr] = useState("");
  const total = knowledgeCount(memory);
  const approved = memory.versions.filter((v) => v.gate === "approved");
  const growth = approved.map((_, i) => ({ i, n: i + 1 }));
  const traces = memory.traces;
  const firstTry = (t: typeof traces) => (t.length ? Math.round((t.filter((x) => x.retries === 0 && x.ok).length / t.length) * 100) : 0);
  const half = Math.floor(traces.length / 2);

  const add = async () => {
    setErr("");
    const picked = await open({ directory: true, multiple: false, title: "Give Harry read access to a folder" });
    if (typeof picked !== "string") return;
    try {
      onRoots(await api.grantFolder(picked));
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-8 pt-10 pb-12">
        {/* Hero */}
        <Card className="relative overflow-hidden p-8">
          <div className="absolute inset-x-0 bottom-0 h-24 opacity-60">
            {growth.length > 1 && (
              <ResponsiveContainer>
                <AreaChart data={growth} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} /></linearGradient></defs>
                  <Area dataKey="n" stroke="var(--chart-1)" strokeWidth={2} fill="url(#g)" type="monotone" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="relative">
            <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Memory</div>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-6xl font-semibold tracking-tight text-brand-2 tabular-nums">{total}</span>
              <span className="text-lg text-muted-foreground">things Harry knows about your business</span>
            </div>
            <div className="mt-5 flex flex-wrap gap-6 text-sm">
              <Mini n={memory.glossary.length} label="terms" />
              <Mini n={memory.skills.length} label="saved queries" />
              <Mini n={memory.scars.length} label="lessons" />
              {traces.length >= 4 && <Mini n={`${firstTry(traces.slice(0, half))}% → ${firstTry(traces.slice(half))}%`} label="right first try" />}
            </div>
          </div>
        </Card>

        <Tabs defaultValue="learned">
          <TabsList>
            <TabsTrigger value="learned">Learned</TabsTrigger>
            <TabsTrigger value="data">Your data</TabsTrigger>
            <TabsTrigger value="folders">Folders {roots.length > 0 && <span className="text-muted-foreground">{roots.length}</span>}</TabsTrigger>
          </TabsList>

          <TabsContent value="learned" className="mt-5 space-y-6">
            {total === 0 ? (
              <Card className="py-14">
                <EmptyState icon={<Sparkles />} title="Harry hasn't learned anything yet" action={<Button onClick={() => askHarry("Which open deals over $50k have stalled, and who owns them?")}><Play /> Ask a first question</Button>}>
                  Ask him a question, correct an answer with “Teach Harry”, or let him fix a failed query. Everything he learns shows up here.
                </EmptyState>
              </Card>
            ) : (
              <>
                {memory.glossary.length > 0 && (
                  <section>
                    <SectionLabel className="mb-2">Your team's vocabulary</SectionLabel>
                    <div className="grid grid-cols-2 gap-2">
                      {memory.glossary.map((g) => (
                        <Card key={g.term} className="p-4">
                          <div className="flex items-center gap-2 font-medium"><BookOpen className="size-4 text-sky-300" />{g.term}</div>
                          <div className="selectable mt-1 text-sm text-muted-foreground">{g.definition}</div>
                        </Card>
                      ))}
                    </div>
                  </section>
                )}

                {memory.skills.length > 0 && (
                  <section>
                    <SectionLabel className="mb-2">Questions Harry can answer instantly</SectionLabel>
                    <div className="space-y-2">
                      {[...memory.skills].sort((a, b) => b.uses - a.uses).map((s) => (
                        <button key={s.question} onClick={() => askHarry(s.question)} className="group flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-primary/50">
                          <Wand2 className="size-4 shrink-0 text-primary" />
                          <span className="min-w-0 flex-1 truncate text-sm">{s.question}</span>
                          <span className="text-xs text-muted-foreground">used {s.uses}×</span>
                          <span className="text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">Ask again →</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <SectionLabel className="mb-3">Timeline</SectionLabel>
                  <div className="relative space-y-4 pl-6 before:absolute before:top-2 before:bottom-2 before:left-[11px] before:w-px before:bg-border">
                    {[...memory.versions].reverse().slice(0, 30).map((v) => {
                      const k = KIND[v.kind] ?? KIND.rule;
                      const Icon = v.gate === "rejected" ? ShieldX : k.icon;
                      return (
                        <div key={v.v} className="relative">
                          <span className={cx("absolute top-0 -left-6 flex size-6 items-center justify-center rounded-full ring-4 ring-background", v.gate === "rejected" ? "bg-destructive/15 text-destructive" : k.tone)}><Icon className="size-3.5" /></span>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{v.gate === "rejected" ? "Blocked by the policy gate" : k.label}</span>
                            <span>·</span><span>{ago(v.at)}</span>
                          </div>
                          <div className="selectable mt-0.5 text-sm text-muted-foreground">{v.change}{v.reason ? ` (${v.reason})` : ""}</div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={async () => { if (!confirm("Erase everything Harry learned?")) return; const m = emptyMemory(); await saveMemory(m); onMemory(m); }}>
                    <Trash2 /> Reset memory
                  </Button>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="data" className="mt-5 space-y-3">
            <p className="text-sm text-muted-foreground">What Harry sees in <span className="text-foreground">{src.label}</span>. Amber means mixed types or missing values, which he handles for you.</p>
            <div className="grid grid-cols-2 gap-3">
              {src.schemas.map((s) => (
                <Card key={`${s.db}.${s.name}`} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium"><Database className="size-4 text-muted-foreground" />{s.name}</div>
                    <Pill>{s.count.toLocaleString()} rows</Pill>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {s.fields.filter((f) => !f.path.includes(".")).slice(0, 18).map((f) => (
                      <span key={f.path} title={`${f.types.join(" | ")} · e.g. ${f.examples.join(", ")}`} className={cx("rounded-md border px-1.5 py-0.5 font-mono text-[11px]", f.types.length > 1 || f.presence < 0.9 ? "border-amber-400/30 text-amber-300" : "text-muted-foreground")}>{f.path}</span>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="folders" className="mt-5 space-y-3">
            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium">Folders Harry can read</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">Spreadsheets become tables he can query; notes become context. Hidden files, keys and secrets are always skipped.</div>
                </div>
                <Button onClick={add}><FolderPlus /> Add folder</Button>
              </div>
              <div className="mt-4 space-y-2">
                {roots.length === 0 && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No folders shared yet.</div>}
                {roots.map((r) => (
                  <div key={r} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                    <FolderOpen className="size-4 text-muted-foreground" />
                    <span className="selectable min-w-0 flex-1 truncate font-mono text-xs">{r}</span>
                    <span className="text-xs text-muted-foreground">{files.filter((f) => f.path.startsWith(r)).length} files</span>
                    <Button size="sm" variant="ghost" onClick={async () => onRoots(await api.revokeFolder(r))}><X /> Remove</Button>
                  </div>
                ))}
              </div>
            </Card>
            <ErrorBox>{err}</ErrorBox>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function Mini({ n, label }: { n: number | string; label: string }) {
  return (
    <div>
      <span className="font-semibold tabular-nums">{n}</span> <span className="text-muted-foreground">{label}</span>
    </div>
  );
}
