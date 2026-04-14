import {
  getMissionTask,
  listMissionTasksByStatus,
  updateMissionTask,
  appendConversation,
  getRecentConversation,
  type ConversationEntry,
} from './db.js';
import { getA2AEndpoint } from './orchestrator.js';
import type { A2ATaskRequest, A2ATaskStatus } from '../shared/a2a.js';

/** Format prior conversation as a context block for the agent's next task. */
function buildConversationContext(history: ConversationEntry[]): string | undefined {
  if (history.length === 0) return undefined;
  const lines = history.map(e => `${e.role}: ${e.content}`);
  return `Previous exchanges with you (most recent last):\n${lines.join('\n\n')}`;
}

const POLL_INTERVAL_MS = 15_000;

/**
 * Dispatch a queued mission task to its agent's A2A endpoint.
 * On success: task transitions queued -> running with a2a_task_id recorded.
 * On failure: task transitions queued -> failed with error message.
 */
export async function dispatchMissionTask(taskId: string): Promise<void> {
  const task = getMissionTask(taskId);
  if (!task) return;
  if (task.status !== 'queued') return;

  const endpoint = getA2AEndpoint(task.agent_id);
  if (!endpoint) {
    updateMissionTask(taskId, {
      status: 'failed',
      error: `No A2A endpoint registered for agent '${task.agent_id}'`,
      completed_at: Math.floor(Date.now() / 1000),
    });
    return;
  }

  // R2.3: inject prior conversation so the agent has memory continuity
  const history = getRecentConversation(task.agent_id);
  const conversationContext = buildConversationContext(history);

  const body: A2ATaskRequest = {
    id: task.id,
    goal: task.prompt,
    context: conversationContext,
    skill: task.skill ?? undefined,
    sender: { id: 'mission-dispatcher', name: 'CMD Mission Dispatcher' },
  };

  try {
    const res = await fetch(`${endpoint}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      updateMissionTask(taskId, {
        status: 'failed',
        error: `A2A dispatch failed (${res.status}): ${text.slice(0, 500)}`,
        completed_at: Math.floor(Date.now() / 1000),
      });
      return;
    }
    const data = await res.json() as { task_id: string };
    updateMissionTask(taskId, {
      status: 'running',
      claimed_at: Math.floor(Date.now() / 1000),
      a2a_task_id: data.task_id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateMissionTask(taskId, {
      status: 'failed',
      error: `A2A dispatch exception: ${msg.slice(0, 500)}`,
      completed_at: Math.floor(Date.now() / 1000),
    });
  }
}

/**
 * Poll A2A for each running task and sync its status into mission_tasks.
 * If an A2A task is unreachable (agent restarted, 404), mark as failed.
 */
async function pollRunningTasks(): Promise<void> {
  const running = listMissionTasksByStatus('running');
  for (const task of running) {
    if (!task.a2a_task_id) continue;
    const endpoint = getA2AEndpoint(task.agent_id);
    if (!endpoint) continue;

    try {
      const res = await fetch(`${endpoint}/task/${task.a2a_task_id}`);
      if (res.status === 404) {
        updateMissionTask(task.id, {
          status: 'failed',
          error: 'A2A task lost (agent restarted or task expired)',
          completed_at: Math.floor(Date.now() / 1000),
        });
        continue;
      }
      if (!res.ok) continue;

      const status = await res.json() as A2ATaskStatus;
      if (status.state === 'completed') {
        const result = status.result ?? '(no output)';
        updateMissionTask(task.id, {
          status: 'completed',
          result,
          completed_at: Math.floor(Date.now() / 1000),
        });
        // R2.3: persist the exchange so future tasks for this agent have context
        appendConversation(task.agent_id, 'user', task.prompt, task.id);
        appendConversation(task.agent_id, 'assistant', result, task.id);
      } else if (status.state === 'failed') {
        updateMissionTask(task.id, {
          status: 'failed',
          error: status.error ?? 'A2A task failed without error message',
          completed_at: Math.floor(Date.now() / 1000),
        });
      }
      // else still running — leave for next poll
    } catch {
      // Network hiccup — retry next poll
    }
  }
}

let pollerHandle: NodeJS.Timeout | null = null;

export function startMissionDispatcher(): void {
  if (pollerHandle) return;
  pollerHandle = setInterval(() => {
    pollRunningTasks().catch(err => console.error('[mission-dispatcher] poll error:', err));
  }, POLL_INTERVAL_MS);
  console.log(`[mission-dispatcher] Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopMissionDispatcher(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}
