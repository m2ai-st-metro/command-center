import path from 'path';
import { fileURLToPath } from 'url';
import { startAgentServer } from '../runtime/server.js';
import type { AgentConfig } from '../runtime/agent-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: AgentConfig = {
  id: 'research',
  name: 'Soundwave',
  description: 'Deep web research, database analysis, and structured reporting.',
  skills: ['research', 'analysis', 'reporting', 'web-search'],
  type: 'named',
  port: parseInt(process.env.RESEARCH_AGENT_PORT ?? '3143', 10),
  system_prompt_path: path.resolve(__dirname, 'agent.md'),
  accepts: ['text/plain'],
  produces: ['text/plain', 'text/markdown'],
  timeout_ms: 600_000, // 10 min
};

startAgentServer(config);
