// Pipelines are config, not code. Playbooks start from the config and evolve as versioned
// documents in the `playbooks` collection.

import { parse } from "yaml";
import saasYaml from "../../pipelines/saas.yaml?raw";
import { store, uid } from "./store";

export type Variant = { id: string; label: string; hint: string };
export type Stage = {
  id: string;
  name: string;
  goal: string;
  success: { check: "interaction" | "calendar_event" | "crm_stage"; outcome?: string[]; stage?: string };
  owner: "agent" | "human" | "human_assisted";
  actions: string[];
  stuck?: { unanswered: number; then: "pause" | "back" };
  checklist: string[];
  playbook: { rules: string[]; variants: Variant[] };
};
export type Pipeline = { id: string; name: string; entity: string; stages: Stage[]; firm_limits: string[] };

export const PIPELINE = parse(saasYaml) as Pipeline;

export type PlaybookVersion = {
  _id: string;
  pipeline: string;
  stage: string;
  version: number;
  parent: string | null;
  rules: string[];
  variants: Variant[];
  rationale: string;
  diff: { added: string[]; removed: string[] };
  status: "active" | "candidate" | "rejected" | "retired";
  source: "config" | "reviewer" | "call_insight" | "random_edit";
  scores?: { baseline: number; candidate: number; noise: number; downstream?: number };
  createdAt: string;
};

export async function activePlaybook(pipeline: Pipeline, stage: Stage): Promise<PlaybookVersion> {
  const all = (await store.list<PlaybookVersion>("playbooks")).filter((p) => p.pipeline === pipeline.id && p.stage === stage.id);
  const active = all.filter((p) => p.status === "active").sort((a, b) => b.version - a.version)[0];
  if (active) return active;
  const seed: PlaybookVersion = {
    _id: uid("pb"),
    pipeline: pipeline.id,
    stage: stage.id,
    version: 1,
    parent: null,
    rules: stage.playbook.rules,
    variants: stage.playbook.variants,
    rationale: "Initial playbook from pipeline config",
    diff: { added: stage.playbook.rules, removed: [] },
    status: "active",
    source: "config",
    createdAt: new Date().toISOString(),
  };
  await store.upsert("playbooks", seed);
  return seed;
}

export async function playbookHistory(pipeline: string) {
  return (await store.list<PlaybookVersion>("playbooks")).filter((p) => p.pipeline === pipeline).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Map messy CRM stage labels onto pipeline stages. */
export function stageForDeal(pipeline: Pipeline, crmStage: string, hasReply: boolean): Stage | null {
  const s = crmStage.toLowerCase();
  if (/won|lost|closed/.test(s)) return null;
  if (pipeline.id === "saas") {
    if (/negotiation|proposal|follow-up|contract|sales call done/.test(s)) return pipeline.stages.find((x) => x.id === "close")!;
    if (/demo|call booked|presentation/.test(s)) return pipeline.stages.find((x) => x.id === "sales_call")!;
    if (/discovery|replied|qualified/.test(s) || hasReply) return pipeline.stages.find((x) => x.id === "call_booked")!;
    return pipeline.stages[0];
  }
  return hasReply ? pipeline.stages[1] : pipeline.stages[0];
}
