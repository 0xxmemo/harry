import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { api, FileEntry } from "../lib/api";
import { emptyMemory, Memory, saveMemory } from "../lib/memory";
import { SourceSet } from "../lib/sources";
import { Button, Card, cx, ErrorBox, errText, Pill } from "../components/ui";

export default function Brain({
  src,
  memory,
  roots,
  files,
  onRoots,
  onMemory,
}: {
  src: SourceSet;
  memory: Memory;
  roots: string[];
  files: FileEntry[];
  onRoots: (r: string[]) => void;
  onMemory: (m?: Memory) => void;
}) {
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"memory" | "schema" | "folders">("memory");

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

  const traces = memory.traces;
  const half = Math.floor(traces.length / 2);
  const rate = (t: typeof traces) => (t.length ? t.filter((x) => x.retries === 0 && x.ok).length / t.length : 0);
  const early = traces.slice(0, Math.max(half, 1));
  const late = traces.slice(half);

  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-5xl">
        <div className="grid grid-cols-4 gap-3">
          <Stat n={memory.glossary.length} label="terms learned" />
          <Stat n={memory.skills.length} label="proven queries" />
          <Stat n={memory.scars.length} label="lessons from failures" />
          <Stat
            n={traces.length >= 4 ? `${Math.round(rate(early) * 100)}→${Math.round(rate(late) * 100)}%` : `${traces.length}`}
            label={traces.length >= 4 ? "first-try success, early → recent" : "questions answered"}
          />
        </div>

        <div className="mt-6 flex gap-1 rounded-lg border border-line bg-panel p-1 text-sm w-fit">
          {(["memory", "schema", "folders"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx("rounded-md px-4 py-1.5 capitalize", tab === t ? "bg-white/10 text-white" : "text-mute")}>
              {t === "memory" ? "What Harry learned" : t === "schema" ? "Schema map" : "Folders"}
            </button>
          ))}
        </div>

        {tab === "memory" && (
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Section title="Glossary" empty="Correct an answer with “Teach Harry” to add terms.">
              {memory.glossary.map((g) => (
                <Row key={g.term} title={g.term} body={g.definition} />
              ))}
            </Section>
            <Section title="Lessons from failures" empty="When a query fails and Harry repairs it, the lesson lands here.">
              {memory.scars.map((s, i) => (
                <Row key={i} title={s.lesson} body={`from: ${s.question}`} />
              ))}
            </Section>
            <Section title="Proven queries" empty="Questions that returned results are saved and reused.">
              {[...memory.skills].reverse().map((s, i) => (
                <Row key={i} title={s.question} body={`${s.db}.${s.collection} · ${s.pipeline.length} stages · used ${s.uses}×`} />
              ))}
            </Section>
            <Section title="Harness changes (versioned, gated)" empty="Every change Harry makes to itself is logged here.">
              {[...memory.versions].reverse().slice(0, 40).map((v) => (
                <div key={v.v} className="flex items-start gap-2 py-1.5 text-xs">
                  <span className="font-mono text-mute">v{v.v}</span>
                  <Pill tone={v.gate === "approved" ? "brand" : "bad"}>{v.gate}</Pill>
                  <Pill>{v.kind}</Pill>
                  <span className="selectable flex-1">{v.change}{v.reason ? ` (${v.reason})` : ""}</span>
                </div>
              ))}
            </Section>
            <div className="col-span-2 flex justify-end">
              <Button
                variant="danger"
                onClick={async () => {
                  if (!confirm("Erase everything Harry learned?")) return;
                  const m = emptyMemory();
                  await saveMemory(m);
                  onMemory(m);
                }}
              >
                Reset memory
              </Button>
            </div>
          </div>
        )}

        {tab === "schema" && (
          <div className="mt-4 grid grid-cols-2 gap-4">
            {src.schemas.map((s) => (
              <Card key={`${s.db}.${s.name}`} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-sm">
                    <span className="text-mute">{s.db}.</span>
                    {s.name}
                  </div>
                  <div className="flex gap-1.5">
                    {s.source === "file" && <Pill tone="warn">file</Pill>}
                    <Pill>{s.count.toLocaleString()} docs</Pill>
                  </div>
                </div>
                <div className="mt-3 space-y-1">
                  {s.fields.slice(0, 16).map((f) => (
                    <div key={f.path} className="flex gap-2 text-xs">
                      <span className="w-40 truncate font-mono">{f.path}</span>
                      <span className={f.types.length > 1 ? "text-amber-300" : "text-brand-2"}>{f.types.join(" | ")}</span>
                      <span className="flex-1 truncate text-mute">{f.examples.join(", ")}</span>
                      {f.presence < 0.9 && <span className="text-amber-300">{Math.round(f.presence * 100)}%</span>}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}

        {tab === "folders" && (
          <div className="mt-4 space-y-4">
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">Folders Harry can read</div>
                  <div className="text-xs text-mute">CSV, TSV and JSON become queryable tables. Markdown and text become notes. Hidden files, secrets and keys are always skipped.</div>
                </div>
                <Button onClick={add}>+ Add folder</Button>
              </div>
              <div className="mt-4 space-y-2">
                {roots.length === 0 && <div className="text-sm text-mute">No folders yet.</div>}
                {roots.map((r) => (
                  <div key={r} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                    <span className="selectable font-mono text-xs">{r}</span>
                    <Button variant="ghost" className="text-xs" onClick={async () => onRoots(await api.revokeFolder(r))}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
            {files.length > 0 && (
              <Card className="p-5">
                <div className="mb-2 text-sm font-medium">{files.length} readable files</div>
                <div className="max-h-72 space-y-1 overflow-y-auto">
                  {files.map((f) => (
                    <div key={f.path} className="flex justify-between text-xs">
                      <span className="font-mono">{f.rel}</span>
                      <span className="text-mute">{(f.size / 1024).toFixed(1)} KB</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <ErrorBox>{err}</ErrorBox>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <Card className="p-4">
      <div className="text-3xl font-semibold text-brand-2 tabular-nums">{n}</div>
      <div className="mt-0.5 text-xs text-mute">{label}</div>
    </Card>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const list = Array.isArray(children) ? children : [children];
  return (
    <Card className="p-4">
      <div className="mb-2 text-[11px] font-medium tracking-wide text-mute uppercase">{title}</div>
      <div className="max-h-72 divide-y divide-line/60 overflow-y-auto">{list.length ? children : <div className="py-2 text-sm text-mute">{empty}</div>}</div>
    </Card>
  );
}

function Row({ title, body }: { title: string; body: string }) {
  return (
    <div className="selectable py-2">
      <div className="text-sm">{title}</div>
      <div className="text-xs text-mute">{body}</div>
    </div>
  );
}
