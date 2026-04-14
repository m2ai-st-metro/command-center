import path from 'path';
import { fileURLToPath } from 'url';
import { startAgentServer } from '../runtime/server.js';
import type { AgentConfig } from '../runtime/agent-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: AgentConfig = {
  id: 'coding',
  name: 'Ravage',
  description: 'Software engineering — write, modify, debug, refactor, and review code across Python and TypeScript projects.',
  skills: ['coding', 'debugging', 'refactoring', 'testing', 'git'],
  type: 'named',
  port: parseInt(process.env.CODING_AGENT_PORT ?? '3144', 10),
  system_prompt_path: path.resolve(__dirname, 'agent.md'),
  accepts: ['text/plain'],
  produces: ['text/plain', 'text/markdown'],
  timeout_ms: 600_000, // 10 min
};

startAgentServer(config);
