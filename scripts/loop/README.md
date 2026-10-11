# Headless learning loop

Runs the app's own improvement rounds (`src/lib/improve.ts` + `src/lib/sim.ts`) from the terminal,
with Harry's memory (playbooks, evals, LLM cache, traces) in MongoDB Atlas instead of local JSON.
`shim.ts` stands in for the Tauri bridge: LLM calls go to the `openllm` CLI, the store goes to Atlas,
and the playbook gate is a TS port of `gate.rs::gate_playbook`.

```sh
# HARRY_ATLAS_URI=mongodb+srv://user:pass@cluster0.shp2nv.mongodb.net/   (read-write user)
bun --preload ./scripts/loop/shim.ts scripts/loop/run.ts --stage reply --rounds 3 --n 20 --fresh
```

Flags: `--pipeline saas|real_estate`, `--stage <id>`, `--rounds`, `--n` (buyers per run), `--fresh`
(clear playbooks/evals for the pipeline). `HARRY_DB` picks the database (default `harry`),
`HARRY_LLM_PARALLEL` caps concurrent LLM calls (default 8).

Each round: commit a held-out seed hash → train run → reviewer (different model) proposes edits →
policy gate → candidate vs current vs random-edit control on the revealed seed → kept only if the
gain beats the paired noise band and unsubscribes don't rise. Every version and round is in Atlas.
