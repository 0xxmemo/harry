<div align="center">

<img src="site/harry-face.png" alt="Harry" width="140" />

# Harry

### Your best sales rep. He learns from every deal.

[**Landing page →**](https://harry-mv4gavd1b9m-prod.cloud.modelence.app/) · Built for the #SFTechWeek Harness Engineering Hackathon

</div>

---

## What Harry does

| | |
|---|---|
| ✉️ **Follows up** | Drafts follow-up emails to every lead. You approve them before they're sent. |
| 📈 **Moves deals** | Works through your pipeline one stage at a time. |
| 🎧 **Coaches reps** | Scores recorded calls and suggests what to improve. |
| 💬 **Answers questions** | Answers questions about your sales data, using only real numbers from your data. |

## Built on MongoDB Atlas

Atlas is Harry's memory. It holds:

| What | Why |
|---|---|
| **Playbooks** | Every version Harry has written, so you can see how he improved |
| **Deals and contacts** | What Harry remembers about each lead, and your CRM data |
| **Outbox** | Draft emails waiting for your approval |
| **Traces** | A record of everything Harry did |

Harry sets up his own database on your cluster. He can't access anything else on it.

## How Harry learns

```
try playbook → suggest a change → test on new buyers → keep it only if it wins → repeat
```

Every round starts from the last winning playbook in Atlas. Harry gets better over time, and a bad change never ships.

## OpenLLM harness

All AI calls go through the `openllm` CLI. Every call records which model ran and how many tokens it used. The model that writes Harry's emails is never the one that grades them.

## Landing page

The landing page is the `site/` folder, deployed on **Modelence**:
https://harry-mv4gavd1b9m-prod.cloud.modelence.app/

## Run it

```sh
git clone https://github.com/0xxmemo/harry.git && cd harry && bun install && bun run app
```

You need the `atlas`, `mongosh`, `openllm`, and `composio` CLIs installed.

See [PLAN.md](PLAN.md) for the full design.
