// ── Mission Types ─────────────────────────────────────────────────────

export type MissionStatus = 'proposed' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Mission {
  id: string;
  goal: string;
  status: MissionStatus;
  created_at: number;
  updated_at: number;
  plan: MissionPlan | null;
  result: string | null;
  duration_ms: number | null;
  agent_id: string | null;
}

export interface MissionPlan {
  reasoning: string;
  subtasks: MissionSubtask[];
  needs_clarification: boolean;
  clarification_question?: string;
}

export interface MissionSubtask {
  id: string;
  description: string;
  agent_id: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';
  result: string | null;
  depends_on: string[];
  duration_ms?: number | null;
  task_type?: string;
}

// ── Agent Types ──────────────────────────────────────────────────────

export type AgentStatus = 'available' | 'busy' | 'offline';

export interface AgentCard {
  id: string;
  name: string;
  description: string;
  skills: string[];
  status: AgentStatus;
  type: 'named' | 'stock';
  active_mission_id: string | null;
}

// ── Log Types ────────────────────────────────────────────────────────

export interface MissionLog {
  id: number;
  mission_id: string;
  timestamp: number;
  level: 'info' | 'progress' | 'error' | 'result';
  message: string;
  agent_id: string | null;
}

// ── Quality Evaluation Types (Phase 5 — Planner-Worker-Judge) ────

export interface QualityScores {
  correctness: number;   // 0-1: Did the output achieve what was asked?
  completeness: number;  // 0-1: Were all parts of the request addressed?
  relevance: number;     // 0-1: Is the output on-topic and well-targeted?
}

export interface JudgeVerdict {
  passed: boolean;
  quality_scores: QualityScores;
  composite_score: number; // 0-1: weighted average per task type
  reasoning: string;
  evaluated_at: number;    // unix timestamp
  method: 'algorithmic' | 'llm' | 'both';
}

/** Per-task-type dimension weights for composite score calculation. */
export const DIMENSION_WEIGHTS: Record<string, QualityScores> = {
  coding:   { correctness: 0.6, completeness: 0.2, relevance: 0.2 },
  research: { correctness: 0.2, completeness: 0.5, relevance: 0.3 },
  content:  { correctness: 0.2, completeness: 0.3, relevance: 0.5 },
  ops:      { correctness: 0.5, completeness: 0.3, relevance: 0.2 },
  general:  { correctness: 0.34, completeness: 0.33, relevance: 0.33 },
};

export function computeCompositeScore(scores: QualityScores, taskType: string): number {
  const w = DIMENSION_WEIGHTS[taskType] ?? DIMENSION_WEIGHTS.general;
  return scores.correctness * w.correctness + scores.completeness * w.completeness + scores.relevance * w.relevance;
}

// ── Worker Manager Types (Phase 5.2) ─────────────────────────────

export type WorkerSlotStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface WorkerSlot {
  id: number;               // 0-based slot index
  mission_id: string | null;
  subtask_id: string | null;
  pid: number | null;
  status: WorkerSlotStatus;
  worktree_path: string | null;
  started_at: number | null; // unix timestamp
}

export interface SubtaskExecution {
  subtask_id: string;
  mission_id: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';
  result: string | null;
  duration_ms: number | null;
  worker_slot: number | null;
  retry_count: number;
}

export interface WorkerPoolConfig {
  maxWorkers: number;        // default 8
  burstLimit: number;        // max 12
  subtaskTimeoutMs: number;  // 15 min default
  contextDir: string;        // /tmp/cmd-{missionId}
}

export const DEFAULT_POOL_CONFIG: WorkerPoolConfig = {
  maxWorkers: 8,
  burstLimit: 12,
  subtaskTimeoutMs: 900_000,
  contextDir: '/tmp',
};

// ── Mission Task Types (R2.1 — async queue for fire-and-forget dispatch) ──

export type MissionTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MissionTask {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  priority: number;            // 0-10, default 5
  status: MissionTaskStatus;
  result: string | null;
  error: string | null;
  created_at: number;
  claimed_at: number | null;   // when dispatched to A2A
  completed_at: number | null;
  a2a_task_id: string | null;  // id returned by agent's A2A endpoint
  skill: string | null;        // R2.4: optional skill hint for per-skill model routing
}

export interface CreateMissionTaskRequest {
  agent_id: string;
  title: string;
  prompt: string;
  priority?: number;
  skill?: string;              // R2.4
}

// ── API Types ────────────────────────────────────────────────────────

export interface CreateMissionRequest {
  goal: string;
}

export interface CreateMissionResponse {
  mission: Mission;
}

export interface MissionDetailResponse {
  mission: Mission;
  logs: MissionLog[];
}

export interface AgentListResponse {
  agents: AgentCard[];
}

export interface StatusResponse {
  mission_id: string;
  status: MissionStatus;
  summary: string;
  progress_pct: number | null;
}
