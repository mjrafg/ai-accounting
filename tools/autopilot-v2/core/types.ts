/**
 * Autopilot V2 — shared types.
 *
 * Fewer durable states than V1; phase/subPhase carry the detail. The event
 * model is deliberately small and generic: structured fields, not new event
 * types, describe variation. History is append-only; corrections append.
 */

export type Risk = 'low' | 'medium' | 'high';

export type TaskState =
  | 'NEW'
  | 'DESIGN'
  | 'IMPLEMENT'
  | 'VERIFY'
  | 'REVIEW'
  | 'FIX'
  | 'FINAL_ACCEPTANCE'
  | 'AWAITING_HUMAN'
  | 'READY_TO_MERGE'
  | 'MERGED'
  | 'READY_TO_DEPLOY'
  | 'DEPLOYED'
  | 'PAUSED'
  | 'PAUSED_RATE_LIMIT'
  | 'ESCALATED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_STATES: TaskState[] = ['DEPLOYED', 'ESCALATED', 'FAILED', 'CANCELLED'];
export const RESUMABLE_STATES: TaskState[] = [
  'NEW', 'DESIGN', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FIX', 'FINAL_ACCEPTANCE',
  'READY_TO_MERGE', 'MERGED', 'READY_TO_DEPLOY', 'PAUSED', 'PAUSED_RATE_LIMIT',
];

export type EventType =
  | 'TASK_CREATED'
  | 'STATE_CHANGED'
  | 'AGENT_STARTED'
  | 'AGENT_FINISHED'
  | 'AGENT_FAILED'
  | 'DESIGN_REVISION'
  | 'FINDING'
  | 'ADJUDICATION'
  | 'CODE_CHANGE'
  | 'TEST_RESULT'
  | 'DETERMINISTIC_CHECK'
  | 'POLICY_BLOCK'
  | 'EVIDENCE'
  | 'HUMAN_DECISION'
  | 'MERGE_RESULT'
  | 'DEPLOY_RESULT'
  | 'TASK_CANCELLED'
  | 'SETTING_CHANGED'
  | 'AUTOMATIC_DEPLOYMENT_HELD'
  | 'NOTE';

export interface V2Event {
  id: string;            // content hash, EV2-<16hex>
  taskId: string;
  seq: number;
  ts: string;
  type: EventType;
  /** Structured variation lives here, not in new event types. */
  agent?: 'claude' | 'codex' | 'claude-code' | 'system' | 'human';
  phase?: string;
  subPhase?: string;
  attempt?: number;
  payload: Record<string, unknown>;
}

export type FindingSeverity = 'CRITICAL' | 'IMPORTANT' | 'SUGGESTION';
export type FindingStatus =
  | 'FIX'
  | 'TEST_TO_DECIDE'
  | 'DEFER'
  | 'REJECT'
  | 'DETERMINISTICALLY_CONFIRMED'
  | 'DETERMINISTICALLY_REJECTED'
  | 'UNRESOLVED';

export interface Finding {
  findingId: string;
  severity: FindingSeverity;
  category: string;
  claim: string;
  file?: string;
  scenario?: string;
  confidence?: string;
  status: FindingStatus;
  decisionSource?: 'agent' | 'deterministic' | 'human' | 'policy';
  evidence?: string;
}

/**
 * Exactly one active design revision at any time. A review that changes the
 * design produces revision N+1 with the corrections applied IN PLACE; revision
 * N stays as history. Nothing ever appends amendments beside superseded text.
 */
export interface DesignRevision {
  revision: number;
  createdAt: string;
  author: 'claude';
  scopeAllowlist: string[];
  outOfScope?: string[];
  plan: string;
  invariants: string[];
  /** Each prediction may carry an executable check the acceptance layer runs. */
  predictions: Array<{ text: string; check?: string }>;
  requiredTests: string[];
  acceptance: string[];
  /** Finding ids applied into this revision (history, not pending work). */
  appliedFindings: string[];
}

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string;
  risk: Risk;
  state: TaskState;
  phase: string;
  subPhase: string;
  branch: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  worktree: string;
  legacy?: boolean;
  awaitingHuman?: HumanDecisionRequest | null;
  lastError?: string;
}

/** A human question that earns its interruption. */
export interface HumanDecisionRequest {
  decisionId: string;
  issue: string;
  whyAutomationStopped: string;
  evidence: string[];
  recommendedAction: string;
  whyRecommended: string;
  alternatives: string[];
  riskIfApproved: string;
  riskIfRejected: string;
  createdAt: string;
}

export interface AgentRunResult {
  ok: boolean;
  structured: Record<string, unknown> | null;
  text: string;
  exitCode: number | null;
  durationMs: number;
  rateLimited: boolean;
  failureKind?: 'AGENT_EXECUTION_ERROR' | 'ADAPTER_PARSE_ERROR' | 'AGENT_SCHEMA_ERROR' | 'RATE_LIMIT';
  providerStatus?: number;
  error?: string;
  attempts: number;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
  firstChunkMs?: number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
  data?: Record<string, unknown>;
}
