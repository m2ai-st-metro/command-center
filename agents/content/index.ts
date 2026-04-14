import path from 'path';
import { fileURLToPath } from 'url';
import { startAgentServer } from '../runtime/server.js';
import type { AgentConfig } from '../runtime/agent-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: AgentConfig = {
  id: 'content',
  name: 'Content Agent',
  description: 'Writing and content specialist — blog posts, documentation, social media, email drafts, reports, and marketing copy.',
  skills: ['content', 'writing', 'documentation', 'social-media', 'editing'],
  type: 'named',
  port: parseInt(process.env.CONTENT_AGENT_PORT ?? '3145', 10),
  system_prompt_path: path.resolve(__dirname, 'agent.md'),
  accepts: ['text/plain'],
  produces: ['text/plain', 'text/markdown'],
  timeout_ms: 600_000, // 10 min
};

startAgentServer(config);
