import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDatabase, syncAgentCapabilities } from './db.js';
import { seedDefaultAgents } from './seed.js';
import { router } from './routes.js';
import { startScheduler } from './scheduler.js';
import { startMissionDispatcher } from './mission-dispatcher.js';
import { startTriggerEvaluator } from './trigger-eval.js';
import { startTriggerPoll } from './trigger-poll.js';

// Find project root
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const PORT = parseInt(process.env.COMMAND_CENTER_PORT ?? '3142', 10);

// ── Initialize ───────────────────────────────────────────────────────

initDatabase();
seedDefaultAgents();
const synced = syncAgentCapabilities(PROJECT_ROOT);
console.log(`Database initialized, agents seeded, ${synced} agent capabilities synced`);

// ── Express App ──────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api', router);

// Serve React SPA in production
const clientDist = path.resolve(PROJECT_ROOT, 'dist', 'client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Start ────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Command Center running on http://0.0.0.0:${PORT}`);
  console.log(`Access from Surface: http://10.0.0.46:${PORT}`);
  startScheduler();
  startMissionDispatcher();
  startTriggerEvaluator();
  startTriggerPoll();
});
