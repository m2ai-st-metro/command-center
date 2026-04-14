/**
 * 027: Worktree lifecycle for the A2A/mission-task dispatch path.
 *
 * Each mission-task with a `repo_path` gets its own isolated git worktree at
 * /tmp/cmd-mt-<id8>/ on branch cmd-mt-<id8>. The dispatcher creates the worktree
 * pre-POST, passes its path as `cwd` in the A2A request, and on terminal state
 * merges (or discards) the worktree back into the source repo.
 *
 * Kept separate from worker-manager.ts's per-subtask worktree code so the two
 * execution paths don't entangle during the rekindle.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface WorktreeIds {
  worktreePath: string;
  branchName: string;
}

function idShort(taskId: string): string {
  // Strip any non-alphanumeric so the branch name is git-safe
  const sanitized = taskId.replace(/[^a-zA-Z0-9]/g, '');
  return sanitized.slice(0, 8);
}

export function worktreeIdsFor(taskId: string): WorktreeIds {
  const short = idShort(taskId);
  return {
    worktreePath: path.join('/tmp', `cmd-mt-${short}`),
    branchName: `cmd-mt-${short}`,
  };
}

/** Return true iff `repoPath` is a git repo we can work with. */
export function isGitRepo(repoPath: string): boolean {
  try {
    execSync(`git -C "${repoPath}" rev-parse --git-dir`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a worktree for a mission-task. Cleans up any stale worktree with the
 * same path first so a rerun doesn't trip on leftover state.
 */
export function createWorktree(repoPath: string, taskId: string): WorktreeIds {
  const { worktreePath, branchName } = worktreeIdsFor(taskId);

  // Prune any stale worktree with the same path (e.g. from a prior crashed run)
  if (fs.existsSync(worktreePath)) {
    try { execSync(`git -C "${repoPath}" worktree remove "${worktreePath}" --force`, { stdio: 'pipe' }); } catch { /* ignore */ }
  }
  // Delete a stale branch of the same name (safe — branches are `cmd-mt-<id8>`)
  try { execSync(`git -C "${repoPath}" branch -D "${branchName}"`, { stdio: 'pipe' }); } catch { /* ignore */ }

  execSync(`git -C "${repoPath}" worktree add "${worktreePath}" -b "${branchName}" HEAD`, { stdio: 'pipe' });
  return { worktreePath, branchName };
}

export interface MergeOutcome {
  merged: boolean;
  conflict: boolean;
  noChanges: boolean;
  error?: string;
}

/**
 * Merge the task's branch back into the source repo's current HEAD.
 * If the worktree made no commits, skips the merge cleanly (noChanges=true).
 * On conflict: leaves the worktree + branch in place for human inspection
 * and returns conflict=true. Caller should mark the task failed with a
 * descriptive error and NOT call cleanupWorktree.
 */
export function mergeWorktree(repoPath: string, branchName: string, worktreePath: string): MergeOutcome {
  // If the worktree has no commits past the base, there's nothing to merge.
  // The worktree may still contain uncommitted changes — we snapshot them as
  // one WIP commit so they can be recovered, then merge.
  try {
    const dirty = execSync(`git -C "${worktreePath}" status --porcelain`, { stdio: 'pipe' }).toString().trim();
    if (dirty) {
      execSync(`git -C "${worktreePath}" add -A`, { stdio: 'pipe' });
      execSync(`git -C "${worktreePath}" commit -m "cmd-mt: snapshot uncommitted work" --no-verify`, { stdio: 'pipe' });
    }
  } catch (err) {
    return { merged: false, conflict: false, noChanges: false, error: `snapshot failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const aheadRaw = execSync(`git -C "${repoPath}" rev-list --count HEAD..${branchName}`, { stdio: 'pipe' }).toString().trim();
  const ahead = parseInt(aheadRaw, 10) || 0;
  if (ahead === 0) {
    return { merged: false, conflict: false, noChanges: true };
  }

  try {
    execSync(`git -C "${repoPath}" merge --no-ff "${branchName}" -m "Merge mission-task branch ${branchName}"`, { stdio: 'pipe' });
    return { merged: true, conflict: false, noChanges: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CONFLICT') || msg.includes('Merge conflict')) {
      // Abort the merge in the source repo so it's left in a clean state.
      // The worktree + branch are preserved for inspection.
      try { execSync(`git -C "${repoPath}" merge --abort`, { stdio: 'pipe' }); } catch { /* ignore */ }
      return { merged: false, conflict: true, noChanges: false, error: 'merge conflict' };
    }
    return { merged: false, conflict: false, noChanges: false, error: msg };
  }
}

/**
 * Remove the worktree directory and delete its branch. Safe to call even if
 * already gone. Do NOT call after a conflict — the branch/worktree should be
 * preserved for human inspection in that case.
 */
export function cleanupWorktree(repoPath: string, worktreePath: string, branchName: string): void {
  try { execSync(`git -C "${repoPath}" worktree remove "${worktreePath}" --force`, { stdio: 'pipe' }); } catch { /* ignore */ }
  try { execSync(`git -C "${repoPath}" branch -D "${branchName}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
}
