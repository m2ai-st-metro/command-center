// Re-export shared agent.md helpers for backwards compatibility with local imports.
// Canonical location is shared/agent-md.ts — both server/ and agents/runtime/ import from there.
export { splitFrontmatter, readAgentMd } from '../../shared/agent-md.js';
export type { AgentCapabilitiesConfig } from '../../shared/agent-md.js';

/**
 * Agent configuration — loaded from index.ts + agent.md frontmatter.
 */
export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  skills: string[];
  type: 'named' | 'stock';
  port: number;
  /** Path to the markdown file (with YAML frontmatter + system prompt body) */
  system_prompt_path?: string;
  /** Inline system prompt (alternative to file) */
  system_prompt?: string;
  /** What input formats this agent accepts */
  accepts: string[];
  /** What output formats this agent produces */
  produces: string[];
  /** Task timeout in ms */
  timeout_ms: number;
  /** Capabilities from agent.md frontmatter (optional — Tier 2/3 won't have this) */
  capabilities?: import('../../shared/agent-md.js').AgentCapabilitiesConfig;
}

export const DEFAULT_CONFIG: Partial<AgentConfig> = {
  type: 'stock',
  accepts: ['text/plain'],
  produces: ['text/plain'],
  timeout_ms: 600_000, // 10 min
};

/** Default tools for agents without a capabilities config */
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
