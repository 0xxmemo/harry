import { invoke } from "@tauri-apps/api/core";

export type Coll = "settings" | "outbox" | "interactions" | "runs" | "calls" | "insights" | "playbooks" | "evals" | "llm_cache" | "optouts" | "traces" | "sync" | CrmColl;
export type CrmColl = "crm_accounts" | "crm_contacts" | "crm_reps" | "crm_deals" | "crm_activities";

export const store = {
  list: <T = Record<string, unknown>>(coll: Coll) => invoke<T[]>("store_list", { coll }),
  upsert: <T = Record<string, unknown>>(coll: Coll, doc: { _id: string } & Record<string, unknown>) => invoke<T>("store_upsert", { coll, doc }),
  mirror: (coll: CrmColl, docs: Record<string, unknown>[]) => invoke<number>("store_mirror", { coll, docs }),
  reset: (colls: Coll[]) => invoke<void>("store_reset", { colls }),
};

export type Settings = {
  _id: "settings";
  demoMode: boolean;
  allowlist: string[];
  perContactPerWeek: number;
  perMailboxPerDay: number;
  businessHours: boolean;
  autoSend: Record<string, boolean>;
  recipientOverride?: string;
};

export async function getSettings(): Promise<Settings> {
  const s = (await store.list<Settings>("settings"))[0] as Partial<Settings> | undefined;
  return { _id: "settings", demoMode: true, allowlist: [], perContactPerWeek: 2, perMailboxPerDay: 20, businessHours: true, autoSend: {}, ...s };
}

export const saveSettings = (s: Partial<Settings>) => store.upsert("settings", { ...s, _id: "settings" });

export const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export async function hash(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
