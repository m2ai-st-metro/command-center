/**
 * Agent configuration — loaded from index.ts + agent.config.json.
 */
export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  skills: string[];
  type: 'named' | 'stock';
  port: number;
  /** Path to the markdown system prompt file */
  system_prompt_path?: string;
  /** Inline system prompt (alternative to file) */
  system_prompt?: string;
  /** What input formats this agent accepts */
  accepts: string[];
  /** What output formats this agent produces */
  produces: string[];
  /** Task timeout in ms */
  timeout_ms: number;
  /** Capabilities from agent.config.json (optional — Tier 2/3 won't have this) */
  capabilities?: AgentCapabilitiesConfig;
}

/**
 * Capabilities declared in agent.config.json.
 * Controls which tools, MCP servers, and flags are passed to Claude Code.
 */
export interface AgentCapabilitiesConfig {
  tier: number;
  tools: string[];
  mcpServers: string[];
  mcpConfigPath?: string;
  canSpawnSubAgents: boolean;
  maxTurns: number;
  timeout: number;
}

export const DEFAULT_CONFIG: Partial<AgentConfig> = {
  type: 'stock',
  accepts: ['text/plain'],
  produces: ['text/plain'],
  timeout_ms: 600_000, // 10 min
};

/** Default tools for agents without a capabilities config */
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
