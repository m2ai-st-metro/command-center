import { spawn } from 'child_process';
import { updateTask, addTaskLog } from './task-store.js';
import type { AgentCapabilitiesConfig } from './agent-config.js';
import { DEFAULT_TOOLS } from './agent-config.js';

/**
 * Execute a task via Claude Code CLI with the agent's system prompt.
 * Uses --append-system-prompt for agent instructions (separate from user goal).
 * Dynamically builds --allowedTools and --mcp-config from agent capabilities.
 */
export async function executeTask(
  taskId: string,
  goal: string,
  systemPrompt: string,
  context?: string,
  timeoutMs = 900_000,
  capabilities?: AgentCapabilitiesConfig,
): Promise<void> {
  updateTask(taskId, { state: 'running' });
  addTaskLog(taskId, 'info', 'Starting Claude Code session...');

  const startTime = Date.now();

  // Build user prompt with optional context
  const userPrompt = context
    ? `[Context]\n${context}\n[End Context]\n\n${goal}`
    : goal;

  try {
    const result = await runClaudeCode(taskId, userPrompt, systemPrompt, timeoutMs, capabilities);
    const durationMs = Date.now() - startTime;

    updateTask(taskId, {
      state: 'completed',
      result,
      duration_ms: durationMs,
    });
    addTaskLog(taskId, 'info', `Completed in ${Math.round(durationMs / 1000)}s`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);

    updateTask(taskId, {
      state: 'failed',
      error: errMsg,
      duration_ms: durationMs,
    });
    addTaskLog(taskId, 'error', `Failed: ${errMsg}`);
  }
}

function runClaudeCode(
  taskId: string,
  prompt: string,
  systemPrompt: string,
  timeoutMs: number,
  capabilities?: AgentCapabilitiesConfig,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Determine tools from capabilities or use defaults
    const tools = capabilities?.tools ?? DEFAULT_TOOLS;
    const maxTurns = capabilities?.maxTurns ?? 25;

    const args = [
      '--print', prompt,
      '--output-format', 'text',
      '--append-system-prompt', systemPrompt,
      '--allowedTools', ...tools,
      '--max-turns', String(maxTurns),
    ];

    // R2.4: if a model is resolved (from frontmatter model or skillModels[skill]),
    // pass --model. Otherwise let the CLI use its default.
    if (capabilities?.model) {
      args.push('--model', capabilities.model);
      addTaskLog(taskId, 'info', `Model: ${capabilities.model}`);
    }

    // Add MCP config if agent has MCP servers configured
    if (capabilities?.mcpConfigPath) {
      args.push('--mcp-config', capabilities.mcpConfigPath);
      // Isolate from user's personal MCP servers (Gmail, Notion, etc.)
      args.push('--strict-mcp-config');
      addTaskLog(taskId, 'info', `MCP config: ${capabilities.mcpConfigPath} (strict isolation)`);
    }

    // If agent can spawn sub-agents, add the Agent tool to allowed tools
    if (capabilities?.canSpawnSubAgents && !tools.includes('Agent')) {
      args.splice(args.indexOf('--allowedTools') + 1, 0);
      // Agent tool is already in the --allowedTools list if canSpawnSubAgents is true
      // and was specified in agent.md tools array. No extra handling needed.
    }

    // Build env without ANTHROPIC_API_KEY (use Max OAuth)
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const toolList = tools.join(', ');
    addTaskLog(taskId, 'info', `Tools: ${toolList} | Max turns: ${maxTurns}`);

    const child = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Log stderr lines as progress for visibility
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        addTaskLog(taskId, 'progress', line.slice(0, 200));
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim() || '(no output)');
      } else {
        reject(new Error(`Claude Code exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
    });
  });
}
