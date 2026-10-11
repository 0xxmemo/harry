import { listen } from "@tauri-apps/api/event";
import { ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ExternalLink, KeyRound, Plug, Terminal } from "lucide-react";
import { api, AuthStatus, ToolStatus } from "../lib/api";
import { Button, Card, cx, ErrorBox, errText, Pill, Spinner } from "../components/ui";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

const INFO: Record<string, { label: string; role: string }> = {
  openllm: { label: "OpenLLM", role: "Runs every model call" },
  atlas: { label: "Atlas CLI", role: "Signs in to MongoDB, creates Harry's database user" },
  mongosh: { label: "mongosh", role: "Queries Harry's own harry database" },
  composio: { label: "Composio", role: "Your one integration for email, CRM and calendar" },
};

const PROVIDERS = [
  { group: "Email", why: "Send approved follow-ups from your own inbox and read replies", items: [["gmail", "Gmail"], ["outlook", "Outlook"]] },
  { group: "CRM", why: "Read contacts and deals, add notes and tasks (never edits or deletes)", items: [["hubspot", "HubSpot"], ["salesforce", "Salesforce"], ["pipedrive", "Pipedrive"]] },
  { group: "Calendar", why: "Confirm a call was actually booked", items: [["googlecalendar", "Google Calendar"], ["outlook_calendar", "Outlook Calendar"]] },
] as const;

type Comp = { installed: boolean; logged_in: boolean; connections: unknown };

/** Toolkit slugs that show as connected/active in `composio connections list`. */
export function linkedToolkits(connections: unknown): string[] {
  const out = new Set<string>();
  // Current CLI shape: { "<toolkit>": [{ "status": "ACTIVE" | "INITIALIZING" | ... }, ...] }
  if (connections && typeof connections === "object" && !Array.isArray(connections)) {
    for (const [slug, list] of Object.entries(connections as Record<string, unknown>)) {
      if (Array.isArray(list) && list.some((c) => /^active$/i.test(String((c as { status?: unknown })?.status)))) out.add(slug.toLowerCase());
    }
    if (out.size) return [...out];
  }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const slug = (o.toolkit as { slug?: string })?.slug ?? o.toolkit ?? o.slug ?? o.app ?? o.appName;
      const status = String(o.status ?? o.connection_status ?? "active").toLowerCase();
      if (typeof slug === "string" && /active|connected|true/.test(status)) out.add(slug.toLowerCase());
      for (const [k, x] of Object.entries(o)) {
        if (typeof x === "string" && /active|connected/i.test(x) && k.length < 40 && !/status/i.test(k)) out.add(k.toLowerCase());
        if (x && typeof x === "object") walk(x);
      }
    }
  };
  walk(connections);
  return [...out];
}

function Step({ n, done, title, why, children, optional }: { n: number; done?: boolean; title: string; why: string; children: ReactNode; optional?: boolean }) {
  return (
    <Card className={cx("rise p-5 transition-colors", done && "border-primary/25")}>
      <div className="flex gap-4">
        <div className={cx("flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums", done ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>
          {done ? <Check className="size-4" /> : n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-medium">{title}</div>
            {optional && <Pill>optional</Pill>}
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">{why}</div>
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </Card>
  );
}

export default function Setup({ onReady }: { onReady: () => void }) {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [comp, setComp] = useState<Comp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [key, setKey] = useState("");
  const [code, setCode] = useState<{ code?: string; url?: string } | null>(null);
  const [compUrl, setCompUrl] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = async () => {
    const [t, a, c] = await Promise.all([api.toolStatus(), api.authStatus(), api.composioStatus()]);
    setTools(t);
    setAuth(a);
    setComp(c);
    window.dispatchEvent(new CustomEvent("harry-status"));
  };

  useEffect(() => {
    refresh();
    const u1 = listen<{ line: string }>("cli-log", (e) => setLog((l) => [...l.slice(-300), e.payload.line]));
    const u2 = listen<{ code?: string; url?: string }>("atlas-login", (e) => setCode(e.payload));
    const u3 = listen<string>("composio-url", (e) => setCompUrl(e.payload));
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const run = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    setErr("");
    if (id.startsWith("install")) setShowLog(true);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
      setCode(null);
      setCompUrl("");
      refresh();
    }
  };

  const installed = (n: string) => !!tools?.find((t) => t.name === n)?.path;
  const allInstalled = !!tools?.every((t) => t.path);
  const linked = linkedToolkits(comp?.connections);
  const steps = [allInstalled, !!auth?.openllm, !!auth?.atlas, !!comp?.logged_in && linked.length > 0];
  const doneCount = steps.filter(Boolean).length;
  const ready = !!auth?.openllm && !!auth?.atlas && installed("mongosh");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-8 pt-14 pb-12">
        <div className="rise">
          <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Setup</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Connect Harry to your tools</h1>
          <p className="mt-1 text-sm text-muted-foreground">Four steps. Credentials stay inside each tool; Harry never stores them.</p>
          <div className="mt-4 flex items-center gap-3">
            <Progress value={(doneCount / 4) * 100} className="h-1.5 flex-1" />
            <span className="text-xs text-muted-foreground tabular-nums">{doneCount} of 4</span>
          </div>
        </div>

        <Step n={1} done={steps[0]} title="Install local tools" why="Harry does everything through these command-line tools, so your accounts stay on your Mac.">
          <div className="divide-y rounded-lg border">
            {(tools ?? Object.keys(INFO).map((name) => ({ name, path: null, version: null }))).map((t) => (
              <div key={t.name} className="flex items-center gap-3 px-3.5 py-2.5">
                {t.path ? <Check className="size-4 text-primary" /> : tools ? <Terminal className="size-4 text-muted-foreground" /> : <Spinner className="text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{INFO[t.name].label}</div>
                  <div className="truncate text-xs text-muted-foreground">{t.path ? t.version ?? "installed" : INFO[t.name].role}</div>
                </div>
                {tools && !t.path && (
                  <Button size="sm" disabled={!!busy} onClick={() => run(`install-${t.name}`, () => api.installTool(t.name), `${INFO[t.name].label} installed`)}>
                    {busy === `install-${t.name}` ? <Spinner /> : null} Install
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Step>

        <Step n={2} done={steps[1]} title="Connect OpenLLM" why="The models that draft emails, score calls and review playbooks.">
          {auth?.openllm ? (
            <div className="flex items-center gap-2 text-sm text-brand-2"><Check className="size-4" /> {auth.openllm_detail}</div>
          ) : (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run("openllm-key", async () => { await api.openllmSetKey(key); setKey(""); }, "OpenLLM connected"); }}>
              <div className="relative flex-1">
                <KeyRound className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your API key (sk-llm-…)" className="pl-9 font-mono" />
              </div>
              <Button type="submit" disabled={!key || !!busy || !installed("openllm")}>{busy === "openllm-key" ? <><Spinner /> Verifying…</> : "Connect"}</Button>
            </form>
          )}
        </Step>

        <Step n={3} done={steps[2]} title="Sign in to MongoDB Atlas" why="Harry keeps everything (outbox, runs, playbooks, memory) in a harry database on your cluster. Nothing is stored on your Mac.">
          {auth?.atlas ? (
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-brand-2"><Check className="size-4" /> {auth.atlas_detail}</span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("atlas-logout", api.atlasLogout)}>Sign out</Button>
            </div>
          ) : busy === "atlas-login" ? (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center">
              <div className="text-xs text-muted-foreground">Enter this code on the MongoDB page that just opened</div>
              <div className="selectable mt-1 font-mono text-3xl font-semibold tracking-[0.2em] text-brand-2">{code?.code ?? "····-····"}</div>
              <div className="mt-1 text-xs text-muted-foreground">{code?.url ? "Expires in 3 minutes" : "Starting…"}</div>
            </div>
          ) : (
            <Button variant="outline" disabled={!!busy || !installed("atlas")} onClick={() => run("atlas-login", api.atlasLogin, "Signed in to MongoDB")}>
              <ExternalLink /> Connect with MongoDB
            </Button>
          )}
        </Step>

        <Step n={4} done={steps[3]} title="Link your accounts through Composio" why="Harry's single integration. Use your Composio account, or create one free when the browser opens.">
          {!comp?.logged_in ? (
            <div className="space-y-2">
              <Button variant="outline" disabled={!!busy || !installed("composio")} onClick={() => run("composio-login", api.composioLogin, "Signed in to Composio")}>
                {busy === "composio-login" ? <Spinner /> : <Plug />} Sign in to Composio
              </Button>
              {busy === "composio-login" && <div className="text-xs text-muted-foreground">Finish in your browser.{compUrl && <> If it didn't open: <span className="selectable text-foreground">{compUrl}</span></>}</div>}
            </div>
          ) : (
            <div className="space-y-4">
              {PROVIDERS.map((g) => (
                <div key={g.group}>
                  <div className="text-sm font-medium">{g.group}</div>
                  <div className="text-xs text-muted-foreground">{g.why}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {g.items.map(([slug, label]) => {
                      const on = linked.includes(slug);
                      return (
                        <Button key={slug} size="sm" variant={on ? "secondary" : "outline"} disabled={!!busy || on} onClick={() => run(`composio-link-${slug}`, () => api.composioLink(slug), `${label} linked`)}>
                          {busy === `composio-link-${slug}` ? <Spinner /> : on ? <Check className="text-primary" /> : null} {label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between border-t pt-3">
                {busy?.startsWith("composio-link") ? <span className="text-xs text-muted-foreground">Finish signing in to the provider in your browser…</span> : <span />}
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("composio-logout", api.composioLogout)}>Sign out of Composio</Button>
              </div>
            </div>
          )}
        </Step>

        <ErrorBox>{err}</ErrorBox>

        {log.length > 0 && (
          <div>
            <button onClick={() => setShowLog(!showLog)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className={cx("size-3.5 transition-transform", !showLog && "-rotate-90")} /> Install log
            </button>
            {showLog && <pre ref={logRef} className="selectable mt-2 max-h-40 overflow-y-auto rounded-lg border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{log.join("\n")}</pre>}
          </div>
        )}

        <div className="flex items-center justify-end border-t pt-5">
          <Button disabled={!ready} onClick={onReady} title={ready ? "" : "Connect OpenLLM and MongoDB Atlas first"}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

export function MongoLeaf({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12.2 1.5c-.2.9-.5 1.6-1.1 2.3C8.9 6.3 6.6 9 6.6 13c0 3.5 2.2 6.2 5 7.4l.4 2.1h.8l.3-2.1c2.8-1.1 5-3.9 5-7.4 0-4-2.3-6.8-4.6-9.3-.6-.7-1-1.4-1.3-2.2Zm.2 17.8-.2-13.6.3 13.6Z" />
    </svg>
  );
}
