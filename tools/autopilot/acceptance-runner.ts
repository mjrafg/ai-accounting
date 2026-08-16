/**
 * Acceptance gates.
 *
 * Two tiers: a cheap pre-review gate that catches obvious breakage before
 * spending a reviewer cycle, and the authoritative final gate.
 *
 * The evidence hierarchy is enforced here rather than left to prose: runtime
 * and database evidence outrank agent agreement, and two runtime results that
 * disagree produce EVIDENCE_CONFLICT instead of a winner being picked.
 */
import { TestOutcome, Risk } from './types';
import { PolicyEngine, PolicyViolation } from './policy-engine';
import { SUITES, TestRunner } from './test-runner';

export type EvidenceRank =
  | 'RUNTIME_DB'
  | 'FAIL_BEFORE_PASS_AFTER'
  | 'DETERMINISTIC_TEST'
  | 'GATES_GREEN'
  | 'ADJUDICATION'
  | 'MODEL_OPINION';

export const EVIDENCE_ORDER: EvidenceRank[] = [
  'RUNTIME_DB',
  'FAIL_BEFORE_PASS_AFTER',
  'DETERMINISTIC_TEST',
  'GATES_GREEN',
  'ADJUDICATION',
  'MODEL_OPINION',
];

export function outranks(a: EvidenceRank, b: EvidenceRank): boolean {
  return EVIDENCE_ORDER.indexOf(a) < EVIDENCE_ORDER.indexOf(b);
}

export interface AcceptanceResult {
  ok: boolean;
  tier: 'pre-review' | 'final';
  outcomes: TestOutcome[];
  violations: PolicyViolation[];
  verified: string[];
  notVerified: string[];
  evidenceConflict?: { detail: string };
}

/** Claims a gate can honestly support, and the ones it deliberately cannot. */
function classifyCoverage(outcomes: TestOutcome[], risk: Risk, tier: 'pre-review' | 'final') {
  const verified: string[] = [];
  const notVerified: string[] = [];

  const has = (n: string) => outcomes.find((o) => o.name === n && o.ok);

  if (has('typecheck')) verified.push('TypeScript compiles with no errors');
  else notVerified.push('TypeScript compilation (gate did not pass or did not run)');

  const s0 = has('stage0');
  if (s0) {
    verified.push(`Stage 0 fail-closed suite (${s0.passed} passed, ${s0.skipped} skipped)`);
  } else {
    notVerified.push('Stage 0 fail-closed suite');
  }

  const bl = has('stage-minus-1-baseline');
  if (bl) {
    verified.push('Stage -1 canonical baseline unchanged (0 regressions, 0 review-required)');
  } else if (tier === 'final') {
    notVerified.push('Stage -1 canonical baseline comparison');
  }

  // Standing limits of the harness itself, always reported.
  notVerified.push('numeric tax / FX / rounding correctness');
  notVerified.push('historical production data migration');
  notVerified.push('asynchronous COGS worker behaviour under queue failure');
  notVerified.push('multi-tenant concurrency beyond the single disposable tenant');
  if (risk === 'high') {
    notVerified.push('production-scale performance characteristics');
  }
  return { verified, notVerified };
}

export class AcceptanceRunner {
  constructor(
    private readonly taskId: string,
    private readonly policy: PolicyEngine,
    private readonly runner = new TestRunner(taskId),
  ) {}

  private gate(
    tier: 'pre-review' | 'final',
    specs: ReturnType<typeof SUITES.typecheck>[],
    risk: Risk,
    prior?: TestOutcome[],
  ): AcceptanceResult {
    const outcomes: TestOutcome[] = [];
    const violations: PolicyViolation[] = [];

    for (const spec of specs) {
      const outcome = this.runner.run(spec);
      const baseline = prior?.find((p) => p.name === outcome.name);
      const v = this.policy.checkTestOutcome(outcome, baseline);
      if (v.length) {
        outcome.ok = false;
        outcome.blockedReason = v.map((x) => `${x.rule}: ${x.detail}`).join('; ');
      }
      violations.push(...v);
      outcomes.push(outcome);
    }

    const { verified, notVerified } = classifyCoverage(outcomes, risk, tier);
    return {
      ok: outcomes.every((o) => o.ok) && violations.length === 0,
      tier,
      outcomes,
      violations,
      verified,
      notVerified,
    };
  }

  /** Cheap: typecheck plus the targeted deterministic suite. */
  preReview(risk: Risk, prior?: TestOutcome[]): AcceptanceResult {
    return this.gate('pre-review', [SUITES.typecheck(), SUITES.stage0()], risk, prior);
  }

  /**
   * Authoritative: adds the canonical baseline comparator and a second
   * deterministic Stage 0 run. A suite that does not reproduce itself is
   * nondeterministic, which is an EVIDENCE_CONFLICT rather than a pass.
   */
  final(risk: Risk, prior?: TestOutcome[]): AcceptanceResult {
    const res = this.gate(
      'final',
      [SUITES.typecheck(), SUITES.stage0(), SUITES.baseline()],
      risk,
      prior,
    );

    const first = res.outcomes.find((o) => o.name === 'stage0');
    if (first) {
      const second = this.runner.run(SUITES.stage0());
      second.name = 'stage0-rerun';
      res.outcomes.push(second);
      const same =
        second.passed === first.passed &&
        second.failed === first.failed &&
        second.skipped === first.skipped &&
        second.total === first.total;
      if (!same) {
        res.ok = false;
        res.evidenceConflict = {
          detail:
            `Stage 0 did not reproduce: run A ${first.passed}/${first.failed}/${first.skipped}, ` +
            `run B ${second.passed}/${second.failed}/${second.skipped}`,
        };
      } else {
        res.verified.push('Stage 0 reproduced identically across two consecutive runs');
      }
    }
    return res;
  }
}
