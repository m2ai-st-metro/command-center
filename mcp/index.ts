#!/usr/bin/env node
import http from 'node:http';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/**
 * CMD MCP server — exposes CMD's mission, agent, schedule, task, trigger,
 * and activity-log surface over Model Context Protocol.
 *
 * Two transports, selected by MCP_TRANSPORT env var:
 *   - "stdio" (default) — for Claude Desktop, Claude Code CLI, local stdio clients.
 *     Logs to stderr only (stdout is reserved for JSON-RPC frames).
 *   - "http"            — for remote MCP clients (e.g. Claude Cowork Live Artifacts)
 *     that reach us through a public tunnel. Requires CMD_MCP_BEARER_TOKEN.
 *
 * Design: thin shim over CMD's HTTP API at CMD_BASE_URL. No direct DB access,
 * so permissions and validation stay concentrated in `server/routes.ts`.
 *
 * Every refreshable tool accepts an ignored `_nonce?: number` argument so
 * Live Artifacts can bypass Cowork's (tool, args)-keyed client-side cache by
 * passing `_nonce: Date.now()` on every refresh.
 */

// ── Config ──────────────────────────────────────────────────────────

const CMD_BASE_URL = process.env.CMD_BASE_URL ?? 'http://localhost:3142';
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();
const MCP_PORT = Number.parseInt(process.env.MCP_PORT ?? '3150', 10);
const MCP_HOST = process.env.MCP_HOST ?? '127.0.0.1';
const MCP_BEARER = process.env.CMD_MCP_BEARER_TOKEN ?? '';

// OAuth 2.0 Client Credentials — for MCP clients (e.g. Claude Cowork) that
// negotiate auth via RFC 6749 §4.4 rather than a pre-shared bearer.
const OAUTH_CLIENT_ID = process.env.CMD_MCP_OAUTH_CLIENT_ID ?? '';
const OAUTH_CLIENT_SECRET = process.env.CMD_MCP_OAUTH_CLIENT_SECRET ?? '';
const PUBLIC_URL = (process.env.CMD_MCP_PUBLIC_URL ?? '').replace(/\/$/, '');
const OAUTH_ENABLED = Boolean(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && PUBLIC_URL);
const OAUTH_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h — matches CF Access default session
const OAUTH_REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d — long enough to bridge typical inactivity

// ── CMD HTTP client ─────────────────────────────────────────────────

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
    throw new Error(
      `CMD ${init?.method ?? 'GET'} ${path} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }
  return res.json() as Promise<T>;
}

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

// Cache-bust nonce, accepted and ignored by every refreshable tool.
const NONCE_FIELD = z
  .number()
  .optional()
  .describe(
    'Cache-bust nonce. Live Artifacts should pass Date.now() on every refresh to bypass Cowork client-side (tool, args) cache. Ignored server-side.',
  );

/** Attach the shared _nonce field to any tool input shape. */
function refreshable<S extends Record<string, z.ZodTypeAny>>(shape: S): S & { _nonce: typeof NONCE_FIELD } {
  return { ...shape, _nonce: NONCE_FIELD };
}

// ── Server construction ─────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'cmd', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  // ── Missions ──────────────────────────────────────────────────────

  server.registerTool(
    'cmd_list_missions',
    {
      description:
        'List recent missions. Summary detail (default) strips result, plan, logs, judge_history — 10-20x smaller payload, safe for Live Artifact consumption. Use cmd_get_mission for full detail on a single mission.',
      inputSchema: refreshable({
        status: z
          .enum(['proposed', 'running', 'completed', 'failed'])
          .optional()
          .describe('Filter by mission status'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe('summary (default): omit heavy fields (result, plan, logs, judge_history). full: include everything — can blow Claude context limits.'),
      }),
    },
    async ({ status, limit, detail }) => {
      const { missions } = await cmdFetch<{ missions: Array<Record<string, unknown>> }>(
        '/api/missions',
      );
      let list = missions;
      if (status) list = list.filter((m) => m.status === status);
      const cap = limit ?? 50;
      const sliced = list.slice(0, cap);
      const HEAVY_FIELDS = ['result', 'plan', 'logs', 'judge_history'];
      const items =
        detail === 'full'
          ? sliced
          : sliced.map((m) => {
              const copy: Record<string, unknown> = { ...m };
              for (const k of HEAVY_FIELDS) delete copy[k];
              return copy;
            });
      return textResult({ count: items.length, missions: items });
    },
  );

  server.registerTool(
    'cmd_get_mission',
    {
      description:
        'Get full detail for a mission: metadata, logs, and judge_history (R3 retry-loop iterations).',
      inputSchema: refreshable({
        id: z.string().describe('Mission UUID'),
      }),
    },
    async ({ id }) => {
      const data = await cmdFetch<Record<string, unknown>>(
        `/api/missions/${encodeURIComponent(id)}`,
      );
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_create_mission',
    {
      description:
        'Propose a new mission. Returns mission id and classification. Must be approved separately via cmd_approve_mission before it runs.',
      inputSchema: refreshable({
        goal: z.string().min(1).describe('What the mission should accomplish (natural language)'),
      }),
    },
    async ({ goal }) => {
      const data = await cmdFetch<{
        mission: Record<string, unknown>;
        classification: unknown;
      }>('/api/missions', { method: 'POST', body: JSON.stringify({ goal }) });
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
      description:
        'Approve a proposed mission and start execution. Returns immediately — use cmd_get_mission to poll for completion.',
      inputSchema: refreshable({
        id: z.string().describe('Mission UUID from cmd_create_mission'),
      }),
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
    'cmd_cancel_mission',
    {
      description: 'Cancel a running or proposed mission.',
      inputSchema: refreshable({
        id: z.string().describe('Mission UUID'),
      }),
    },
    async ({ id }) => {
      const data = await cmdFetch<{ message: string; mission_id: string }>(
        `/api/missions/${encodeURIComponent(id)}/cancel`,
        { method: 'POST', body: '{}' },
      );
      return textResult(data);
    },
  );

  // ── Agents ────────────────────────────────────────────────────────

  server.registerTool(
    'cmd_list_agents',
    {
      description:
        'List registered agents with status (available/busy), skills, and tier (named/custom/stock).',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<{ agents: unknown[] }>('/api/agents');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_get_agent_capabilities',
    {
      description:
        'Get the capability record for one agent: skills, tools, MCP, routing weights. Source of truth is the agent.config.json on disk.',
      inputSchema: refreshable({
        id: z.string().describe('Agent id (e.g. "coding", "research", "data")'),
      }),
    },
    async ({ id }) => {
      const data = await cmdFetch<{ capabilities: unknown }>(
        `/api/agents/${encodeURIComponent(id)}/capabilities`,
      );
      return textResult(data);
    },
  );

  // ── Schedules ─────────────────────────────────────────────────────

  server.registerTool(
    'cmd_list_schedules',
    {
      description:
        'List recurring mission schedules with goal, cadence (interval or cron), enabled flag, and next_run_at.',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<{ schedules: unknown[] }>('/api/schedules');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_create_schedule',
    {
      description:
        'Create a recurring schedule. Supply either interval (e.g. "1h", "30m", "24h", "7d") or cron_expr (5-field cron), not both.',
      inputSchema: refreshable({
        goal: z.string().min(1).describe('Mission goal (what to run on every fire)'),
        interval: z
          .string()
          .optional()
          .describe('Interval string like "5m", "1h", "24h", "7d". Mutually exclusive with cron_expr.'),
        cron_expr: z
          .string()
          .optional()
          .describe('Standard 5-field cron expression like "0 9 * * *". Mutually exclusive with interval.'),
      }),
    },
    async ({ goal, interval, cron_expr }) => {
      const body: Record<string, unknown> = { goal };
      if (interval) body.interval = interval;
      if (cron_expr) body.cron_expr = cron_expr;
      const data = await cmdFetch<{ schedule: unknown }>('/api/schedules', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_run_schedule_now',
    {
      description:
        'Fire a schedule immediately — creates + auto-approves a mission from the schedule\'s goal. Does not affect next_run_at.',
      inputSchema: refreshable({
        id: z.string().describe('Schedule id'),
      }),
    },
    async ({ id }) => {
      const data = await cmdFetch<{ message: string; mission_id: string }>(
        `/api/schedules/${encodeURIComponent(id)}/run`,
        { method: 'POST', body: '{}' },
      );
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_delete_schedule',
    {
      description: 'Delete a schedule. Does not cancel already-running missions it spawned.',
      inputSchema: refreshable({
        id: z.string().describe('Schedule id'),
      }),
    },
    async ({ id }) => {
      const data = await cmdFetch<{ message: string }>(
        `/api/schedules/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      return textResult(data);
    },
  );

  // ── Tasks (fire-and-forget A2A dispatch) ──────────────────────────

  server.registerTool(
    'cmd_list_tasks',
    {
      description:
        'List mission tasks (R2.1 async fire-and-forget queue). Shows queued, running, completed, failed, cancelled tasks across all Named agents.',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<{ tasks: unknown[] }>('/api/tasks');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_create_mission_task',
    {
      description:
        'Direct fire-and-forget A2A dispatch to a Named agent. Skips the propose/approve handshake — use for automated workflows (triggers, cron, other agents). Returns immediately with queued task.',
      inputSchema: refreshable({
        agent_id: z
          .string()
          .describe('Agent to dispatch to (e.g. "coding", "content", "data", "kup", "research")'),
        title: z.string().describe('Short task title for the queue view'),
        prompt: z.string().describe('Full prompt to run against the agent'),
        priority: z.enum(['low', 'normal', 'high']).optional().describe('Queue priority (default normal)'),
        skill: z
          .string()
          .optional()
          .describe('Skill hint for per-skill model routing (e.g. "coding", "debugging")'),
        repo_path: z.string().optional().describe('Repo path if task needs worktree isolation'),
        max_turns: z.number().int().min(1).max(200).optional().describe('Per-task maxTurns override'),
      }),
    },
    async (args) => {
      const { _nonce, ...body } = args as typeof args & { _nonce?: number };
      void _nonce;
      const data = await cmdFetch<{ task: unknown }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_get_task',
    {
      description: 'Get full detail for a mission task: status, logs, dispatch metadata.',
      inputSchema: refreshable({
        id: z.string().describe('Task UUID'),
      }),
    },
    async ({ id }) => {
      const data = await cmdFetch<{ task: unknown }>(`/api/tasks/${encodeURIComponent(id)}`);
      return textResult(data);
    },
  );

  // ── Observability ────────────────────────────────────────────────

  server.registerTool(
    'cmd_get_status',
    {
      description:
        'Lightweight system-health snapshot: active missions + recent completed. Fast path for dashboards.',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<Record<string, unknown>>('/api/status');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_get_stats',
    {
      description:
        'Aggregate outcome statistics across missions and agents (counts, success rates, latencies).',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<{ stats: unknown }>('/api/stats');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_get_workers',
    {
      description:
        'Current worker-pool state: pool counts (default/burst) and per-slot status. Used by dashboard to show worker utilization.',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<{ pool: unknown; slots: unknown }>('/api/workers');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_hivemind',
    {
      description:
        'Query the cross-agent activity log (HiveMind). Ordered most-recent-first. Useful for: "what has agent X been doing", "show me recent judge FAILs", "what happened during mission Y".',
      inputSchema: refreshable({
        agent: z.string().optional().describe('Filter to one agent_id'),
        type: z
          .string()
          .optional()
          .describe(
            'Event type: mission_start|mission_end|agent_dispatch|agent_complete|agent_fail|judge_verdict|reasoner_action|subtask_start|subtask_complete',
          ),
        mission: z.string().optional().describe('Filter to one mission_id'),
        since: z.number().int().optional().describe('Unix seconds; only return events after this timestamp'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max events (default 100)'),
      }),
    },
    async ({ agent, type, mission, since, limit }) => {
      const qs = new URLSearchParams();
      if (agent) qs.set('agent', agent);
      if (type) qs.set('type', type);
      if (mission) qs.set('mission', mission);
      if (since !== undefined) qs.set('since', String(since));
      if (limit) qs.set('limit', String(limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      const data = await cmdFetch<{ events: unknown[] }>(`/api/hivemind${suffix}`);
      return textResult(data);
    },
  );

  // ── Triggers ─────────────────────────────────────────────────────

  server.registerTool(
    'cmd_list_triggers',
    {
      description:
        'List configured triggers: name, condition_type, action_type, enabled state, cooldown.',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<{ triggers: unknown[] }>('/api/triggers');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_get_trigger_fires',
    {
      description: 'Get recent fire history for a trigger (when it evaluated true and what action ran).',
      inputSchema: refreshable({
        id: z.string().describe('Trigger id'),
        limit: z.number().int().min(1).max(200).optional().describe('Max fires (default 20)'),
      }),
    },
    async ({ id, limit }) => {
      const qs = new URLSearchParams();
      if (limit) qs.set('limit', String(limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      const data = await cmdFetch<{ fires: unknown[] }>(
        `/api/triggers/${encodeURIComponent(id)}/fires${suffix}`,
      );
      return textResult(data);
    },
  );

  // ── Insights ─────────────────────────────────────────────────────

  server.registerTool(
    'cmd_get_ideaforge',
    {
      description:
        'Read-only snapshot of the IdeaForge pipeline: signals in last 7d, stage breakdown, top ideas by weighted score, anomaly count.',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<Record<string, unknown>>('/api/st-metro/ideaforge');
      return textResult(data);
    },
  );

  server.registerTool(
    'cmd_get_sky_lynx_recs',
    {
      description: 'Read-only snapshot of Sky-Lynx recommendations (weekly continuous-improvement proposals).',
      inputSchema: refreshable({}),
    },
    async () => {
      const data = await cmdFetch<Record<string, unknown>>('/api/sky-lynx/recs');
      return textResult(data);
    },
  );

  return server;
}

// ── Transport: stdio (existing behaviour preserved) ─────────────────

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // IMPORTANT: stdout is reserved for JSON-RPC frames, so all logs go to stderr.
  console.error(`[cmd-mcp] stdio mode, base=${CMD_BASE_URL}`);
}

// ── Transport: streamable HTTP (for remote MCP clients) ─────────────

function unauthorized(res: http.ServerResponse, reason: string): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (OAUTH_ENABLED) {
    // RFC 9728 — tell the client where to find OAuth metadata.
    headers['WWW-Authenticate'] =
      `Bearer realm="cmd-mcp", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`;
  }
  res.writeHead(401, headers);
  res.end(JSON.stringify({ error: 'unauthorized', reason }));
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function oauthProtectedResourceMetadata(): Record<string, unknown> {
  // RFC 9728 — OAuth 2.0 Protected Resource Metadata.
  return {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  };
}

function oauthAuthorizationServerMetadata(): Record<string, unknown> {
  // RFC 8414 — OAuth 2.0 Authorization Server Metadata.
  return {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/oauth/token`,
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
  };
}

// Redirect back to Cowork with code + state appended to redirect_uri.
function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function handleAuthorizeEndpoint(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!OAUTH_ENABLED) {
    writeJson(res, 503, { error: 'oauth_not_configured' });
    return;
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.searchParams;
  const clientId = p.get('client_id') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  const responseType = p.get('response_type') ?? '';
  const codeChallenge = p.get('code_challenge') ?? '';
  const codeChallengeMethod = p.get('code_challenge_method') ?? '';
  const state = p.get('state') ?? '';

  // Validate before redirecting. If redirect_uri is bad, we MUST NOT redirect
  // (RFC 6749 §4.1.2.1 — render error locally). If other params are bad,
  // redirect with error=... so the client can surface it.
  if (!redirectUri || !/^https:\/\/(claude\.ai|.*\.anthropic\.com)\//.test(redirectUri)) {
    writeJson(res, 400, { error: 'invalid_redirect_uri', redirect_uri: redirectUri });
    return;
  }
  if (responseType !== 'code') {
    res.writeHead(302, { Location: appendQuery(redirectUri, { error: 'unsupported_response_type', state }) });
    res.end();
    return;
  }
  if (clientId !== OAUTH_CLIENT_ID) {
    res.writeHead(302, { Location: appendQuery(redirectUri, { error: 'unauthorized_client', state }) });
    res.end();
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    res.writeHead(302, { Location: appendQuery(redirectUri, { error: 'invalid_request', error_description: 'PKCE S256 required', state }) });
    res.end();
    return;
  }

  // Auto-approve (single-user personal server). Issue code and redirect.
  const code = issueAuthCode(clientId, redirectUri, codeChallenge);
  res.writeHead(302, { Location: appendQuery(redirectUri, { code, state }) });
  res.end();
}

async function handleTokenEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  if (!OAUTH_ENABLED) {
    writeJson(res, 503, {
      error: 'oauth_not_configured',
      error_description:
        'Server is missing CMD_MCP_OAUTH_CLIENT_ID / CMD_MCP_OAUTH_CLIENT_SECRET / CMD_MCP_PUBLIC_URL.',
    });
    return;
  }
  const raw = await readRawBody(req);
  const body = parseFormBody(raw);
  const grant = body.grant_type;

  if (grant === 'client_credentials') {
    const creds = parseOAuthCredentials(req, body);
    if (!creds) {
      writeJson(res, 401, { error: 'invalid_client', error_description: 'client_id and client_secret required.' });
      return;
    }
    if (!timingSafeEqual(creds.clientId, OAUTH_CLIENT_ID) ||
        !timingSafeEqual(creds.clientSecret, OAUTH_CLIENT_SECRET)) {
      writeJson(res, 401, { error: 'invalid_client' });
      return;
    }
    const { access_token, expires_in } = issueOAuthToken();
    writeJson(res, 200, { access_token, token_type: 'Bearer', expires_in, scope: 'mcp' });
    return;
  }

  if (grant === 'authorization_code') {
    const code = body.code ?? '';
    const codeVerifier = body.code_verifier ?? '';
    const redirectUri = body.redirect_uri ?? '';
    // Client auth: Cowork passes client_id in body; client_secret may or may not be present.
    // Since we minted client_id via our static registration, we accept a matching client_id
    // as "public client" auth per OAuth 2.1 for PKCE flows. If a secret is sent, verify it.
    const clientId = body.client_id ?? (parseOAuthCredentials(req, body)?.clientId ?? '');
    if (clientId !== OAUTH_CLIENT_ID) {
      writeJson(res, 401, { error: 'invalid_client' });
      return;
    }
    const sentSecret = body.client_secret ?? (parseOAuthCredentials(req, body)?.clientSecret ?? '');
    if (sentSecret && !timingSafeEqual(sentSecret, OAUTH_CLIENT_SECRET)) {
      writeJson(res, 401, { error: 'invalid_client' });
      return;
    }
    const entry = authCodes.get(code);
    if (!entry) {
      writeJson(res, 400, { error: 'invalid_grant', error_description: 'unknown or reused code' });
      return;
    }
    // One-time use: delete immediately, even on failure, to prevent replay.
    authCodes.delete(code);
    if (entry.expiresAt < Date.now()) {
      writeJson(res, 400, { error: 'invalid_grant', error_description: 'code expired' });
      return;
    }
    if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
      writeJson(res, 400, { error: 'invalid_grant', error_description: 'client_id/redirect_uri mismatch' });
      return;
    }
    if (!verifyPkceS256(codeVerifier, entry.codeChallenge)) {
      writeJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }
    const { access_token, expires_in } = issueOAuthToken();
    const refresh_token = issueRefreshToken(clientId);
    writeJson(res, 200, { access_token, token_type: 'Bearer', expires_in, refresh_token, scope: 'mcp' });
    return;
  }

  if (grant === 'refresh_token') {
    // Client auth: same posture as authorization_code — public client auth via
    // client_id alone is acceptable for PKCE-issued refresh tokens; if a secret
    // is sent, verify it.
    const clientId = body.client_id ?? (parseOAuthCredentials(req, body)?.clientId ?? '');
    if (clientId !== OAUTH_CLIENT_ID) {
      writeJson(res, 401, { error: 'invalid_client' });
      return;
    }
    const sentSecret = body.client_secret ?? (parseOAuthCredentials(req, body)?.clientSecret ?? '');
    if (sentSecret && !timingSafeEqual(sentSecret, OAUTH_CLIENT_SECRET)) {
      writeJson(res, 401, { error: 'invalid_client' });
      return;
    }
    const refreshToken = body.refresh_token ?? '';
    if (!refreshToken) {
      writeJson(res, 400, { error: 'invalid_request', error_description: 'refresh_token required' });
      return;
    }
    if (!consumeRefreshToken(refreshToken, clientId)) {
      writeJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'refresh_token expired, unknown, or already used',
      });
      return;
    }
    const { access_token, expires_in } = issueOAuthToken();
    const refresh_token = issueRefreshToken(clientId);
    writeJson(res, 200, { access_token, token_type: 'Bearer', expires_in, refresh_token, scope: 'mcp' });
    return;
  }

  writeJson(res, 400, {
    error: 'unsupported_grant_type',
    error_description: `Supported: authorization_code, client_credentials, refresh_token. Got "${grant ?? '(none)'}".`,
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}

// In-memory OAuth access-token store. Restart invalidates all tokens;
// Cowork/other clients simply re-exchange via client credentials grant
// or re-run the Authorization Code + PKCE flow.
const oauthTokens = new Map<string, { expiresAt: number }>();

// Short-lived authorization codes (RFC 6749 §4.1). One-time use, 10-minute TTL.
const authCodes = new Map<
  string,
  { clientId: string; redirectUri: string; codeChallenge: string; expiresAt: number }
>();
const AUTH_CODE_TTL_SECONDS = 600;

function issueAuthCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
): string {
  const code = `code_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  authCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
  });
  if (authCodes.size > 100) {
    const now = Date.now();
    for (const [k, v] of authCodes) if (v.expiresAt < now) authCodes.delete(k);
  }
  return code;
}

// PKCE S256 verifier per RFC 7636 §4.6: base64url(SHA256(code_verifier)) === code_challenge.
function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest();
  const computed = hash.toString('base64url');
  return computed === codeChallenge;
}

function issueOAuthToken(): { access_token: string; expires_in: number } {
  const token = `cmt_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const expiresAt = Date.now() + OAUTH_TOKEN_TTL_SECONDS * 1000;
  oauthTokens.set(token, { expiresAt });
  // Opportunistic cleanup of expired tokens so the map doesn't grow unboundedly.
  if (oauthTokens.size > 100) {
    const now = Date.now();
    for (const [k, v] of oauthTokens) if (v.expiresAt < now) oauthTokens.delete(k);
  }
  return { access_token: token, expires_in: OAUTH_TOKEN_TTL_SECONDS };
}

function isValidOAuthToken(token: string): boolean {
  const entry = oauthTokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    oauthTokens.delete(token);
    return false;
  }
  return true;
}

// Refresh tokens: 90-day TTL, rotated on every use (RFC 6749 §6 + OAuth 2.1
// guidance). Stored in-memory; restart drops them and clients fall back to
// the /authorize flow. Keyed to clientId so tokens can't be exchanged across
// clients if more are ever registered.
const oauthRefreshTokens = new Map<string, { clientId: string; expiresAt: number }>();

function issueRefreshToken(clientId: string): string {
  const token = `cmr_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  oauthRefreshTokens.set(token, {
    clientId,
    expiresAt: Date.now() + OAUTH_REFRESH_TTL_SECONDS * 1000,
  });
  if (oauthRefreshTokens.size > 100) {
    const now = Date.now();
    for (const [k, v] of oauthRefreshTokens) if (v.expiresAt < now) oauthRefreshTokens.delete(k);
  }
  return token;
}

// One-time consume: returns true iff the token was valid and matches the
// supplied clientId. Always deletes the token, even on failure, so a leaked
// token can't be retried. Caller mints a fresh refresh_token on success.
function consumeRefreshToken(token: string, clientId: string): boolean {
  const entry = oauthRefreshTokens.get(token);
  if (!entry) return false;
  oauthRefreshTokens.delete(token);
  if (entry.expiresAt < Date.now()) return false;
  if (entry.clientId !== clientId) return false;
  return true;
}

function extractBearer(req: http.IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function checkBearer(req: http.IncomingMessage): boolean {
  const token = extractBearer(req);
  // Static bearer path — kept for backwards compat (curl, scripts, stdio-era clients).
  if (MCP_BEARER && token === MCP_BEARER) return true;
  // OAuth-issued access token path — for Cowork and any RFC-6749 client.
  if (OAUTH_ENABLED && token && isValidOAuthToken(token)) return true;
  // No auth configured at all → permissive (local dev only).
  if (!MCP_BEARER && !OAUTH_ENABLED) return true;
  return false;
}

// Parse OAuth credentials from either HTTP Basic auth header or form body
// (per RFC 6749 §2.3.1, both MUST be supported).
function parseOAuthCredentials(
  req: http.IncomingMessage,
  body: Record<string, string>,
): { clientId: string; clientSecret: string } | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const basicMatch = auth.match(/^Basic\s+(.+)$/i);
    if (basicMatch) {
      const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
      }
    }
  }
  if (body.client_id && body.client_secret) {
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }
  return null;
}

// Constant-time string equality to avoid timing attacks on client_secret.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { timingSafeEqual: tse } = require('node:crypto') as typeof import('node:crypto');
    return tse(ba, bb);
  } catch {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
}

async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseFormBody(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

async function runHttp(): Promise<void> {
  if (!MCP_BEARER) {
    console.warn(
      '[cmd-mcp] WARNING: CMD_MCP_BEARER_TOKEN is empty — auth is DISABLED. Set this env var for any non-local deployment.',
    );
  }

  const httpServer = http.createServer(async (req, res) => {
    const started = Date.now();
    const label = `${req.method} ${req.url}`;

    // CORS — permissive for now; Phase 2 locks down to Cowork origins.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint — unauthenticated by design so external monitors can probe.
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'cmd-mcp',
          version: '0.2.0',
          cmd_base_url: CMD_BASE_URL,
          auth_required: Boolean(MCP_BEARER) || OAUTH_ENABLED,
          oauth_enabled: OAUTH_ENABLED,
          time: new Date().toISOString(),
        }),
      );
      return;
    }

    // OAuth 2.0 metadata discovery — unauthenticated per RFC 9728 / 8414.
    if (req.method === 'GET' &&
        (req.url === '/.well-known/oauth-protected-resource' ||
         req.url === '/.well-known/oauth-protected-resource/mcp')) {
      if (!OAUTH_ENABLED) { writeJson(res, 404, { error: 'oauth_not_configured' }); return; }
      writeJson(res, 200, oauthProtectedResourceMetadata());
      return;
    }
    if (req.method === 'GET' && req.url === '/.well-known/oauth-authorization-server') {
      if (!OAUTH_ENABLED) { writeJson(res, 404, { error: 'oauth_not_configured' }); return; }
      writeJson(res, 200, oauthAuthorizationServerMetadata());
      return;
    }

    // OAuth 2.0 authorization endpoint — Authorization Code + PKCE flow.
    if (req.url?.startsWith('/authorize')) {
      handleAuthorizeEndpoint(req, res);
      return;
    }

    // OAuth 2.0 token endpoint — authorization_code or client_credentials grants.
    if (req.url === '/oauth/token') {
      await handleTokenEndpoint(req, res);
      return;
    }

    // MCP endpoint — authed (static bearer OR OAuth-issued token).
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', hint: 'POST /mcp or GET /health' }));
      return;
    }

    if (!checkBearer(req)) {
      unauthorized(res, 'Authorization: Bearer <token> required');
      return;
    }

    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      const mcpServer = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      await transport.handleRequest(req, res, body);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          tool: 'http',
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration_ms: Date.now() - started,
        }),
      );
    } catch (err) {
      console.error(`[cmd-mcp] ${label} error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  httpServer.listen(MCP_PORT, MCP_HOST, () => {
    console.log(`[cmd-mcp] http mode on http://${MCP_HOST}:${MCP_PORT}, base=${CMD_BASE_URL}`);
    console.log(`[cmd-mcp]   MCP endpoint : POST /mcp  (bearer ${MCP_BEARER ? 'required' : 'DISABLED'}${OAUTH_ENABLED ? ', OAuth accepted' : ''})`);
    console.log(`[cmd-mcp]   Health check : GET  /health`);
    if (OAUTH_ENABLED) {
      console.log(`[cmd-mcp]   OAuth authz  : GET  /authorize  (response_type=code, PKCE S256)`);
      console.log(`[cmd-mcp]   OAuth token  : POST /oauth/token  (grant_type=authorization_code | client_credentials | refresh_token)`);
      console.log(`[cmd-mcp]   OAuth meta   : GET  /.well-known/oauth-protected-resource{,/mcp}`);
      console.log(`[cmd-mcp]   OAuth meta   : GET  /.well-known/oauth-authorization-server`);
      console.log(`[cmd-mcp]   Advertised   : ${PUBLIC_URL}`);
    }
  });
}

// ── Entry ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (MCP_TRANSPORT === 'http') {
    await runHttp();
  } else if (MCP_TRANSPORT === 'stdio') {
    await runStdio();
  } else {
    throw new Error(`Unknown MCP_TRANSPORT "${MCP_TRANSPORT}". Use "stdio" or "http".`);
  }
}

main().catch((err) => {
  console.error('[cmd-mcp] fatal:', err);
  process.exit(1);
});
