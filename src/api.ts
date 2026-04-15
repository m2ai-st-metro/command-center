const BASE = '/api';

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
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
};
