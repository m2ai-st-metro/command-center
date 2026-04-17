import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { readAgentMd } from '../shared/agent-md.js';

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

    CREATE TABLE IF NOT EXISTS routing_weights (
      agent_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      success_rate REAL NOT NULL DEFAULT 0.5,
      total_missions INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms REAL,
      last_updated INTEGER NOT NULL,
      PRIMARY KEY (agent_id, task_type)
    );

    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_mission_logs_mission ON mission_logs(mission_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_outcome_logs_agent ON outcome_logs(agent_id);

    -- R2.1: async fire-and-forget task queue for mission-cli/cron/hook dispatch
    CREATE TABLE IF NOT EXISTS mission_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued',
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER,
      a2a_task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mission_tasks_agent_status ON mission_tasks(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_mission_tasks_created ON mission_tasks(created_at);

    -- R2.3: per-agent conversation log for memory continuity across tasks
    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_agent_time ON conversation_log(agent_id, created_at DESC);
  `);

  // Phase 5 schema migrations — add quality scoring columns
  const migrateSafe = (sql: string) => {
    try { db.exec(sql); } catch { /* column already exists */ }
  };
  // outcome_logs: per-dimension quality scores from Judge
  migrateSafe('ALTER TABLE outcome_logs ADD COLUMN correctness REAL');
  migrateSafe('ALTER TABLE outcome_logs ADD COLUMN completeness REAL');
  migrateSafe('ALTER TABLE outcome_logs ADD COLUMN relevance REAL');
  migrateSafe('ALTER TABLE outcome_logs ADD COLUMN composite_score REAL');
  migrateSafe('ALTER TABLE outcome_logs ADD COLUMN judge_reasoning TEXT');
  migrateSafe('ALTER TABLE outcome_logs ADD COLUMN judge_method TEXT');
  // routing_weights: dimensional averages for weighted agent scoring
  migrateSafe('ALTER TABLE routing_weights ADD COLUMN correctness_avg REAL');
  migrateSafe('ALTER TABLE routing_weights ADD COLUMN completeness_avg REAL');
  migrateSafe('ALTER TABLE routing_weights ADD COLUMN relevance_avg REAL');
  // missions: planner decomposition flag + judge verdict
  migrateSafe('ALTER TABLE missions ADD COLUMN judge_verdict TEXT');
  // R2.4: mission_tasks gains optional skill hint for per-skill model routing
  migrateSafe('ALTER TABLE mission_tasks ADD COLUMN skill TEXT');
  // 027: per-task worktree isolation for the A2A/mission-task dispatch path
  migrateSafe('ALTER TABLE mission_tasks ADD COLUMN repo_path TEXT');
  migrateSafe('ALTER TABLE mission_tasks ADD COLUMN worktree_path TEXT');
  migrateSafe('ALTER TABLE mission_tasks ADD COLUMN branch_name TEXT');
  // 024: richer schedule cadence (cron expressions)
  migrateSafe("ALTER TABLE schedules ADD COLUMN cadence_type TEXT NOT NULL DEFAULT 'interval'");
  migrateSafe('ALTER TABLE schedules ADD COLUMN cron_expr TEXT');
  migrateSafe('ALTER TABLE schedules ADD COLUMN agent_id TEXT');
  migrateSafe('ALTER TABLE schedules ADD COLUMN ends_at INTEGER');

  // 026: Triggers — event→action subsystem
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      condition_type TEXT NOT NULL,
      condition_config TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_config TEXT NOT NULL,
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      last_fired_at INTEGER,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_enabled_type ON triggers(enabled, condition_type);

    CREATE TABLE IF NOT EXISTS trigger_fires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      event_payload TEXT NOT NULL,
      action_result TEXT,
      FOREIGN KEY (trigger_id) REFERENCES triggers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_fires_trigger ON trigger_fires(trigger_id, fired_at DESC);
  `);
  // 026: mission_tasks gains a source column so trigger-dispatched tasks can be excluded from re-firing
  migrateSafe("ALTER TABLE mission_tasks ADD COLUMN source TEXT");
  // 029: per-task maxTurns override (null = use agent.md default)
  migrateSafe('ALTER TABLE mission_tasks ADD COLUMN max_turns INTEGER');

  // R3 (029): Judge-Reasoner retry loop — track iterations + final resolution
  migrateSafe('ALTER TABLE missions ADD COLUMN judge_iterations INTEGER NOT NULL DEFAULT 0');
  migrateSafe('ALTER TABLE missions ADD COLUMN judge_final_action TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_judge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL REFERENCES missions(id),
      iteration INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reasoner_action TEXT NOT NULL,
      reasoner_rationale TEXT,
      next_agent_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mission_judge_history_mission
      ON mission_judge_history(mission_id, iteration);
  `);

  // Phase 5.2: Worker pool persistence
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_slots (
      id INTEGER PRIMARY KEY,
      mission_id TEXT,
      subtask_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      worktree_path TEXT,
      started_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  // Initialize pool slots if table is empty (first run)
  const slotCount = (db.prepare('SELECT COUNT(*) as c FROM worker_slots').get() as { c: number }).c;
  if (slotCount === 0) {
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare('INSERT INTO worker_slots (id, status, updated_at) VALUES (?, ?, ?)');
    for (let i = 0; i < 12; i++) { // Pre-create up to burst limit
      insert.run(i, 'idle', now);
    }
  }

  // Reset any stale 'running' slots from prior crash
  db.prepare("UPDATE worker_slots SET status = 'idle', mission_id = NULL, subtask_id = NULL, pid = NULL, worktree_path = NULL WHERE status = 'running'").run();

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

export interface OutcomeData {
  missionId: string;
  taskType: string;
  agentId: string;
  reasoning: string;
  status: string;
  durationMs?: number;
  correctness?: number;
  completeness?: number;
  relevance?: number;
  compositeScore?: number;
  judgeReasoning?: string;
  judgeMethod?: string;
}

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

/** Log outcome with full quality scores from Judge. */
export function logOutcomeWithScores(data: OutcomeData): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO outcome_logs (mission_id, task_type, agent_id, classification_reasoning, status, duration_ms,
      correctness, completeness, relevance, composite_score, judge_reasoning, judge_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.missionId, data.taskType, data.agentId, data.reasoning, data.status, data.durationMs ?? null,
    data.correctness ?? null, data.completeness ?? null, data.relevance ?? null,
    data.compositeScore ?? null, data.judgeReasoning ?? null, data.judgeMethod ?? null, now,
  );
}

/** Update quality scores on an existing outcome log (for async judge). */
export function updateOutcomeScores(missionId: string, scores: {
  correctness: number; completeness: number; relevance: number;
  compositeScore: number; judgeReasoning: string; judgeMethod: string;
}): void {
  getDb().prepare(`
    UPDATE outcome_logs SET
      correctness = ?, completeness = ?, relevance = ?,
      composite_score = ?, judge_reasoning = ?, judge_method = ?
    WHERE mission_id = ?
  `).run(
    scores.correctness, scores.completeness, scores.relevance,
    scores.compositeScore, scores.judgeReasoning, scores.judgeMethod,
    missionId,
  );
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
 * Sync agent.md frontmatter from agents/ directory into the capability registry.
 * Source of truth: files on disk. Registry is a runtime cache.
 */
export function syncAgentCapabilities(projectRoot: string): number {
  const agentsDir = path.resolve(projectRoot, 'agents');
  const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'runtime')
    .map(d => d.name);

  let synced = 0;
  for (const dirName of agentDirs) {
    const agentMdPath = path.join(agentsDir, dirName, 'agent.md');
    if (!fs.existsSync(agentMdPath)) continue;

    const { frontmatter } = readAgentMd(agentMdPath);
    if (!frontmatter) continue;
    const raw = frontmatter;

    // Resolve MCP config path if agent has MCP servers
    let mcpConfigPath: string | null = null;
    const mcpJsonPath = path.join(agentsDir, dirName, '.claude', 'mcp.json');
    const mcpServers = (raw.mcpServers as string[] | undefined) ?? [];
    if (mcpServers.length > 0 && fs.existsSync(mcpJsonPath)) {
      mcpConfigPath = mcpJsonPath;
    }

    // Map directory name to agent ID (directory name IS the agent ID)
    const agentId = dirName;

    upsertAgentCapabilities({
      agent_id: agentId,
      tier: (raw.tier as number | undefined) ?? 3,
      tools: (raw.tools as string[] | undefined) ?? ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
      mcp_servers: mcpServers,
      mcp_config_path: mcpConfigPath,
      can_spawn_sub_agents: (raw.canSpawnSubAgents as boolean | undefined) ?? false,
      max_turns: (raw.maxTurns as number | undefined) ?? 25,
      timeout: (raw.timeout as number | undefined) ?? 900_000,
    });
    synced++;
  }

  return synced;
}

// ── Routing Weights (learned from outcomes) ─────────────────────────

export interface RoutingWeight {
  agent_id: string;
  task_type: string;
  success_rate: number;
  total_missions: number;
  avg_duration_ms: number | null;
  correctness_avg: number | null;
  completeness_avg: number | null;
  relevance_avg: number | null;
  last_updated: number;
}

function mapRoutingWeight(row: Record<string, unknown>): RoutingWeight {
  return {
    agent_id: row.agent_id as string,
    task_type: row.task_type as string,
    success_rate: row.success_rate as number,
    total_missions: row.total_missions as number,
    avg_duration_ms: row.avg_duration_ms as number | null,
    correctness_avg: row.correctness_avg as number | null,
    completeness_avg: row.completeness_avg as number | null,
    relevance_avg: row.relevance_avg as number | null,
    last_updated: row.last_updated as number,
  };
}

export function getRoutingWeight(agentId: string, taskType: string): RoutingWeight | null {
  const row = getDb().prepare(
    'SELECT * FROM routing_weights WHERE agent_id = ? AND task_type = ?'
  ).get(agentId, taskType) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRoutingWeight(row);
}

export function listRoutingWeights(): RoutingWeight[] {
  const rows = getDb().prepare('SELECT * FROM routing_weights ORDER BY agent_id, task_type').all() as Array<Record<string, unknown>>;
  return rows.map(mapRoutingWeight);
}

/**
 * Recalculate routing weight for an agent+task_type from outcome_logs.
 * Now includes dimensional quality averages from Judge scores.
 * Called after each mission completes or fails.
 */
export function updateRoutingWeight(agentId: string, taskType: string): void {
  const now = Math.floor(Date.now() / 1000);
  const stats = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes,
      AVG(duration_ms) as avg_ms,
      AVG(correctness) as avg_correctness,
      AVG(completeness) as avg_completeness,
      AVG(relevance) as avg_relevance
    FROM outcome_logs
    WHERE agent_id = ? AND task_type = ?
  `).get(agentId, taskType) as {
    total: number; successes: number; avg_ms: number | null;
    avg_correctness: number | null; avg_completeness: number | null; avg_relevance: number | null;
  };

  if (!stats || stats.total === 0) return;

  const successRate = stats.successes / stats.total;

  getDb().prepare(`
    INSERT INTO routing_weights (agent_id, task_type, success_rate, total_missions, avg_duration_ms,
      correctness_avg, completeness_avg, relevance_avg, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, task_type) DO UPDATE SET
      success_rate=?, total_missions=?, avg_duration_ms=?,
      correctness_avg=?, completeness_avg=?, relevance_avg=?, last_updated=?
  `).run(
    agentId, taskType, successRate, stats.total, stats.avg_ms,
    stats.avg_correctness, stats.avg_completeness, stats.avg_relevance, now,
    successRate, stats.total, stats.avg_ms,
    stats.avg_correctness, stats.avg_completeness, stats.avg_relevance, now,
  );
}

/** Store judge verdict JSON on a mission. */
export function setMissionJudgeVerdict(missionId: string, verdict: unknown): void {
  getDb().prepare('UPDATE missions SET judge_verdict = ? WHERE id = ?')
    .run(JSON.stringify(verdict), missionId);
}

// ── Judge-Reasoner Iteration History (R3 / 029) ─────────────────────

export interface JudgeHistoryRow {
  id: number;
  mission_id: string;
  iteration: number;
  agent_id: string;
  verdict: unknown;
  reasoner_action: string;
  reasoner_rationale: string | null;
  next_agent_id: string | null;
  created_at: number;
}

export function recordJudgeIteration(data: {
  mission_id: string;
  iteration: number;
  agent_id: string;
  verdict: unknown;
  reasoner_action: string;
  reasoner_rationale: string | null;
  next_agent_id: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  db.prepare(
    `INSERT INTO mission_judge_history
      (mission_id, iteration, agent_id, verdict, reasoner_action, reasoner_rationale, next_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.mission_id, data.iteration, data.agent_id,
    JSON.stringify(data.verdict), data.reasoner_action,
    data.reasoner_rationale, data.next_agent_id, now,
  );
  db.prepare('UPDATE missions SET judge_iterations = ? WHERE id = ?')
    .run(data.iteration, data.mission_id);
}

export function setMissionJudgeFinalAction(missionId: string, action: string): void {
  getDb().prepare('UPDATE missions SET judge_final_action = ? WHERE id = ?')
    .run(action, missionId);
}

export function listMissionJudgeHistory(missionId: string): JudgeHistoryRow[] {
  const rows = getDb().prepare(
    `SELECT id, mission_id, iteration, agent_id, verdict,
            reasoner_action, reasoner_rationale, next_agent_id, created_at
     FROM mission_judge_history WHERE mission_id = ? ORDER BY iteration ASC`
  ).all(missionId) as Array<Omit<JudgeHistoryRow, 'verdict'> & { verdict: string }>;
  return rows.map(r => ({ ...r, verdict: JSON.parse(r.verdict) }));
}

// ── Schedules ───────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  goal: string;
  cron: string;
  cadence_type: 'interval' | 'cron';
  cron_expr: string | null;
  agent_id: string | null;
  ends_at: number | null;
  enabled: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  last_mission_id: string | null;
  created_at: number;
}

export function createSchedule(
  id: string, goal: string, cron: string, nextRunAt: number,
  opts?: { cadence_type?: 'interval' | 'cron'; cron_expr?: string | null },
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'INSERT INTO schedules (id, goal, cron, enabled, next_run_at, created_at, cadence_type, cron_expr) VALUES (?, ?, ?, 1, ?, ?, ?, ?)'
  ).run(id, goal, cron, nextRunAt, now, opts?.cadence_type ?? 'interval', opts?.cron_expr ?? null);
}

export function listSchedules(): Schedule[] {
  const rows = getDb().prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    goal: row.goal as string,
    cron: row.cron as string,
    cadence_type: ((row.cadence_type as string | null) ?? 'interval') as 'interval' | 'cron',
    cron_expr: (row.cron_expr as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    ends_at: (row.ends_at as number | null) ?? null,
    enabled: (row.enabled as number) === 1,
    last_run_at: row.last_run_at as number | null,
    next_run_at: row.next_run_at as number | null,
    last_mission_id: row.last_mission_id as string | null,
    created_at: row.created_at as number,
  }));
}

export function updateSchedule(id: string, updates: Partial<{
  goal: string; cron: string; cadence_type: string; cron_expr: string | null;
  enabled: boolean; last_run_at: number; next_run_at: number; last_mission_id: string;
}>): void {
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

// ── Triggers (026) ───────────────────────────────────────────────────

export type TriggerConditionType = 'mission_failed' | 'schedule_missed' | 'agent_offline';
export type TriggerActionType = 'dispatch_mission_task' | 'notify_log_file';

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  condition_type: TriggerConditionType;
  condition_config: Record<string, unknown>;
  action_type: TriggerActionType;
  action_config: Record<string, unknown>;
  cooldown_seconds: number;
  last_fired_at: number | null;
  fire_count: number;
  created_at: number;
}

export interface TriggerFire {
  id: number;
  trigger_id: string;
  fired_at: number;
  event_payload: Record<string, unknown>;
  action_result: string | null;
}

function mapTriggerRow(row: Record<string, unknown>): Trigger {
  return {
    id: row.id as string,
    name: row.name as string,
    enabled: (row.enabled as number) === 1,
    condition_type: row.condition_type as TriggerConditionType,
    condition_config: JSON.parse((row.condition_config as string) || '{}'),
    action_type: row.action_type as TriggerActionType,
    action_config: JSON.parse((row.action_config as string) || '{}'),
    cooldown_seconds: row.cooldown_seconds as number,
    last_fired_at: (row.last_fired_at as number | null) ?? null,
    fire_count: row.fire_count as number,
    created_at: row.created_at as number,
  };
}

export function createTrigger(t: {
  id: string;
  name: string;
  condition_type: TriggerConditionType;
  condition_config: Record<string, unknown>;
  action_type: TriggerActionType;
  action_config: Record<string, unknown>;
  cooldown_seconds?: number;
}): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO triggers (id, name, enabled, condition_type, condition_config,
                           action_type, action_config, cooldown_seconds, fire_count, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    t.id, t.name, t.condition_type, JSON.stringify(t.condition_config),
    t.action_type, JSON.stringify(t.action_config), t.cooldown_seconds ?? 300, now,
  );
}

export function listTriggers(): Trigger[] {
  const rows = getDb().prepare('SELECT * FROM triggers ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(mapTriggerRow);
}

export function listEnabledTriggersByCondition(conditionType: TriggerConditionType): Trigger[] {
  const rows = getDb().prepare(
    'SELECT * FROM triggers WHERE enabled = 1 AND condition_type = ? ORDER BY created_at ASC'
  ).all(conditionType) as Array<Record<string, unknown>>;
  return rows.map(mapTriggerRow);
}

export function getTrigger(id: string): Trigger | null {
  const row = getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapTriggerRow(row) : null;
}

export function updateTrigger(id: string, updates: Partial<{
  name: string;
  enabled: boolean;
  condition_config: Record<string, unknown>;
  action_config: Record<string, unknown>;
  cooldown_seconds: number;
}>): void {
  const fields = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (fields.length === 0) return;
  const sets = fields.map(([k]) => `${k} = ?`).join(', ');
  const values = fields.map(([k, v]) => {
    if (k === 'enabled') return v ? 1 : 0;
    if (k === 'condition_config' || k === 'action_config') return JSON.stringify(v);
    return v;
  });
  getDb().prepare(`UPDATE triggers SET ${sets} WHERE id = ?`).run(...values, id);
}

export function deleteTrigger(id: string): boolean {
  const db = getDb();
  db.prepare('DELETE FROM trigger_fires WHERE trigger_id = ?').run(id);
  const result = db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function markTriggerFired(id: string, firedAt: number): void {
  getDb().prepare(
    'UPDATE triggers SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?'
  ).run(firedAt, id);
}

export function recordTriggerFire(
  triggerId: string,
  firedAt: number,
  eventPayload: Record<string, unknown>,
  actionResult: string | null,
): void {
  getDb().prepare(
    `INSERT INTO trigger_fires (trigger_id, fired_at, event_payload, action_result)
     VALUES (?, ?, ?, ?)`
  ).run(triggerId, firedAt, JSON.stringify(eventPayload), actionResult);
}

export function listTriggerFires(triggerId: string, limit = 20): TriggerFire[] {
  const rows = getDb().prepare(
    'SELECT * FROM trigger_fires WHERE trigger_id = ? ORDER BY fired_at DESC LIMIT ?'
  ).all(triggerId, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    trigger_id: row.trigger_id as string,
    fired_at: row.fired_at as number,
    event_payload: JSON.parse((row.event_payload as string) || '{}'),
    action_result: (row.action_result as string | null) ?? null,
  }));
}

// ── Worker Pool (Phase 5.2) ──────────────────────────────────────────

import type { WorkerSlot } from '../shared/types.js';

export function listWorkerSlots(limit?: number): WorkerSlot[] {
  const rows = getDb().prepare(
    `SELECT * FROM worker_slots WHERE id < ? ORDER BY id`
  ).all(limit ?? 12) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as number,
    mission_id: row.mission_id as string | null,
    subtask_id: row.subtask_id as string | null,
    pid: row.pid as number | null,
    status: row.status as WorkerSlot['status'],
    worktree_path: row.worktree_path as string | null,
    started_at: row.started_at as number | null,
  }));
}

export function acquireWorkerSlot(
  slotLimit: number,
  missionId: string,
  subtaskId: string,
): number | null {
  const now = Math.floor(Date.now() / 1000);
  const slot = getDb().prepare(
    `SELECT id FROM worker_slots WHERE status = 'idle' AND id < ? ORDER BY id LIMIT 1`
  ).get(slotLimit) as { id: number } | undefined;
  if (!slot) return null;

  getDb().prepare(
    `UPDATE worker_slots SET status = 'running', mission_id = ?, subtask_id = ?, started_at = ?, updated_at = ? WHERE id = ?`
  ).run(missionId, subtaskId, now, now, slot.id);
  return slot.id;
}

export function updateWorkerSlot(slotId: number, updates: Partial<{
  status: string; pid: number | null; worktree_path: string | null;
  mission_id: string | null; subtask_id: string | null;
}>): void {
  const now = Math.floor(Date.now() / 1000);
  const entries: [string, string | number | null][] = Object.entries(updates)
    .filter(([, v]) => v !== undefined) as [string, string | number | null][];
  entries.push(['updated_at', now]);
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  getDb().prepare(`UPDATE worker_slots SET ${sets} WHERE id = ?`).run(...values, slotId);
}

export function releaseWorkerSlot(slotId: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `UPDATE worker_slots SET status = 'idle', mission_id = NULL, subtask_id = NULL, pid = NULL, worktree_path = NULL, started_at = NULL, updated_at = ? WHERE id = ?`
  ).run(now, slotId);
}

export function getActiveWorkerCount(): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) as c FROM worker_slots WHERE status = 'running'`
  ).get() as { c: number };
  return row.c;
}

/** Update a subtask's status/result within the mission's plan JSON. */
export function updateMissionSubtask(
  missionId: string,
  subtaskId: string,
  updates: { status?: string; result?: string | null; duration_ms?: number },
): void {
  const mission = getMission(missionId);
  if (!mission?.plan) return;

  const plan = mission.plan;
  const subtask = plan.subtasks.find((s: { id: string }) => s.id === subtaskId);
  if (!subtask) return;

  if (updates.status) subtask.status = updates.status;
  if (updates.result !== undefined) subtask.result = updates.result;
  if (updates.duration_ms !== undefined) subtask.duration_ms = updates.duration_ms;

  updateMission(missionId, { plan });
}

// ── Outcome Logging ──────────────────────────────────────────────────

// ── Conversation Log (R2.3 — per-agent memory continuity) ──────────────

const CONVERSATION_RETENTION = 20; // last N rows per agent

export type ConversationRole = 'user' | 'assistant';

export interface ConversationEntry {
  agent_id: string;
  role: ConversationRole;
  content: string;
  created_at: number;
  task_id: string | null;
}

export function appendConversation(
  agent_id: string,
  role: ConversationRole,
  content: string,
  task_id?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO conversation_log (agent_id, role, content, created_at, task_id) VALUES (?, ?, ?, ?, ?)`
  ).run(agent_id, role, content, now, task_id ?? null);

  // Prune older rows beyond retention cap (per agent)
  getDb().prepare(`
    DELETE FROM conversation_log
    WHERE agent_id = ?
      AND id NOT IN (
        SELECT id FROM conversation_log
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
  `).run(agent_id, agent_id, CONVERSATION_RETENTION);
}

export function getRecentConversation(agent_id: string, limit = CONVERSATION_RETENTION): ConversationEntry[] {
  // Query DESC by (created_at, id) so insertion order breaks ties when two
  // rows share the same unix-second timestamp; reverse to ASC so history
  // reads chronologically.
  const rows = getDb().prepare(
    `SELECT agent_id, role, content, created_at, task_id FROM conversation_log WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(agent_id, limit) as Array<Record<string, unknown>>;
  return rows
    .map(r => ({
      agent_id: r.agent_id as string,
      role: r.role as ConversationRole,
      content: r.content as string,
      created_at: r.created_at as number,
      task_id: r.task_id as string | null,
    }))
    .reverse();
}

// ── Mission Tasks (R2.1 — async fire-and-forget queue) ────────────────

import type { MissionTask, MissionTaskStatus } from '../shared/types.js';

function mapMissionTaskRow(row: Record<string, unknown>): MissionTask {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    title: row.title as string,
    prompt: row.prompt as string,
    priority: row.priority as number,
    status: row.status as MissionTaskStatus,
    result: row.result as string | null,
    error: row.error as string | null,
    created_at: row.created_at as number,
    claimed_at: row.claimed_at as number | null,
    completed_at: row.completed_at as number | null,
    a2a_task_id: row.a2a_task_id as string | null,
    skill: (row.skill as string | null | undefined) ?? null,
    repo_path: (row.repo_path as string | null | undefined) ?? null,
    worktree_path: (row.worktree_path as string | null | undefined) ?? null,
    branch_name: (row.branch_name as string | null | undefined) ?? null,
    source: (row.source as string | null | undefined) ?? null,
    max_turns: (row.max_turns as number | null | undefined) ?? null,
  };
}

export function createMissionTask(task: {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  priority?: number;
  skill?: string;
  repo_path?: string;
  source?: string;
  max_turns?: number;
}): MissionTask {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO mission_tasks (id, agent_id, title, prompt, priority, status, created_at, skill, repo_path, source, max_turns) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
  ).run(task.id, task.agent_id, task.title, task.prompt, task.priority ?? 5, now, task.skill ?? null, task.repo_path ?? null, task.source ?? null, task.max_turns ?? null);
  return getMissionTask(task.id)!;
}

export function getMissionTask(id: string): MissionTask | null {
  const row = getDb().prepare('SELECT * FROM mission_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapMissionTaskRow(row) : null;
}

export function listMissionTasks(limit = 50): MissionTask[] {
  const rows = getDb().prepare('SELECT * FROM mission_tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapMissionTaskRow);
}

export function listMissionTasksByStatus(status: MissionTaskStatus): MissionTask[] {
  const rows = getDb().prepare('SELECT * FROM mission_tasks WHERE status = ? ORDER BY created_at ASC').all(status) as Array<Record<string, unknown>>;
  return rows.map(mapMissionTaskRow);
}

export function updateMissionTask(id: string, updates: Partial<{
  status: MissionTaskStatus;
  result: string | null;
  error: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  a2a_task_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
}>): void {
  const fields = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (fields.length === 0) return;
  const sets = fields.map(([k]) => `${k} = ?`).join(', ');
  const values = fields.map(([, v]) => v as string | number | null);
  getDb().prepare(`UPDATE mission_tasks SET ${sets} WHERE id = ?`).run(...values, id);
}

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
