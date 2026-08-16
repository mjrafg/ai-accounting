/**
 * Autopilot V1 — shared types.
 *
 * The event log is the only authoritative store. Everything else (task state,
 * reports, metrics) is a pure function of the log and must be rebuildable.
 */

export type Risk = 'low' | 'medium' | 'high';

export type TaskState =
  | 'NEW'
  | 'DESIGNING'
  | 'DESIGN_REVIEW'
  | 'DESIGN_ADJUDICATION'
  | 'READY_TO_IMPLEMENT'
  | 'IMPLEMENTING'
  | 'TESTING'
  | 'PRE_REVIEW_ACCEPTANCE'
  | 'CODEX_REVIEW'
  | 'ADJUDICATION'
  | 'FIXING'
  | 'RE_REVIEW'
  | 'FINAL_ACCEPTANCE'
  | 'READY_TO_MERGE'
  | 'MERGED'
  | 'ESCALATED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_STATES: TaskState[] = [
  'READY_TO_MERGE',
  'MERGED',
  'ESCALATED',
  'FAILED',
  'CANCELLED',
];

export type EventType =
  | 'TASK_CREATED'
  | 'STATE_TRANSITION'
  | 'DESIGN_DECISION'
  | 'DESIGN_REVIEW'
  | 'IMPLEMENTATION'
  | 'FINDING'
  | 'ADJUDICATION'
  | 'FIX'
  | 'TEST_RESULT'
  | 'RUNTIME_EVIDENCE'
  | 'VERDICT'
  | 'DEFERRED'
  | 'ESCALATION'
  | 'READY_TO_MERGE'
  | 'MERGED'
  | 'BACKFILL_GAP'
  | 'EVIDENCE_CONFLICT'
  | 'POLICY_BLOCK';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type Actor =
  | 'orchestrator'
  | 'claude-advisor'
  | 'claude-code'
  | 'codex'
  | 'policy-engine'
  | 'test-runner'
  | 'acceptance-runner'
  | 'human'
  | 'backfill';

/**
 * One immutable record. Never edited in place: corrections are new events that
 * point at the record they supersede via `parents`.
 */
export interface AutopilotEvent {
  eventId: string;
  taskId: string;
  seq: number;
  ts: string;
  type: EventType;
  actor: Actor;
  /** IDs of the claims/findings/events this one answers or supersedes. */
  parents: string[];
  payload: Record<string, unknown>;
  /** True when the event was reconstructed from history rather than observed. */
  reconstructed?: boolean;
  reconstructionConfidence?: Confidence;
  /** Where a reconstructed event came from (commit sha, report name, ...). */
  source?: string;
  /**
   * True when the event was produced by a fixture/replay transport rather than
   * a real agent. Simulated evidence never satisfies reviewer independence.
   */
  simulated?: boolean;
}

export interface TaskRecord {
  taskId: string;
  title: string;
  risk: Risk;
  state: TaskState;
  branch: string;
  createdAt: string;
  updatedAt: string;
  reviewRounds: number;
  autoMerge: boolean;
  /** Files the task is allowed to touch; empty until the design is final. */
  allowlist: string[];
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Agent contracts
// ---------------------------------------------------------------------------

export interface AgentTask {
  taskId: string;
  role: 'design' | 'design-review' | 'adjudication' | 'implement' | 'review' | 're-review';
  /** Rendered prompt. Never contains raw secrets — callers sanitize first. */
  prompt: string;
  /** JSON shape the agent must return, embedded in the prompt. */
  schemaName: string;
  cwd: string;
  timeoutMs: number;
}

export interface AgentResult {
  ok: boolean;
  structured: Record<string, unknown> | null;
  rawArtifactPath: string;
  rawArtifactHash: string;
  durationMs: number;
  exitCode: number | null;
  /** Only populated when the provider actually reports it. Never invented. */
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  error?: string;
  simulated: boolean;
  provider: string;
}

export interface AgentAdapter {
  readonly name: string;
  readonly provider: string;
  available(): Promise<{ ok: boolean; reason?: string; mechanism?: string }>;
  run(input: AgentTask): Promise<AgentResult>;
}

// ---------------------------------------------------------------------------
// Design / review payloads
// ---------------------------------------------------------------------------

export interface Design {
  taskId: string;
  risk: Risk;
  scopeAllowlist: string[];
  outOfScope: string[];
  invariants: string[];
  falsifiablePredictions: string[];
  implementationConstraints: string[];
  requiredTests: string[];
  requiredRuntimeAcceptance: string[];
  knownUnverified: string[];
}

export type Severity = 'BLOCKER' | 'MAJOR' | 'MINOR' | 'NIT';

export interface Finding {
  findingId: string;
  severity: Severity;
  category: string;
  file: string;
  claim: string;
  scenario: string;
  violatedInvariant: string;
  confidence: Confidence;
  evidenceAvailable: string;
}

export type Adjudication = 'CONFIRMED' | 'PARTIAL' | 'REJECTED';

export interface AdjudicationResult {
  findingId: string;
  verdict: Adjudication;
  reasoning: string;
  requiredFix: string | null;
  requiredEvidence: string | null;
}

export interface TestOutcome {
  name: string;
  command: string;
  exitCode: number | null;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Baseline comparator classifications, when the command reports them. */
  classifications?: Record<string, number>;
  stdoutHash: string;
  rawPath: string;
  ok: boolean;
  blockedReason?: string;
}
