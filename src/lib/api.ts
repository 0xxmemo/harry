import { invoke } from "@tauri-apps/api/core";

export type ToolStatus = { name: string; path: string | null; version: string | null };
export type AuthStatus = { openllm: boolean; openllm_detail: string; atlas: boolean; atlas_detail: string };
export type Completion = { text: string; model: string; resolved_model: string; finish_reason: string; fallbacks: number; ms: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number };
export type TraceMeta = { eventId: string; event: string; userId: string; convoId?: string; properties?: Record<string, string | number | boolean> };
export type FileEntry = { path: string; rel: string; ext: string; size: number };
export type AtlasProject = { id: string; name: string };
export type AtlasCluster = { name: string; stateName?: string; clusterType?: string };

export const api = {
  toolStatus: () => invoke<ToolStatus[]>("tool_status"),
  authStatus: () => invoke<AuthStatus>("auth_status"),
  installTool: (name: string) => invoke<string>("install_tool", { name }),
  openllmSetKey: (key: string) => invoke<string>("openllm_set_key", { key }),

  atlasLogin: () => invoke<string>("atlas_login"),
  atlasLogout: () => invoke<void>("atlas_logout"),
  atlasProjects: async () => {
    const v = await invoke<{ results?: AtlasProject[] } | AtlasProject[]>("atlas_projects");
    return Array.isArray(v) ? v : v.results ?? [];
  },
  atlasClusters: async (projectId: string) => {
    const v = await invoke<{ results?: AtlasCluster[] } | AtlasCluster[]>("atlas_clusters", { projectId });
    return Array.isArray(v) ? v : v.results ?? [];
  },
  atlasConnect: (projectId: string, cluster: string) =>
    invoke<{ username: string; host: string }>("atlas_connect", { projectId, cluster }),

  storeStatus: () => invoke<{ persistent: boolean; host: string | null }>("store_status"),
  atlasRestore: () => invoke<{ username: string; host: string } | null>("atlas_restore"),
  mongoDisconnect: () => invoke<void>("mongo_disconnect"),
  mongoSample: () => invoke<SampledDb[]>("mongo_sample"),
  mongoAggregate: (db: string, collection: string, pipeline: unknown[]) =>
    invoke<Record<string, unknown>[]>("mongo_aggregate", { db, collection, pipeline }),
  gateCheck: (pipeline: unknown[]) => invoke<unknown[]>("gate_check", { pipeline }),

  // `trace` is observability context (Raindrop event name, user, round). Rust ignores unknown args.
  llm: (system: string, prompt: string, model?: string, trace?: TraceMeta) => invoke<Completion>("llm_complete", { system, prompt, model, trace }),
  /** Raindrop outcome signals. Only the headless loop handles this today; the app ignores it. */
  traceSignal: (s: { eventId: string; name: string; comment?: string; sentiment?: "POSITIVE" | "NEGATIVE"; replay?: TraceMeta & { input: string; output: string; model: string } }) =>
    invoke<void>("trace_signal", s).catch(() => {}),

  listRoots: () => invoke<string[]>("list_roots"),
  grantFolder: (path: string) => invoke<string[]>("grant_folder", { path }),
  revokeFolder: (path: string) => invoke<string[]>("revoke_folder", { path }),
  scanFolder: (root: string) => invoke<FileEntry[]>("scan_folder", { root }),
  readSource: (path: string) => invoke<string>("read_source", { path }),
  memLoad: () => invoke<unknown>("mem_load"),
  memSave: (memory: unknown) => invoke<void>("mem_save", { memory }),

  composioStatus: () => invoke<{ installed: boolean; logged_in: boolean; connections: unknown }>("composio_status"),
  composioLogin: () => invoke<void>("composio_login"),
  composioLogout: () => invoke<void>("composio_logout"),
  composioLink: (toolkit: string) => invoke<void>("composio_link", { toolkit }),
  composioExecute: (slug: string, data: unknown) => invoke<unknown>("composio_execute", { slug, data }),
  outboxApprove: (id: string) => invoke<unknown>("outbox_approve", { id }),
  outboxSend: (id: string) => invoke<unknown>("outbox_send", { id }),
  fetchReplies: () => invoke<Record<string, unknown>[]>("fetch_replies"),
  gatePlaybook: (firmLimits: string[], rules: string[]) => invoke<void>("gate_playbook", { firmLimits, rules }),
};

export type SampledDb = {
  name: string;
  collections: { name: string; count: number; samples: Record<string, unknown>[] }[];
};

export const isTauri = () => "__TAURI_INTERNALS__" in window;
