import { useCallback, useEffect, useState } from "react";
import { api, AuthStatus, FileEntry, isTauri } from "./lib/api";
import { knowledgeCount, loadMemory, Memory } from "./lib/memory";
import { demoSources, loadFiles, mergeFiles, mongoSources, SourceSet } from "./lib/sources";
import { Brain, ChevronRight, Database, Headphones, Inbox, LucideIcon, MessageSquare, RotateCcw, Settings2, TrendingUp, Workflow } from "lucide-react";
import { Button, cx, Dot, EmptyState, errText, SectionLabel } from "./components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import Setup from "./views/Setup";
import Connect from "./views/Connect";
import Ask from "./views/Ask";
import Pipeline from "./views/Pipeline";
import Calls from "./views/Calls";
import Improve from "./views/Improve";
import { PIPELINES } from "./lib/pipeline";
import { getSettings, saveSettings } from "./lib/store";
import { unfinishedRun } from "./lib/followup";
import { linkedToolkits } from "./views/Setup";
import BrainView from "./views/Brain";

import type { View } from "./lib/nav";

export default function App() {
  const [view, setView] = useState<View>("setup");
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [base, setBase] = useState<SourceSet | null>(null);
  const [src, setSrc] = useState<SourceSet | null>(null);
  const [memory, setMemory] = useState<Memory | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [, bump] = useState(0);
  const [boot, setBoot] = useState("");
  const [pipelineId, setPipelineId] = useState("saas");
  const [composio, setComposio] = useState<{ logged_in: boolean; linked: string[] } | null>(null);
  const [resumable, setResumable] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setBoot("Harry runs as a desktop app. Start it with `bun run app`.");
      return;
    }
    loadMemory().then(setMemory);
    getSettings().then((s) => s.pipeline && setPipelineId(s.pipeline));
    unfinishedRun().then((r) => setResumable(!!r));
    api.composioStatus().then((c) => setComposio({ logged_in: c.logged_in, linked: linkedToolkits(c.connections) })).catch(() => {});
    api.listRoots().then(setRoots);
    api.authStatus().then((a) => {
      setAuth(a);
      if (a.openllm) setView("connect");
    });
  }, []);

  useEffect(() => {
    const h = (e: Event) => setView((e as CustomEvent<View>).detail);
    window.addEventListener("harry-nav", h);
    return () => window.removeEventListener("harry-nav", h);
  }, []);

  // Re-merge granted folder files into whatever source is active.
  useEffect(() => {
    if (!base) return;
    let live = true;
    loadFiles(roots)
      .then((f) => {
        if (!live) return;
        setFiles(f.files);
        setSrc(mergeFiles(base, f));
      })
      .catch(() => live && setSrc(base));
    return () => {
      live = false;
    };
  }, [base, roots]);

  const refreshAuth = useCallback(() => {
    api.authStatus().then(setAuth);
    api.composioStatus().then((c) => setComposio({ logged_in: c.logged_in, linked: linkedToolkits(c.connections) })).catch(() => {});
  }, []);
  useEffect(() => {
    window.addEventListener("harry-status", refreshAuth);
    window.addEventListener("focus", refreshAuth);
    return () => {
      window.removeEventListener("harry-status", refreshAuth);
      window.removeEventListener("focus", refreshAuth);
    };
  }, [refreshAuth]);
  const pipeline = PIPELINES[pipelineId];

  if (boot) return <div className="flex h-full items-center justify-center text-muted-foreground">{boot}</div>;
  if (!memory) return null;

  const connected = !!src;
  const nav: { id: View; label: string; icon: LucideIcon; hint: string }[] = [
    { id: "pipeline", label: "Pipeline", icon: Inbox, hint: "Follow-ups and the approval outbox" },
    { id: "calls", label: "Calls", icon: Headphones, hint: "Score calls, draft recaps, learn from reps" },
    { id: "improve", label: "Improve", icon: TrendingUp, hint: "Test playbook changes on held-out buyers" },
    { id: "ask", label: "Ask Harry", icon: MessageSquare, hint: "Questions about your pipeline data" },
    { id: "brain", label: "Memory", icon: Brain, hint: "Glossary, lessons, schema, folders" },
  ];

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full bg-background">
      <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r bg-sidebar">
        <div data-tauri-drag-region className="h-11 shrink-0" />
        <div className="flex items-center gap-2.5 px-5 pb-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_24px_-4px] shadow-primary/60">
            <span className="text-sm font-bold">H</span>
          </div>
          <div>
            <div className="text-[15px] leading-none font-semibold tracking-tight">Harry</div>
            <div className="mt-1 text-xs text-muted-foreground">Your best sales rep</div>
          </div>
        </div>

        <div className="px-3">
          <Select value={pipelineId} onValueChange={async (v) => { setPipelineId(v); await saveSettings({ pipeline: v }); }}>
            <SelectTrigger size="sm" className="w-full bg-background/40 text-xs">
              <Workflow className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(PIPELINES).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <nav className="mt-4 space-y-0.5 px-3">
          {nav.map((n) => {
            const Icon = n.icon;
            const active = view === n.id;
            return (
              <Tooltip key={n.id}>
                <TooltipTrigger asChild>
                  <button
                    disabled={!connected}
                    onClick={() => setView(n.id)}
                    className={cx(
                      "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-35",
                      active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className={cx("size-4", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                    {n.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{connected ? n.hint : "Connect a data source first"}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        <div className="mt-5 px-3">
          <SectionLabel className="px-2.5 pb-1.5">Data source</SectionLabel>
          <button
            onClick={() => setView("connect")}
            className={cx("flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors", view === "connect" ? "border-primary/50 bg-primary/5" : "bg-background/40 hover:border-primary/40")}
          >
            <Database className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{src ? src.label : "Not connected"}</div>
              {src && <div className="text-xs text-muted-foreground">{src.schemas.length} collections{files.length ? ` · ${files.length} files` : ""}</div>}
            </div>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>
        </div>

        <div className="mt-auto space-y-3 p-3">
          {resumable && connected && (
            <button onClick={() => { setResumable(false); setView("pipeline"); }} className="flex w-full items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-2.5 text-left text-xs text-amber-200">
              <RotateCcw className="mt-0.5 size-3.5 shrink-0" />
              <span>Unfinished run found. Resume from checkpoint.</span>
            </button>
          )}
          <div className="rounded-md border bg-background/40 p-3">
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-semibold text-brand-2 tabular-nums">{knowledgeCount(memory)}</span>
              <span className="text-xs text-muted-foreground">things learned</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">about your business</div>
          </div>
          <button onClick={() => setView("setup")} className={cx("w-full space-y-1.5 rounded-md p-2.5 text-left text-xs transition-colors hover:bg-sidebar-accent/60", view === "setup" && "bg-sidebar-accent")}>
            <div className="mb-2 flex items-center justify-between text-muted-foreground">
              <span className="font-medium tracking-wider uppercase">Connections</span>
              <Settings2 className="size-3.5" />
            </div>
            {[
              ["OpenLLM", auth?.openllm, !auth],
              ["MongoDB Atlas", auth?.atlas, !auth],
              ["Composio", composio?.logged_in, !composio],
            ].map(([label, ok, warn]) => (
              <div key={String(label)} className="flex items-center gap-2 text-muted-foreground">
                <Dot ok={!!ok} warn={!!warn} />
                <span className="flex-1">{label as string}</span>
                {label === "Composio" && composio?.linked.length ? <span className="truncate text-[11px]">{composio.linked.length} linked</span> : null}
              </div>
            ))}
          </button>
        </div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1">
        
        {view === "setup" && (
          <Setup
            onReady={() => {
              refreshAuth();
              setView("connect");
            }}
            onSkip={() => {
              refreshAuth();
              setBase(demoSources());
              setView("pipeline");
            }}
          />
        )}
        {view === "connect" && (
          <Connect
            atlasReady={!!auth?.atlas}
            onDemo={() => {
              api.mongoDisconnect();
              setBase(demoSources());
              setView("pipeline");
            }}
            onImported={(s) => {
              api.mongoDisconnect();
              setBase(s);
              setView("pipeline");
            }}
            onConnected={async (label) => {
              try {
                setBase(await mongoSources(label));
                setView("ask");
              } catch (e) {
                throw new Error(`Connected, but sampling the cluster failed: ${errText(e)}`);
              }
            }}
          />
        )}
        {src && view === "ask" && <Ask key={src.label} src={src} memory={memory} onMemory={() => bump((n) => n + 1)} />}
        {src && src.kind === "mongo" && (view === "pipeline" || view === "calls") && (
          <EmptyState icon={<Database />} title="Live clusters are read-only" action={<Button variant="outline" onClick={() => setView("connect")}>Change data source</Button>}>
            Ask Harry works on live clusters. Load the demo CRM or import a CSV export to run the follow-up agent.
          </EmptyState>
        )}
        {src && src.kind !== "mongo" && view === "pipeline" && <Pipeline key={pipeline.id} src={src} pipeline={pipeline} onChange={() => bump((n) => n + 1)} />}
        {src && src.kind !== "mongo" && view === "calls" && <Calls src={src} onChange={() => bump((n) => n + 1)} />}
        {view === "improve" && <Improve key={pipeline.id} pipeline={pipeline} onChange={() => bump((n) => n + 1)} />}
        {src && view === "brain" && (
          <BrainView
            src={src}
            memory={memory}
            roots={roots}
            files={files}
            onRoots={setRoots}
            onMemory={(m) => {
              if (m) setMemory(m);
              bump((n) => n + 1);
            }}
          />
        )}
      </main>
      <Toaster position="bottom-right" richColors />
    </div>
    </TooltipProvider>
  );
}
