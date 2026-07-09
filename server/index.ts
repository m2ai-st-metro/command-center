import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDatabase, syncAgentCapabilities } from './db.js';
import { seedDefaultAgents } from './seed.js';
import { router } from './routes.js';
import { SCRATCHPAD_DIR, ARCHIVE_DIR } from './scratchpad.js';
import { startScheduler } from './scheduler.js';
import { startMissionDispatcher } from './mission-dispatcher.js';
import { startTriggerEvaluator } from './trigger-eval.js';
import { startTriggerPoll } from './trigger-poll.js';
import { requireApiToken, API_TOKEN } from './auth.js';

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

// P3 (Q-20260708-0007): tighten the orchestrator CORS from wildcard to an origin
// allowlist, mirroring the agent runtime (agents/runtime/server.ts). Non-browser
// callers (mission-cli, cmd-mcp) send no Origin header and are unaffected; the
// dashboard is same-origin. CORS is browser-only, so this is defense-in-depth.
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3142',
  'http://localhost:3142',
  'http://10.0.0.46:3142',
]);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.has(origin)) cb(null, true);
      else cb(new Error('Not allowed by CORS'));
    },
  }),
);
app.use(express.json());

// API routes — bearer required on all mutating methods (Q-20260708-0007).
app.use('/api', requireApiToken, router);

// Scratchpad artifacts (ad-hoc reports) served from outside the work-tree.
// Mount _archive first so its prefix is not swallowed by the active mount.
app.use('/scratchpad-files/_archive', express.static(ARCHIVE_DIR));
app.use('/scratchpad-files', express.static(SCRATCHPAD_DIR));

// Serve React SPA in production.
const clientDist = path.resolve(PROJECT_ROOT, 'dist', 'client');
// index:false so static never serves the raw index.html — the catch-all below
// serves a token-injected copy instead.
app.use(express.static(clientDist, { index: false }));

// Inject the API bearer into the SPA at serve time (Q-20260708-0007): the browser
// sends it WITHOUT the secret ever living in a committed bundle. Only hosts the ufw
// allowlist permits (Surface + localhost) can fetch this. Precomputed once at boot.
// The token is hex (openssl rand -hex), so JSON.stringify yields a safe <script> literal.
const indexHtml = (() => {
  try {
    const raw = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
    const inject = `<script>window.__CMD_TOKEN__=${JSON.stringify(API_TOKEN)}</script>`;
    return raw.includes('</head>') ? raw.replace('</head>', `${inject}</head>`) : `${inject}${raw}`;
  } catch {
    return ''; // dev / not-built: nothing to serve
  }
})();
app.get('*', (_req, res) => {
  if (indexHtml) res.type('html').send(indexHtml);
  else res.status(404).send('Client not built');
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
