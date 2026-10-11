import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { api, AuthStatus, ToolStatus } from "../lib/api";
import { Button, Card, Dot, ErrorBox, errText, Spinner } from "../components/ui";

const INFO: Record<string, { label: string; role: string }> = {
  openllm: { label: "OpenLLM", role: "Inference for every answer and post" },
  atlas: { label: "Atlas CLI", role: "MongoDB login, projects, clusters, temp users" },
  mongosh: { label: "mongosh", role: "Runs read-only queries on your cluster" },
  composio: { label: "Composio", role: "Your one integration: email, CRM, and calendar" },
};

const PROVIDERS = [
  { group: "Email", items: [["gmail", "Gmail"], ["outlook", "Outlook"]] },
  { group: "CRM", items: [["hubspot", "HubSpot"], ["salesforce", "Salesforce"], ["pipedrive", "Pipedrive"]] },
  { group: "Calendar", items: [["googlecalendar", "Google Calendar"], ["outlook_calendar", "Outlook Calendar"]] },
] as const;

type Comp = { installed: boolean; logged_in: boolean; connections: unknown };

/** Toolkit slugs that show as connected/active in `composio connections list`. */
export function linkedToolkits(connections: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key = "") => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const slug = (o.toolkit as { slug?: string })?.slug ?? o.toolkit ?? o.slug ?? o.app ?? o.appName;
      const status = String(o.status ?? o.connection_status ?? "active").toLowerCase();
      if (typeof slug === "string" && /active|connected|true/.test(status)) out.add(slug.toLowerCase());
      for (const [k, x] of Object.entries(o)) {
        if (typeof x === "string" && /active|connected/i.test(x) && k.length < 40 && !/status/i.test(k)) out.add(k.toLowerCase());
        if (x && typeof x === "object") walk(x, k);
      }
    }
  };
  walk(connections);
  return [...out];
}

export default function Setup({ onReady, onSkip }: { onReady: () => void; onSkip: () => void }) {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const [code, setCode] = useState<{ code?: string; url?: string } | null>(null);
  const [comp, setComp] = useState<Comp | null>(null);
  const [compUrl, setCompUrl] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = async () => {
    const [t, a, c] = await Promise.all([api.toolStatus(), api.authStatus(), api.composioStatus()]);
    setTools(t);
    setAuth(a);
    setComp(c);
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

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr("");
    try {
      await fn();
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
  const allInstalled = tools?.every((t) => t.path);
  const linked = linkedToolkits(comp?.connections);
  const ready = auth?.openllm && installed("mongosh");

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-5 overflow-y-auto px-8 pt-16 pb-10">
      <div className="rise">
        <h1 className="text-3xl font-semibold tracking-tight">Set up Harry</h1>
        <p className="mt-1 text-mute">Harry uses a few local tools and one integration, Composio. He installs and signs them in for you. Credentials stay with each tool, never in Harry.</p>
      </div>

      <Card className="rise divide-y divide-line">
        {(tools ?? Object.keys(INFO).map((name) => ({ name, path: null, version: null }))).map((t) => (
          <div key={t.name} className="flex items-center gap-4 px-5 py-4">
            <Dot ok={!!t.path} warn={!tools} />
            <div className="flex-1">
              <div className="font-medium">{INFO[t.name].label}</div>
              <div className="text-xs text-mute">{t.path ? `${t.version ?? "installed"} · ${t.path}` : INFO[t.name].role}</div>
            </div>
            {tools && !t.path && (
              <Button disabled={!!busy} onClick={() => run(`install-${t.name}`, () => api.installTool(t.name))}>
                {busy === `install-${t.name}` ? <Spinner /> : null} Install
              </Button>
            )}
          </div>
        ))}
      </Card>

      <Card className="rise p-5">
        <div className="flex items-center gap-3">
          <Dot ok={auth?.openllm} warn={!auth} />
          <div className="flex-1">
            <div className="font-medium">OpenLLM API key</div>
            <div className="text-xs text-mute">{auth?.openllm ? auth.openllm_detail : "Paste your key from the OpenLLM dashboard. Saved by `openllm login`."}</div>
          </div>
        </div>
        {!auth?.openllm && (
          <div className="mt-4 flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-llm-…"
              className="flex-1 rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-sm outline-none focus:border-brand"
            />
            <Button
              disabled={!key || !!busy}
              onClick={() =>
                run("openllm-key", async () => {
                  await api.openllmSetKey(key);
                  setKey("");
                })
              }
            >
              {busy === "openllm-key" ? <Spinner /> : null} Connect
            </Button>
          </div>
        )}
      </Card>

      <Card className="rise p-5">
        <div className="flex items-center gap-3">
          <Dot ok={auth?.atlas} warn={!auth} />
          <div className="flex-1">
            <div className="font-medium">MongoDB Atlas</div>
            <div className="text-xs text-mute">{auth?.atlas ? auth.atlas_detail : "Sign in through your browser. The token stays in the Atlas CLI."}</div>
          </div>
          {auth?.atlas ? (
            <Button variant="ghost" disabled={!!busy} onClick={() => run("atlas-logout", api.atlasLogout)}>
              Sign out
            </Button>
          ) : (
            <Button disabled={!!busy || !installed("atlas")} onClick={() => run("atlas-login", api.atlasLogin)}>
              {busy === "atlas-login" ? <Spinner /> : <MongoLeaf />} Connect with MongoDB
            </Button>
          )}
        </div>
        {busy === "atlas-login" && (
          <div className="rise mt-4 rounded-lg border border-brand/30 bg-brand/5 p-4 text-center">
            <div className="text-xs tracking-wide text-mute uppercase">Enter this code in the browser</div>
            <div className="selectable mt-1 font-mono text-4xl font-semibold tracking-[0.2em] text-brand-2">{code?.code ?? "····-····"}</div>
            <div className="mt-2 text-xs text-mute">
              {code?.url ? (
                <>
                  Opened <span className="selectable text-white">{code.url}</span> · expires in 3 minutes
                </>
              ) : (
                "Starting Atlas login…"
              )}
            </div>
          </div>
        )}
      </Card>

      <Card className="rise p-5">
        <div className="flex items-center gap-3">
          <Dot ok={comp?.logged_in} warn={!comp} />
          <div className="flex-1">
            <div className="font-medium">Composio</div>
            <div className="text-xs text-mute">
              {comp?.logged_in ? "Signed in. Link the accounts Harry should use." : "Harry's one integration. Use your Composio account, or create one free in the browser."}
            </div>
          </div>
          {comp?.logged_in ? (
            <Button variant="ghost" disabled={!!busy} onClick={() => run("composio-logout", api.composioLogout)}>
              Sign out
            </Button>
          ) : (
            <Button disabled={!!busy || !installed("composio")} onClick={() => run("composio-login", api.composioLogin)}>
              {busy === "composio-login" ? <Spinner /> : null} Sign in to Composio
            </Button>
          )}
        </div>
        {busy?.startsWith("composio") && compUrl && (
          <div className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3 text-xs text-mute">
            Finish in your browser. If it didn't open: <span className="selectable text-white">{compUrl}</span>
          </div>
        )}
        {comp?.logged_in && (
          <div className="mt-4 space-y-3">
            {PROVIDERS.map((g) => (
              <div key={g.group} className="flex items-center gap-3">
                <div className="w-20 text-xs text-mute">{g.group}</div>
                <div className="flex flex-wrap gap-2">
                  {g.items.map(([slug, label]) => {
                    const on = linked.includes(slug);
                    return (
                      <Button key={slug} variant={on ? "primary" : "outline"} className="py-1.5 text-xs" disabled={!!busy || on} onClick={() => run(`composio-link-${slug}`, () => api.composioLink(slug))}>
                        {busy === `composio-link-${slug}` ? <Spinner /> : on ? "✓" : "+"} {label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ErrorBox>{err}</ErrorBox>

      {log.length > 0 && (
        <pre ref={logRef} className="selectable max-h-40 overflow-y-auto rounded-lg border border-line bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-mute">
          {log.join("\n")}
        </pre>
      )}

      <div className="flex items-center justify-between pt-2">
        <button className="text-sm text-mute hover:text-white" onClick={onSkip}>
          Skip and explore the demo CRM →
        </button>
        <Button disabled={!ready} onClick={onReady}>
          Continue
        </Button>
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
