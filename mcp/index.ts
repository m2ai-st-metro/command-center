#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * CMD MCP server (Phase 5B / 031) — exposes CMD's mission + agent + activity
 * log surface over Model Context Protocol (stdio transport), so other agents
 * (Claude Desktop, ClaudeClaw workers, other Claude Code sessions) can:
 *   - query the mission/agent/activity state
 *   - propose and approve missions
 *   - dispatch fire-and-forget mission-tasks
 *
 * Design: thin shim over CMD's HTTP API at CMD_BASE_URL. No direct DB access,
 * so permissions and validation stay concentrated in `server/routes.ts`.
 *
 * All logs MUST go to stderr — stdout is reserved for JSON-RPC frames.
 */

const CMD_BASE_URL = process.env.CMD_BASE_URL ?? 'http://localhost:3142';

async function cmdFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const url = `${CMD_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CMD ${init?.method ?? 'GET'} ${path} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

const server = new McpServer(
  { name: 'cmd', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'cmd_list_missions',
  {
    description: 'List recent missions. Returns id, goal, status, agent_id, timestamps. Use cmd_get_mission for full detail.',
    inputSchema: {
      status: z.enum(['proposed', 'running', 'completed', 'failed']).optional()
        .describe('Filter by mission status'),
      limit: z.number().int().min(1).max(200).optional()
        .describe('Max results (default 50)'),
    },
  },
  async ({ status, limit }) => {
    const { missions } = await cmdFetch<{ missions: Array<Record<string, unknown>> }>('/api/missions');
    let list = missions;
    if (status) list = list.filter(m => m.status === status);
    const cap = limit ?? 50;
    return textResult({ count: list.length, missions: list.slice(0, cap) });
  },
);

server.registerTool(
  'cmd_get_mission',
  {
    description: 'Get full detail for a mission: metadata, logs, and judge_history (R3 retry-loop iterations).',
    inputSchema: {
      id: z.string().describe('Mission UUID'),
    },
  },
  async ({ id }) => {
    const data = await cmdFetch<Record<string, unknown>>(`/api/missions/${encodeURIComponent(id)}`);
    return textResult(data);
  },
);

server.registerTool(
  'cmd_create_mission',
  {
    description: 'Propose a new mission. Returns mission id and classification. Must be approved separately via cmd_approve_mission before it runs.',
    inputSchema: {
      goal: z.string().min(1).describe('What the mission should accomplish (natural language)'),
    },
  },
  async ({ goal }) => {
    const data = await cmdFetch<{ mission: Record<string, unknown>; classification: unknown }>(
      '/api/missions',
      { method: 'POST', body: JSON.stringify({ goal }) },
    );
    return textResult({
      mission_id: data.mission.id,
      status: data.mission.status,
      agent_id: data.mission.agent_id,
      classification: data.classification,
      next_step: `Call cmd_approve_mission with id=${data.mission.id} to execute.`,
    });
  },
);

server.registerTool(
  'cmd_approve_mission',
  {
    description: 'Approve a proposed mission and start execution. Returns immediately — use cmd_get_mission to poll for completion.',
    inputSchema: {
      id: z.string().describe('Mission UUID from cmd_create_mission'),
    },
  },
  async ({ id }) => {
    const data = await cmdFetch<{ message: string; mission_id: string }>(
      `/api/missions/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: '{}' },
    );
    return textResult(data);
  },
);

server.registerTool(
  'cmd_list_agents',
  {
    description: 'List registered agents with status (available/busy), skills, and tier (named/custom/stock).',
    inputSchema: {},
  },
  async () => {
    const data = await cmdFetch<{ agents: unknown[] }>('/api/agents');
    return textResult(data);
  },
);

server.registerTool(
  'cmd_hivemind',
  {
    description: 'Query the cross-agent activity log (HiveMind). Ordered most-recent-first. Useful for: "what has agent X been doing", "show me recent judge FAILs", "what happened during mission Y".',
    inputSchema: {
      agent: z.string().optional().describe('Filter to one agent_id'),
      type: z.string().optional().describe('Event type: mission_start|mission_end|agent_dispatch|agent_complete|agent_fail|judge_verdict|reasoner_action|subtask_start|subtask_complete'),
      mission: z.string().optional().describe('Filter to one mission_id'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max events (default 100)'),
    },
  },
  async ({ agent, type, mission, limit }) => {
    const qs = new URLSearchParams();
    if (agent) qs.set('agent', agent);
    if (type) qs.set('type', type);
    if (mission) qs.set('mission', mission);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    const data = await cmdFetch<{ events: unknown[] }>(`/api/hivemind${suffix}`);
    return textResult(data);
  },
);

server.registerTool(
  'cmd_create_mission_task',
  {
    description: 'Direct fire-and-forget A2A dispatch to a Named agent. Skips the propose/approve handshake — use for automated workflows (triggers, cron, other agents). Returns immediately with queued task.',
    inputSchema: {
      agent_id: z.string().describe('Agent to dispatch to (e.g. "coding", "content", "data", "kup", "research")'),
      title: z.string().describe('Short task title for the queue view'),
      prompt: z.string().describe('Full prompt to run against the agent'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Queue priority (default normal)'),
      skill: z.string().optional().describe('Skill hint for per-skill model routing (e.g. "coding", "debugging")'),
      repo_path: z.string().optional().describe('Repo path if task needs worktree isolation'),
      max_turns: z.number().int().min(1).max(200).optional().describe('Per-task maxTurns override'),
    },
  },
  async (args) => {
    const data = await cmdFetch<{ task: unknown }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return textResult(data);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cmd-mcp] connected, base=${CMD_BASE_URL}`);
}

main().catch((err) => {
  console.error('[cmd-mcp] fatal:', err);
  process.exit(1);
});
