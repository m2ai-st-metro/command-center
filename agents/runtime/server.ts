import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import type { AgentConfig } from './agent-config.js';
import type { AgentCapabilitiesConfig } from '../../shared/agent-md.js';
import { readAgentMd } from '../../shared/agent-md.js';
import type { A2AAgentCard, A2ATaskRequest, A2ATaskResponse, A2ATaskStatus } from '../../shared/a2a.js';
import { createTask, getTask, addTaskLog } from './task-store.js';
import { executeTask } from './executor.js';

/**
 * Load capabilities from agent.md frontmatter next to the agent's index.ts.
 * Returns undefined if no agent.md is found or it has no frontmatter (Tier 2/3 fallback).
 */
function loadCapabilities(config: AgentConfig): AgentCapabilitiesConfig | undefined {
  // agent.md lives alongside index.ts
  const agentDir = config.system_prompt_path
    ? path.dirname(config.system_prompt_path)
    : undefined;

  if (!agentDir) return undefined;

  const agentMdPath = config.system_prompt_path ?? path.join(agentDir, 'agent.md');
  if (!fs.existsSync(agentMdPath)) return undefined;

  const { frontmatter } = readAgentMd(agentMdPath);
  if (!frontmatter) return undefined;
  const raw = frontmatter as Record<string, unknown>;

  // Resolve MCP config path
  let mcpConfigPath: string | undefined;
  const mcpJsonPath = path.join(agentDir, '.claude', 'mcp.json');
  const mcpServers = (raw.mcpServers as string[] | undefined) ?? [];
  if (mcpServers.length > 0 && fs.existsSync(mcpJsonPath)) {
    mcpConfigPath = mcpJsonPath;
  }

  return {
    tier: (raw.tier as number | undefined) ?? 3,
    tools: (raw.tools as string[] | undefined) ?? ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
    mcpServers,
    mcpConfigPath,
    canSpawnSubAgents: (raw.canSpawnSubAgents as boolean | undefined) ?? false,
    maxTurns: (raw.maxTurns as number | undefined) ?? 25,
    timeout: (raw.timeout as number | undefined) ?? 900_000,
  };
}

/**
 * Start an A2A-compliant agent server.
 * This is the generic runtime shell — any agent config + system prompt
 * can be loaded to create a specialist agent.
 */
export function startAgentServer(config: AgentConfig): void {
  // Load system prompt — strip YAML frontmatter so only the body is fed to Claude
  let systemPrompt = config.system_prompt ?? '';
  if (config.system_prompt_path && !systemPrompt) {
    try {
      const { body } = readAgentMd(config.system_prompt_path);
      systemPrompt = body;
    } catch (err) {
      console.error(`Failed to load system prompt from ${config.system_prompt_path}:`, err);
      process.exit(1);
    }
  }

  // Load capabilities from agent.md frontmatter
  const capabilities = loadCapabilities(config);
  if (capabilities) {
    console.log(`[${config.name}] Capabilities loaded: tier ${capabilities.tier}, tools: [${capabilities.tools.join(', ')}], MCP: [${capabilities.mcpServers.join(', ')}]`);
  } else {
    console.log(`[${config.name}] No agent.md frontmatter found — using default capabilities`);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── A2A: Agent Card ──────────────────────────────────────────────
  const agentCard: A2AAgentCard = {
    id: config.id,
    name: config.name,
    description: config.description,
    skills: config.skills,
    type: config.type,
    protocol_version: '0.1',
    endpoint: `http://localhost:${config.port}`,
    accepts: config.accepts,
    produces: config.produces,
  };

  app.get('/.well-known/agent.json', (_req, res) => {
    res.json(agentCard);
  });

  // ── A2A: Submit Task ─────────────────────────────────────────────
  app.post('/task', (req, res) => {
    const body = req.body as A2ATaskRequest;

    if (!body.id || !body.goal) {
      res.status(400).json({ error: 'id and goal are required' });
      return;
    }

    const task = createTask(
      body.id,
      body.goal,
      body.sender?.id ?? 'unknown',
      body.sender?.name ?? 'unknown',
      body.context,
    );

    addTaskLog(task.id, 'info', `Task received from ${body.sender?.name ?? 'unknown'}`);

    // Fire-and-forget execution — pass capabilities for dynamic tool/MCP selection
    executeTask(
      task.id,
      body.goal,
      systemPrompt,
      body.context,
      body.timeout_ms ?? config.timeout_ms,
      capabilities,
    ).catch((err) => {
      console.error(`Task ${task.id} execution error:`, err);
    });

    const response: A2ATaskResponse = {
      task_id: task.id,
      state: 'queued',
      estimated_seconds: Math.round(config.timeout_ms / 1000 / 2),
    };

    res.status(202).json(response);
  });

  // ── A2A: Task Status ─────────────────────────────────────────────
  app.get('/task/:id', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const status: A2ATaskStatus = {
      task_id: task.id,
      state: task.state,
      progress: task.logs.length > 0 ? task.logs[task.logs.length - 1].message : undefined,
      result: task.result,
      error: task.error,
      duration_ms: task.duration_ms,
      logs: task.logs,
    };

    res.json(status);
  });

  // ── Capabilities endpoint (for orchestrator introspection) ─────
  app.get('/capabilities', (_req, res) => {
    res.json(capabilities ?? { tier: 3, tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'], mcpServers: [], canSpawnSubAgents: false, maxTurns: 25, timeout: 900_000 });
  });

  // ── Health ───────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: config.id });
  });

  // ── Start ────────────────────────────────────────────────────────
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[${config.name}] A2A agent running on port ${config.port}`);
    console.log(`[${config.name}] Agent card: http://localhost:${config.port}/.well-known/agent.json`);
  });
}
