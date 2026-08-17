/**
 * Explicit state machine.
 *
 * Transitions are validated rather than assumed so a resumed run cannot skip a
 * gate: after a crash the state comes from the event log, and any step that
 * would jump the pipeline forward is rejected here instead of silently running.
 */
import { TaskState, TERMINAL_STATES } from './types';

const ALLOWED: Record<TaskState, TaskState[]> = {
  NEW: ['DESIGNING', 'CANCELLED', 'ESCALATED'],
  DESIGNING: ['DESIGN_REVIEW', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  DESIGN_REVIEW: ['DESIGN_ADJUDICATION', 'READY_TO_IMPLEMENT', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  DESIGN_ADJUDICATION: ['READY_TO_IMPLEMENT', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  READY_TO_IMPLEMENT: ['IMPLEMENTING', 'ESCALATED', 'FAILED'],
  IMPLEMENTING: ['TESTING', 'DESIGNING', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  TESTING: ['PRE_REVIEW_ACCEPTANCE', 'FIXING', 'ESCALATED', 'FAILED'],
  // RE_REVIEW is reachable here because a fix round re-tests before the
  // focused re-review: FIXING -> TESTING -> PRE_REVIEW_ACCEPTANCE -> RE_REVIEW.
  PRE_REVIEW_ACCEPTANCE: ['CODEX_REVIEW', 'RE_REVIEW', 'FIXING', 'ESCALATED', 'FAILED'],
  CODEX_REVIEW: ['ADJUDICATION', 'FINAL_ACCEPTANCE', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  ADJUDICATION: ['FIXING', 'FINAL_ACCEPTANCE', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  FIXING: ['TESTING', 'RE_REVIEW', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  RE_REVIEW: ['ADJUDICATION', 'FINAL_ACCEPTANCE', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  FINAL_ACCEPTANCE: ['READY_TO_MERGE', 'FIXING', 'PAUSED_RATE_LIMIT', 'ESCALATED', 'FAILED'],
  // A quota pause is recoverable from every agent-driven state, and always
  // returns to the state it paused from. It never becomes an API-billing path.
  PAUSED_RATE_LIMIT: [
    'DESIGNING', 'DESIGN_REVIEW', 'DESIGN_ADJUDICATION', 'IMPLEMENTING',
    'CODEX_REVIEW', 'ADJUDICATION', 'FIXING', 'RE_REVIEW', 'FINAL_ACCEPTANCE',
    'ESCALATED', 'CANCELLED',
  ],
  READY_TO_MERGE: ['MERGED', 'ESCALATED'],
  MERGED: [],
  ESCALATED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal state transition ${from} -> ${to}`);
  }
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Steps whose effects are already durable once their state is recorded. Resume
 * must not re-run these, or a restart would duplicate commits and reviews.
 */
export const WRITE_STEPS: TaskState[] = ['IMPLEMENTING', 'FIXING'];

export function shouldReplay(state: TaskState, completedStates: TaskState[]): boolean {
  if (WRITE_STEPS.includes(state) && completedStates.includes(state)) return false;
  return true;
}
