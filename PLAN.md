# Harry: Your Best Sales Rep

A Tauri Mac app for sales teams. Harry follows up with every lead from the rep's own mailbox through their Composio account, moves deals through your pipeline one goal at a time, coaches your reps from their recorded calls, and answers questions about your sales data. Every change Harry makes to his own playbook is tested against a baseline, kept only if it wins, and versioned in MongoDB Atlas.

Built for the Harness Engineering & Model Wrangling #SFTechWeek Hackathon.
- **Statement 1 (Recursive Harnessing):** Harry rewrites his own per-stage playbooks, rules, and query skills, behind a deterministic policy gate.
- **Statement 2 (Long Horizon):** deals span days to weeks; Harry keeps per-contact memory and checkpoints in Atlas and resumes after a crash without repeating actions.
- **Self-improvement from traces:** every run is traced in Atlas; flagged failures feed the playbook reviewer.

## Principles

- **One integration: Composio.** Every outside service (email, CRM, calendar) goes through the user's own Composio account. Harry has no other third-party connectors. Users bring an existing Composio account or create one during setup.
- **The app holds no credentials.** Local CLIs (`atlas`, `mongosh`, `openllm`, `composio`) store their own tokens; provider OAuth lives in the user's Composio account.
- **Local files only with consent.** Harry reads only folders the user explicitly grants.
- **Self-contained database.** Harry's database user can read and write only the `harry` database it provisions on the user's Atlas cluster, with no access to anything else. A deterministic gate checks every pipeline before it runs.
- **Never invent data.** Every number in an answer traces back to a query result or a transcript line.
- **A human approves anything that leaves Harry.** Harry drafts follow-ups, CRM notes, and playbook changes; a person approves them. Email is sent from the rep's own mail app only after approval (or under an explicit, capped auto-send rule the user turns on per stage). Harry never changes a deal stage on his own.
- **Self-improvement is earned, not assumed.** A playbook change ships only if it beats the current version on held-out buyers and doesn't hurt later stages.

## Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust), `tauri-plugin-shell` to spawn CLIs and stream output |
| UI | React, TypeScript, Tailwind, Recharts |
| Auth / clusters | Atlas CLI (`atlas auth login` browser login) |
| Queries | `mongosh --quiet --json=relaxed --eval` |
| LLM | `openllm -p - -m <model> -s <system> --no-stream` (prompt on stdin); agent, reviewer, and simulated buyers on **different** models |
| Email, CRM, calendar | Composio CLI, the single integration layer: Gmail or Outlook, HubSpot / Salesforce / Pipedrive, Google Calendar or Outlook Calendar, all as Composio toolkits on the user's account |
| Transcripts | User drops exported files into a granted folder or the app window |
| Harry's memory | Harry's own Atlas DB: pipelines, deals, playbooks, calls, glossary, skills, scars, traces |
| Retrieval | Atlas Vector Search (Atlas automated embeddings) |
| Observability | Traces in Atlas for every agent, reviewer, Composio action, and query run, shown in the app |

## Architecture

```
React UI
  │  invoke / events
Rust backend (CLIRunner)
  ├─ atlas    → login, clusters, dbuser scoped to readWrite@harry, connection string
  ├─ mongosh  → schema sampling, aggregation execution
  ├─ openllm  → follow-ups, call scoring, playbook review, question → pipeline
  └─ composio → link providers, send approved email, fetch replies, read/write CRM, check calendar
File reader → granted folders only (CRM exports, call transcripts)
Policy gate (deterministic Rust): read-only stages, limits, firm sales rules
Pipeline engine: stage config → goals → checks → owner (agent / human)
Simulator (separate service + separate Atlas DB): buyer personas with hidden traits
Memory (Harry Atlas DB): pipelines · deals · playbooks · calls · glossary · skills · scars · runs · traces
```

The agent talks only to Atlas. Outgoing email goes through an outbox: Harry writes a draft to `outbox`, a human approves, and a sender worker delivers it through Composio. Replies are pulled back into `interactions`. CRM data arrives through the user's Composio-linked CRM (or CSV import), that translate into one standard format; the simulator is just another connector, so playbooks learned in simulation run unchanged on real data.

## Features

### 0. Setup
Keep it minimal for the hackathon.
- **Detect:** resolve `openllm`, `atlas`, `mongosh` on PATH (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, then `zsh -lc which`). Show version and status per tool.
- **Missing tools:** show the one-line install command with a copy button. (Stretch: one-click install with streamed output.)
- **Auth OpenLLM:** paste-API-key field → `openllm login` with the key on stdin (never argv, never logged). Verify with a cheap `openllm -p` call on a small model.
- **Auth Atlas:** `atlas auth login`; parse the verification URL/code from stdout, open the browser, verify with `atlas auth whoami`.
- **Connect Composio:** detect the `composio` CLI (show the install command if missing), then `composio login` in the browser. No account? Link to sign up, then log in. Harry stores nothing; the CLI keeps the session.
- **Link providers:** one screen listing what Harry can use: email (Gmail / Outlook), CRM (HubSpot / Salesforce / Pipedrive), calendar (Google / Outlook). Each "Link" runs `composio link <toolkit>` and opens the provider's sign-in. Linked accounts and addresses show in the status bar with disconnect buttons.
- Cancel kills the child process; timeouts surface a retry.

### 1. Connect your CRM
One standard format in Atlas (`contacts`, `deals`, `interactions`), one small connector per source. Each connector does four things: pull contacts, pull new activity, write back (notes and tasks only), and report what it supports.
- **Try demo CRM:** one click to the seeded sandbox cluster.
- **CSV import:** HubSpot, Salesforce, Pipedrive, or spreadsheet exports, with a field-mapping step. Covers almost every CRM.
- **Live CRM via Composio:** HubSpot, Salesforce, or Pipedrive linked in Composio (read contacts and deals, write a note and a task). Same connector shape for all three; only the toolkit name and field mapping differ.
- **Write-back safety:** tag everything Harry creates, never edit or delete existing records, and record an idempotency key per write in Atlas so a restart never duplicates a note.

### 2. Configurable pipeline
The pipeline is a config file, not code. Each stage defines:

| Setting | Example |
|---|---|
| Goal | "Call booked" |
| Success check | Calendar event exists / CRM stage changed (checked in code, never by the LLM) |
| Owner | `agent`, `human`, or `human_assisted` |
| Allowed actions | send email, propose times, send listings |
| Playbook | per-stage rules and message variants, improved separately |
| Firm limits | rules the agent can never change |
| Stuck rule | e.g. 3 unanswered follow-ups → pause or move back |

Ship two configs:
- **SaaS** (fully run in the demo): email reply → call booked → sales call (human) → follow-up and close (human-assisted).
- **Real estate** (config swap in the demo): engaged → tour booked → home shortlisted → offer submitted (human) → closed (human). Firm limit: fair-housing rules.

### 3. Follow-up agent
- For each deal, Harry reads the stage config, the stage playbook, and the contact's memory (past objections, tone, last touch), then drafts the next message.
- Variants per stage are chosen with a multi-armed bandit, so traffic shifts toward winners with small sample sizes.
- Each step is checkpointed in `runs`. Kill the app mid-run and restart: Harry resumes from the checkpoint and sends nothing twice.

### 3b. Email via Composio
Real email from the rep's own inbox, so replies thread naturally and land in their Sent folder. Gmail and Outlook both come through the same Composio account.
- **Link:** `composio link gmail` (or `outlook`). Composio's verified apps handle OAuth; no Google Cloud project for us. Multiple reps link with `--alias`.
- **Outbox flow:** Harry drafts → `outbox` (status `draft`) → rep reviews/edits in the app → `approved` → sender worker runs `composio execute GMAIL_SEND_EMAIL` (or the Outlook equivalent) → stores the message/thread id → `sent`.
- **No double sends:** each outbox item has an idempotency key; the worker marks `sending` before the call and, after a crash, checks Sent for that key (stored thread id or a header) before retrying. Same resume story as the follow-up agent.
- **Replies are the real learning signal:** poll `GMAIL_FETCH_EMAILS` for tracked threads (stretch: `composio listen` triggers). Replies go into `interactions`, update contact memory, and count as a stage outcome (reply / meeting request / unsubscribe) for the bandit. Same scoring as the simulator.
- **Calendar:** stage success checks like "call booked" read the linked calendar through Composio.
- **Edits are signal too:** when a rep edits a draft before approving, the diff is stored and fed to the reviewer.
- **Safety (policy gate, in Rust, right before every Composio call):** the call must match the approved outbox item exactly (recipient, subject, body hash); only allow-listed Composio actions (send, fetch, read CRM, create note/task, read calendar; never delete); per-contact and per-day send caps; opt-outs honored; business hours only; demo mode restricts recipients to an allowlist. Auto-send, if enabled for a stage, still respects all caps and is logged.

### 4. Call transcripts (drop-in)
No Google Meet API, no OAuth. Reps export the transcript from whatever they already use and drop it in.
- **How:** drag files onto the app, or put them in a granted `Calls` folder that Harry watches.
- **Formats:** `.txt`, `.docx`, `.vtt`, `.srt`, `.json`. Covers Google Meet (transcript Doc downloaded as .docx/.txt), Zoom (.vtt), Teams (.vtt/.docx), Otter, Fireflies, Fathom, and Gong exports.
- **Parsing:** normalize to speaker turns `{speaker, start, text}`. Detect the rep vs. the buyer using the rep roster and contact names; ask the user to confirm if unsure.
- **Deal matching:** suggest a deal from names, emails, company, and date in the file; the user confirms with one click.
- **Dedup:** file hash stored in `calls`, so dropping the same file twice does nothing.
- **What Harry does with a call:**
  1. **Before** the next call: a brief for the rep (past objections, what this buyer cares about, suggested questions).
  2. **After** the call: scores it against the company's checklist for that stage (budget discussed, objection handled, next step agreed), with coaching notes quoting the transcript.
  3. **Follow-up:** drafts the email from what was actually said, for the rep to approve.
  4. **Learning:** when a rep handles an objection well, Harry proposes it as a new playbook rule with the source quote. A manager approves before it's tested.
- **Rules:** only process calls where participants were told they were recorded (checkbox on import); rep scores visible to the rep and their manager only; coaching, not ranking.

### 5. Ask Harry
Plain-language questions about the pipeline: "Why are deals stalling after the first call?", "Top objection from fintech buyers?", "Which email variant books the most calls?"
- **Tool hierarchy, not raw queries:** overview (funnel by stage) → stage detail (objections, best playbook) → deal detail (history and calls) → search (similar past conversations via Vector Search). Harry starts broad and drills down only when needed. Measure cost and latency before/after from Harry's own traces.
- Question + schema + glossary/skills/scars → `openllm` → aggregation pipeline → policy gate → `mongosh` → table + chart + trace.
- **Answers lead to actions:** "Deals stall at call booked" → "Want me to test a new follow-up for this stage?" which starts a playbook experiment.
- This is a skill of Harry's, not the product. The product is the agent that moves deals and improves itself.

### 6. Learning loop (the recursive harness)
- **Playbooks (per stage):** after each round, a reviewer reads failed conversations and flagged traces, proposes specific rule changes, and the new version runs against **held-out** simulated buyers. Kept only if it beats the current version beyond the noise band and doesn't hurt downstream stages; otherwise rolled back. Each version stores its parent, diff, rationale, and scores.
- **Insights from humans:** approved rules learned from rep calls enter the same test-then-keep path.
- **Glossary:** corrections like "stalled means no activity for 14 days" stored as term → field/logic.
- **Skills:** query pipelines that worked, embedded and reused for similar questions.
- **Scars:** failed queries and corrections, recalled so the same mistake isn't repeated.
- Every change to Harry's rules passes the policy gate and is versioned in `harness_versions`.

### 7. Simulator (evaluation)
- ~20 buyer personas with hidden traits: objections, budget, preferred tone, per-stage readiness, ghosting threshold.
- Runs as a separate service with its own Atlas database and DB user. Harry only sends a message and receives a reply; the reviewer never sees personas.
- Outcomes (reply / book / drop) come from persona rules plus a seeded roll. An LLM writes the buyer's words and answers narrow yes/no checks ("did this address security?"), never "were you convinced?"
- Train set is fixed; test set is generated from a seed whose hash is committed before each round (commit-reveal).
- Baselines on the chart: seed variance band, deliberately bad playbook, random-edit control, and a "cheat ceiling" playbook that can see hidden traits.
- All LLM responses cached in Atlas by input hash so any seed can be replayed exactly.
- Base reply rates calibrated to published cold-email benchmarks; includes out-of-office, unsubscribes, and "send me info" ghosts.

## Policy gate (deterministic)

- **Queries:** allow-listed stages only (`$match $project $group $sort $limit $lookup $unwind $addFields $count $facet $bucket`). Reject `$out`, `$merge`, `$function`, `$where`, `$accumulator`. Force `$limit` (default 500) and `maxTimeMS`.
- **Agent actions:** max messages per contact per week and per mailbox per day, opt-outs always honored, no invented discounts or prices, no stage changes or sends without approval (or an explicit per-stage auto-send rule), recipient allowlist in demo mode. The gate runs in Rust right before every Composio call, not in the prompt.
- **Harness edits:** firm limits are not editable by the reviewer; any proposed playbook that removes or contradicts a firm limit is rejected before testing.
- **Transcripts:** only from granted folders or drag-drop; deny hidden files, `.env`, keys; symlinks resolved and checked.

## Data model (Harry's DB)

| Collection | Contents |
|---|---|
| `connections` | cluster metadata and linked Composio toolkits (no secrets) |
| `sources` | granted folder roots, file paths, hashes |
| `pipelines` | stage configs per company, versioned |
| `contacts` | standard contact records, running summary, objections |
| `deals` | current stage, stage history with reasons |
| `interactions` | every message sent or received, thread reference, with embeddings |
| `outbox` | draft, edits, approval, status, idempotency token, sent confirmation |
| `calls` | transcript turns, matched deal, file hash, score, coaching notes |
| `reps` | roster, strengths, coaching history |
| `insights` | lessons from calls, source quotes, approval status |
| `playbooks` | per-stage versions: parent, diff, rationale, scores |
| `runs` | checkpoints and idempotency keys for resumable execution |
| `evals` | scores per round, seed, playbook version, baselines |
| `schemas` | inferred schema per cluster/collection |
| `glossary` | term, definition, field mapping, source correction |
| `skills` | question, pipeline, embedding, success count |
| `scars` | question, failed pipeline, error/correction, embedding |
| `traces` | prompt, pipeline/action, Composio action + result, latency, cost |
| `harness_versions` | versioned rule changes and gate decisions |

Simulator personas live in a **separate** database that Harry's DB user cannot read.

## Demo CRM seed

`accounts`, `contacts`, `deals`, `activities`, `reps`, deliberately messy (inconsistent stage names, missing fields), plus:
- a few large deals stalled for 14+ days
- two sample call transcripts in different formats (Meet .docx, Zoom .vtt), one with a rep handling a security objection well

## Directory layout

```
harry/
  PLAN.md
  src-tauri/        Rust: CLIRunner, policy gate, Composio runner, transcript parsers, commands
  src/              React UI: Connect, Pipeline, Deals, Calls, Ask, Trace, Improvement chart
  pipelines/        saas.yaml, real_estate.yaml
  sim/              buyer service, personas, seeds, commit-reveal
  scripts/seed/     demo CRM + sample transcripts
```

## Build order (two people, submissions due 5:00 PM)

**Person A: simulator + learning loop**
1. Shared message contract (agent ↔ simulator) agreed with Person B first.
2. Simulator service, personas, seeded outcomes, LLM cache.
3. Eval runner: train/test split, commit-reveal, baselines.
4. Reviewer → playbook versions → keep or roll back.

**Person B: app + agent + calls**
1. Scaffold Tauri 2 + React. CLIRunner with streaming, stdin secrets, cancel.
2. Minimal setup + Connect (demo CRM, CSV import).
3. Pipeline engine from `saas.yaml`; follow-up agent with checkpoints.
3b. Composio: login, link Gmail (+ CRM, calendar), outbox + approve, send, fetch replies.
4. Transcript drop-in: parsers, deal matching, scoring, follow-up draft, insight → playbook proposal.
5. Ask Harry with the tool hierarchy (if time).

**Both, from ~3:30 PM:** trace view, improvement chart, record backup demo video by 4:00, then the 1-minute submission video. Feature freeze at 3:30.

Cut if behind, in this order: Ask Harry → live CRM via Composio (keep CSV) → reply triggers (keep polling) → calendar check → setup install buttons → real-estate run (keep the config swap).

## Demo script (3 minutes)

1. **Problem (0:20):** follow-ups are generic and never get better.
2. **Round 1 (0:30):** Harry follows up with simulated buyers; 22% reply. Open the trace where Harry ignored a security objection.
3. **Drop in a call (0:30):** drag a Meet transcript into Harry. He matches the deal, scores the call, and proposes the rep's security answer as a new rule. Approve it.
4. **Harry improves (0:30):** reviewer diffs the playbook, tested on unseen buyers, kept. Funnel shows the bottleneck stage improving, above the noise band and the random-edit control.
5. **Real email (0:20):** approve one follow-up; it goes out through Composio from the rep's Gmail and lands in a teammate's inbox. They reply live, and Harry pulls the reply into the deal and logs the outcome.
6. **Kill and resume (0:20):** stop the app mid-run, restart, Harry resumes from the Atlas checkpoint with no duplicate messages.
7. **Configurable (0:15):** swap to `real_estate.yaml`; Harry starts working toward "tour booked." Show the firm limits.
8. **Close (0:10):** "Harry follows up with every lead, learns from every call, and every change he makes to himself is tested and approved."

## Already built (current `harry/` code)

- **Setup:** detects and installs `openllm`, `atlas`, `mongosh`, `composio`; `openllm login` (key on stdin); Atlas device-code login; Composio browser login + provider linking (Gmail/Outlook, HubSpot/Salesforce/Pipedrive, Google/Outlook Calendar).
- **Connect:** demo CRM (now with contacts), CSV import with field mapping, Atlas cluster (temp read-only user), pasted URI.
- **Pipelines:** `pipelines/saas.yaml` and `real_estate.yaml`, switchable in the sidebar; firm limits shown and enforced.
- **Follow-up agent:** Thompson-sampling variants, drafts into `outbox` with deterministic ids, checkpointed runs with a "Kill mid-run" / "Resume from checkpoint" demo.
- **Outbox via Composio:** approve freezes a content hash in Rust; send re-checks the hash, message rules, caps, opt-outs, business hours, allowlist; `sending` state + Sent-folder check prevents double sends; replies fetched and classified into `interactions`, unsubscribes become opt-outs.
- **Calls:** drag-drop or import `.vtt/.srt/.txt/.docx/.json` (Rust parsers, tested on two samples in `demo-crm/calls/`), file-hash dedup, consent checkbox, deal matching, quote-verified scorecard, coaching, next-call brief, follow-up draft, proposed rule → manager approval.
- **Improve:** simulator (seeded personas with hidden traits, narrow yes/no checks on a separate model, cached by input hash), commit-reveal test seed, reviewer on a third model, policy-gated edits, paired noise band, random-edit control, keep-or-rollback with versioned playbooks and a chart.
- **Ask Harry / Harry's brain:** unchanged (query loop, glossary/skills/scars).

Not done: state lives in local JSON (`store` collections mirror the Atlas data model) and must move to Atlas; no tool-hierarchy for Ask; Composio output shapes and Gmail argument names are unverified until someone logs in; "cheat ceiling" and "bad playbook" baselines not built; no calendar success check yet.

## Open items to verify

- ~~`openllm` inference/login~~ Verified: `openllm login` reads the key from stdin; `openllm -p - -m <model> -s <system> --no-stream` reads the prompt from stdin and prints the reply. It doesn't report token usage, so traces estimate tokens from length.
- ~~`atlas auth login` output~~ Verified (Atlas CLI 1.59): `--authType UserAccount --output json --noBrowser` prints a code like `GX38-4GJD` and `https://account.mongodb.com/account/connect`.
- ~~Atlas flags~~ Verified: `dbusers create --deleteAfter <ISO UTC>` and `accessLists create --currentIp --deleteAfter <ISO UTC>` both exist.
- Project must run on the **MongoDB Atlas Sandbox** cluster; repo must be public.
- Whether Atlas automated embeddings are available on the Sandbox cluster.
- `.docx` parsing in Rust (or parse in the TS layer).
- Composio CLI: exact `login` / `link` commands, and argument names for `GMAIL_SEND_EMAIL`, `GMAIL_FETCH_EMAILS`, CRM and calendar actions via `--get-schema`; how to reply in a thread; whether a header can carry the idempotency key.
- Composio account model: each user signs in with their own account (no shared project key in the app).
- Test sending early; send only to your own two inboxes during the hackathon.
