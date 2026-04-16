/**
 * Ephemeral conflict-resolution agent. Spawned against a repo that is in a
 * conflicted merge state; expected to run `git diff`, edit the conflicted
 * files, then `git add` + `git commit` to finalize the merge.
 *
 * Originally inline in worker-manager.ts; extracted in 027 Phase 2 so the
 * mission-task dispatch path in worktree-mt.ts can use the same resolver.
 * Logging is callback-based so callers (mission vs mission-task) can route
 * events into their own log streams.
 */
import { spawn } from 'child_process';

export interface ConflictResolverOptions {
  /** Optional progress callback. Called with log level + message. */
  onLog?: (level: 'info' | 'progress' | 'error', message: string) => void;
  /** Timeout in ms. Defaults to 5 min — enough for non-trivial conflicts, short enough not to wedge a mission. */
  timeoutMs?: number;
  /** Max Claude turns. Defaults to 15. */
  maxTurns?: number;
}

/**
 * Resolve the conflicted merge in `repoPath`. Returns true iff the resolver
 * exited cleanly. On success the caller can assume the merge commit has been
 * finalized (the resolver runs `git add` + `git commit`). On failure the
 * caller should `git merge --abort` in the source repo.
 */
export function resolveConflict(
  repoPath: string,
  options: ConflictResolverOptions = {},
): Promise<boolean> {
  const { onLog, timeoutMs = 300_000, maxTurns = 15 } = options;
  onLog?.('info', 'Spawning ephemeral conflict-resolution agent...');

  return new Promise((resolve) => {
    const args = [
      '--print',
      `Resolve the git merge conflicts in ${repoPath}. Run 'git diff' to see conflicts, fix them, then 'git add' the resolved files and 'git commit'.`,
      '--output-format', 'text',
      '--allowedTools', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash',
      '--max-turns', String(maxTurns),
    ];

    // Max OAuth path: explicitly unset ANTHROPIC_API_KEY so the spawned
    // Claude Code CLI uses the same subscription as the parent process.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn('claude', args, {
      env,
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    // Drain stdout so the child does not block on a full pipe buffer.
    child.stdout.on('data', () => { /* consume */ });
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) onLog?.('progress', `ConflictResolver: ${line.slice(0, 150)}`);
    });

    child.on('close', (code) => {
      if (code === 0) {
        onLog?.('info', 'Conflict resolution succeeded');
        resolve(true);
      } else {
        onLog?.('error', `Conflict resolution failed (exit ${code})`);
        resolve(false);
      }
    });

    child.on('error', () => resolve(false));
  });
}
