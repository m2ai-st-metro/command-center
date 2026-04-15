/**
 * Trigger evaluator (026).
 *
 * Subscribes to the trigger bus, matches events against enabled triggers,
 * enforces cooldown, and dispatches actions. Every attempt — fired, cooldown-
 * blocked, condition-mismatch — is NOT recorded; only fired attempts produce
 * a trigger_fires row. Cooldown misses are silent by design (too noisy).
 */
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import {
  listEnabledTriggersByCondition,
  markTriggerFired,
  recordTriggerFire,
  createMissionTask,
  type Trigger,
  type TriggerConditionType,
} from './db.js';
import { triggerBus, type TriggerEvent } from './trigger-bus.js';
import { dispatchMissionTask } from './mission-dispatcher.js';

/**
 * Return true if the event satisfies the trigger's condition_config.
 * All matchers are "config is optional filter" — empty config matches all
 * events of that type.
 */
function matchesCondition(trigger: Trigger, event: TriggerEvent): boolean {
  const cfg = trigger.condition_config;
  switch (event.type) {
    case 'mission_failed': {
      const agentFilter = cfg.agent_id as string | undefined;
      if (agentFilter && event.agent_id !== agentFilter) return false;
      // Depth-guard: never fire on failures of tasks dispatched BY a trigger.
      if (event.source === 'trigger') return false;
      return true;
    }
    case 'schedule_missed': {
      const scheduleFilter = cfg.schedule_id as string | undefined;
      const minDelay = (cfg.min_delay_seconds as number | undefined) ?? 0;
      if (scheduleFilter && event.schedule_id !== scheduleFilter) return false;
      if (event.delay_seconds < minDelay) return false;
      return true;
    }
    case 'agent_offline': {
      const agentFilter = cfg.agent_id as string | undefined;
      const minDuration = (cfg.min_duration_seconds as number | undefined) ?? 0;
      if (agentFilter && event.agent_id !== agentFilter) return false;
      if (event.duration_seconds < minDuration) return false;
      return true;
    }
  }
}

function isInCooldown(trigger: Trigger, now: number): boolean {
  if (!trigger.last_fired_at) return false;
  return now - trigger.last_fired_at < trigger.cooldown_seconds;
}

async function runAction(trigger: Trigger, event: TriggerEvent): Promise<string> {
  const cfg = trigger.action_config;
  switch (trigger.action_type) {
    case 'dispatch_mission_task': {
      const agent = cfg.agent as string | undefined;
      const title = (cfg.title as string | undefined) ?? `Triggered by ${trigger.name}`;
      const promptBase = (cfg.prompt as string | undefined) ?? '';
      const repoPath = cfg.repo_path as string | undefined;
      if (!agent || !promptBase) {
        throw new Error('dispatch_mission_task requires agent and prompt in action_config');
      }
      const promptWithEvent = `${promptBase}\n\n--- triggered by event ---\n${JSON.stringify(event, null, 2)}`;
      const id = uuidv4();
      createMissionTask({
        id,
        agent_id: agent,
        title,
        prompt: promptWithEvent,
        repo_path: repoPath,
        source: 'trigger',
      });
      // Fire-and-forget dispatch; dispatcher handles its own errors.
      dispatchMissionTask(id).catch((e) => {
        console.error('[trigger-eval] dispatch error:', e);
      });
      return `dispatched mission_task ${id}`;
    }
    case 'notify_log_file': {
      const logPath = cfg.path as string | undefined;
      const format = (cfg.format as 'json' | 'text' | undefined) ?? 'json';
      if (!logPath) throw new Error('notify_log_file requires path in action_config');
      const line =
        format === 'json'
          ? JSON.stringify({ at: new Date().toISOString(), trigger: trigger.name, event }) + '\n'
          : `[${new Date().toISOString()}] ${trigger.name}: ${event.type} ${JSON.stringify(event)}\n`;
      fs.appendFileSync(logPath, line);
      return `appended to ${logPath}`;
    }
  }
}

async function handleEvent(event: TriggerEvent): Promise<void> {
  const triggers = listEnabledTriggersByCondition(event.type as TriggerConditionType);
  const now = Math.floor(Date.now() / 1000);
  for (const trigger of triggers) {
    if (!matchesCondition(trigger, event)) continue;
    if (isInCooldown(trigger, now)) continue;
    let result: string;
    try {
      result = await runAction(trigger, event);
    } catch (err) {
      result = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    markTriggerFired(trigger.id, now);
    recordTriggerFire(trigger.id, now, event as unknown as Record<string, unknown>, result);
  }
}

let started = false;

/**
 * Subscribe the evaluator to the bus. Idempotent — multiple calls do nothing.
 */
export function startTriggerEvaluator(): void {
  if (started) return;
  started = true;
  triggerBus.on('event', (event: TriggerEvent) => {
    handleEvent(event).catch((e) => {
      console.error('[trigger-eval] handler error:', e);
    });
  });
  console.log('[trigger-eval] started');
}
