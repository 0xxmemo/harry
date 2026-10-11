// Live HubSpot import through the user's Composio connection (`composio link hubspot`).
// Read-only list calls, mapped into the same standard format as the demo CRM and CSV import.

import { api } from "./api";
import { inferFields } from "./schema";
import { SourceSet } from "./sources";

type Doc = Record<string, unknown>;
type HsRecord = { id: string; properties: Record<string, string | null>; associations?: Record<string, { results: { id: string }[] }> };

const results = (v: unknown): HsRecord[] => {
  const o = v as { data?: { results?: HsRecord[] }; results?: HsRecord[] };
  return o?.data?.results ?? o?.results ?? [];
};
const nextAfter = (v: unknown): string | undefined => {
  const o = v as { data?: { paging?: { next?: { after?: string } } }; paging?: { next?: { after?: string } } };
  return (o?.data?.paging ?? o?.paging)?.next?.after;
};

async function listAll(slug: string, properties: string[], associations: string[] = []): Promise<HsRecord[]> {
  const out: HsRecord[] = [];
  let after: string | undefined;
  do {
    const v = await api.composioExecute(slug, { limit: 100, properties, associations, ...(after ? { after } : {}) });
    out.push(...results(v));
    after = nextAfter(v);
  } while (after);
  return out;
}

const date = (v: string | null | undefined) => (v ? new Date(v) : undefined);
const first = (r: HsRecord, k: string) => r.associations?.[k]?.results?.[0]?.id;

export async function hubspotSources(): Promise<SourceSet> {
  const [companies, contacts, deals, stages] = await Promise.all([
    listAll("HUBSPOT_LIST_COMPANIES", ["name", "domain", "industry", "city", "state", "numberofemployees", "description"]),
    listAll("HUBSPOT_LIST_CONTACTS", ["firstname", "lastname", "email", "jobtitle", "hs_timezone"], ["companies"]),
    listAll("HUBSPOT_LIST_DEALS", ["dealname", "dealstage", "amount", "closedate", "createdate", "description", "hs_next_step", "closed_lost_reason", "notes_last_updated", "hs_lastmodifieddate"], ["contacts", "companies"]),
    api.composioExecute("HUBSPOT_RETRIEVE_PIPELINE_STAGES", { objectType: "deals", pipelineId: "default" }).then(results).catch(() => []),
  ]);
  const stageLabel = new Map(stages.map((s) => [s.id, String((s as unknown as { label: string }).label)]));

  const accounts: Doc[] = companies.map((c) => ({
    _id: `hs-${c.id}`, name: c.properties.name, domain: c.properties.domain, industry: c.properties.industry ?? null,
    employees: Number(c.properties.numberofemployees) || null, tier: null, hubspotId: c.id,
  }));
  const people: Doc[] = contacts.map((c) => ({
    _id: `hs-${c.id}`, accountId: first(c, "companies") ? `hs-${first(c, "companies")}` : null,
    name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || c.properties.email,
    email: c.properties.email, title: c.properties.jobtitle ?? null,
    timezone: c.properties.hs_timezone || "America/Los_Angeles", hubspotId: c.id,
  }));

  // HubSpot only allows real users as owners, so seeded reps live in the description ("Rep: Name").
  const reps = new Map<string, Doc>();
  const dealDocs: Doc[] = deals.map((d) => {
    const p = d.properties;
    const repName = /Rep: ([^·]+)/.exec(p.description ?? "")?.[1]?.trim() ?? "Unassigned";
    const repId = `r-${repName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (!reps.has(repId)) reps.set(repId, { _id: repId, name: repName });
    const stage = stageLabel.get(p.dealstage ?? "") ?? p.dealstage ?? "";
    const closed = /won|lost/i.test(stage);
    return {
      _id: `hs-${d.id}`, name: p.dealname, accountId: first(d, "companies") ? `hs-${first(d, "companies")}` : null,
      contactId: first(d, "contacts") ? `hs-${first(d, "contacts")}` : undefined,
      contactIds: (d.associations?.contacts?.results ?? []).map((x) => `hs-${x.id}`),
      ownerId: repId, amount: Number(p.amount) || 0, currency: "USD", stage,
      description: p.description, nextStep: p.hs_next_step, lostReason: p.closed_lost_reason,
      createdAt: date(p.createdate), lastActivityAt: date(p.notes_last_updated ?? p.hs_lastmodifieddate),
      closedAt: closed ? date(p.closedate) ?? new Date() : undefined, hubspotId: d.id,
    };
  });

  const data: Record<string, Doc[]> = { accounts, contacts: people, reps: [...reps.values()], deals: dealDocs, activities: [] };
  const local = new Map<string, Doc[]>();
  const schemas = Object.entries(data).map(([name, docs]) => {
    local.set(`crm.${name}`, docs);
    return { db: "crm", name, count: docs.length, fields: inferFields(docs.slice(0, 60)), source: "demo" as const };
  });
  return { kind: "demo", label: "HubSpot", schemas, local, notes: [] };
}
