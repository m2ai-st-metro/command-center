/**
 * Trigger poll loop (026).
 *
 * Polls state that can't be pushed:
 *   - agent_offline: HTTP GET each registered A2A agent's /health; track
 *     how long each has been down; emit once duration crosses any trigger's
 *     min_duration_seconds (condition evaluator handles the actual threshold).
 *   - schedule_missed: scan schedules where next_run_at is in the past by
 *     more than a grace window; emit schedule_missed.
 *
 * Scheduler's own tick() handles re-enqueuing; this loop is strictly an
 * observation layer — it never mutates schedule state.
 */
import { listSchedules } from './db.js';
import { listA2AEndpoints } from './orchestrator.js';
import { triggerBus } from './trigger-bus.js';

const POLL_INTERVAL_MS = 30_000;
const SCHEDULE_MISS_GRACE_SECONDS = 120; // 2 min past next_run_at before considering missed
const HEALTH_TIMEOUT_MS = 5_000;

// Track first-failure timestamp per agent so duration_seconds can be computed.
const agentDownSince = new Map<string, number>();
// Track schedules we've already emitted for (keyed by id+expected_at) to avoid spam.
const missedEmitted = new Set<string>();

async function checkAgent(agentId: string, endpoint: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      if (agentDownSince.has(agentId)) agentDownSince.delete(agentId);
      return;
    }
    registerDown(agentId, now, `HTTP ${res.status}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    registerDown(agentId, now, reason);
  }
}

function registerDown(agentId: string, now: number, reason: string): void {
  if (!agentDownSince.has(agentId)) agentDownSince.set(agentId, now);
  const downSince = agentDownSince.get(agentId)!;
  const duration = now - downSince;
  // Emit on every poll tick while down; cooldown + min_duration_seconds in
  // the evaluator handles the actual fire rate.
  triggerBus.emitEvent({
    type: 'agent_offline',
    agent_id: agentId,
    duration_seconds: duration,
    reason,
  });
}

function scanSchedules(): void {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const schedules = listSchedules();
  for (const s of schedules) {
    if (!s.enabled || !s.next_run_at) continue;
    const nextMs = s.next_run_at * 1000;
    const delayMs = nowMs - nextMs;
    if (delayMs < SCHEDULE_MISS_GRACE_SECONDS * 1000) continue;
    const key = `${s.id}:${s.next_run_at}`;
    if (missedEmitted.has(key)) continue;
    missedEmitted.add(key);
    triggerBus.emitEvent({
      type: 'schedule_missed',
      schedule_id: s.id,
      goal: s.goal,
      expected_at: s.next_run_at,
      delay_seconds: Math.floor(delayMs / 1000),
    });
  }
  // Opportunistic pruning — limit the dedupe set.
  if (missedEmitted.size > 500) {
    const arr = Array.from(missedEmitted);
    missedEmitted.clear();
    for (const k of arr.slice(-200)) missedEmitted.add(k);
  }
  void nowSec;
}

async function tick(): Promise<void> {
  const endpoints = listA2AEndpoints();
  await Promise.all(endpoints.map(([id, ep]) => checkAgent(id, ep)));
  try {
    scanSchedules();
  } catch (e) {
    console.error('[trigger-poll] scanSchedules error:', e);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startTriggerPoll(): void {
  if (timer) return;
  // Short initial delay so server boot completes before first poll.
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, 5_000);
  console.log('[trigger-poll] started');
}

export function stopTriggerPoll(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
