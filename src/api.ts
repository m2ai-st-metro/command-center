const BASE = '/api';

// Bearer for mutating /api routes (Q-20260708-0007). The server injects this into
// index.html at serve time (window.__CMD_TOKEN__), so it is never in a committed
// bundle. GET reads don't need it; sending it on every request is harmless.
declare global {
  interface Window {
    __CMD_TOKEN__?: string;
  }
}
const CMD_TOKEN = typeof window !== 'undefined' ? window.__CMD_TOKEN__ ?? '' : '';

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(CMD_TOKEN ? { Authorization: `Bearer ${CMD_TOKEN}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

export const api = {
  chat: (message: string) => fetchJson<{ reply: string }>('/chat', {
    method: 'POST',
    body: JSON.stringify({ message }),
  }),
  listMissions: () => fetchJson<{ missions: unknown[] }>('/missions'),
  getMission: (id: string) => fetchJson<{ mission: unknown; logs: unknown[] }>(`/missions/${id}`),
  createMission: (goal: string) => fetchJson<{ mission: unknown; classification: unknown }>('/missions', {
    method: 'POST',
    body: JSON.stringify({ goal }),
  }),
  approveMission: (id: string) => fetchJson<{ message: string }>(`/missions/${id}/approve`, { method: 'POST' }),
  cancelMission: (id: string) => fetchJson<{ message: string }>(`/missions/${id}/cancel`, { method: 'POST' }),
  listAgents: () => fetchJson<{ agents: unknown[] }>('/agents'),
  getStatus: () => fetchJson<unknown>('/status'),

  // Custom agents
  listCustomAgents: () => fetchJson<{ agents: unknown[] }>('/custom-agents'),
  getCustomAgent: (id: string) => fetchJson<{ agent: unknown }>(`/custom-agents/${id}`),
  createCustomAgent: (data: { name: string; description: string; skills: string[]; system_prompt: string }) =>
    fetchJson<{ agent: unknown }>('/custom-agents', { method: 'POST', body: JSON.stringify(data) }),
  updateCustomAgent: (id: string, data: { name?: string; description?: string; skills?: string[]; system_prompt?: string }) =>
    fetchJson<{ agent: unknown }>(`/custom-agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCustomAgent: (id: string) =>
    fetchJson<{ message: string }>(`/custom-agents/${id}`, { method: 'DELETE' }),

  // Agent capabilities
  listCapabilities: () => fetchJson<{ capabilities: unknown[] }>('/agents/capabilities'),
  getAgentCapabilities: (id: string) => fetchJson<{ capabilities: unknown }>(`/agents/${id}/capabilities`),

  // Schedules
  listSchedules: () => fetchJson<{ schedules: unknown[] }>('/schedules'),
  createSchedule: (goal: string, interval?: string, cron_expr?: string) =>
    fetchJson<{ schedule: unknown }>('/schedules', { method: 'POST', body: JSON.stringify({ goal, interval, cron_expr }) }),
  updateSchedule: (id: string, data: { enabled?: boolean; goal?: string; interval?: string; cron_expr?: string }) =>
    fetchJson<{ message: string }>(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSchedule: (id: string) =>
    fetchJson<{ message: string }>(`/schedules/${id}`, { method: 'DELETE' }),

  // Worker pool
  getWorkerPool: () => fetchJson<{ pool: unknown; slots: unknown[] }>('/workers'),

  // Routing insights
  getRoutingInsights: () => fetchJson<unknown>('/routing/insights'),

  // Triggers (026)
  listTriggers: () => fetchJson<{ triggers: unknown[] }>('/triggers'),
  getTrigger: (id: string) => fetchJson<{ trigger: unknown }>(`/triggers/${id}`),
  createTrigger: (data: {
    name: string;
    condition_type: string;
    condition_config: Record<string, unknown>;
    action_type: string;
    action_config: Record<string, unknown>;
    cooldown_seconds?: number;
  }) => fetchJson<{ trigger: unknown }>('/triggers', { method: 'POST', body: JSON.stringify(data) }),
  updateTrigger: (id: string, data: {
    name?: string;
    enabled?: boolean;
    condition_config?: Record<string, unknown>;
    action_config?: Record<string, unknown>;
    cooldown_seconds?: number;
  }) => fetchJson<{ trigger: unknown }>(`/triggers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTrigger: (id: string) =>
    fetchJson<{ ok: boolean }>(`/triggers/${id}`, { method: 'DELETE' }),
  listTriggerFires: (id: string, limit = 20) =>
    fetchJson<{ fires: unknown[] }>(`/triggers/${id}/fires?limit=${limit}`),

  // Stock agents
  listStockAgents: () => fetchJson<{ total: number; categories: string[]; agents: unknown[] }>('/stock-agents'),
  syncStockRepos: () => fetchJson<{ message: string }>('/stock-agents/sync', { method: 'POST' }),
  loadStockAgent: (agentId: string) =>
    fetchJson<{ message: string; agent: unknown }>('/stock-agents/load', {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId }),
    }),
  loadStockCategory: (category: string) =>
    fetchJson<{ message: string; agents: unknown[] }>('/stock-agents/load', {
      method: 'POST',
      body: JSON.stringify({ category }),
    }),

  // HiveMind (R3.b / 030)
  listHivemindEvents: (opts: { agent?: string; type?: string; mission?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.agent) qs.set('agent', opts.agent);
    if (opts.type) qs.set('type', opts.type);
    if (opts.mission) qs.set('mission', opts.mission);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return fetchJson<{ events: HivemindEvent[] }>(`/hivemind${suffix}`);
  },

  // Scratchpad (ad-hoc report surface)
  listScratchpad: () =>
    fetchJson<{ entries: ScratchpadEntry[]; archived: ScratchpadEntry[] }>('/scratchpad'),
  pinScratchpad: (slug: string, pinned: boolean) =>
    fetchJson<{ ok: boolean }>(`/scratchpad/${encodeURIComponent(slug)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    }),
  archiveScratchpad: (slug: string) =>
    fetchJson<{ ok: boolean }>(`/scratchpad/${encodeURIComponent(slug)}/archive`, {
      method: 'POST',
    }),
};

export interface ScratchpadEntry {
  slug: string;
  title: string;
  task: string | null;
  tags: string[];
  created: string;
  pinned: boolean;
  url: string;
  archived: boolean;
}

export interface HivemindEvent {
  id: number;
  ts: number;
  agent_id: string | null;
  mission_id: string | null;
  task_id: string | null;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown> | null;
}
