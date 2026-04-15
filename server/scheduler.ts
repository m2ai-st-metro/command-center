import { CronExpressionParser } from 'cron-parser';
import { listSchedules, updateSchedule } from './db.js';
import type { Schedule } from './db.js';
import { proposeMission, approveMission } from './orchestrator.js';

/**
 * Simple cron-like scheduler.
 * Checks schedules every 30 seconds, fires missions when next_run_at has passed.
 * Supports: interval strings like "5m", "1h", "30m", "24h", "7d"
 */

const INTERVAL_MS = 30_000; // Check every 30 seconds
let timer: ReturnType<typeof setInterval> | null = null;

/** Parse interval string to milliseconds */
export function parseInterval(interval: string): number | null {
  const match = interval.trim().match(/^(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': case 'sec': return num * 1_000;
    case 'm': case 'min': return num * 60_000;
    case 'h': case 'hr': return num * 3_600_000;
    case 'd': case 'day': return num * 86_400_000;
    default: return null;
  }
}

/** Calculate next run timestamp from interval string */
export function nextRunFromInterval(interval: string, fromMs = Date.now()): number | null {
  const ms = parseInterval(interval);
  if (!ms) return null;
  return Math.floor((fromMs + ms) / 1000);
}

/** Calculate next run timestamp from a cron expression (5-field standard cron) */
export function nextRunFromCron(expr: string, fromMs = Date.now()): number | null {
  try {
    const parsed = CronExpressionParser.parse(expr, { currentDate: new Date(fromMs) });
    return Math.floor(parsed.next().getTime() / 1000);
  } catch {
    return null;
  }
}

/**
 * Return the next run unix timestamp for a schedule, branching on cadence_type.
 * Pass-through to nextRunFromInterval for legacy interval rows.
 */
export function nextRunFromSchedule(schedule: Pick<Schedule, 'cron' | 'cadence_type' | 'cron_expr'>, fromMs = Date.now()): number | null {
  if (schedule.cadence_type === 'cron' && schedule.cron_expr) {
    return nextRunFromCron(schedule.cron_expr, fromMs);
  }
  return nextRunFromInterval(schedule.cron, fromMs);
}

/**
 * Create and immediately auto-approve a mission for the given goal.
 * Does NOT touch next_run_at -- callers decide what to update in the DB.
 * Returns the created mission id.
 */
export async function runScheduleNow(goal: string): Promise<string> {
  const { mission } = await proposeMission(goal);
  approveMission(mission.id).catch(err => {
    console.error(`[Scheduler] run-now mission ${mission.id} execution error:`, err);
  });
  return mission.id;
}

/** Check all schedules and fire any that are due */
async function tick(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const schedules = listSchedules();

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.next_run_at || schedule.next_run_at > now) continue;

    try {
      console.log(`[Scheduler] Firing schedule "${schedule.id}": ${schedule.goal}`);

      const missionId = await runScheduleNow(schedule.goal);

      // Calculate next run
      const nextRun = nextRunFromSchedule(schedule);

      updateSchedule(schedule.id, {
        last_run_at: now,
        next_run_at: nextRun ?? undefined,
        last_mission_id: missionId,
      });

      // Disable if we can't calculate next run (bad expression)
      if (!nextRun) {
        console.warn(`[Scheduler] Cannot compute next run for schedule ${schedule.id} — disabling`);
        updateSchedule(schedule.id, { enabled: false });
      }
    } catch (err) {
      console.error(`[Scheduler] Error firing schedule ${schedule.id}:`, err);
    }
  }
}

export function startScheduler(): void {
  if (timer) return;
  console.log('[Scheduler] Started — checking every 30s');
  timer = setInterval(() => {
    tick().catch(err => console.error('[Scheduler] Tick error:', err));
  }, INTERVAL_MS);
  // Run immediately on start
  tick().catch(err => console.error('[Scheduler] Initial tick error:', err));
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[Scheduler] Stopped');
  }
}
