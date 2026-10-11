// CSV import: HubSpot / Salesforce / Pipedrive / spreadsheet exports mapped into Harry's one
// standard format (accounts, contacts, deals, reps), so every feature runs unchanged on it.

import { parseDelimited } from "./csv";
import { inferFields } from "./schema";
import { SourceSet } from "./sources";

type Doc = Record<string, unknown>;

export const TARGETS = ["deal", "company", "contact", "email", "amount", "stage", "owner", "lastActivity", "created", "closed", "title", "industry"] as const;
export type Target = (typeof TARGETS)[number];

const GUESS: Record<Target, RegExp> = {
  deal: /^(deal|opportunity)( name)?$|^name$/i,
  company: /company|account|organi[sz]ation/i,
  contact: /contact( name)?|full name|person/i,
  email: /e-?mail/i,
  amount: /amount|value|revenue|deal size/i,
  stage: /stage|status/i,
  owner: /owner|rep|assigned|user/i,
  lastActivity: /last (activity|contacted|touch|modified)/i,
  created: /creat/i,
  closed: /close ?date|closed/i,
  title: /title|job/i,
  industry: /industry|sector|vertical/i,
};

export function guessMapping(columns: string[]): Partial<Record<Target, string>> {
  const m: Partial<Record<Target, string>> = {};
  for (const t of TARGETS) {
    const hit = columns.find((c) => GUESS[t].test(c) && !Object.values(m).includes(c));
    if (hit) m[t] = hit;
  }
  return m;
}

export function readCsv(text: string) {
  const rows = parseDelimited(text, text.split("\n")[0].includes("\t") ? "\t" : ",");
  return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
}

const date = (v: unknown) => {
  if (v == null || v === "") return undefined;
  const d = new Date(String(v));
  return isNaN(+d) ? undefined : d;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function toSources(rows: Doc[], m: Partial<Record<Target, string>>, label: string): SourceSet {
  const get = (r: Doc, t: Target) => (m[t] ? r[m[t]!] : undefined);
  const accounts = new Map<string, Doc>(), contacts = new Map<string, Doc>(), reps = new Map<string, Doc>();
  const deals: Doc[] = [];
  rows.forEach((r, i) => {
    const company = String(get(r, "company") ?? "Unknown company");
    const aId = `a-${slug(company)}`;
    if (!accounts.has(aId)) accounts.set(aId, { _id: aId, name: company, industry: get(r, "industry") ?? null, tier: null });
    const owner = String(get(r, "owner") ?? "Unassigned");
    const rId = `r-${slug(owner)}`;
    if (!reps.has(rId)) reps.set(rId, { _id: rId, name: owner });
    let cId: string | undefined;
    const email = get(r, "email");
    if (email || get(r, "contact")) {
      cId = `c-${slug(String(email ?? get(r, "contact")))}`;
      if (!contacts.has(cId)) contacts.set(cId, { _id: cId, accountId: aId, name: get(r, "contact") ?? String(email).split("@")[0], email: email ?? null, title: get(r, "title") ?? null, timezone: "America/Los_Angeles" });
    }
    const stage = String(get(r, "stage") ?? "");
    const closed = date(get(r, "closed"));
    deals.push({
      _id: `d${i + 1}`,
      name: String(get(r, "deal") ?? `${company} deal`),
      accountId: aId,
      contactId: cId,
      ownerId: rId,
      amount: Number(get(r, "amount") ?? 0) || 0,
      currency: "USD",
      stage,
      createdAt: date(get(r, "created")),
      lastActivityAt: date(get(r, "lastActivity")),
      closedAt: /won|lost|closed/i.test(stage) ? closed ?? new Date() : undefined,
    });
  });
  const data: Record<string, Doc[]> = { accounts: [...accounts.values()], contacts: [...contacts.values()], reps: [...reps.values()], deals, activities: [] };
  const local = new Map<string, Doc[]>();
  const schemas = Object.entries(data).map(([name, docs]) => {
    local.set(`crm.${name}`, docs);
    return { db: "crm", name, count: docs.length, fields: inferFields(docs.slice(0, 60)), source: "demo" as const };
  });
  return { kind: "demo", label, schemas, local, notes: [] };
}
