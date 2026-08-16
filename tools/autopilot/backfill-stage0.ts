/**
 * Stage 0 backfill.
 *
 * Reconstructs the approved Stage 0 work as the observatory's first dataset.
 * Every event carries `reconstructed: true`, a confidence, and the artefact it
 * was derived from. Where evidence does not exist -- notably the verbatim Codex
 * review text, which was relayed through the human and never captured -- a
 * BACKFILL_GAP is recorded instead of a plausible-looking reconstruction.
 *
 * Confidence means:
 *   HIGH   - derived directly from a durable artefact (a commit, a test run).
 *   MEDIUM - derived from a report written at the time by a known actor.
 *   LOW    - inferred from surrounding evidence; the detail may be wrong.
 */
import { EventStore } from './storage/event-store';
import { TaskStore } from './storage/task-store';
import { GitManager } from './git-manager';

export const STAGE0_TASK_ID = 'TASK-0000';

/** Commit subjects that made up the approved Stage 0 change set, in order. */
const STAGE0_COMMIT_SUBJECTS = [
  'fix(test): resolve E2E EventEmitter bootstrap failure',
  'test: add isolated deterministic E2E runner',
  'chore(dev): align local MariaDB with CI 10.6',
  'test: record Stage -1 E2E baseline',
  'fix(ledger): propagate storage failures instead of swallowing them',
  'fix(accounting): fail closed on GL failures for manual journals and inventory adjustments',
  'fix(tenancy): use managed Knex transactions so commit failures reach the caller',
  'fix(accounting): fail closed on the remaining atomic financial subscribers',
  'fix(accounting): propagate remaining atomic financial subscriber failures',
  'fix(accounting): keep financial reversals and rewrites inside owning transaction',
  'test(accounting): cover remaining Stage 0 fail-closed paths',
  'fix(accounting): close remaining synchronous subscriber propagation gaps',
  'fix(accounting): keep payment-received receivable creation inside transaction',
  'test(accounting): strengthen final Stage 0 atomicity coverage',
  'test(accounting): close the three remaining Stage 0 evidence gaps',
];

export interface BackfillResult {
  taskId: string;
  eventsWritten: number;
  gaps: number;
  commitsMatched: number;
  commitsMissing: string[];
}

export function backfillStage0(
  events: EventStore,
  tasks: TaskStore,
  git: GitManager,
  baseRef = 'develop',
): BackfillResult {
  const taskId = STAGE0_TASK_ID;
  if (tasks.exists(taskId)) {
    throw new Error(
      `${taskId} already backfilled. The log is append-only; delete .ai/tasks/${taskId} deliberately to redo it.`,
    );
  }

  const commits = git.commitsBetween(baseRef).reverse();
  const bySubject = new Map(commits.map((c) => [c.subject, c.sha]));
  const commitsMissing: string[] = [];
  let gaps = 0;

  // Fixed timestamps: the backfill describes history, so it must not stamp the
  // rebuild time into the log or reports stop being reproducible.
  const T = (n: number) => new Date(Date.UTC(2026, 7, 16, 0, 0, n)).toISOString();
  let clock = 0;
  const at = () => T(clock++);

  events.append({
    taskId,
    type: 'TASK_CREATED',
    actor: 'human',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'user instructions in the Stage 0 session',
    payload: {
      title: 'Stage 0 — make accounting write failures fail closed',
      risk: 'high',
      branch: 'fix/stage0-ledger-failure-propagation',
      autoMerge: false,
      allowlist: [],
      baseRef,
    },
  });

  events.append({
    taskId,
    type: 'DESIGN_DECISION',
    actor: 'claude-advisor',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'MEDIUM',
    source: 'Stage 0 design brief and the locked design decisions accepted by the user',
    payload: {
      final: true,
      note: 'Reconstructed from the agreed Stage 0 scope, not from a captured design artefact',
      design: {
        taskId,
        risk: 'high',
        scopeAllowlist: [
          'packages/server/src/modules/Ledger',
          'packages/server/src/modules/Tenancy/TenancyDB',
          'packages/server/src/modules/SaleInvoices',
          'packages/server/src/modules/CreditNotes',
          'packages/server/src/modules/VendorCredit',
          'packages/server/src/modules/PaymentReceived',
          'packages/server/src/modules/BillLandedCosts',
          'packages/server/test',
        ],
        outOfScope: [
          'tax correctness',
          'FX / exchange rate correctness',
          'document totals',
          'overapplication rules',
          'period locking',
          'READ_UNCOMMITTED isolation',
          'assertBalanced()',
          'retries / backoff',
          'async COGS worker',
          'pre-COMMIT enqueue',
          'EE/ee packaging',
          'SMTP and invites',
          'NaN route params',
        ],
        invariants: [
          'a failed accounting write must not report success',
          'GL, inventory and balance writes participate in the owning transaction',
          'a rolled-back document leaves no correlated financial rows behind',
        ],
        falsifiablePredictions: [
          'injecting a ledger storage failure produces HTTP >= 400 and zero persisted rows',
          'killing the connection before COMMIT rejects instead of resolving',
          'the after-transaction hook does not run when the transaction fails',
        ],
        implementationConstraints: [
          'suppressErrors:false only on the semantic Bucket A boundary',
          'managed Knex transactions; no separate rollback(error) implementation',
          'no retries or backoff',
          'do not annotate FinancialAuditLog',
        ],
        requiredTests: [
          'fault-injection specs for each fail-closed boundary',
          'UnitOfWork lifecycle specs including commit-death',
        ],
        requiredRuntimeAcceptance: [
          'Stage 0 suite green',
          'Stage -1 canonical baseline unchanged',
          'general_log thread evidence for the A/R transaction boundary',
        ],
        knownUnverified: [
          'numeric tax correctness',
          'async COGS worker',
          'credit-note edit inventory rewrite (handler proven unreachable)',
        ],
      },
    },
  });

  // -- Codex design review: not recoverable --------------------------------
  events.append({
    taskId,
    type: 'BACKFILL_GAP',
    actor: 'backfill',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'absence of any stored Codex transcript',
    payload: {
      what: 'Codex design-review transcript',
      why:
        'Stage 0 predates the observatory. Codex reviews were relayed by the human as prose and the ' +
        'verbatim reviewer output was never captured, so it cannot be reconstructed without inventing it.',
    },
  });
  gaps += 1;

  // -- implementation commits ---------------------------------------------
  let matched = 0;
  for (const subject of STAGE0_COMMIT_SUBJECTS) {
    const sha = bySubject.get(subject);
    if (!sha) {
      commitsMissing.push(subject);
      continue;
    }
    matched += 1;
    events.append({
      taskId,
      type: 'IMPLEMENTATION',
      actor: 'claude-code',
      ts: at(),
      reconstructed: true,
      reconstructionConfidence: 'HIGH',
      source: `git commit ${sha}`,
      payload: { status: 'IMPLEMENTED', commit: sha, subject, filesChanged: [] },
    });
  }

  // -- the Codex blocker chain that is recoverable from commit messages -----
  const blockerChain: Array<[string, string, string, string]> = [
    [
      'CDX-S0-01',
      'ledger storage failures were swallowed by async.queue drain',
      'CONFIRMED',
      'fix(ledger): propagate storage failures instead of swallowing them',
    ],
    [
      'CDX-S0-02',
      'UnitOfWork manual transaction resolved even when COMMIT failed',
      'CONFIRMED',
      'fix(tenancy): use managed Knex transactions so commit failures reach the caller',
    ],
    [
      'CDX-S0-03',
      'financial reversals and rewrites ran outside the owning transaction',
      'CONFIRMED',
      'fix(accounting): keep financial reversals and rewrites inside owning transaction',
    ],
    [
      'CDX-S0-04',
      'payment-received receivable creation committed independently of the payment',
      'CONFIRMED',
      'fix(accounting): keep payment-received receivable creation inside transaction',
    ],
  ];
  for (const [findingId, claim, verdict, fixSubject] of blockerChain) {
    events.append({
      taskId,
      type: 'FINDING',
      actor: 'codex',
      ts: at(),
      reconstructed: true,
      reconstructionConfidence: 'MEDIUM',
      source: 'Codex blocker list relayed by the human; wording is a summary, not verbatim',
      payload: {
        roundStart: true,
        round: 1,
        findings: [
          {
            findingId,
            severity: 'BLOCKER',
            category: 'transaction-boundary',
            file: 'packages/server/src',
            claim,
            scenario: 'see the corresponding fault-injection spec in packages/server/test',
            violatedInvariant: 'a failed accounting write must not report success',
            confidence: 'MEDIUM',
            evidenceAvailable: 'fix commit and fault-injection test',
          },
        ],
      },
    });
    events.append({
      taskId,
      type: 'ADJUDICATION',
      actor: 'claude-advisor',
      ts: at(),
      parents: [findingId],
      reconstructed: true,
      reconstructionConfidence: 'MEDIUM',
      source: 'Stage 0 adjudication reports',
      payload: {
        findingId,
        verdict,
        reasoning: 'accepted during Stage 0 and fixed in the referenced commit',
        requiredFix: fixSubject,
        requiredEvidence: 'deterministic fault-injection test',
      },
    });
    const sha = bySubject.get(fixSubject);
    events.append({
      taskId,
      type: 'FIX',
      actor: 'claude-code',
      ts: at(),
      parents: [findingId],
      reconstructed: true,
      reconstructionConfidence: sha ? 'HIGH' : 'LOW',
      source: sha ? `git commit ${sha}` : 'commit not found on this branch',
      payload: { round: 1, status: sha ? 'IMPLEMENTED' : 'UNKNOWN', commit: sha ?? null, subject: fixSubject },
    });
  }

  // -- runtime evidence actually observed ----------------------------------
  events.append({
    taskId,
    type: 'RUNTIME_EVIDENCE',
    actor: 'acceptance-runner',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'mysql.general_log trace captured by stage0-payment-ar-thread.stage0-spec.ts',
    payload: {
      tier: 'final',
      ok: true,
      verified: [
        'A/R account INSERT and ROLLBACK observed on a single MariaDB thread: BEGIN -> PAYMENT_INSERT -> PAYMENT_ENTRIES_INSERT -> AR_ACCOUNT_LOOKUP -> AR_ACCOUNT_INSERT -> ROLLBACK, no COMMIT',
        'post-rollback database state: 0 payments, 0 A/R accounts, 0 ledger rows, invoice payment amount 0',
        'Stage 0 suite: 29 passed, 0 failed, 0 skipped',
        'Stage -1 canonical baseline: 55 clean, 0 regressions, 0 review-required',
      ],
      notVerified: [
        'numeric tax / FX / rounding correctness',
        'historical production data',
        'asynchronous COGS worker behaviour',
        'credit-note edit inventory rewrite (handler proven unreachable, not fixed)',
      ],
    },
  });

  events.append({
    taskId,
    type: 'DEFERRED',
    actor: 'claude-advisor',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'Stage 0 final report',
    payload: {
      what: 'credit-note edit inventory rewrite',
      why:
        'the onEdited handler is invoked but always short-circuits on !isOpen because the edit payload ' +
        'omits openedAt and the usage columns (upstream 76fc32078). Fixing it changes edit semantics, ' +
        'which is Stage 1 work.',
    },
  });

  // Codex's own miss rate cannot be computed: there is no record of findings it
  // did not raise, so claiming precision from this dataset would be fabrication.
  events.append({
    taskId,
    type: 'BACKFILL_GAP',
    actor: 'backfill',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'structural limitation of the dataset',
    payload: {
      what: 'reviewer miss rate / finding precision denominators',
      why:
        'only findings that were raised are recoverable. Issues nobody raised leave no trace, so precision ' +
        'and recall cannot be computed from Stage 0.',
    },
  });
  gaps += 1;

  events.append({
    taskId,
    type: 'VERDICT',
    actor: 'human',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'user approval at the end of Stage 0',
    payload: { verdict: 'ACCEPTED', note: 'approved as the Stage 0 baseline; not merged' },
  });

  events.append({
    taskId,
    type: 'READY_TO_MERGE',
    actor: 'orchestrator',
    ts: at(),
    reconstructed: true,
    reconstructionConfidence: 'HIGH',
    source: 'Stage 0 final state: committed, not pushed, not merged',
    payload: {
      branch: 'fix/stage0-ledger-failure-propagation',
      head: commits.length ? commits[commits.length - 1].sha : 'unknown',
      autoMerge: false,
      reason: 'HIGH-risk accounting task: auto-merge disabled',
    },
  });

  const rec = tasks.deriveTask(taskId)!;
  tasks.writeCache(rec);

  return {
    taskId,
    eventsWritten: events.read(taskId).length,
    gaps,
    commitsMatched: matched,
    commitsMissing,
  };
}
