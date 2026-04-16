import { spawn } from 'child_process';
import type { JudgeVerdict } from '../shared/types.js';

/**
 * Reasoner (R3 / 029) — decides what to do with a Judge FAIL.
 *
 * Called from the orchestrator's retry loop on single-agent missions whenever
 * `judgeMission` returns a non-passing verdict and the iteration cap has not
 * been hit. Picks one of: retry the same agent with a refined prompt, reassign
 * to a different agent, or escalate to a human.
 *
 * Model: Claude via CLI (Max-covered). Does NOT use ANTHROPIC_API_KEY — the
 * CLI picks up Max OAuth. On any transport/parse failure the Reasoner
 * escalates rather than looping on itself.
 */

export type ReasonerAction = 'retry_same' | 'retry_different' | 'escalate';

export interface ReasonerAttempt {
  agent_id: string;
  verdict: JudgeVerdict;
  reasoner_action: string;
}

export interface ReasonerInput {
  goal: string;
  result: string;
  verdict: JudgeVerdict;
  iteration: number;
  maxIterations: number;
  priorAttempts: ReasonerAttempt[];
  currentAgentId: string;
  availableAgents: Array<{ id: string; skills: string[] }>;
  taskType: string;
}

export interface ReasonerDecision {
  action: ReasonerAction;
  rationale: string;
  new_agent_id?: string;
  refined_prompt?: string;
}

const REASONER_SYSTEM_PROMPT = `You are the Reasoner for an autonomous orchestrator. A mission's most recent attempt failed the Judge and you must decide the next move.

You will receive: the original goal, the failed output, the Judge verdict, the prior attempts, which agent ran this attempt, and which agents are available.

Choose exactly one action:
- retry_same: The agent is the right fit but the prompt or context was unclear. Provide a refined_prompt that addresses what the Judge flagged.
- retry_different: A different agent is better matched to this goal. Provide new_agent_id chosen from the available list. You may also provide refined_prompt.
- escalate: The task is ambiguous, impossible with the current agent roster, or repeated retries are unlikely to help. Do not retry.

## Rules
- Never invent an agent ID that is not in the available list.
- Prefer retry_different when the current agent has already failed once with the same flavour of mistake.
- Prefer escalate once two distinct agents have failed on the same goal.
- Keep refined_prompt under 500 characters and do not rewrite the goal — only add clarifying constraints or point out the specific Judge finding to fix.
- Be honest. If the goal itself is vague, escalate — do not paper over it with prompt tweaks.

## Output Format
Return ONLY valid JSON. No markdown, no code fences, no commentary.

{"action": "retry_same" | "retry_different" | "escalate", "rationale": "<one sentence>", "new_agent_id": "<id or omit>", "refined_prompt": "<string or omit>"}`;

function buildUserPrompt(input: ReasonerInput): string {
  const priorStr = input.priorAttempts.length
    ? input.priorAttempts.map((a, i) =>
        `Attempt ${i + 1} — agent=${a.agent_id}, composite=${a.verdict.composite_score.toFixed(2)}, reason: ${a.verdict.reasoning}`
      ).join('\n')
    : '(none)';
  const agentsStr = input.availableAgents.length
    ? input.availableAgents.map(a => `- ${a.id}: skills=[${a.skills.join(', ')}]`).join('\n')
    : '(no other agents registered)';

  return `## Goal
${input.goal}

## Task Type
${input.taskType}

## Iteration
${input.iteration} of ${input.maxIterations} max

## Current Agent
${input.currentAgentId}

## Latest Judge Verdict
passed=${input.verdict.passed}, composite=${input.verdict.composite_score.toFixed(2)}
correctness=${input.verdict.quality_scores.correctness.toFixed(2)}
completeness=${input.verdict.quality_scores.completeness.toFixed(2)}
relevance=${input.verdict.quality_scores.relevance.toFixed(2)}
reasoning: ${input.verdict.reasoning}

## Latest Output (truncated)
${input.result.slice(0, 4000)}

## Prior Attempts
${priorStr}

## Available Agents
${agentsStr}

Decide the next action. Return JSON only.`;
}

export async function askReasoner(input: ReasonerInput): Promise<ReasonerDecision> {
  try {
    const raw = await callReasoner(buildUserPrompt(input));
    return parseReasonerDecision(raw, input);
  } catch (err) {
    return {
      action: 'escalate',
      rationale: `reasoner unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseReasonerDecision(raw: string, input: ReasonerInput): ReasonerDecision {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      action: 'escalate',
      rationale: `reasoner returned non-JSON: ${cleaned.slice(0, 120)}`,
    };
  }

  const action = parsed.action as ReasonerAction | undefined;
  if (action !== 'retry_same' && action !== 'retry_different' && action !== 'escalate') {
    return {
      action: 'escalate',
      rationale: `reasoner returned invalid action: ${String(action)}`,
    };
  }
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : 'no rationale';
  const newAgentId = typeof parsed.new_agent_id === 'string' ? parsed.new_agent_id : undefined;
  const refinedPrompt = typeof parsed.refined_prompt === 'string' ? parsed.refined_prompt : undefined;

  if (action === 'retry_different') {
    if (!newAgentId) {
      return { action: 'escalate', rationale: 'retry_different chosen but no new_agent_id supplied' };
    }
    const allowed = input.availableAgents.some(a => a.id === newAgentId);
    if (!allowed) {
      return { action: 'escalate', rationale: `new_agent_id '${newAgentId}' not in available list` };
    }
  }

  return { action, rationale, new_agent_id: newAgentId, refined_prompt: refinedPrompt };
}

function callReasoner(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', prompt,
      '--output-format', 'text',
      '--append-system-prompt', REASONER_SYSTEM_PROMPT,
      '--max-turns', '1',
      '--model', 'sonnet',
    ];

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Reasoner exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn reasoner: ${err.message}`));
    });
  });
}
