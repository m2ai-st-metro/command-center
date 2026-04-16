import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  getMission,
  updateMission,
  addMissionLog,
  updateMissionSubtask,
  acquireWorkerSlot,
  releaseWorkerSlot,
  updateWorkerSlot,
  getActiveWorkerCount,
  getAgentCapabilities,
} from './db.js';
import { getStockAgentPrompt } from './stock-loader.js';
import { getCustomAgentPrompt } from './custom-agents.js';
import { resolveConflict } from './conflict-resolver.js';
import type { MissionSubtask, WorkerPoolConfig } from '../shared/types.js';
import { DEFAULT_POOL_CONFIG } from '../shared/types.js';

/**
 * Worker Manager (Phase 5.2)
 *
 * Executes multi-subtask missions with parallel workers, dependency ordering,
 * git worktree isolation for coding tasks, and retry/failure handling.
 *
 * Architecture:
 * - Worker Pool: 8 default slots, burstable to 12, persisted in SQLite
 * - Subtask Scheduler: resolves dependency DAG, dispatches ready subtasks
 * - Context Manager: /tmp/cmd-{missionId}/ with shared context.json
 * - Worktree Manager: git worktree create/merge/cleanup for coding subtasks
 * - Merge Orchestrator: sequential merge with ephemeral conflict resolution
 * - Failure Handler: retry once, cancel dependents, continue independents
 */

const config: WorkerPoolConfig = { ...DEFAULT_POOL_CONFIG };

// Queue of missions waiting for worker slots
const missionQueue: string[] = [];

// ── Context Manager ─────────────────────────────────────────────

function getContextDir(missionId: string): string {
  return path.join(config.contextDir, `cmd-${missionId}`);
}

function initMissionContext(missionId: string, goal: string, plan: unknown): string {
  const dir = getContextDir(missionId);
  fs.mkdirSync(dir, { recursive: true });

  const contextFile = path.join(dir, 'context.json');
  fs.writeFileSync(contextFile, JSON.stringify({
    mission_id: missionId,
    goal,
    plan,
    completed_subtasks: [],
  }, null, 2));

  return dir;
}

function appendSubtaskResult(
  missionId: string,
  subtaskId: string,
  description: string,
  result: string,
): void {
  const contextFile = path.join(getContextDir(missionId), 'context.json');
  if (!fs.existsSync(contextFile)) return;

  const ctx = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
  ctx.completed_subtasks.push({ subtask_id: subtaskId, description, result: result.slice(0, 4000) });
  fs.writeFileSync(contextFile, JSON.stringify(ctx, null, 2));
}

function buildWorkerPrompt(
  missionId: string,
  subtask: MissionSubtask,
  totalSubtasks: number,
  subtaskIndex: number,
): string {
  const contextFile = path.join(getContextDir(missionId), 'context.json');
  let priorResults = '';

  if (fs.existsSync(contextFile)) {
    const ctx = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
    if (ctx.completed_subtasks.length > 0) {
      priorResults = '\n\nPrior completed subtasks and their results:\n' +
        ctx.completed_subtasks.map((s: { description: string; result: string }, i: number) =>
          `--- Subtask ${i + 1} (${s.description}) ---\n${s.result}`
        ).join('\n\n');
    }
  }

  return `You are executing subtask ${subtaskIndex + 1} of ${totalSubtasks} in a multi-step mission.

Mission goal: ${(getMission(missionId) as { goal: string }).goal}

Your task: ${subtask.description}
${priorResults}

Focus on YOUR task only. Produce clear, actionable output. Your work will be evaluated by a quality judge.`;
}

function cleanupMissionContext(missionId: string): void {
  const dir = getContextDir(missionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Worktree Manager ────────────────────────────────────────────

function detectRepoPath(subtask: MissionSubtask): string | null {
  // Heuristic: if the subtask description mentions a specific project path, extract it
  const pathMatch = subtask.description.match(/(?:in|at|for)\s+(\/\S+|~\/\S+)/i);
  if (pathMatch) {
    const p = pathMatch[1].replace('~', process.env.HOME ?? '/home/apexaipc');
    try {
      execSync(`git -C "${p}" rev-parse --git-dir`, { stdio: 'pipe' });
      return p;
    } catch { /* not a git repo */ }
  }

  // Check if task_type is coding — if so, try common project locations
  if (subtask.task_type === 'coding' || subtask.agent_id === 'coding') {
    // Default to no repo — worker runs from home
    return null;
  }

  return null;
}

function createWorktree(repoPath: string, branchName: string): string {
  const worktreePath = path.join('/tmp', `cmd-wt-${branchName}`);

  if (fs.existsSync(worktreePath)) {
    // Clean up stale worktree
    try { execSync(`git -C "${repoPath}" worktree remove "${worktreePath}" --force`, { stdio: 'pipe' }); } catch { /* ignore */ }
  }

  execSync(`git -C "${repoPath}" worktree add "${worktreePath}" -b "${branchName}" HEAD`, { stdio: 'pipe' });
  return worktreePath;
}

function mergeWorktree(repoPath: string, branchName: string, missionId: string): { success: boolean; conflict: boolean } {
  try {
    execSync(`git -C "${repoPath}" merge --no-ff "${branchName}" -m "Merge subtask branch ${branchName}"`, { stdio: 'pipe' });
    return { success: true, conflict: false };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('CONFLICT') || errMsg.includes('Merge conflict')) {
      return { success: false, conflict: true };
    }
    addMissionLog(missionId, 'error', `Merge failed for ${branchName}: ${errMsg}`);
    return { success: false, conflict: false };
  }
}

function cleanupWorktree(repoPath: string, worktreePath: string, branchName: string): void {
  try { execSync(`git -C "${repoPath}" worktree remove "${worktreePath}" --force`, { stdio: 'pipe' }); } catch { /* ignore */ }
  try { execSync(`git -C "${repoPath}" branch -D "${branchName}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
}

// ── Subtask Executor ────────────────────────────────────────────

function executeSubtask(
  missionId: string,
  subtask: MissionSubtask,
  subtaskIndex: number,
  totalSubtasks: number,
  slotId: number,
): Promise<{ result: string; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const systemPrompt = buildWorkerPrompt(missionId, subtask, totalSubtasks, subtaskIndex);

    // Determine agent capabilities and prompt
    const agentId = subtask.agent_id;
    const capabilities = getAgentCapabilities(agentId);
    const customPrompt = getCustomAgentPrompt(agentId);
    const stockPrompt = customPrompt ? null : getStockAgentPrompt(agentId);
    const agentPrompt = customPrompt || stockPrompt;

    const tools = capabilities?.tools ?? ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
    const maxTurns = capabilities?.max_turns ?? 25;
    const timeoutMs = Math.min(capabilities?.timeout ?? config.subtaskTimeoutMs, config.subtaskTimeoutMs);

    const args = [
      '--print', subtask.description,
      '--output-format', 'text',
      '--allowedTools', ...tools,
      '--max-turns', String(maxTurns),
      '--append-system-prompt', agentPrompt ? `${agentPrompt}\n\n${systemPrompt}` : systemPrompt,
    ];

    if (capabilities?.mcp_config_path) {
      args.push('--mcp-config', capabilities.mcp_config_path);
      args.push('--strict-mcp-config');
    }

    // Determine working directory
    const repoPath = detectRepoPath(subtask);
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    const cwd = process.env.HOME ?? '/home/apexaipc';

    if (repoPath) {
      branchName = `cmd-${missionId.slice(0, 8)}-st${subtaskIndex}`;
      try {
        worktreePath = createWorktree(repoPath, branchName);
        updateWorkerSlot(slotId, { worktree_path: worktreePath });
        addMissionLog(missionId, 'info', `Worktree created: ${worktreePath} (branch: ${branchName})`);
      } catch (err) {
        addMissionLog(missionId, 'error', `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
        // Fall back to home dir
      }
    }

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const startTime = Date.now();

    addMissionLog(missionId, 'progress',
      `Worker[${slotId}] starting subtask ${subtaskIndex + 1}/${totalSubtasks}: ${subtask.description.slice(0, 80)}`);

    const child = spawn('claude', args, {
      env,
      cwd: worktreePath ?? cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    updateWorkerSlot(slotId, { pid: child.pid ?? null });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        addMissionLog(missionId, 'progress', `Worker[${slotId}]: ${line.slice(0, 200)}`);
      }
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      if (code === 0) {
        resolve({ result: stdout.trim() || '(no output)', durationMs });
      } else {
        reject(new Error(`Worker exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn worker: ${err.message}`));
    });
  });
}

// ── Subtask Scheduler (Dependency DAG) ──────────────────────────

function getReadySubtasks(subtasks: MissionSubtask[]): MissionSubtask[] {
  return subtasks.filter(st => {
    if (st.status !== 'pending' && st.status !== 'queued') return false;
    // All dependencies must be completed
    return st.depends_on.every(depId => {
      const dep = subtasks.find(s => s.id === depId);
      return dep?.status === 'completed';
    });
  });
}

function hasCancelledDependency(subtask: MissionSubtask, subtasks: MissionSubtask[]): boolean {
  return subtask.depends_on.some(depId => {
    const dep = subtasks.find(s => s.id === depId);
    return dep?.status === 'failed' || dep?.status === 'cancelled';
  });
}

// ── Mission Execution ───────────────────────────────────────────

interface WorktreeInfo {
  subtaskId: string;
  repoPath: string;
  branchName: string;
  worktreePath: string;
}

export async function executeMission(missionId: string): Promise<void> {
  const mission = getMission(missionId);
  if (!mission?.plan?.subtasks?.length) {
    throw new Error(`Mission ${missionId} has no plan or subtasks`);
  }

  const subtasks: MissionSubtask[] = mission.plan.subtasks;
  const totalSubtasks = subtasks.length;
  const worktrees: WorktreeInfo[] = [];

  addMissionLog(missionId, 'info',
    `Worker Manager: executing ${totalSubtasks} subtask(s), pool has ${config.maxWorkers} default / ${config.burstLimit} burst slots`);

  initMissionContext(missionId, mission.goal as string, mission.plan);

  // Main scheduling loop
  while (true) {
    // Refresh subtask state from DB
    const current = getMission(missionId);
    if (!current?.plan) break;
    const liveSubtasks: MissionSubtask[] = current.plan.subtasks;

    // Cancel subtasks with failed/cancelled dependencies
    for (const st of liveSubtasks) {
      if ((st.status === 'pending' || st.status === 'queued') && hasCancelledDependency(st, liveSubtasks)) {
        updateMissionSubtask(missionId, st.id, { status: 'cancelled' });
        addMissionLog(missionId, 'info', `Subtask "${st.description.slice(0, 60)}" cancelled — dependency failed`);
      }
    }

    // Check if all subtasks are terminal
    const refreshed = (getMission(missionId) as typeof mission).plan!.subtasks as MissionSubtask[];
    const allDone = refreshed.every(st =>
      st.status === 'completed' || st.status === 'failed' || st.status === 'cancelled'
    );
    if (allDone) break;

    // Find subtasks ready to dispatch (dependencies met)
    const ready = getReadySubtasks(refreshed);
    if (ready.length === 0) {
      // Nothing ready — check if we're waiting on running subtasks
      const running = refreshed.filter(st => st.status === 'running' || st.status === 'retrying');
      if (running.length === 0) {
        // Deadlock — no ready, no running
        addMissionLog(missionId, 'error', 'Worker Manager: scheduling deadlock — no subtasks ready or running');
        break;
      }
      // Wait for running subtasks to complete
      await sleep(2000);
      continue;
    }

    // Determine current pool limit (burst if needed)
    const activeCount = getActiveWorkerCount();
    const currentLimit = activeCount >= config.maxWorkers ? config.burstLimit : config.maxWorkers;

    // Dispatch ready subtasks to available slots
    const dispatches: Promise<void>[] = [];

    for (const subtask of ready) {
      const subtaskIndex = subtasks.findIndex(s => s.id === subtask.id);
      const slotId = acquireWorkerSlot(currentLimit, missionId, subtask.id);

      if (slotId === null) {
        // No slots available — mark as queued and wait
        updateMissionSubtask(missionId, subtask.id, { status: 'queued' });
        addMissionLog(missionId, 'info', `Subtask "${subtask.description.slice(0, 60)}" queued — no worker slots available`);
        continue;
      }

      updateMissionSubtask(missionId, subtask.id, { status: 'running' });

      // Dispatch worker (async, don't block the loop)
      dispatches.push(
        runSubtaskWithRetry(missionId, subtask, subtaskIndex, totalSubtasks, slotId, worktrees)
      );
    }

    // Wait for at least one dispatch to complete before re-checking
    if (dispatches.length > 0) {
      await Promise.race(dispatches);
      // Small delay to let DB updates propagate
      await sleep(500);
    } else {
      // All ready subtasks were queued — wait for slots
      await sleep(3000);
    }
  }

  // Merge worktrees if any
  if (worktrees.length > 0) {
    await mergeAllWorktrees(missionId, worktrees);
  }

  // Cleanup
  cleanupMissionContext(missionId);

  // Aggregate results
  const finalMission = getMission(missionId);
  const finalSubtasks: MissionSubtask[] = finalMission?.plan?.subtasks ?? [];
  const completedCount = finalSubtasks.filter(s => s.status === 'completed').length;
  const failedCount = finalSubtasks.filter(s => s.status === 'failed').length;
  const cancelledCount = finalSubtasks.filter(s => s.status === 'cancelled').length;

  const aggregatedResult = finalSubtasks
    .filter(s => s.result)
    .map((s, i) => `## Subtask ${i + 1}: ${s.description}\n\n${s.result}`)
    .join('\n\n---\n\n');

  const overallStatus = failedCount === totalSubtasks ? 'failed'
    : completedCount > 0 ? 'completed' : 'failed';

  addMissionLog(missionId, 'info',
    `Worker Manager finished: ${completedCount} completed, ${failedCount} failed, ${cancelledCount} cancelled`);

  updateMission(missionId, {
    status: overallStatus,
    result: aggregatedResult || '(no output from any subtask)',
  });
}

// ── Retry Logic ─────────────────────────────────────────────────

async function runSubtaskWithRetry(
  missionId: string,
  subtask: MissionSubtask,
  subtaskIndex: number,
  totalSubtasks: number,
  slotId: number,
  worktrees: WorktreeInfo[],
): Promise<void> {
  try {
    const { result, durationMs } = await executeSubtask(missionId, subtask, subtaskIndex, totalSubtasks, slotId);

    updateMissionSubtask(missionId, subtask.id, {
      status: 'completed',
      result,
      duration_ms: durationMs,
    });

    // Track worktree for later merge
    const worktreePath = detectRepoPath(subtask);
    if (worktreePath) {
      const branchName = `cmd-${missionId.slice(0, 8)}-st${subtaskIndex}`;
      worktrees.push({ subtaskId: subtask.id, repoPath: worktreePath, branchName, worktreePath: `/tmp/cmd-wt-${branchName}` });
    }

    appendSubtaskResult(missionId, subtask.id, subtask.description, result);
    addMissionLog(missionId, 'info',
      `Subtask ${subtaskIndex + 1} completed in ${Math.round(durationMs / 1000)}s`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Retry once
    addMissionLog(missionId, 'info', `Subtask ${subtaskIndex + 1} failed: ${errMsg.slice(0, 200)}. Retrying...`);
    updateMissionSubtask(missionId, subtask.id, { status: 'retrying' });

    try {
      const { result, durationMs } = await executeSubtask(missionId, subtask, subtaskIndex, totalSubtasks, slotId);

      updateMissionSubtask(missionId, subtask.id, {
        status: 'completed',
        result,
        duration_ms: durationMs,
      });

      appendSubtaskResult(missionId, subtask.id, subtask.description, result);
      addMissionLog(missionId, 'info',
        `Subtask ${subtaskIndex + 1} completed on retry in ${Math.round(durationMs / 1000)}s`);
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      updateMissionSubtask(missionId, subtask.id, {
        status: 'failed',
        result: retryMsg,
      });
      addMissionLog(missionId, 'error',
        `Subtask ${subtaskIndex + 1} failed after retry: ${retryMsg.slice(0, 200)}`);
    }
  } finally {
    releaseWorkerSlot(slotId);
  }
}

// ── Merge Orchestrator ──────────────────────────────────────────

async function mergeAllWorktrees(missionId: string, worktrees: WorktreeInfo[]): Promise<void> {
  addMissionLog(missionId, 'info', `Merging ${worktrees.length} worktree(s) sequentially...`);

  for (const wt of worktrees) {
    const { success, conflict } = mergeWorktree(wt.repoPath, wt.branchName, missionId);

    if (success) {
      addMissionLog(missionId, 'info', `Merged branch ${wt.branchName} successfully`);
    } else if (conflict) {
      const resolved = await resolveConflict(wt.repoPath, {
        onLog: (level, message) => addMissionLog(missionId, level, message),
      });
      if (!resolved) {
        addMissionLog(missionId, 'error', `Unresolved merge conflict for branch ${wt.branchName} — aborting merge`);
        try { execSync(`git -C "${wt.repoPath}" merge --abort`, { stdio: 'pipe' }); } catch { /* ignore */ }
      }
    }

    // Cleanup worktree and branch
    cleanupWorktree(wt.repoPath, wt.worktreePath, wt.branchName);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get the current pool status for diagnostics. */
export function getPoolStatus(): {
  active: number;
  available: number;
  maxWorkers: number;
  burstLimit: number;
  queueLength: number;
} {
  const active = getActiveWorkerCount();
  return {
    active,
    available: config.burstLimit - active,
    maxWorkers: config.maxWorkers,
    burstLimit: config.burstLimit,
    queueLength: missionQueue.length,
  };
}
