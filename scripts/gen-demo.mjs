// Generates a deliberately messy demo CRM into demo-crm/*.json.
// Planted findings: stalled big deals, fast-first-touch win lift, a top rep, a record month.
import { mkdirSync, writeFileSync } from "node:fs";

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const DAY = 86400000;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();

const reps = [
  ["r1", "Maya Chen", "West"], ["r2", "Diego Alvarez", "West"], ["r3", "Priya Nair", "East"],
  ["r4", "Sam Okafor", "East"], ["r5", "Lena Fischer", "EMEA"], ["r6", "Tom Becker", "EMEA"],
  ["r7", "Aisha Rahman", "Central"], ["r8", "Jordan Lee", "Central"],
].map(([_id, name, region]) => ({ _id, name, region, email: `${name.split(" ")[0].toLowerCase()}@acme.io`, quota: 600000 }));

const prefixes = ["Nimbus", "Vertex", "Bluefin", "Quanta", "Helios", "Orbit", "Granite", "Lumen", "Cobalt", "Juniper", "Pioneer", "Atlas", "Summit", "Harbor", "Falcon"];
const suffixes = ["Labs", "Systems", "Health", "Logistics", "Bank", "Retail", "AI", "Foods", "Energy", "Media"];
const industries = ["SaaS", "Healthcare", "Logistics", "Fintech", "Retail", "Manufacturing", "Media"];
const accounts = [];
for (let i = 0; i < 70; i++) {
  const name = `${prefixes[i % prefixes.length]} ${suffixes[Math.floor(i / prefixes.length) % suffixes.length]}`;
  accounts.push({
    _id: `a${i + 1}`,
    name,
    industry: pick(industries),
    // messy: employees sometimes a string, sometimes missing
    employees: rand() < 0.1 ? undefined : rand() < 0.15 ? String(Math.floor(50 + rand() * 5000)) : Math.floor(50 + rand() * 5000),
    tier: rand() < 0.25 ? "Enterprise" : rand() < 0.5 ? "mid-market" : "SMB",
    ownerId: pick(reps)._id,
    weeklyActiveUsers: Math.floor(rand() * 400),
    wauTrend30d: Math.round((rand() * 1.2 - 0.6) * 100) / 100,
  });
}

const wonLabels = ["Closed Won", "closed-won", "Won"];
const lostLabels = ["Closed Lost", "closed-lost", "Lost"];
const openStages = ["Prospecting", "Discovery", "Demo", "Proposal", "Negotiation"];
const sources = ["Inbound", "Outbound", "Referral", "Event", "Partner"];
const deals = [];
const activities = [];
let actId = 1;

function addActivities(deal, start, end, n) {
  const types = ["email", "call", "meeting", "demo", "note"];
  let last = start;
  for (let k = 0; k < n; k++) {
    // last activity lands exactly on `end`
    const at = start + ((end - start) * (k + 1)) / n;
    activities.push({ _id: `x${actId++}`, dealId: deal._id, repId: deal.ownerId, type: pick(types), at: iso(at), note: `${pick(["Followed up on", "Discussed", "Sent", "Reviewed"])} ${pick(["pricing", "security review", "timeline", "integration", "procurement"])}` });
    last = at;
  }
  return last;
}

for (let i = 0; i < 320; i++) {
  const acct = pick(accounts);
  // r3 (Priya) is the planted top rep: more deals and a better win rate
  const owner = rand() < 0.2 ? reps[2] : pick(reps);
  const created = now - Math.floor(rand() * 330) * DAY;
  const fastTouch = rand() < 0.45;
  const firstTouchHours = fastTouch ? Math.floor(rand() * 24) : 24 + Math.floor(rand() * 200);
  let winP = fastTouch ? 0.46 : 0.2;
  if (owner._id === "r3") winP += 0.15;
  const amountBase = acct.tier === "Enterprise" ? 60000 : acct.tier === "SMB" ? 8000 : 25000;
  const amount = Math.round((amountBase * (0.5 + rand() * 1.6)) / 100) * 100;
  const deal = {
    _id: `d${i + 1}`,
    name: `${acct.name} — ${pick(["Platform", "Expansion", "Renewal", "Pilot", "Analytics add-on"])}`,
    accountId: acct._id,
    ownerId: owner._id,
    amount,
    currency: rand() < 0.08 ? "EUR" : "USD",
    source: pick(sources),
    createdAt: iso(created),
    firstTouchHours,
  };
  const age = (now - created) / DAY;
  const closes = age > 25 && rand() < 0.75;
  if (closes) {
    const won = rand() < winP;
    const cycle = (won ? 20 : 30) + rand() * (won ? 50 : 70);
    let closed = Math.min(now - DAY, created + cycle * DAY);
    // record month: push extra wins into last calendar month
    deal.stage = won ? pick(wonLabels) : pick(lostLabels);
    deal.closedAt = iso(closed);
    deal.lastStageChangeAt = deal.closedAt;
    deal.lastActivityAt = iso(addActivities(deal, created, closed, 3 + Math.floor(rand() * 8)));
  } else {
    deal.stage = pick(openStages);
    deal.expectedCloseAt = iso(now + Math.floor(rand() * 90) * DAY);
    deal.forecastCategory = pick(["Commit", "Best Case", "Pipeline"]);
    const lastAct = now - Math.floor(rand() * 9) * DAY;
    deal.lastStageChangeAt = iso(now - Math.floor(rand() * 30) * DAY);
    deal.lastActivityAt = iso(addActivities(deal, created, lastAct, 2 + Math.floor(rand() * 6)));
  }
  deals.push(deal);
}

// Planted: big open deals that have gone quiet (stage changed recently on some, so "stalled" is ambiguous)
const stalled = [
  ["Granite Bank — Platform", 182000, 31, 3], ["Helios Health — Expansion", 96000, 22, 25], ["Cobalt Logistics — Platform", 140000, 18, 2],
  ["Lumen AI — Analytics add-on", 74000, 16, 20], ["Summit Energy — Renewal", 58000, 27, 27],
];
stalled.forEach(([name, amount, quietDays, stageDays], k) => {
  const acctName = name.split(" — ")[0];
  let acct = accounts.find((a) => a.name === acctName);
  if (!acct) {
    acct = { _id: `a${accounts.length + 1}`, name: acctName, industry: pick(industries), employees: 1200, tier: "Enterprise", ownerId: reps[(k * 3) % 8]._id, weeklyActiveUsers: 140, wauTrend30d: -0.2 };
    accounts.push(acct);
  }
  const created = now - (60 + quietDays) * DAY;
  const deal = {
    _id: `d${deals.length + 1}`, name, accountId: acct._id, ownerId: reps[(k * 3) % 8]._id, amount, currency: "USD",
    source: "Outbound", createdAt: iso(created), firstTouchHours: 40, stage: pick(["Proposal", "Negotiation"]),
    forecastCategory: "Commit", expectedCloseAt: iso(now + 10 * DAY), lastStageChangeAt: iso(now - stageDays * DAY),
  };
  deal.lastActivityAt = iso(addActivities(deal, created, now - quietDays * DAY, 4));
  deals.push(deal);
});

// Planted record month: extra wins closed last calendar month
const d = new Date(now);
const lastMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
for (let k = 0; k < 14; k++) {
  const acct = pick(accounts);
  const closed = lastMonthStart + (2 + k * 2) * DAY;
  const deal = {
    _id: `d${deals.length + 1}`, name: `${acct.name} — Platform`, accountId: acct._id, ownerId: k % 2 ? "r3" : pick(reps)._id,
    amount: Math.round((30000 + rand() * 70000) / 100) * 100, currency: "USD", source: pick(sources),
    createdAt: iso(closed - 40 * DAY), firstTouchHours: Math.floor(rand() * 20), stage: "Closed Won", closedAt: iso(closed), lastStageChangeAt: iso(closed),
  };
  deal.lastActivityAt = iso(addActivities(deal, closed - 40 * DAY, closed, 5));
  deals.push(deal);
}

// Contacts: one or two buyers per account, on example domains so nothing real is ever emailed.
const first = ["Alex", "Jamie", "Morgan", "Riley", "Casey", "Taylor", "Jordan", "Avery", "Quinn", "Drew", "Skyler", "Reese"];
const last = ["Park", "Nguyen", "Garcia", "Kim", "Patel", "Novak", "Silva", "Cohen", "Ito", "Moreau", "Haddad", "Larsen"];
const titles = ["VP Sales", "Head of RevOps", "CTO", "Director of Operations", "CFO", "Head of IT", "COO"];
const contacts = [];
for (const a of accounts) {
  const n = rand() < 0.5 ? 1 : 2;
  for (let k = 0; k < n; k++) {
    const fn = pick(first), ln = pick(last);
    contacts.push({
      _id: `c${contacts.length + 1}`, accountId: a._id, name: `${fn} ${ln}`, title: pick(titles),
      email: `${fn}.${ln}@${a.name.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`.toLowerCase(),
      timezone: pick(["America/Los_Angeles", "America/New_York", "Europe/Berlin", "America/Chicago"]),
    });
  }
}
for (const deal of deals) {
  const c = contacts.filter((x) => x.accountId === deal.accountId);
  if (c.length) deal.contactId = c[0]._id;
}

mkdirSync("demo-crm", { recursive: true });
const clean = (x) => JSON.parse(JSON.stringify(x));
for (const [name, data] of Object.entries({ reps, accounts, contacts, deals, activities })) {
  writeFileSync(`demo-crm/${name}.json`, JSON.stringify(clean(data)));
}
console.log(`reps ${reps.length} · accounts ${accounts.length} · contacts ${contacts.length} · deals ${deals.length} · activities ${activities.length}`);
