/**
 * V2 policy: SAFE + CORRECT + FINISHED — not "every agent must agree".
 *
 * Three effective finding levels. Consensus is not a gate; deterministic
 * evidence outranks agent opinion; the human is interrupted only for the
 * enumerated CRITICAL triggers, with a decision package worth reading.
 */
import { Finding, FindingSeverity, Risk, HumanDecisionRequest } from './types';
import * as crypto from 'crypto';

export const PROTECTED_PATHS = [
  'packages/server/src/database/',           // migrations: schema changes are their own task
  'packages/server/test/e2e-baseline.json',  // the Stage -1 baseline is never rewritten by a task
  '.github/', '.gitignore', 'package.json', 'pnpm-lock.yaml',
  'tools/autopilot', 'tools/control-center', // the control plane may not modify itself via a task
];
export const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.github\//, /^\.gitignore$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)package-lock\.json$/,
  /(^|\/)migrations?\//, /(^|\/)Dockerfile/, /(^|\/)docker-compose/,
];

export interface PolicyViolation { rule: string; detail: string; }

export function checkScope(changed: string[], allowlist: string[]): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  if (!allowlist.length && changed.length) {
    return [{ rule: 'SCOPE_ALLOWLIST_EMPTY', detail: `${changed.length} file(s) changed with no allowlist` }];
  }
  for (const f of changed) {
    const ok = allowlist.some((a) => f === a || f.startsWith(a.replace(/\/*$/, '/')) ||
      (a.endsWith('/**') && f.startsWith(a.slice(0, -3))));
    if (!ok) out.push({ rule: 'OUT_OF_ALLOWLIST', detail: f });
  }
  return out;
}

export function checkProtectedPaths(changed: string[]): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const f of changed) {
    for (const p of PROTECTED_PATHS) {
      if (f === p || f.startsWith(p)) out.push({ rule: 'PROTECTED_PATH', detail: `${f} (${p})` });
    }
    for (const re of FORBIDDEN_PATH_PATTERNS) {
      if (re.test(f)) out.push({ rule: 'PROTECTED_PATH', detail: `${f} matches ${re}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review budgets — bounded by design, not by agent patience
// ---------------------------------------------------------------------------

export interface ReviewBudget {
  designReview: boolean;
  implementationReviews: number;
  /** Fix/re-review cycles on MATERIAL disagreement. */
  materialCycles: number;
}

export function budgetFor(risk: Risk): ReviewBudget {
  switch (risk) {
    case 'low': return { designReview: false, implementationReviews: 1, materialCycles: 0 };
    case 'medium': return { designReview: false, implementationReviews: 1, materialCycles: 1 };
    case 'high': return { designReview: true, implementationReviews: 1, materialCycles: 2 };
  }
}

/** CRITICAL blocks. IMPORTANT is normally fixed within budget. SUGGESTION never blocks. */
export function materialFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) =>
    (f.severity === 'CRITICAL' || f.severity === 'IMPORTANT') &&
    !['REJECT', 'DEFER', 'DETERMINISTICALLY_REJECTED'].includes(f.status));
}
export function unresolvedCritical(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'CRITICAL' &&
    !['REJECT', 'DETERMINISTICALLY_REJECTED', 'DEFER'].includes(f.status) &&
    f.status !== 'FIX' /* FIX means resolved-by-fix once fix cycle completes */ &&
    f.status !== 'DETERMINISTICALLY_CONFIRMED');
}

/**
 * Blocker progress rule: if the unresolved MATERIAL count fails to decrease for
 * two consecutive cycles, automatic debate stops — CRITICAL goes to the human,
 * anything else continues on the best supported implementation.
 */
export function blockerProgressStalled(history: number[]): boolean {
  if (history.length < 3) return false;
  const [a, b, c] = history.slice(-3);
  return c >= b && b >= a;
}

/** A blocking finding must state concrete impact; theory alone cannot block. */
export function findingMayBlock(f: Finding): boolean {
  if (f.severity !== 'CRITICAL') return false;
  return Boolean(f.claim && f.scenario && f.scenario.length > 20);
}

// ---------------------------------------------------------------------------
// Human decision triggers — the ONLY reasons to interrupt the owner
// ---------------------------------------------------------------------------

export type HumanTrigger =
  | 'ACCOUNTING_POLICY_CHANGE'
  | 'REBASELINE'
  | 'IRREVERSIBLE_DATA_CHANGE'
  | 'CONFLICTING_RUNTIME_EVIDENCE'
  | 'UNRESOLVED_CRITICAL_DISPUTE'
  | 'TRUST_BOUNDARY_EXPANSION'
  | 'HISTORY_REWRITE'
  | 'NON_ROLLBACKABLE_PROD_OP';

export function decisionRequest(trigger: HumanTrigger, detail: {
  issue: string; why: string; evidence: string[]; recommended: string;
  whyRecommended: string; alternatives: string[]; riskApproved: string; riskRejected: string;
}): HumanDecisionRequest {
  return {
    decisionId: `HD-${crypto.randomBytes(6).toString('hex')}`,
    issue: `[${trigger}] ${detail.issue}`,
    whyAutomationStopped: detail.why,
    evidence: detail.evidence,
    recommendedAction: detail.recommended,
    whyRecommended: detail.whyRecommended,
    alternatives: detail.alternatives,
    riskIfApproved: detail.riskApproved,
    riskIfRejected: detail.riskRejected,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Auto-merge / auto-deploy — risk raises the evidence bar, not the human bar
// ---------------------------------------------------------------------------

export interface GateSummary {
  deterministicOk: boolean;     // required checks passed
  testsOk: boolean;
  criticalOpen: number;         // unresolved CRITICAL findings
  evidenceConflict: boolean;
  backupVerified: boolean;
  rollbackShaExists: boolean;
  protectedTriggerHit: boolean; // any HumanTrigger condition raised
}

export function autoMergeAllowed(risk: Risk, g: GateSummary): { allowed: boolean; reason: string } {
  if (g.criticalOpen > 0) return { allowed: false, reason: `${g.criticalOpen} unresolved CRITICAL finding(s)` };
  if (!g.deterministicOk || !g.testsOk) return { allowed: false, reason: 'required gates not green' };
  if (g.evidenceConflict) return { allowed: false, reason: 'evidence conflict unresolved' };
  if (g.protectedTriggerHit) return { allowed: false, reason: 'critical human trigger raised' };
  return { allowed: true, reason: `${risk} auto-merge permitted: gates green, no critical findings` };
}

export function autoDeployAllowed(risk: Risk, g: GateSummary): { allowed: boolean; reason: string } {
  const merge = autoMergeAllowed(risk, g);
  if (!merge.allowed) return merge;
  if (!g.backupVerified) return { allowed: false, reason: 'no verified pre-deploy backup' };
  if (!g.rollbackShaExists) return { allowed: false, reason: 'no rollback SHA recorded' };
  return { allowed: true, reason: `${risk} auto-deploy permitted: backup + rollback + gates` };
}

/**
 * Merge SHA safety: never merge a commit other than the one that was reviewed
 * (and, for human approvals, the one the browser displayed).
 */
export function mergeShaSafe(approvedSha: string, reviewedSha: string, branchHead: string): boolean {
  return Boolean(approvedSha) && approvedSha === reviewedSha && approvedSha === branchHead;
}

// ---------------------------------------------------------------------------
// Scope expansion
// ---------------------------------------------------------------------------

export function scopeExpansionDecision(risk: Risk, requestedPaths: string[], reason: string):
  { allow: boolean; needsHuman: boolean; detail: string } {
  const protectedHit = checkProtectedPaths(requestedPaths);
  if (protectedHit.length) {
    return { allow: false, needsHuman: risk === 'high',
      detail: `protected paths requested: ${protectedHit.map((v) => v.detail).join(', ')}` };
  }
  if (!reason || reason.length < 20) {
    return { allow: false, needsHuman: false, detail: 'expansion reason not concrete enough' };
  }
  return { allow: true, needsHuman: false, detail: `expanded by ${requestedPaths.length} path(s): ${reason.slice(0, 160)}` };
}
