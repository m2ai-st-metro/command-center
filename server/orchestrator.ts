import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import {
  createMission,
  getMission,
  updateMission,
  addMissionLog,
  listAgents,
  updateAgentStatus,
  logOutcome,
  updateOutcomeScores,
  setMissionJudgeVerdict,
  getAgentCapabilities,
  listAgentCapabilities,
  getRoutingWeight,
  listRoutingWeights,
  updateRoutingWeight,
  type AgentCapabilities,
} from './db.js';
import { getStockAgentPrompt } from './stock-loader.js';
import { getCustomAgentPrompt } from './custom-agents.js';
import { planMission } from './planner.js';
import { judgeMission } from './judge.js';
import { executeMission as executeViaWorkerManager } from './worker-manager.js';
import type { Mission, MissionPlan, AgentCard } from '../shared/types.js';
import { DIMENSION_WEIGHTS, computeCompositeScore } from '../shared/types.js';
import type { A2ATaskRequest, A2ATaskStatus } from '../shared/a2a.js';

// ── A2A Agent Registry ───────────────────────────────────────────────
// Maps agent IDs to their A2A endpoint URLs

const a2aEndpoints = new Map<string, string>();

export function registerA2AAgent(agentId: string, endpoint: string): void {
  a2aEndpoints.set(agentId, endpoint);
}

/** Get the A2A endpoint URL for an agent, or undefined if not registered. */
export function getA2AEndpoint(agentId: string): string | undefined {
  return a2aEndpoints.get(agentId);
}

/** List all registered A2A (agentId, endpoint) pairs. Used by trigger-poll (026). */
export function listA2AEndpoints(): Array<[string, string]> {
  return Array.from(a2aEndpoints.entries());
}

/** Try to discover an agent's A2A card. Returns true if successful. */
export async function discoverAgent(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/.well-known/agent.json`);
    if (!res.ok) return false;
    const card = await res.json();
    a2aEndpoints.set(card.id, endpoint);
    return true;
  } catch {
    return false;
  }
}

// ── Capability Requirements ─────────────────────────────────────────

interface RequiredCapabilities {
  needsWebSearch: boolean;
  needsMcp: string[];
  needsSubAgents: boolean;
  needsWrite: boolean;
}

/** Heuristic: infer what capabilities a goal requires based on keywords. */
function inferRequiredCapabilities(goal: string): RequiredCapabilities {
  const lower = goal.toLowerCase();
  return {
    needsWebSearch: /\b(search.*web|web.*search|look up online|find.*online|latest.*news|current.*price|recent|trending|live data|real-time)\b/.test(lower),
    needsMcp: /\b(scrape|crawl|extract.*from.*url|fetch.*page|website.*content|firecrawl)\b/.test(lower) ? ['firecrawl'] : [],
    needsSubAgents: /\b(parallel|concurrent|multiple.*files|batch|across.*projects|refactor.*all)\b/.test(lower),
    needsWrite: /\b(write|create|implement|build|fix|refactor|edit|modify|update.*code|add.*feature)\b/.test(lower),
  };
}

// ── Gap Detection ───────────────────────────────────────────────────

export interface CapabilityGap {
  detected: boolean;
  missing: string[];
  recommendation: string;
}

function detectCapabilityGap(agentId: string, required: RequiredCapabilities): CapabilityGap {
  const cap = getAgentCapabilities(agentId);
  const missing: string[] = [];

  if (!cap) {
    if (required.needsWebSearch) missing.push('WebSearch');
    if (required.needsMcp.length > 0) missing.push(...required.needsMcp.map(m => `MCP:${m}`));
    if (required.needsSubAgents) missing.push('sub-agents');
  } else {
    if (required.needsWebSearch && !cap.tools.includes('WebSearch')) missing.push('WebSearch');
    for (const mcp of required.needsMcp) {
      if (!cap.mcp_servers.includes(mcp)) missing.push(`MCP:${mcp}`);
    }
    if (required.needsSubAgents && !cap.can_spawn_sub_agents) missing.push('sub-agents');
    if (required.needsWrite && !cap.tools.includes('Write') && !cap.tools.includes('Edit')) missing.push('Write/Edit');
  }

  if (missing.length === 0) return { detected: false, missing: [], recommendation: '' };

  const allCaps = listAgentCapabilities();
  const recs: string[] = [];
  for (const m of missing) {
    const capable = allCaps.find(c => {
      if (m === 'WebSearch') return c.tools.includes('WebSearch');
      if (m.startsWith('MCP:')) return c.mcp_servers.includes(m.replace('MCP:', ''));
      if (m === 'sub-agents') return c.can_spawn_sub_agents;
      return false;
    });
    recs.push(capable
      ? `Route to ${capable.agent_id} (has ${m})`
      : `No agent has ${m} — add to existing Named Agent or create new one`);
  }

  return { detected: true, missing, recommendation: recs.join('; ') };
}

/** Find the best available agent that satisfies required capabilities. */
function findCapableAgent(agents: AgentCard[], required: RequiredCapabilities, taskType: string): AgentCard | null {
  const allCaps = listAgentCapabilities();
  const capMap = new Map(allCaps.map(c => [c.agent_id, c]));
  const allWeights = listRoutingWeights();
  const weightMap = new Map(allWeights.map(w => [`${w.agent_id}:${w.task_type}`, w]));

  const scored = agents
    .filter(a => a.status === 'available')
    .map(agent => {
      const cap = capMap.get(agent.id);
      let score = 0;

      // Skill match (static)
      if (agent.skills.some(s => s.toLowerCase() === taskType)) score += 10;

      // Capability match (static)
      if (cap) {
        if (required.needsWebSearch) score += cap.tools.includes('WebSearch') ? 15 : -20;
        if (required.needsMcp.length > 0) score += required.needsMcp.every(m => cap.mcp_servers.includes(m)) ? 10 : -20;
        if (required.needsSubAgents) score += cap.can_spawn_sub_agents ? 5 : -20;
        if (cap.tier === 1) score += 2;
      } else if (required.needsWebSearch || required.needsMcp.length > 0 || required.needsSubAgents) {
        score -= 20;
      }

      // Learned routing weight (dynamic — dimensional quality scores from Judge)
      const weight = weightMap.get(`${agent.id}:${taskType}`);
      if (weight && weight.total_missions >= 3) {
        // If dimensional scores exist, compute weighted composite for this task type
        if (weight.correctness_avg != null && weight.completeness_avg != null && weight.relevance_avg != null) {
          const w = DIMENSION_WEIGHTS[taskType] ?? DIMENSION_WEIGHTS.general;
          const composite = weight.correctness_avg * w.correctness
            + weight.completeness_avg * w.completeness
            + weight.relevance_avg * w.relevance;
          // Scale: 0.0 composite = -10, 0.5 = 0, 1.0 = +10
          score += (composite - 0.5) * 20;
        } else {
          // Fallback to flat success_rate when no Judge data yet
          score += (weight.success_rate - 0.5) * 20;
        }
      }

      return { agent, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 && scored[0].score > 0 ? scored[0].agent : null;
}

// ── Intent Classification ────────────────────────────────────────────

interface ClassificationResult {
  task_type: 'research' | 'coding' | 'content' | 'ops' | 'general';
  complexity: 'simple' | 'moderate' | 'complex';
  suggested_agent: string | null;
  reasoning: string;
  required_capabilities: RequiredCapabilities;
  gap: CapabilityGap;
}

export function classifyIntent(goal: string): ClassificationResult {
  const lower = goal.toLowerCase();

  const codingKeywords = /\b(build|code|implement|fix|refactor|debug|create.*app|write.*function|add.*feature|test|deploy)\b/;
  const researchKeywords = /\b(research|find|search|look up|investigate|analyze|compare|what is|how does|summarize)\b/;
  const contentKeywords = /\b(write|draft|blog|post|email|article|documentation|content|social media|copy)\b/;
  const opsKeywords = /\b(deploy|restart|update|install|configure|migrate|backup|monitor|server|docker|container)\b/;

  let task_type: ClassificationResult['task_type'] = 'general';
  if (codingKeywords.test(lower)) task_type = 'coding';
  else if (researchKeywords.test(lower)) task_type = 'research';
  else if (contentKeywords.test(lower)) task_type = 'content';
  else if (opsKeywords.test(lower)) task_type = 'ops';

  const complexity = lower.length > 200 || lower.includes(' and ') || lower.includes(' then ')
    ? 'complex'
    : lower.length > 80 ? 'moderate' : 'simple';

  const required_capabilities = inferRequiredCapabilities(goal);

  const agents = listAgents() as AgentCard[];
  const capableAgent = findCapableAgent(agents, required_capabilities, task_type);

  const suggested_agent = capableAgent?.id
    ?? agents.find(a => a.skills.some(s => s.toLowerCase() === task_type) && a.status === 'available')?.id
    ?? agents.find(a => a.status === 'available')?.id
    ?? null;

  const gap = suggested_agent
    ? detectCapabilityGap(suggested_agent, required_capabilities)
    : { detected: false, missing: [] as string[], recommendation: '' };

  let reasoning = `Classified as ${task_type} (${complexity}).`;
  if (capableAgent) reasoning += ` Capability-matched: ${capableAgent.name}.`;
  else if (suggested_agent) reasoning += ` Skill-matched: ${suggested_agent}.`;
  else reasoning += ' No agent available.';
  if (gap.detected) reasoning += ` GAP: missing [${gap.missing.join(', ')}]. ${gap.recommendation}`;

  return {
    task_type,
    complexity,
    suggested_agent,
    reasoning,
    required_capabilities,
    gap,
  };
}

// ── Mission Lifecycle ────────────────────────────────────────────────

export async function proposeMission(goal: string): Promise<{ mission: Mission; classification: ClassificationResult }> {
  const id = uuidv4();
  const classification = classifyIntent(goal);

  createMission(id, goal);

  addMissionLog(id, 'info', `Mission proposed: ${goal}`);
  addMissionLog(id, 'info', `Classification: ${classification.task_type} (${classification.complexity})`);

  // Phase 5.1: Sonnet planner decomposes goal into subtasks
  addMissionLog(id, 'info', 'Planner: decomposing goal into subtasks...');
  let plan: MissionPlan;
  try {
    plan = await planMission(goal);
    addMissionLog(id, 'info', `Planner: ${plan.subtasks.length} subtask(s) — ${plan.reasoning}`);
  } catch (err) {
    // Fallback to single-subtask plan
    console.error('Planner failed for mission', id, err);
    plan = {
      reasoning: classification.reasoning,
      subtasks: [{
        id: uuidv4(),
        description: goal,
        agent_id: classification.suggested_agent ?? 'claude-code',
        status: 'pending',
        result: null,
        depends_on: [],
      }],
      needs_clarification: false,
    };
    addMissionLog(id, 'info', 'Planner fallback: single subtask');
  }

  // Use first subtask's agent or classification suggestion as primary
  const primaryAgent = plan.subtasks[0]?.agent_id ?? classification.suggested_agent ?? 'claude-code';

  updateMission(id, {
    plan,
    agent_id: primaryAgent,
  });

  if (classification.suggested_agent) {
    addMissionLog(id, 'info', `Primary agent: ${primaryAgent}`);
  }
  if (classification.gap.detected) {
    addMissionLog(id, 'info', `Capability gap: missing [${classification.gap.missing.join(', ')}]`);
    addMissionLog(id, 'info', `Recommendation: ${classification.gap.recommendation}`);
  }

  const mission = getMission(id) as Mission;
  return { mission, classification };
}

export async function approveMission(missionId: string): Promise<void> {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  const agentId = (mission.agent_id as string) ?? 'stock-fallback';
  const subtaskCount = mission.plan?.subtasks?.length ?? 1;

  // Phase 5.2: Multi-subtask missions route through Worker Manager
  if (subtaskCount > 1) {
    updateMission(missionId, { status: 'running' });
    addMissionLog(missionId, 'info', `Mission approved — routing ${subtaskCount} subtasks to Worker Manager`);

    const startTime = Date.now();
    try {
      await executeViaWorkerManager(missionId);

      const durationMs = Date.now() - startTime;
      // Worker Manager already set mission status and result
      const completed = getMission(missionId);
      updateMission(missionId, { duration_ms: durationMs });
      addMissionLog(missionId, 'info', `Mission finished via Worker Manager in ${Math.round(durationMs / 1000)}s`);

      const planReasoning = mission.plan?.reasoning ?? '';
      const taskType = inferTaskType(planReasoning, mission.goal as string);
      logOutcome(missionId, taskType, agentId, planReasoning, completed?.status as string ?? 'completed', durationMs);
      runJudgeAsync(missionId, mission.goal as string, completed?.result as string ?? '', taskType, agentId, completed?.status as string ?? 'completed', durationMs);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMission(missionId, { status: 'failed', result: errMsg, duration_ms: durationMs });
      addMissionLog(missionId, 'error', `Worker Manager failed: ${errMsg}`);

      const planReasoning = mission.plan?.reasoning ?? '';
      const taskType = inferTaskType(planReasoning, mission.goal as string);
      logOutcome(missionId, taskType, agentId, planReasoning, 'failed', durationMs);
      runJudgeAsync(missionId, mission.goal as string, errMsg, taskType, agentId, 'failed', durationMs);
    }
    return;
  }

  // Single-subtask missions: existing dispatch path
  // Check if agent is busy — queue instead of failing
  const agents = listAgents() as AgentCard[];
  const agent = agents.find(a => a.id === agentId);
  if (agent?.status === 'busy') {
    addMissionLog(missionId, 'info', `Agent ${agentId} is busy — queuing mission`);
    updateMission(missionId, { status: 'proposed' });
    return;
  }

  updateMission(missionId, { status: 'running' });
  addMissionLog(missionId, 'info', 'Mission approved — executing (single subtask)');
  updateAgentStatus(agentId, 'busy', missionId);

  const startTime = Date.now();

  try {
    addMissionLog(missionId, 'progress', `Dispatching to agent: ${agentId}`);

    // Try A2A dispatch first, fall back to direct Claude Code
    const a2aEndpoint = a2aEndpoints.get(agentId);
    let result: string;

    if (a2aEndpoint) {
      addMissionLog(missionId, 'info', `Using A2A protocol → ${a2aEndpoint}`);
      result = await executeViaA2A(a2aEndpoint, missionId, mission.goal as string);
    } else {
      // Check if this is a custom or stock agent with a markdown prompt
      const customPrompt = getCustomAgentPrompt(agentId);
      const stockPrompt = customPrompt ? null : getStockAgentPrompt(agentId);
      const agentPrompt = customPrompt || stockPrompt;

      // Load capabilities for direct dispatch (Tier 2/3 won't have these)
      const capabilities = getAgentCapabilities(agentId);

      if (agentPrompt) {
        const promptType = customPrompt ? 'custom' : 'stock';
        addMissionLog(missionId, 'info', `Using ${promptType} agent prompt for ${agentId}`);
        result = await executeViaClaudeCode(mission.goal as string, missionId, agentPrompt, capabilities);
      } else {
        addMissionLog(missionId, 'info', 'No A2A endpoint — using direct Claude Code');
        result = await executeViaClaudeCode(mission.goal as string, missionId, undefined, capabilities);
      }
    }

    const durationMs = Date.now() - startTime;
    updateMission(missionId, {
      status: 'completed',
      result,
      duration_ms: durationMs,
    });
    addMissionLog(missionId, 'result', result);
    addMissionLog(missionId, 'info', `Mission completed in ${Math.round(durationMs / 1000)}s`);

    // Log outcome for routing quality tracking
    const planReasoning = mission.plan?.reasoning ?? '';
    const taskType = inferTaskType(planReasoning, mission.goal as string);
    logOutcome(missionId, taskType, agentId, planReasoning, 'completed', durationMs);

    // Phase 5.3/5.4: Async Judge evaluation — does not block mission completion
    runJudgeAsync(missionId, mission.goal as string, result, taskType, agentId, 'completed', durationMs);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    updateMission(missionId, {
      status: 'failed',
      result: errMsg,
      duration_ms: durationMs,
    });
    addMissionLog(missionId, 'error', `Mission failed: ${errMsg}`);

    const planReasoning = mission.plan?.reasoning ?? '';
    const taskType = inferTaskType(planReasoning, mission.goal as string);
    logOutcome(missionId, taskType, agentId, planReasoning, 'failed', durationMs);

    // Judge also evaluates failures — to score partial quality
    runJudgeAsync(missionId, mission.goal as string, errMsg, taskType, agentId, 'failed', durationMs);
  } finally {
    updateAgentStatus(agentId, 'available', null);
  }
}

export function cancelMission(missionId: string): void {
  const mission = getMission(missionId);
  updateMission(missionId, { status: 'cancelled' });
  addMissionLog(missionId, 'info', 'Mission cancelled');

  // Reset agent status if it was assigned
  if (mission?.agent_id) {
    updateAgentStatus(mission.agent_id as string, 'available', null);
  }
}

// ── A2A Dispatch ─────────────────────────────────────────────────────

async function executeViaA2A(endpoint: string, missionId: string, goal: string): Promise<string> {
  const taskId = uuidv4();

  // Submit task
  const taskReq: A2ATaskRequest = {
    id: taskId,
    goal,
    sender: { id: 'data-orchestrator', name: 'Data' },
    timeout_ms: 600_000,
  };

  const submitRes = await fetch(`${endpoint}/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskReq),
  });

  if (!submitRes.ok) {
    throw new Error(`A2A task submission failed: ${submitRes.status} ${await submitRes.text()}`);
  }

  addMissionLog(missionId, 'progress', `A2A task ${taskId.slice(0, 8)} submitted, polling...`);

  // Poll for completion
  const maxWait = 660_000; // 11 min (give agent 10 min + buffer)
  const pollInterval = 3_000;
  const startPoll = Date.now();
  let lastProgress = '';

  while (Date.now() - startPoll < maxWait) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const statusRes = await fetch(`${endpoint}/task/${taskId}`);
    if (!statusRes.ok) continue;

    const status = await statusRes.json() as A2ATaskStatus;

    if (status.state === 'completed') {
      return status.result ?? '(no output)';
    }

    if (status.state === 'failed') {
      throw new Error(`Agent failed: ${status.error ?? 'unknown error'}`);
    }

    // Log progress only when the message changes (prevents log spam)
    if (status.progress && status.progress !== lastProgress) {
      lastProgress = status.progress;
      addMissionLog(missionId, 'progress', `Agent: ${status.progress}`);
    }
  }

  throw new Error('A2A task timed out waiting for agent response');
}

// ── Direct Claude Code Dispatch (fallback) ───────────────────────────

function executeViaClaudeCode(
  prompt: string,
  missionId: string,
  systemPrompt?: string,
  capabilities?: AgentCapabilities | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tools = capabilities?.tools ?? ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
    const maxTurns = capabilities?.max_turns ?? 25;
    const timeoutMs = capabilities?.timeout ?? 900_000;

    const args = [
      '--print', prompt,
      '--output-format', 'text',
      '--allowedTools', ...tools,
      '--max-turns', String(maxTurns),
    ];
    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }
    if (capabilities?.mcp_config_path) {
      args.push('--mcp-config', capabilities.mcp_config_path);
      args.push('--strict-mcp-config');
      addMissionLog(missionId, 'info', `MCP: ${capabilities.mcp_config_path} (strict isolation)`);
    }

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    addMissionLog(missionId, 'progress', `Starting session — tools: [${tools.join(', ')}], max turns: ${maxTurns}`);

    const child = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        addMissionLog(missionId, 'progress', `Claude: ${line.slice(0, 200)}`);
      }
    });

    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim() || '(no output)');
      else reject(new Error(`Claude Code exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
    });
  });
}

// ── Task Type Inference ───────────────────────────────────────────

function inferTaskType(planReasoning: string, goal: string): string {
  // Try to extract from planner/classifier reasoning
  const fromPlan = planReasoning.match(/(?:Classified as|type:)\s*(\w+)/i)?.[1];
  if (fromPlan && ['coding', 'research', 'content', 'ops', 'general'].includes(fromPlan)) {
    return fromPlan;
  }
  // Fallback: re-classify from goal
  return classifyIntent(goal).task_type;
}

// ── Async Judge Evaluation ────────────────────────────────────────

function runJudgeAsync(
  missionId: string,
  goal: string,
  result: string,
  taskType: string,
  agentId: string,
  status: string,
  durationMs: number,
): void {
  // Fire-and-forget — judge runs in background
  addMissionLog(missionId, 'info', 'Judge: evaluating mission quality...');

  judgeMission(goal, result, taskType, status, durationMs)
    .then(verdict => {
      addMissionLog(missionId, 'info',
        `Judge verdict: ${verdict.passed ? 'PASS' : 'FAIL'} ` +
        `(composite: ${(verdict.composite_score * 100).toFixed(0)}% — ` +
        `correctness: ${(verdict.quality_scores.correctness * 100).toFixed(0)}%, ` +
        `completeness: ${(verdict.quality_scores.completeness * 100).toFixed(0)}%, ` +
        `relevance: ${(verdict.quality_scores.relevance * 100).toFixed(0)}%) ` +
        `[${verdict.method}]`
      );
      addMissionLog(missionId, 'info', `Judge reasoning: ${verdict.reasoning}`);

      // Persist verdict on the mission
      setMissionJudgeVerdict(missionId, verdict);

      // Update outcome_logs with quality scores
      updateOutcomeScores(missionId, {
        correctness: verdict.quality_scores.correctness,
        completeness: verdict.quality_scores.completeness,
        relevance: verdict.quality_scores.relevance,
        compositeScore: verdict.composite_score,
        judgeReasoning: verdict.reasoning,
        judgeMethod: verdict.method,
      });

      // Recalculate routing weights with dimensional data
      updateRoutingWeight(agentId, taskType);
    })
    .catch(err => {
      console.error('Judge evaluation failed for mission', missionId, err);
      addMissionLog(missionId, 'error', `Judge failed: ${err instanceof Error ? err.message : String(err)}`);
      // Still update routing weights with pass/fail only
      updateRoutingWeight(agentId, taskType);
    });
}
