import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Find project root by looking for package.json
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
const DB_PATH = path.resolve(STORE_DIR, 'command-center.db');

let db: Database.Database;

export function initDatabase(): Database.Database {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      plan TEXT,
      result TEXT,
      duration_ms INTEGER,
      agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS mission_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL REFERENCES missions(id),
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'available',
      type TEXT NOT NULL DEFAULT 'stock',
      active_mission_id TEXT
    );

    CREATE TABLE IF NOT EXISTS outcome_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL REFERENCES missions(id),
      task_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      classification_reasoning TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_capabilities (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      tier INTEGER NOT NULL DEFAULT 3,
      tools TEXT NOT NULL DEFAULT '[]',
      mcp_servers TEXT NOT NULL DEFAULT '[]',
      mcp_config_path TEXT,
      can_spawn_sub_agents INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 25,
      timeout INTEGER NOT NULL DEFAULT 900000,
      synced_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_mission_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_mission_logs_mission ON mission_logs(mission_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_outcome_logs_agent ON outcome_logs(agent_id);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// ── Mission CRUD ─────────────────────────────────────────────────────

export function createMission(id: string, goal: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'INSERT INTO missions (id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, goal, 'proposed', now, now);
}

interface MissionRow {
  id: string;
  goal: string;
  status: string;
  created_at: number;
  updated_at: number;
  plan: string | null;
  result: string | null;
  duration_ms: number | null;
  agent_id: string | null;
}

export function getMission(id: string) {
  const row = getDb().prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined;
  if (!row) return null;
  return {
    ...row,
    plan: row.plan ? JSON.parse(row.plan) : null,
  };
}

export function listMissions(limit = 50) {
  const rows = getDb().prepare(
    'SELECT * FROM missions ORDER BY updated_at DESC LIMIT ?'
  ).all(limit) as MissionRow[];
  return rows.map(row => ({
    ...row,
    plan: row.plan ? JSON.parse(row.plan) : null,
  }));
}

export function updateMission(id: string, updates: Record<string, unknown>): void {
  const now = Math.floor(Date.now() / 1000);
  const fields = Object.keys(updates);
  const sets = [...fields.map(f => `${f} = ?`), 'updated_at = ?'].join(', ');
  const values = [...fields.map(f => {
    const v = updates[f];
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  }), now, id];
  getDb().prepare(`UPDATE missions SET ${sets} WHERE id = ?`).run(...values);
}

// ── Mission Logs ─────────────────────────────────────────────────────

export function addMissionLog(missionId: string, level: string, message: string, agentId?: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'INSERT INTO mission_logs (mission_id, timestamp, level, message, agent_id) VALUES (?, ?, ?, ?, ?)'
  ).run(missionId, now, level, message, agentId ?? null);
}

export function getMissionLogs(missionId: string) {
  return getDb().prepare(
    'SELECT * FROM mission_logs WHERE mission_id = ? ORDER BY timestamp ASC'
  ).all(missionId);
}

// ── Agent Registry ───────────────────────────────────────────────────

export function upsertAgent(id: string, name: string, description: string, skills: string[], type: string): void {
  getDb().prepare(`
    INSERT INTO agents (id, name, description, skills, status, type)
    VALUES (?, ?, ?, ?, 'available', ?)
    ON CONFLICT(id) DO UPDATE SET name=?, description=?, skills=?, type=?
  `).run(id, name, description, JSON.stringify(skills), type, name, description, JSON.stringify(skills), type);
}

export function listAgents() {
  const rows = getDb().prepare('SELECT * FROM agents ORDER BY name').all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    ...row,
    skills: JSON.parse(row.skills as string),
  }));
}

export function updateAgentStatus(id: string, status: string, activeMissionId?: string | null): void {
  getDb().prepare(
    'UPDATE agents SET status = ?, active_mission_id = ? WHERE id = ?'
  ).run(status, activeMissionId ?? null, id);
}

// ── Outcome Logging ──────────────────────────────────────────────────

export function logOutcome(
  missionId: string,
  taskType: string,
  agentId: string,
  reasoning: string,
  status: string,
  durationMs?: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'INSERT INTO outcome_logs (mission_id, task_type, agent_id, classification_reasoning, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(missionId, taskType, agentId, reasoning, status, durationMs ?? null, now);
}

// ── Agent Capabilities ──────────────────────────────────────────────

export interface AgentCapabilities {
  agent_id: string;
  tier: number;
  tools: string[];
  mcp_servers: string[];
  mcp_config_path: string | null;
  can_spawn_sub_agents: boolean;
  max_turns: number;
  timeout: number;
}

export function upsertAgentCapabilities(cap: AgentCapabilities): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO agent_capabilities (agent_id, tier, tools, mcp_servers, mcp_config_path, can_spawn_sub_agents, max_turns, timeout, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      tier=?, tools=?, mcp_servers=?, mcp_config_path=?, can_spawn_sub_agents=?, max_turns=?, timeout=?, synced_at=?
  `).run(
    cap.agent_id, cap.tier, JSON.stringify(cap.tools), JSON.stringify(cap.mcp_servers),
    cap.mcp_config_path, cap.can_spawn_sub_agents ? 1 : 0, cap.max_turns, cap.timeout, now,
    cap.tier, JSON.stringify(cap.tools), JSON.stringify(cap.mcp_servers),
    cap.mcp_config_path, cap.can_spawn_sub_agents ? 1 : 0, cap.max_turns, cap.timeout, now,
  );
}

export function getAgentCapabilities(agentId: string): AgentCapabilities | null {
  const row = getDb().prepare(
    'SELECT * FROM agent_capabilities WHERE agent_id = ?'
  ).get(agentId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    agent_id: row.agent_id as string,
    tier: row.tier as number,
    tools: JSON.parse(row.tools as string),
    mcp_servers: JSON.parse(row.mcp_servers as string),
    mcp_config_path: row.mcp_config_path as string | null,
    can_spawn_sub_agents: (row.can_spawn_sub_agents as number) === 1,
    max_turns: row.max_turns as number,
    timeout: row.timeout as number,
  };
}

export function listAgentCapabilities(): AgentCapabilities[] {
  const rows = getDb().prepare('SELECT * FROM agent_capabilities').all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    agent_id: row.agent_id as string,
    tier: row.tier as number,
    tools: JSON.parse(row.tools as string),
    mcp_servers: JSON.parse(row.mcp_servers as string),
    mcp_config_path: row.mcp_config_path as string | null,
    can_spawn_sub_agents: (row.can_spawn_sub_agents as number) === 1,
    max_turns: row.max_turns as number,
    timeout: row.timeout as number,
  }));
}

/**
 * Sync agent.config.json files from agents/ directory into the capability registry.
 * Source of truth: files on disk. Registry is a runtime cache.
 */
export function syncAgentCapabilities(projectRoot: string): number {
  const agentsDir = path.resolve(projectRoot, 'agents');
  const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'runtime')
    .map(d => d.name);

  let synced = 0;
  for (const dirName of agentDirs) {
    const configPath = path.join(agentsDir, dirName, 'agent.config.json');
    if (!fs.existsSync(configPath)) continue;

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Resolve MCP config path if agent has MCP servers
    let mcpConfigPath: string | null = null;
    const mcpJsonPath = path.join(agentsDir, dirName, '.claude', 'mcp.json');
    if (raw.mcpServers?.length > 0 && fs.existsSync(mcpJsonPath)) {
      mcpConfigPath = mcpJsonPath;
    }

    // Map directory name to agent ID (directory name IS the agent ID)
    const agentId = dirName;

    upsertAgentCapabilities({
      agent_id: agentId,
      tier: raw.tier ?? 3,
      tools: raw.tools ?? ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
      mcp_servers: raw.mcpServers ?? [],
      mcp_config_path: mcpConfigPath,
      can_spawn_sub_agents: raw.canSpawnSubAgents ?? false,
      max_turns: raw.maxTurns ?? 25,
      timeout: raw.timeout ?? 900_000,
    });
    synced++;
  }

  return synced;
}

// ── Schedules ───────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  goal: string;
  cron: string;
  enabled: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  last_mission_id: string | null;
  created_at: number;
}

export function createSchedule(id: string, goal: string, cron: string, nextRunAt: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'INSERT INTO schedules (id, goal, cron, enabled, next_run_at, created_at) VALUES (?, ?, ?, 1, ?, ?)'
  ).run(id, goal, cron, nextRunAt, now);
}

export function listSchedules(): Schedule[] {
  const rows = getDb().prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    goal: row.goal as string,
    cron: row.cron as string,
    enabled: (row.enabled as number) === 1,
    last_run_at: row.last_run_at as number | null,
    next_run_at: row.next_run_at as number | null,
    last_mission_id: row.last_mission_id as string | null,
    created_at: row.created_at as number,
  }));
}

export function updateSchedule(id: string, updates: Partial<{ goal: string; cron: string; enabled: boolean; last_run_at: number; next_run_at: number; last_mission_id: string }>): void {
  const fields = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (fields.length === 0) return;
  const sets = fields.map(([k]) => `${k} = ?`).join(', ');
  const values = fields.map(([k, v]) => k === 'enabled' ? (v ? 1 : 0) : v);
  getDb().prepare(`UPDATE schedules SET ${sets} WHERE id = ?`).run(...values, id);
}

export function deleteSchedule(id: string): boolean {
  const result = getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── Outcome Logging ──────────────────────────────────────────────────

export function getOutcomeStats() {
  const rows = getDb().prepare(`
    SELECT
      agent_id,
      task_type,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes,
      AVG(duration_ms) as avg_duration_ms
    FROM outcome_logs
    GROUP BY agent_id, task_type
    ORDER BY total DESC
  `).all();
  return rows;
}
