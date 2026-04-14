import { upsertAgent } from './db.js';
import { registerA2AAgent } from './orchestrator.js';

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
    ['research', 'analysis', 'reporting', 'web-search', 'ingestion', 'ideaforge'],
    'named'
  );
  registerA2AAgent('research', 'http://localhost:3143');

  // Ravage — Coding Agent, A2A enabled
  upsertAgent(
    'coding',
    'Ravage',
    'Software engineering — write, modify, debug, refactor, and review code',
    ['coding', 'debugging', 'refactoring', 'testing', 'git'],
    'named'
  );
  registerA2AAgent('coding', 'http://localhost:3144');

  // Creator — Content Creation Agent, A2A enabled, scoped to trades/service businesses
  upsertAgent(
    'content',
    'Creator',
    'Content creation for trades and service businesses — social, SEO blogs, case studies, content calendars',
    ['content', 'writing', 'social-media', 'seo', 'case-studies', 'content-calendar'],
    'named'
  );
  registerA2AAgent('content', 'http://localhost:3145');
}
