import fs from 'fs';
import yaml from 'js-yaml';

/**
 * Capabilities declared in agent.md frontmatter.
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
  /** Default model for this agent (e.g., claude-sonnet-4-6). From agent.md frontmatter. */
  model?: string;
  /** Optional per-skill model overrides. E.g. { 'simple-lookup': 'claude-haiku-4-5-20251001' } */
  skillModels?: Record<string, string>;
}

/**
 * Split an agent.md file into its YAML frontmatter and markdown body.
 * Returns { frontmatter: null, body: fullContent } if no frontmatter present.
 */
export function splitFrontmatter(fileContent: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  // Strip UTF-8 BOM if present
  const content = fileContent.replace(/^\uFEFF/, '');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  const parsed = yaml.load(match[1]);
  const frontmatter = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : null;
  return { frontmatter, body: match[2] };
}

/**
 * Read an agent.md file and return both parsed frontmatter and the body
 * (the body is what should be fed as the system prompt to Claude).
 */
export function readAgentMd(filePath: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return splitFrontmatter(raw);
}
