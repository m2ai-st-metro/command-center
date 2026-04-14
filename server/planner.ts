import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { classifyIntent } from './orchestrator.js';
import type { MissionPlan, MissionSubtask } from '../shared/types.js';

/**
 * Mission Planner (Phase 5.1) — Sonnet decomposes goals into subtasks.
 *
 * Every mission goes through the planner. Simple missions return a single
 * subtask (no-op decomposition). Complex missions get broken into ordered
 * subtasks with dependencies and per-subtask agent assignments.
 */

interface PlannerSubtask {
  description: string;
  task_type: string;
  verification: string;
  depends_on: number[];  // indices into the array
}

const PLANNER_SYSTEM_PROMPT = `You are a mission planner for an AI agent orchestration system called CMD.

Your job: decompose a user's goal into ordered subtasks that can be executed by specialized agents.

## Agent Types Available
- **coding**: Software engineering — build, fix, refactor, debug, test, deploy
- **research**: Web research, analysis, investigation, comparison, summarization
- **content**: Writing — blog posts, emails, documentation, social media, copy
- **ops**: DevOps — deploy, restart, configure, migrate, backup, monitor
- **general**: Anything that doesn't fit the above

## Rules
1. Return a JSON array of subtasks. Each subtask has: description, task_type, verification, depends_on (array of 0-based indices of subtasks this one depends on)
2. Keep subtasks atomic — one clear action per subtask
3. Order by dependency — earlier subtasks first
4. For simple goals that are a single action, return exactly ONE subtask
5. Cap subtasks at 6 for normal goals. Bulk operations (see rule 8) may exceed this and should go up to as many chunks as needed, hard cap 12.
6. depends_on must only reference earlier subtasks (lower indices)
7. **verification** (required, non-empty): describe how to objectively verify this subtask succeeded — a concrete observable outcome, not a restatement of the description. If you cannot articulate verification, decompose further.
8. **Bulk operation chunking:** If a goal involves processing many files or items (renaming across a codebase, bulk edits, mass updates), NEVER put all items into a single subtask. Split into chunks of 10-15 files per subtask. Each subtask gets a specific list of files or a scoped directory. Independent chunks should have NO dependencies between them so they run in parallel. Add a final verification subtask (depends_on all chunks) that confirms the full operation succeeded. This prevents individual subtasks from exceeding the execution timeout.

## Output Format
Return ONLY valid JSON. No markdown, no explanation, no code fences.

Example for "Research competitors and write a blog post comparing them":
[{"description":"Research top competitors, their features, pricing, and market position","task_type":"research","verification":"A structured summary with at least 3 competitors and fields for features, pricing, positioning.","depends_on":[]},{"description":"Write a comparison blog post based on the research findings","task_type":"content","verification":"A published-ready blog post of at least 600 words citing each competitor from the research.","depends_on":[0]}]

Example for "Fix the login bug":
[{"description":"Fix the login bug","task_type":"coding","verification":"Login flow succeeds end-to-end and a regression test covering the bug passes.","depends_on":[]}]

Example for "Refactor error handling in every .ts file under /tmp/foo/" (bulk, 28 files):
[{"description":"Refactor error handling in files 1-14 of /tmp/foo/ (list files first, then edit)","task_type":"coding","verification":"Each of the 14 files wraps risky calls in try/catch and logs via logger.error; build still passes.","depends_on":[]},{"description":"Refactor error handling in files 15-28 of /tmp/foo/","task_type":"coding","verification":"Each of the 14 files wraps risky calls in try/catch and logs via logger.error; build still passes.","depends_on":[]},{"description":"Verify all .ts files under /tmp/foo/ have been refactored","task_type":"coding","verification":"grep confirms zero untouched files remain; build passes.","depends_on":[0,1]}]`;

export async function planMission(goal: string): Promise<MissionPlan> {
  let subtasks: PlannerSubtask[];

  try {
    const raw = await callPlanner(goal);
    subtasks = JSON.parse(raw);

    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      throw new Error('Planner returned empty or non-array result');
    }
  } catch (err) {
    // Fallback: single subtask using keyword classification
    console.error('Planner decomposition failed, falling back to single subtask:', err);
    const classification = classifyIntent(goal);
    return {
      reasoning: `Planner fallback — classified as ${classification.task_type} (${classification.complexity}).`,
      subtasks: [{
        id: uuidv4(),
        description: goal,
        agent_id: classification.suggested_agent ?? 'claude-code',
        status: 'pending',
        result: null,
        depends_on: [],
        verification: 'Task completed without errors and goal is addressed.',
      }],
      needs_clarification: false,
    };
  }

  // Convert planner output to MissionSubtask[] with agent assignments
  const missionSubtasks: MissionSubtask[] = subtasks.map((st, idx) => {
    // Use classifyIntent to find the best agent for each subtask
    const classification = classifyIntent(st.description);

    // Map numeric depends_on indices to subtask IDs (assigned below)
    const id = uuidv4();

    return {
      id,
      description: st.description,
      agent_id: classification.suggested_agent ?? 'claude-code',
      status: 'pending' as const,
      result: null,
      depends_on: [], // resolved below
      verification: (st.verification ?? '').trim() || 'Task completed without errors and goal is addressed.',
    };
  });

  // Resolve depends_on indices to subtask IDs
  for (let i = 0; i < subtasks.length; i++) {
    const deps = subtasks[i].depends_on ?? [];
    missionSubtasks[i].depends_on = deps
      .filter(idx => idx >= 0 && idx < i) // only valid earlier indices
      .map(idx => missionSubtasks[idx].id);
  }

  // Build reasoning summary
  const taskTypes = subtasks.map(s => s.task_type);
  const uniqueTypes = [...new Set(taskTypes)];
  const isMultiDomain = uniqueTypes.length > 1;
  const reasoning = isMultiDomain
    ? `Planner decomposed into ${subtasks.length} subtasks across [${uniqueTypes.join(', ')}]. Dependencies: ${subtasks.some(s => s.depends_on.length > 0) ? 'yes' : 'none'}.`
    : `Planner: ${subtasks.length} subtask(s), type: ${uniqueTypes[0]}.`;

  return {
    reasoning,
    subtasks: missionSubtasks,
    needs_clarification: false,
  };
}

function callPlanner(goal: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', `Decompose this goal into subtasks:\n\n${goal}`,
      '--output-format', 'text',
      '--append-system-prompt', PLANNER_SYSTEM_PROMPT,
      '--max-turns', '1',
      '--model', 'sonnet',
    ];

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        // Strip markdown code fences if present
        let result = stdout.trim();
        result = result.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
        resolve(result.trim());
      } else {
        reject(new Error(`Planner exited with code ${code}: ${stderr.trim()}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn planner: ${err.message}`));
    });
  });
}
