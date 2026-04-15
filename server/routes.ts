import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
  getMission,
  listMissions,
  getMissionLogs,
  listAgents,
  listWorkerSlots,
  getOutcomeStats,
  listAgentCapabilities,
  getAgentCapabilities,
  listRoutingWeights,
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  createMissionTask,
  getMissionTask,
  listMissionTasks,
  updateMissionTask,
  createTrigger,
  listTriggers,
  getTrigger,
  updateTrigger,
  deleteTrigger,
  listTriggerFires,
  type TriggerConditionType,
  type TriggerActionType,
} from './db.js';
import { dispatchMissionTask } from './mission-dispatcher.js';
import type { CreateMissionTaskRequest } from '../shared/types.js';
import { nextRunFromInterval, nextRunFromCron, runScheduleNow } from './scheduler.js';
import { chatWithData } from './chat.js';
import {
  proposeMission,
  approveMission,
  cancelMission,
} from './orchestrator.js';
import {
  syncStockRepos,
  listStockAgents,
  loadStockAgent,
  loadStockCategory,
} from './stock-loader.js';
import { getPoolStatus } from './worker-manager.js';
import {
  listCustomAgents,
  getCustomAgent,
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
} from './custom-agents.js';
import type { CreateMissionRequest } from '../shared/types.js';

export const router = Router();

// ── Chat (lightweight advisor) ────────────────────────────────────────

router.post('/chat', async (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message?.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  try {
    const reply = await chatWithData(message.trim());
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Missions ─────────────────────────────────────────────────────────

router.get('/missions', (_req, res) => {
  const missions = listMissions();
  res.json({ missions });
});

router.get('/missions/:id', (req, res) => {
  const mission = getMission(req.params.id);
  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  const logs = getMissionLogs(req.params.id);
  // Parse judge verdict if present
  const judge_verdict = (mission as Record<string, unknown>).judge_verdict
    ? JSON.parse((mission as Record<string, unknown>).judge_verdict as string)
    : null;
  res.json({ mission, logs, judge_verdict });
});

router.post('/missions', async (req, res) => {
  const { goal } = req.body as CreateMissionRequest;
  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    res.status(400).json({ error: 'Goal is required' });
    return;
  }
  try {
    const { mission, classification } = await proposeMission(goal.trim());
    res.status(201).json({ mission, classification });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/missions/:id/approve', (req, res) => {
  const mission = getMission(req.params.id);
  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  if (mission.status !== 'proposed') {
    res.status(400).json({ error: `Cannot approve mission in status: ${mission.status}` });
    return;
  }

  // Fire-and-forget — mission runs in background
  approveMission(req.params.id).catch((err) => {
    console.error('Mission execution error:', err);
  });

  res.json({ message: 'Mission approved and running', mission_id: req.params.id });
});

router.post('/missions/:id/cancel', (req, res) => {
  const mission = getMission(req.params.id);
  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }

  cancelMission(req.params.id);
  res.json({ message: 'Mission cancelled', mission_id: req.params.id });
});

// ── Agents ───────────────────────────────────────────────────────────

router.get('/agents', (_req, res) => {
  const agents = listAgents();
  res.json({ agents });
});

// ── Agent Capabilities ──────────────────────────────────────────────

router.get('/agents/capabilities', (_req, res) => {
  const capabilities = listAgentCapabilities();
  res.json({ capabilities });
});

router.get('/agents/:id/capabilities', (req, res) => {
  const cap = getAgentCapabilities(req.params.id);
  if (!cap) {
    res.status(404).json({ error: 'No capabilities found for agent' });
    return;
  }
  res.json({ capabilities: cap });
});

// ── Status (for DataTG queries) ──────────────────────────────────────

router.get('/status', (_req, res) => {
  const missions = listMissions(10);
  const active = missions.filter((m: Record<string, unknown>) =>
    m.status === 'running' || m.status === 'proposed'
  );
  const recent = missions.filter((m: Record<string, unknown>) =>
    m.status === 'completed' || m.status === 'failed'
  ).slice(0, 5);

  res.json({
    active_count: active.length,
    active: active.map((m: Record<string, unknown>) => ({
      id: m.id,
      goal: (m.goal as string).slice(0, 100),
      status: m.status,
    })),
    recent_completed: recent.map((m: Record<string, unknown>) => ({
      id: m.id,
      goal: (m.goal as string).slice(0, 100),
      status: m.status,
      duration_ms: m.duration_ms,
    })),
  });
});

router.get('/status/:id', (req, res) => {
  const mission = getMission(req.params.id);
  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  const logs = getMissionLogs(req.params.id);
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;

  res.json({
    mission_id: mission.id,
    status: mission.status,
    summary: (lastLog as Record<string, unknown> | null)?.message ?? mission.goal,
    progress_pct: mission.status === 'completed' ? 100 : mission.status === 'running' ? 50 : 0,
  });
});

// ── Outcome Stats ────────────────────────────────────────────────────

router.get('/stats', (_req, res) => {
  const stats = getOutcomeStats();
  res.json({ stats });
});

// ── Stock Agents ────────────────────────────────────────────────────

router.post('/stock-agents/sync', (_req, res) => {
  try {
    const result = syncStockRepos();
    res.json({ message: 'Stock repos synced', ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/stock-agents', (_req, res) => {
  const agents = listStockAgents();
  const categories = [...new Set(agents.map(a => a.category))].sort();
  res.json({
    total: agents.length,
    categories,
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      source: a.source,
      skills: a.skills,
    })),
  });
});

// ── Custom Agents ──────────────────────────────────────────────────

router.get('/custom-agents', (_req, res) => {
  const agents = listCustomAgents();
  res.json({ agents });
});

router.get('/custom-agents/:id', (req, res) => {
  const agent = getCustomAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Custom agent not found' });
    return;
  }
  res.json({ agent });
});

router.post('/custom-agents', (req, res) => {
  const { name, description, skills, system_prompt } = req.body as {
    name?: string;
    description?: string;
    skills?: string[];
    system_prompt?: string;
  };

  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  if (!system_prompt || !system_prompt.trim()) {
    res.status(400).json({ error: 'System prompt is required' });
    return;
  }

  try {
    const agent = createCustomAgent({
      name: name.trim(),
      description: (description || '').trim(),
      skills: skills || [],
      system_prompt: system_prompt.trim(),
    });
    res.status(201).json({ agent });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/custom-agents/:id', (req, res) => {
  const { name, description, skills, system_prompt } = req.body as {
    name?: string;
    description?: string;
    skills?: string[];
    system_prompt?: string;
  };

  try {
    const agent = updateCustomAgent(req.params.id, { name, description, skills, system_prompt });
    res.json({ agent });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

router.delete('/custom-agents/:id', (req, res) => {
  const deleted = deleteCustomAgent(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Custom agent not found' });
    return;
  }
  res.json({ message: 'Custom agent deleted' });
});

// ── Stock Agents ────────────────────────────────────────────────────

router.post('/stock-agents/load', (req, res) => {
  const { agent_id, category } = req.body as { agent_id?: string; category?: string };

  if (agent_id) {
    const agent = loadStockAgent(agent_id);
    if (!agent) {
      res.status(404).json({ error: `Stock agent ${agent_id} not found` });
      return;
    }
    res.json({ message: 'Agent loaded into registry', agent });
    return;
  }

  if (category) {
    const agents = loadStockCategory(category);
    res.json({ message: `Loaded ${agents.length} agents from ${category}`, agents });
    return;
  }

  res.status(400).json({ error: 'Provide agent_id or category' });
});

// ── Routing Insights (Phase 5 Learning Loop) ────────────────────────

router.get('/routing/insights', (_req, res) => {
  const weights = listRoutingWeights();
  const stats = getOutcomeStats() as Array<Record<string, unknown>>;
  const capabilities = listAgentCapabilities();

  // Identify gap patterns — task types with high failure rates
  const gapPatterns = weights
    .filter(w => w.total_missions >= 2 && w.success_rate < 0.5)
    .map(w => ({
      agent_id: w.agent_id,
      task_type: w.task_type,
      success_rate: Math.round(w.success_rate * 100),
      total: w.total_missions,
      recommendation: `${w.agent_id} struggles with ${w.task_type} tasks (${Math.round(w.success_rate * 100)}% success). Consider routing elsewhere or adding capabilities.`,
    }));

  // Top performers — agent+task combos with high success
  const topPerformers = weights
    .filter(w => w.total_missions >= 2 && w.success_rate >= 0.8)
    .sort((a, b) => b.success_rate - a.success_rate || b.total_missions - a.total_missions)
    .map(w => ({
      agent_id: w.agent_id,
      task_type: w.task_type,
      success_rate: Math.round(w.success_rate * 100),
      total: w.total_missions,
      avg_duration_s: w.avg_duration_ms ? Math.round(w.avg_duration_ms / 1000) : null,
      quality: w.correctness_avg != null ? {
        correctness: Math.round((w.correctness_avg ?? 0) * 100),
        completeness: Math.round((w.completeness_avg ?? 0) * 100),
        relevance: Math.round((w.relevance_avg ?? 0) * 100),
      } : null,
    }));

  // Quality-aware insights — agents with dimensional data
  const qualityInsights = weights
    .filter(w => w.correctness_avg != null && w.total_missions >= 2)
    .map(w => ({
      agent_id: w.agent_id,
      task_type: w.task_type,
      total: w.total_missions,
      correctness: Math.round((w.correctness_avg ?? 0) * 100),
      completeness: Math.round((w.completeness_avg ?? 0) * 100),
      relevance: Math.round((w.relevance_avg ?? 0) * 100),
    }));

  res.json({
    routing_weights: weights,
    gap_patterns: gapPatterns,
    top_performers: topPerformers,
    quality_insights: qualityInsights,
    total_outcomes: stats.reduce((sum, s) => sum + (s.total as number), 0),
    learning_active: weights.some(w => w.total_missions >= 3),
    judge_active: weights.some(w => w.correctness_avg != null),
  });
});

// ── Mission Tasks (R2.1 — async fire-and-forget queue) ────────────────

router.post('/tasks', async (req, res) => {
  const { agent_id, title, prompt, priority, skill, repo_path } = req.body as CreateMissionTaskRequest;
  if (!agent_id?.trim()) {
    res.status(400).json({ error: 'agent_id is required' });
    return;
  }
  if (!title?.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  if (!prompt?.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  const id = uuidv4();
  const task = createMissionTask({
    id,
    agent_id: agent_id.trim(),
    title: title.trim(),
    prompt: prompt.trim(),
    priority,
    skill: skill?.trim() || undefined,
    repo_path: repo_path?.trim() || undefined,
  });
  // Fire-and-forget dispatch — returns immediately with queued task
  dispatchMissionTask(id).catch(err => console.error(`[tasks] dispatch error for ${id}:`, err));
  res.status(201).json({ task });
});

router.get('/tasks', (_req, res) => {
  const tasks = listMissionTasks();
  res.json({ tasks });
});

router.get('/tasks/:id', (req, res) => {
  const task = getMissionTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task });
});

router.post('/tasks/:id/cancel', (req, res) => {
  const task = getMissionTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'queued' && task.status !== 'running') {
    res.status(400).json({ error: `Cannot cancel task in status: ${task.status}` });
    return;
  }
  updateMissionTask(req.params.id, {
    status: 'cancelled',
    completed_at: Math.floor(Date.now() / 1000),
  });
  res.json({ message: 'Task cancelled', task_id: req.params.id });
});

// ── Worker Pool (Phase 5.2) ──────────────────────────────────────────

router.get('/workers', (_req, res) => {
  const pool = getPoolStatus();
  const slots = listWorkerSlots(pool.burstLimit);
  res.json({ pool, slots });
});

// ── Schedules ────────────────────────────────────────────────────────

router.get('/schedules', (_req, res) => {
  const schedules = listSchedules();
  res.json({ schedules });
});

router.post('/schedules', (req, res) => {
  const { goal, interval, cron_expr } = req.body as { goal?: string; interval?: string; cron_expr?: string };
  if (!goal?.trim()) {
    res.status(400).json({ error: 'goal is required' });
    return;
  }
  if (interval && cron_expr) {
    res.status(400).json({ error: 'supply either interval or cron_expr, not both' });
    return;
  }
  if (!interval?.trim() && !cron_expr?.trim()) {
    res.status(400).json({ error: 'supply either interval (e.g. "1h") or cron_expr (e.g. "0 9 * * *")' });
    return;
  }

  let nextRun: number | null;
  let cadenceType: 'interval' | 'cron';
  let cronDisplay: string;
  let cronExprValue: string | null = null;

  if (cron_expr?.trim()) {
    nextRun = nextRunFromCron(cron_expr.trim());
    if (!nextRun) {
      res.status(400).json({ error: `Invalid cron expression "${cron_expr}"` });
      return;
    }
    cadenceType = 'cron';
    cronDisplay = cron_expr.trim();
    cronExprValue = cron_expr.trim();
  } else {
    nextRun = nextRunFromInterval(interval!.trim());
    if (!nextRun) {
      res.status(400).json({ error: `Invalid interval "${interval}". Use: 5m, 1h, 24h, 7d` });
      return;
    }
    cadenceType = 'interval';
    cronDisplay = interval!.trim();
  }

  const id = uuidv4();
  createSchedule(id, goal.trim(), cronDisplay, nextRun, { cadence_type: cadenceType, cron_expr: cronExprValue });
  res.status(201).json({ schedule: { id, goal: goal.trim(), cron: cronDisplay, cadence_type: cadenceType, cron_expr: cronExprValue, enabled: true, next_run_at: nextRun } });
});

router.put('/schedules/:id', (req, res) => {
  const { enabled, goal, interval, cron_expr } = req.body as { enabled?: boolean; goal?: string; interval?: string; cron_expr?: string };
  const updates: Record<string, unknown> = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (goal) updates.goal = goal;
  if (interval && cron_expr) {
    res.status(400).json({ error: 'supply either interval or cron_expr, not both' });
    return;
  }
  if (cron_expr) {
    const nextRun = nextRunFromCron(cron_expr);
    if (!nextRun) {
      res.status(400).json({ error: `Invalid cron expression "${cron_expr}"` });
      return;
    }
    updates.cron = cron_expr;
    updates.cadence_type = 'cron';
    updates.cron_expr = cron_expr;
    updates.next_run_at = nextRun;
  } else if (interval) {
    const nextRun = nextRunFromInterval(interval);
    if (!nextRun) {
      res.status(400).json({ error: `Invalid interval "${interval}"` });
      return;
    }
    updates.cron = interval;
    updates.cadence_type = 'interval';
    updates.cron_expr = null;
    updates.next_run_at = nextRun;
  }
  updateSchedule(req.params.id, updates as Parameters<typeof updateSchedule>[1]);
  res.json({ message: 'Schedule updated' });
});

router.delete('/schedules/:id', (req, res) => {
  const deleted = deleteSchedule(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  res.json({ message: 'Schedule deleted' });
});

router.post('/schedules/:id/run', async (req, res) => {
  const schedule = listSchedules().find(s => s.id === req.params.id);
  if (!schedule) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  try {
    const missionId = await runScheduleNow(schedule.goal);
    const now = Math.floor(Date.now() / 1000);
    updateSchedule(schedule.id, { last_run_at: now, last_mission_id: missionId });
    res.json({ message: 'Mission created', mission_id: missionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── ST Metro: IdeaForge pipeline state ───────────────────────────────────────

const IDEAFORGE_DB_PATH =
  process.env.IDEAFORGE_DB_PATH ??
  '/home/apexaipc/projects/ideaforge/data/ideaforge.db';

const SKYLYNX_PROPOSALS_DB =
  process.env.SKYLYNX_PROPOSALS_DB ??
  '/home/apexaipc/projects/sky-lynx/data/proposals.db';
const SKYLYNX_RECS_DIR =
  process.env.SKYLYNX_RECS_DIR ??
  '/home/apexaipc/projects/sky-lynx/data/claudeclaw-recommendations';

interface StageRow { status: string; cnt: number }
interface IdeaRow { id: number; title: string; weighted_score: number | null; status: string }

router.get('/st-metro/ideaforge', (_req, res) => {
  let ifDb: Database.Database | null = null;
  try {
    ifDb = new Database(IDEAFORGE_DB_PATH, { readonly: true });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const signals_last_7d = (
      ifDb
        .prepare("SELECT COUNT(*) AS cnt FROM signals WHERE harvested_at >= ?")
        .get(sevenDaysAgo) as { cnt: number }
    ).cnt;

    const stage_breakdown = (
      ifDb.prepare("SELECT status, COUNT(*) AS cnt FROM ideas GROUP BY status").all() as StageRow[]
    ).map((r) => ({ status: r.status, count: r.cnt }));

    const total_ideas = stage_breakdown.reduce((s, r) => s + r.count, 0);
    const built_count =
      stage_breakdown.find((r) => r.status === 'built')?.count ?? 0;

    const top_ideas = ifDb
      .prepare(
        `SELECT id, title, weighted_score, status
         FROM ideas
         WHERE weighted_score IS NOT NULL
         ORDER BY weighted_score DESC
         LIMIT 10`
      )
      .all() as IdeaRow[];

    const anomaly_count = (
      ifDb
        .prepare(
          `SELECT COUNT(*) AS cnt FROM ideas
           WHERE status = 'unscored'
             AND synthesized_at <= datetime('now', '-3 days')`
        )
        .get() as { cnt: number }
    ).cnt;

    res.json({
      signals_last_7d,
      total_ideas,
      built_count,
      stage_breakdown,
      top_ideas,
      anomaly_count,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({
      warning: `Could not open IdeaForge DB: ${msg}`,
      signals_last_7d: 0,
      total_ideas: 0,
      built_count: 0,
      stage_breakdown: [],
      top_ideas: [],
      anomaly_count: 0,
    });
  } finally {
    ifDb?.close();
  }
});

// ── Sky-Lynx Recommendations (Phase 1: read-only) ────────────────────────────

interface SkylynxProposalRow {
  id: number;
  parameter: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
  source: string;
  status: string;
  proposed_at: string;
  resolved_at: string | null;
  squawk_count: number;
}

interface SkylynxJsonRec {
  source?: string;
  created_at?: string;
  target_system?: string;
  title?: string;
  priority?: string;
  evidence?: string;
  suggested_change?: string;
  impact?: string;
  reversibility?: string;
  recommendation_type?: string;
}

router.get('/sky-lynx/recs', (_req, res) => {
  let db: Database.Database | null = null;
  try {
    // DB proposals (structured, have acceptance signal)
    db = new Database(SKYLYNX_PROPOSALS_DB, { readonly: true });
    const proposals = db
      .prepare(
        `SELECT id, parameter, current_value, proposed_value, rationale, source,
                status, proposed_at, resolved_at, squawk_count
         FROM proposals
         ORDER BY datetime(proposed_at) DESC
         LIMIT 200`
      )
      .all() as SkylynxProposalRow[];

    const statusCounts = proposals.reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});
    const resolved = (statusCounts.accepted ?? 0) + (statusCounts.rejected ?? 0);
    const acceptance_rate = resolved > 0
      ? (statusCounts.accepted ?? 0) / resolved
      : null;

    // JSON file recs (free-form, no acceptance signal)
    let jsonRecs: Array<SkylynxJsonRec & { filename: string }> = [];
    try {
      const files = fs
        .readdirSync(SKYLYNX_RECS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 50);
      jsonRecs = files.map((f) => {
        const raw = fs.readFileSync(path.join(SKYLYNX_RECS_DIR, f), 'utf8');
        return { ...(JSON.parse(raw) as SkylynxJsonRec), filename: f };
      });
    } catch (_e) {
      // directory missing or unreadable — return empty list
    }

    // Repeat count per parameter (signals recurring recommendations)
    const repeats: Record<string, number> = {};
    for (const p of proposals) {
      repeats[p.parameter] = (repeats[p.parameter] ?? 0) + 1;
    }

    res.json({
      proposal_count: proposals.length,
      status_counts: statusCounts,
      acceptance_rate,
      proposals: proposals.map((p) => ({
        ...p,
        repeat_count: repeats[p.parameter] ?? 1,
      })),
      json_recs: jsonRecs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({
      warning: `Could not read Sky-Lynx data: ${msg}`,
      proposal_count: 0,
      status_counts: {},
      acceptance_rate: null,
      proposals: [],
      json_recs: [],
    });
  } finally {
    db?.close();
  }
});

// ── Triggers (026) ────────────────────────────────────────────────────

const VALID_CONDITION_TYPES: TriggerConditionType[] = [
  'mission_failed',
  'schedule_missed',
  'agent_offline',
];
const VALID_ACTION_TYPES: TriggerActionType[] = [
  'dispatch_mission_task',
  'notify_log_file',
];

router.get('/triggers', (_req, res) => {
  res.json({ triggers: listTriggers() });
});

router.post('/triggers', (req, res) => {
  const {
    name,
    condition_type,
    condition_config,
    action_type,
    action_config,
    cooldown_seconds,
  } = req.body as {
    name?: string;
    condition_type?: string;
    condition_config?: unknown;
    action_type?: string;
    action_config?: unknown;
    cooldown_seconds?: number;
  };
  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!condition_type || !VALID_CONDITION_TYPES.includes(condition_type as TriggerConditionType)) {
    res.status(400).json({ error: `condition_type must be one of: ${VALID_CONDITION_TYPES.join(', ')}` });
    return;
  }
  if (!action_type || !VALID_ACTION_TYPES.includes(action_type as TriggerActionType)) {
    res.status(400).json({ error: `action_type must be one of: ${VALID_ACTION_TYPES.join(', ')}` });
    return;
  }
  if (condition_config === null || typeof condition_config !== 'object' || Array.isArray(condition_config)) {
    res.status(400).json({ error: 'condition_config must be an object' });
    return;
  }
  if (action_config === null || typeof action_config !== 'object' || Array.isArray(action_config)) {
    res.status(400).json({ error: 'action_config must be an object' });
    return;
  }
  const id = uuidv4();
  createTrigger({
    id,
    name: name.trim(),
    condition_type: condition_type as TriggerConditionType,
    condition_config: condition_config as Record<string, unknown>,
    action_type: action_type as TriggerActionType,
    action_config: action_config as Record<string, unknown>,
    cooldown_seconds: typeof cooldown_seconds === 'number' ? cooldown_seconds : undefined,
  });
  const trigger = getTrigger(id);
  res.status(201).json({ trigger });
});

router.get('/triggers/:id', (req, res) => {
  const trigger = getTrigger(req.params.id);
  if (!trigger) {
    res.status(404).json({ error: 'trigger not found' });
    return;
  }
  res.json({ trigger });
});

router.patch('/triggers/:id', (req, res) => {
  const existing = getTrigger(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'trigger not found' });
    return;
  }
  const body = req.body as {
    name?: string;
    enabled?: boolean;
    condition_config?: unknown;
    action_config?: unknown;
    cooldown_seconds?: number;
  };
  const updates: Parameters<typeof updateTrigger>[1] = {};
  if (typeof body.name === 'string') updates.name = body.name.trim();
  if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
  if (body.condition_config !== undefined) {
    if (body.condition_config === null || typeof body.condition_config !== 'object' || Array.isArray(body.condition_config)) {
      res.status(400).json({ error: 'condition_config must be an object' });
      return;
    }
    updates.condition_config = body.condition_config as Record<string, unknown>;
  }
  if (body.action_config !== undefined) {
    if (body.action_config === null || typeof body.action_config !== 'object' || Array.isArray(body.action_config)) {
      res.status(400).json({ error: 'action_config must be an object' });
      return;
    }
    updates.action_config = body.action_config as Record<string, unknown>;
  }
  if (typeof body.cooldown_seconds === 'number') updates.cooldown_seconds = body.cooldown_seconds;
  updateTrigger(req.params.id, updates);
  res.json({ trigger: getTrigger(req.params.id) });
});

router.delete('/triggers/:id', (req, res) => {
  const ok = deleteTrigger(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'trigger not found' });
    return;
  }
  res.json({ ok: true });
});

router.get('/triggers/:id/fires', (req, res) => {
  const trigger = getTrigger(req.params.id);
  if (!trigger) {
    res.status(404).json({ error: 'trigger not found' });
    return;
  }
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 200);
  res.json({ fires: listTriggerFires(req.params.id, limit) });
});
