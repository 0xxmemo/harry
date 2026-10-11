"""Does Harry's reviewer learn anything real? Test it on a founder's actual outreach.

Input: labeled.json (private; never committed): one row per thread the sender started, with
category, first email body, and whether a human replied. Build it from Gmail via Composio.

Method (same honesty rules as the simulator):
  1. Split threads 50/50 into train and test with a fixed seed, stratified by category.
  2. The reviewer (Opus) reads ONLY the train emails and their replied/no-reply labels, and writes
     playbook rules for what gets replies. It never sees the test set.
  3. A scorer (Haiku) rates each test email's chance of a reply under three conditions:
     no rules, the learned rules, and a random-rule control.
  4. Score with AUC (0.5 = chance) and a bootstrap 95% interval on learned - control.
Bodies are redacted (emails, URLs, phone numbers, quoted history) before any model sees them.

  python3 scripts/realmail/eval.py ~/.harry/realmail/labeled.json
"""
import json, random, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SEED = 20261011
REVIEWER, SCORER = "claude-opus-5-5", "claude-haiku-5-5"


def llm(system, prompt, model, tries=4):
    for i in range(tries):
        p = subprocess.run(["openllm", "-p", "-", "-m", model, "-s", system, "--no-stream"], input=prompt, capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout.strip()
    raise RuntimeError(p.stderr[-300:])


def js(text):
    return json.loads(text[text.find("{"):text.rfind("}") + 1])


def redact(body):
    body = re.split(r"\nOn .{5,120}wrote:|\n-----Original Message|\n>", body)[0]
    body = re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "[email]", body)
    body = re.sub(r"https?://\S+", "[link]", body)
    body = re.sub(r"\+?\d[\d\s().-]{7,}\d", "[phone]", body)
    # Names: the greeting's addressee and the sender's sign-off.
    body = re.sub(r"^(\s*(?:hi|hey|hello|dear|hola)\s+)[^\n,!]{1,40}", r"\1[name]", body, flags=re.I)
    body = re.sub(r"\b(Jonathan|Jonny|Archer)\b", "[sender]", body)
    return body.strip()[:1500]


def auc(scores, labels):
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    if not pos or not neg:
        return float("nan")
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))


REVIEW_SYS = """You improve an outreach playbook from real results. You see cold and warm outreach emails a founder sent (to users, podcast hosts, investors, and partners), each labeled REPLIED or NO REPLY.
Find what separates the emails that got replies from the ones that didn't. Write rules a sender could follow next time.
Reply ONE JSON object: {"rules": ["...", ...], "rationale": "2 sentences on the pattern"}. 5 to 8 rules. Each rule short, specific, and checkable from the email text alone. No rules about who the recipient is."""

SCORE_SYS = """You estimate how likely an outreach email is to get a human reply. Answer from the email text only.
{rules}Reply ONE JSON object: {{"p": <integer 0-100>}}."""

RANDOM_RULES = ["Mention the weather or season in the first line.", "Use exactly three paragraphs.", "Include a P.S. line.",
                "Put the most important word of the subject in capitals.", "Sign off with the sender's full name and title.", "Use at least one exclamation mark."]


def main(path):
    rows = [r for r in json.loads(Path(path).read_text()) if len(redact(r["body"])) > 40]
    rnd = random.Random(SEED)
    train, test = [], []
    for cat in sorted({r["category"] for r in rows}):
        group = sorted((r for r in rows if r["category"] == cat), key=lambda r: r["thread"])
        rnd.shuffle(group)
        train += group[: len(group) // 2]
        test += group[len(group) // 2:]
    print(f"{len(rows)} threads · train {len(train)} ({sum(r['replied'] for r in train)} replied) · test {len(test)} ({sum(r['replied'] for r in test)} replied)")

    shown = "\n\n---\n\n".join(f"[{'REPLIED' if r['replied'] else 'NO REPLY'} · {r['category']}]\nSubject: {r['subject']}\n{redact(r['body'])}" for r in train)
    learned = js(llm(REVIEW_SYS, shown, REVIEWER))
    print("\nRules the reviewer learned from the train half:")
    for x in learned["rules"]:
        print("  -", x)
    print("  why:", learned["rationale"])

    conditions = {
        "no rules": "",
        "learned rules": "A playbook learned from this sender's past results says replies come from emails that follow these rules:\n" + "\n".join(f"- {x}" for x in learned["rules"]) + "\n",
        "random rules": "A playbook says replies come from emails that follow these rules:\n" + "\n".join(f"- {x}" for x in random.Random(SEED).sample(RANDOM_RULES, 5)) + "\n",
    }

    def score(args):
        cond, r = args
        try:
            return js(llm(SCORE_SYS.format(rules=conditions[cond]), f"Subject: {r['subject']}\n\n{redact(r['body'])}", SCORER))["p"]
        except Exception:
            return 50

    labels = [r["replied"] for r in test]
    res = {}
    with ThreadPoolExecutor(10) as pool:
        for cond in conditions:
            res[cond] = list(pool.map(score, [(cond, r) for r in test]))

    print("\nPredicting replies on the held-out half (AUC, 0.5 = chance):")
    for cond, s in res.items():
        print(f"  {cond:14} {auc(s, labels):.2f}")
    # Category alone is a strong baseline (investors reply far more than cold users); report it too.
    base = {c: sum(r["replied"] for r in train if r["category"] == c) / max(1, sum(r["category"] == c for r in train)) for c in {r["category"] for r in train}}
    print(f"  {'category only':14} {auc([base.get(r['category'], 0) for r in test], labels):.2f}  (baseline: train reply rate of the email's category)")

    boot = random.Random(SEED + 1)
    diffs = []
    for _ in range(2000):
        idx = [boot.randrange(len(test)) for _ in test]
        l = [labels[i] for i in idx]
        diffs.append(auc([res["learned rules"][i] for i in idx], l) - auc([res["random rules"][i] for i in idx], l))
    diffs = sorted(d for d in diffs if d == d)
    lo, hi = diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs))]
    gain = auc(res["learned rules"], labels) - auc(res["random rules"], labels)
    print(f"\nLearned − random: {gain:+.2f} AUC (95% CI {lo:+.2f} to {hi:+.2f}) → {'REAL SIGNAL' if lo > 0 else 'not distinguishable from noise'}")

    out = Path(path).with_name("eval_result.json")
    out.write_text(json.dumps({"rules": learned, "auc": {c: auc(s, labels) for c, s in res.items()}, "ci": [lo, hi], "n_train": len(train), "n_test": len(test)}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
