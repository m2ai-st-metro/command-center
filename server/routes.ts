import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
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
} from './db.js';
import { dispatchMissionTask } from './mission-dispatcher.js';
import type { CreateMissionTaskRequest } from '../shared/types.js';
import { nextRunFromInterval } from './scheduler.js';
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
  const { agent_id, title, prompt, priority, skill } = req.body as CreateMissionTaskRequest;
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
  const { goal, interval } = req.body as { goal?: string; interval?: string };
  if (!goal?.trim()) {
    res.status(400).json({ error: 'goal is required' });
    return;
  }
  if (!interval?.trim()) {
    res.status(400).json({ error: 'interval is required (e.g. "30m", "1h", "24h")' });
    return;
  }
  const nextRun = nextRunFromInterval(interval.trim());
  if (!nextRun) {
    res.status(400).json({ error: `Invalid interval "${interval}". Use: 5m, 1h, 24h, 7d` });
    return;
  }
  const id = uuidv4();
  createSchedule(id, goal.trim(), interval.trim(), nextRun);
  res.status(201).json({ schedule: { id, goal: goal.trim(), cron: interval.trim(), enabled: true, next_run_at: nextRun } });
});

router.put('/schedules/:id', (req, res) => {
  const { enabled, goal, interval } = req.body as { enabled?: boolean; goal?: string; interval?: string };
  const updates: Record<string, unknown> = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (goal) updates.goal = goal;
  if (interval) {
    const nextRun = nextRunFromInterval(interval);
    if (!nextRun) {
      res.status(400).json({ error: `Invalid interval "${interval}"` });
      return;
    }
    updates.cron = interval;
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
