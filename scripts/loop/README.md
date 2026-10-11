# Headless learning loop

Runs the app's own improvement rounds (`src/lib/improve.ts` + `src/lib/sim.ts`) from the terminal,
with Harry's memory (playbooks, evals, LLM cache, traces) in MongoDB Atlas instead of local JSON.
`shim.ts` stands in for the Tauri bridge: LLM calls go to the `openllm` CLI, the store goes to Atlas,
and the playbook gate is a TS port of `gate.rs::gate_playbook`.

```sh
# HARRY_ATLAS_URI=mongodb+srv://user:pass@cluster0.shp2nv.mongodb.net/   (read-write user)
bun --preload ./scripts/loop/shim.ts scripts/loop/run.ts --stage reply --rounds 3 --n 20 --fresh
```

Flags: `--stage <id>`, `--rounds`, `--n` (buyers per run), `--fresh`
(clear playbooks/evals for the pipeline). `HARRY_DB` picks the database (default `harry`),
`HARRY_LLM_PARALLEL` caps concurrent LLM calls (default 8).

Each round: commit a held-out seed hash → train run → reviewer (different model) proposes edits →
policy gate → candidate vs current vs random-edit control on the revealed seed → kept only if the
gain beats the paired noise band and unsubscribes don't rise. Every version and round is in Atlas.

## Raindrop

With `RAINDROP_WRITE_KEY` set, every LLM call in a round becomes a Raindrop event:
`harry_draft`, `buyer_check`, and `playbook_review`. `userId` is the simulated buyer's persona id
(the playbook id for reviews), `convoId` groups one round, and properties carry
run (train / test_current / test_candidate / test_random), stage, playbook version, variant, and seed.
Each draft gets outcome signals: `no_reply`, `reply`, `meeting_request`, `unsubscribe`, `auto_reply`,
plus `missed_objection` when the buyer had a concern the email ignored. Each `playbook_review` event
lists the draft event ids it read (`source_events`), and the resulting playbook version stores them too,
so every rule change links back to the traces that caused it. `RAINDROP_DEBUG=0` silences SDK logs.

## Regression set

Following howtoeval.com ("turn important failures into tests"; "20 high-signal cases beats 200"):
each round, the current playbook's held-out failures that matter (ignored the buyer's stated concern,
or pushy) are saved as regression cases in `evals` (`kind: "regression"`, max 20 per stage). Every
later candidate replays those exact buyers and must pass the same yes/no check; failing more than 20%
of them rolls the candidate back even if it beats the noise band.
