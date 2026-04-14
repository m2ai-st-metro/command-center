#!/usr/bin/env node
/**
 * mission-cli — dispatch fire-and-forget tasks to CMD's named agents.
 *
 * Subcommands:
 *   create --agent <id> --title <label> [--priority N] [--json] "<prompt>"
 *   list [--limit N] [--status S] [--json]
 *   result <task-id> [--json]
 *   cancel <task-id>
 *   help
 *
 * Base URL from CMD_URL env var (default http://localhost:3142).
 * Exit codes: 0 success, 1 error, 2 usage.
 */

import type { MissionTask } from '../shared/types.js';

const CMD_URL = (process.env.CMD_URL ?? 'http://localhost:3142').replace(/\/$/, '');

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function usage(exitCode = 2): never {
  console.error(`Usage: mission-cli <command> [options]

Commands:
  create --agent <id> --title <label> [--skill <s>] [--repo <path>] [--priority N] [--json] "<prompt>"
     Queue a task for an agent. Returns the task id.
     --skill routes to an agent's skill-specific model (R2.4, if configured).
     --repo runs the task in an isolated git worktree of the given repo (027).
            Path must be an absolute path to a git repo on this machine.

  list [--limit N] [--status <s>] [--json]
     List recent tasks (default 20). Status: queued, running, completed, failed, cancelled.

  result <task-id> [--json]
     Fetch a task's current state and result.

  cancel <task-id>
     Cancel a queued or running task.

  help
     Show this help.

Env:
  CMD_URL  base URL of Command Center (default: http://localhost:3142)
`);
  process.exit(exitCode);
}

async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CMD_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

function formatStatus(status: string): string {
  const icons: Record<string, string> = {
    queued: '⏳', running: '▶', completed: '✓', failed: '✗', cancelled: '⊘',
  };
  return `${icons[status] ?? '?'} ${status}`;
}

function formatTaskLine(t: MissionTask): string {
  const durationMs = t.completed_at && t.claimed_at ? (t.completed_at - t.claimed_at) * 1000 : null;
  const durationStr = durationMs ? ` (${Math.round(durationMs / 1000)}s)` : '';
  return `${t.id.slice(0, 8)}  ${formatStatus(t.status).padEnd(14)}  ${t.agent_id.padEnd(10)}  ${t.title.slice(0, 50)}${durationStr}`;
}

async function cmdCreate(args: ParsedArgs): Promise<void> {
  const agent = args.flags.agent as string | undefined;
  const title = args.flags.title as string | undefined;
  const skill = args.flags.skill as string | undefined;
  const repoPath = args.flags.repo as string | undefined;
  const priority = args.flags.priority ? parseInt(args.flags.priority as string, 10) : undefined;
  const prompt = args.positional.join(' ');

  if (!agent || !title || !prompt) {
    console.error('Error: --agent, --title, and a prompt are required.\n');
    usage();
  }

  if (repoPath && !repoPath.startsWith('/')) {
    console.error(`Error: --repo must be an absolute path (got: ${repoPath}).\n`);
    process.exit(2);
  }

  const { task } = await apiCall<{ task: MissionTask }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ agent_id: agent, title, prompt, priority, skill, repo_path: repoPath }),
  });

  if (args.flags.json) {
    console.log(JSON.stringify(task, null, 2));
  } else {
    console.log(`Queued: ${task.id}`);
    console.log(`Agent:  ${task.agent_id}`);
    console.log(`Title:  ${task.title}`);
    console.log(`Poll:   mission-cli result ${task.id}`);
  }
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const { tasks } = await apiCall<{ tasks: MissionTask[] }>('/api/tasks');
  const limit = args.flags.limit ? parseInt(args.flags.limit as string, 10) : 20;
  const statusFilter = args.flags.status as string | undefined;
  let filtered = tasks;
  if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
  filtered = filtered.slice(0, limit);

  if (args.flags.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log('(no tasks)');
    return;
  }
  console.log('ID        STATUS          AGENT       TITLE');
  console.log('─'.repeat(90));
  for (const t of filtered) console.log(formatTaskLine(t));
}

async function cmdResult(args: ParsedArgs): Promise<void> {
  const taskId = args.positional[0];
  if (!taskId) { console.error('Error: task id required.\n'); usage(); }

  const { task } = await apiCall<{ task: MissionTask }>(`/api/tasks/${taskId}`);

  if (args.flags.json) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  console.log(`Task:    ${task.id}`);
  console.log(`Status:  ${formatStatus(task.status)}`);
  console.log(`Agent:   ${task.agent_id}`);
  console.log(`Title:   ${task.title}`);
  if (task.claimed_at && task.completed_at) {
    console.log(`Runtime: ${task.completed_at - task.claimed_at}s`);
  }
  if (task.result) {
    console.log(`\n--- Result ---\n${task.result}`);
  }
  if (task.error) {
    console.log(`\n--- Error ---\n${task.error}`);
  }
  if (task.status === 'queued' || task.status === 'running') {
    process.exit(0); // not an error — just not done yet
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    process.exit(1);
  }
}

async function cmdCancel(args: ParsedArgs): Promise<void> {
  const taskId = args.positional[0];
  if (!taskId) { console.error('Error: task id required.\n'); usage(); }
  await apiCall(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
  console.log(`Cancelled: ${taskId}`);
}

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') usage(0);

  const args = parseArgs(rest);

  try {
    switch (subcommand) {
      case 'create': await cmdCreate(args); break;
      case 'list':   await cmdList(args); break;
      case 'result': await cmdResult(args); break;
      case 'cancel': await cmdCancel(args); break;
      default:
        console.error(`Unknown command: ${subcommand}\n`);
        usage();
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
