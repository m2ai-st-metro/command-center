import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { upsertAgent } from './db.js';
import { registerA2AAgent } from './orchestrator.js';
import { readAgentMd } from '../shared/agent-md.js';

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');

/**
 * Pull skills from an agent.md frontmatter.
 * Falls back to the provided hardcoded list when:
 *   - the agent.md file does not exist
 *   - there is no frontmatter
 *   - the frontmatter has no skills key or it is not an array
 */
function resolveSkills(agentId: string, fallback: string[]): string[] {
  const mdPath = path.join(AGENTS_DIR, agentId, 'agent.md');
  if (!fs.existsSync(mdPath)) return fallback;
  try {
    const { frontmatter } = readAgentMd(mdPath);
    if (
      frontmatter &&
      Array.isArray(frontmatter.skills) &&
      (frontmatter.skills as unknown[]).every(s => typeof s === 'string')
    ) {
      return frontmatter.skills as string[];
    }
  } catch {
    // Malformed frontmatter — use fallback
  }
  return fallback;
}

/**
 * Seed agents into the registry and register A2A endpoints.
 */
export function seedDefaultAgents(): void {
  // Claude Code — direct dispatch fallback (no A2A endpoint)
  upsertAgent(
    'claude-code',
    'Claude Code',
    'General-purpose coding and task execution via Claude Code CLI',
    ['general', 'ops'],
    'stock'
  );

  // Soundwave — Ingestion Meta-Agent, A2A enabled
  upsertAgent(
    'research',
    'Soundwave',
    'Ingestion meta-agent for ST Metro — research-agents cron, IdeaForge integrity, anomaly investigation',
    resolveSkills('research', ['research', 'analysis', 'reporting', 'web-search', 'ingestion', 'ideaforge']),
    'named'
  );
  registerA2AAgent('research', 'http://localhost:3143');

  // Ravage — Coding Agent, A2A enabled
  upsertAgent(
    'coding',
    'Ravage',
    'Software engineering — write, modify, debug, refactor, and review code',
    resolveSkills('coding', ['coding', 'debugging', 'refactoring', 'testing', 'git']),
    'named'
  );
  registerA2AAgent('coding', 'http://localhost:3144');

  // Creator — Content Creation Agent, A2A enabled, scoped to trades/service businesses
  upsertAgent(
    'content',
    'Creator',
    'Content creation for trades and service businesses — social, SEO blogs, case studies, content calendars',
    resolveSkills('content', ['content', 'writing', 'social-media', 'seo', 'case-studies', 'content-calendar']),
    'named'
  );
  registerA2AAgent('content', 'http://localhost:3145');

  // Data — Chief of Staff, A2A enabled, dispatches to other agents
  upsertAgent(
    'data',
    'Data',
    'Chief of Staff for ST Metro — dispatch layer, open-item queue, weekly digest',
    resolveSkills('data', ['dispatch', 'digest', 'open-items', 'cleanup', 'cos']),
    'named'
  );
  registerA2AAgent('data', 'http://localhost:3146');

  // Kup — Engineering grunt, A2A enabled, can spawn sub-agents
  upsertAgent(
    'kup',
    'Kup',
    'Engineering grunt for ST Metro — infra maintenance, pattern porting, postmortem drafting',
    resolveSkills('kup', ['engineering', 'infrastructure', 'porting', 'postmortem', 'maintenance']),
    'named'
  );
  registerA2AAgent('kup', 'http://localhost:3147');
}
