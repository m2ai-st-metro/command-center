import { listSchedules, updateSchedule } from './db.js';
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

/** Check all schedules and fire any that are due */
async function tick(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const schedules = listSchedules();

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.next_run_at || schedule.next_run_at > now) continue;

    try {
      console.log(`[Scheduler] Firing schedule "${schedule.id}": ${schedule.goal}`);

      // Create and auto-approve the mission
      const { mission } = proposeMission(schedule.goal);
      approveMission(mission.id).catch(err => {
        console.error(`[Scheduler] Mission ${mission.id} execution error:`, err);
      });

      // Calculate next run
      const nextRun = nextRunFromInterval(schedule.cron);

      updateSchedule(schedule.id, {
        last_run_at: now,
        next_run_at: nextRun ?? undefined,
        last_mission_id: mission.id,
      });

      // Disable if we can't calculate next run (bad interval)
      if (!nextRun) {
        console.warn(`[Scheduler] Cannot parse interval "${schedule.cron}" — disabling schedule ${schedule.id}`);
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
