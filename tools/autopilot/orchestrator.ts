/**
 * The autonomous pipeline.
 *
 * Design intent: the orchestrator never asks a human anything. Every branch
 * either advances the task or ends it in a recorded terminal state. The two
 * rules it will not bend, because they are the ones that make unattended
 * operation safe at all:
 *
 *   - A Codex finding is never piped straight into the builder. It always goes
 *     through Claude adjudication first, so an unverified claim cannot rewrite
 *     accounting code on its own.
 *   - A HIGH-risk accounting task stops at READY_TO_MERGE. Nothing here merges.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AdjudicationResult,
  AgentAdapter,
  AgentResult,
  Design,
  Finding,
  Risk,
  TaskRecord,
  TaskState,
  TestOutcome,
} from './types';
import { EventStore } from './storage/event-store';
import { TaskStore } from './storage/task-store';
import { PolicyEngine } from './policy-engine';
import { GitManager } from './git-manager';
import { AcceptanceRunner } from './acceptance-runner';
import { assertTransition, isTerminal } from './state-machine';
import { ClaudeAdvisorAdapter } from './agents/claude-advisor';
import { ClaudeCodeAdapter } from './agents/claude-code';
import { CodexAdapter, reviewerIsIndependent } from './agents/codex';
import { bannedKeysPresent, BILLING_MODE } from './agents/transport';

export interface OrchestratorDeps {
  repoRoot: string;
  events: EventStore;
  tasks: TaskStore;
  policy: PolicyEngine;
  git: GitManager;
  advisor: AgentAdapter;
  builder: AgentAdapter;
  reviewer: AgentAdapter;
  /** Injectable so self-tests can exercise the pipeline without running suites. */
  acceptanceFactory?: (taskId: string, policy: PolicyEngine) => AcceptanceRunner;
  log?: (msg: string) => void;
}

export function defaultDeps(repoRoot: string, policy: PolicyEngine): OrchestratorDeps {
  const events = new EventStore();
  return {
    repoRoot,
    events,
    tasks: new TaskStore(events),
    policy,
    git: new GitManager(repoRoot, policy),
    advisor: new ClaudeAdvisorAdapter(repoRoot),
    builder: new ClaudeCodeAdapter(repoRoot),
    reviewer: new CodexAdapter(repoRoot),
  };
}

// ---------------------------------------------------------------------------
// Prompt contracts
// ---------------------------------------------------------------------------

function roleDoc(repoRoot: string, name: string): string {
  const p = path.join(repoRoot, '.ai', 'roles', `${name}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function designPrompt(repoRoot: string, task: TaskRecord): string {
  return `${roleDoc(repoRoot, 'claude-advisor')}

TASK ${task.taskId} (risk=${task.risk})
${task.description || task.title}

Return ONLY a JSON object with keys:
taskId, risk, scopeAllowlist, outOfScope, invariants, falsifiablePredictions,
implementationConstraints, requiredTests, requiredRuntimeAcceptance, knownUnverified.
Do not write or modify any production code in this phase.`;
}

function designReviewPrompt(repoRoot: string, task: TaskRecord, design: Design): string {
  return `${roleDoc(repoRoot, 'codex-reviewer')}

Independently review this DESIGN before any code is written.
TASK ${task.taskId} (risk=${task.risk}): ${task.description || task.title}

DESIGN:
${JSON.stringify(design, null, 2)}

Review assumptions, transaction/accounting risk, missing invariants, missing
tests, scope, unsafe recommendations, and falsifiability.

Return ONLY JSON: { "verdict": "APPROVE" | "BLOCKERS", "findings": [ {
"findingId", "severity", "category", "file", "claim", "scenario",
"violatedInvariant", "confidence", "evidenceAvailable" } ] }`;
}

function adjudicationPrompt(repoRoot: string, task: TaskRecord, findings: Finding[], design: Design | null): string {
  return `${roleDoc(repoRoot, 'claude-advisor')}

Adjudicate these independent review findings for TASK ${task.taskId}.
${design ? `\nFINAL DESIGN:\n${JSON.stringify(design, null, 2)}\n` : ''}
FINDINGS:
${JSON.stringify(findings, null, 2)}

For each finding decide CONFIRMED, PARTIAL or REJECTED with reasoning, the
required fix (or null) and the evidence that would prove the fix.

Return ONLY JSON: { "adjudications": [ { "findingId", "verdict", "reasoning",
"requiredFix", "requiredEvidence" } ] }`;
}

function implementPrompt(repoRoot: string, task: TaskRecord, design: Design, fixes?: AdjudicationResult[]): string {
  return `${roleDoc(repoRoot, 'claude-code-builder')}

TASK ${task.taskId} (risk=${task.risk}): ${task.description || task.title}
BRANCH: ${task.branch}

FINALIZED DESIGN (authoritative — do not renegotiate it):
${JSON.stringify(design, null, 2)}
${fixes ? `\nCONFIRMED FIXES TO APPLY:\n${JSON.stringify(fixes, null, 2)}\n` : ''}
You may only modify files inside scopeAllowlist. If the work genuinely cannot be
done inside that list, do not expand it: return status SCOPE_EXPANSION_REQUIRED
with the paths and the reason.

Return ONLY JSON: { "status": "IMPLEMENTED" | "SCOPE_EXPANSION_REQUIRED" |
"FAILED", "filesChanged": [], "testsAdded": [], "commits": [],
"requestedPaths": [], "reason": "" }`;
}

function reviewPrompt(repoRoot: string, task: TaskRecord, diff: string, design: Design): string {
  return `${roleDoc(repoRoot, 'codex-reviewer')}

Independently review this IMPLEMENTATION for TASK ${task.taskId}.
You may not edit production code — report findings only.

FINALIZED DESIGN:
${JSON.stringify(design, null, 2)}

DIFF:
${diff.slice(0, 400000)}

Return ONLY JSON: { "findings": [ { "findingId", "severity", "category",
"file", "claim", "scenario", "violatedInvariant", "confidence",
"evidenceAvailable" } ] }`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly log: (m: string) => void;

  constructor(private readonly d: OrchestratorDeps) {
    this.log = d.log ?? ((m) => process.stdout.write(m + '\n'));
  }

  private transition(taskId: string, from: TaskState, to: TaskState): void {
    assertTransition(from, to);
    this.d.events.append({
      taskId,
      type: 'STATE_TRANSITION',
      actor: 'orchestrator',
      payload: { from, to },
    });
    this.log(`  ${from} -> ${to}`);
  }

  private escalate(taskId: string, reason: string, detail: Record<string, unknown> = {}): 'ESCALATED' {
    this.d.events.append({
      taskId,
      type: 'ESCALATION',
      actor: 'orchestrator',
      payload: { reason, ...detail },
    });
    this.log(`  ESCALATED: ${reason}`);
    const rec = this.d.tasks.deriveTask(taskId);
    if (rec) this.d.tasks.writeCache(rec);
    return 'ESCALATED';
  }

  /**
   * Quota exhaustion is a pause, not a failure and never a billing decision.
   * The state is persisted so a later `resume` picks the task up unchanged.
   */
  private pauseForRateLimit(taskId: string, from: TaskState, provider: string): 'PAUSED_RATE_LIMIT' {
    this.d.events.append({
      taskId,
      type: 'PAUSED_RATE_LIMIT',
      actor: 'orchestrator',
      payload: {
        provider,
        pausedFrom: from,
        billingMode: BILLING_MODE,
        note: 'subscription quota reached; will retry later. Paid API fallback is disabled.',
      },
    });
    this.transition(taskId, from, 'PAUSED_RATE_LIMIT');
    const rec = this.d.tasks.deriveTask(taskId);
    if (rec) this.d.tasks.writeCache(rec);
    this.log('  PAUSED_RATE_LIMIT (subscription quota; no API fallback)');
    return 'PAUSED_RATE_LIMIT';
  }

  createTask(title: string, risk: Risk, description = ''): TaskRecord {
    const taskId = this.d.tasks.nextTaskId();
    const branch = `ai/${taskId.toLowerCase()}`;
    this.d.events.append({
      taskId,
      type: 'TASK_CREATED',
      actor: 'human',
      payload: {
        title,
        // Full operator brief, preserved verbatim including line breaks. The
        // title is only a label; agents are given the description.
        description: description || title,
        risk,
        branch,
        // V1 never auto-merges; HIGH risk additionally stops at READY_TO_MERGE.
        autoMerge: this.d.policy.autoMergeAllowed(risk),
        allowlist: [],
        baseRef: this.d.git.head(),
      },
    });
    const rec = this.d.tasks.deriveTask(taskId)!;
    this.d.tasks.writeCache(rec);
    return rec;
  }

  /**
   * Operator-authorised retry of an escalated task, from the design phase.
   *
   * Used when the escalation cause was operational rather than a judgement the
   * pipeline made — an expired token, a since-fixed adapter bug. The original
   * task, brief and history are kept; the authorisation is recorded before
   * anything re-runs, and every gate runs again from DESIGNING.
   */
  authorizeRetry(taskId: string, owner: string, reason: string): TaskRecord | null {
    const rec = this.d.tasks.deriveTask(taskId);
    if (!rec) return null;
    if (rec.state !== 'ESCALATED') {
      throw new Error(`task ${taskId} is ${rec.state}, not ESCALATED; nothing to retry`);
    }
    const priorEscalations = this.d.tasks
      .byType(taskId, 'ESCALATION')
      .map((e) => String((e.payload as any).reason));
    this.d.events.append({
      taskId,
      type: 'RETRY_AUTHORIZED',
      actor: 'human',
      payload: {
        authorizedBy: owner,
        reason,
        retryingFrom: 'ESCALATED',
        reenteringAt: 'DESIGNING',
        priorEscalations,
      },
    });
    this.transition(taskId, 'ESCALATED', 'DESIGNING');
    const updated = this.d.tasks.deriveTask(taskId)!;
    this.d.tasks.writeCache(updated);
    return updated;
  }

  /** Runs the task to a terminal state. Safe to call again after a crash. */
  async run(taskId: string): Promise<TaskState> {
    let rec = this.d.tasks.deriveTask(taskId);
    if (!rec) throw new Error(`unknown task ${taskId}`);
    if (isTerminal(rec.state)) {
      this.log(`task ${taskId} already terminal: ${rec.state}`);
      return rec.state;
    }

    // Subscription-only billing is checked first: an API key in the environment
    // would silently bill per token, which the operator explicitly refused.
    const banned = bannedKeysPresent();
    if (banned.length > 0) {
      return this.escalate(
        taskId,
        `paid API credentials present in the environment (${banned.join(', ')}); ` +
          'billing mode is SUBSCRIPTION_CLI_ONLY',
        { policy: 'NO_PAID_API_FALLBACK' },
      );
    }

    // Reviewer independence is checked before any code is written, so an
    // unavailable reviewer costs nothing instead of failing after the build.
    const reviewerAvail = await this.d.reviewer.available();
    if (!reviewerAvail.ok) {
      return this.escalate(taskId, `independent reviewer unavailable: ${reviewerAvail.reason}`, {
        policy: 'NO_SAME_PROVIDER_REVIEW_FALLBACK',
      });
    }
    const advisorAvail = await this.d.advisor.available();
    if (!advisorAvail.ok) {
      return this.escalate(taskId, `advisor unavailable: ${advisorAvail.reason}`);
    }
    const builderAvail = await this.d.builder.available();
    if (!builderAvail.ok) {
      return this.escalate(taskId, `builder unavailable: ${builderAvail.reason}`);
    }

    const baseRef = String(
      (this.d.tasks.byType(taskId, 'TASK_CREATED')[0].payload as any).baseRef,
    );

    // ---- DESIGN -----------------------------------------------------------
    // Also runs when the task is already DESIGNING but has no design recorded:
    // a crash (or an operator retry after an escalation) must re-run the phase
    // rather than fall through to "no design available".
    if (rec.state === 'NEW' || (rec.state === 'DESIGNING' && !this.currentDesign(taskId))) {
      if (rec.state === 'NEW') this.transition(taskId, rec.state, 'DESIGNING');
      this.d.git.createBranch(rec.branch);

      const runDesign = (extra?: string) =>
        this.d.advisor.run({
          taskId,
          role: 'design',
          prompt: designPrompt(this.d.repoRoot, rec) + (extra ?? ''),
          schemaName: 'design',
          cwd: this.d.repoRoot,
          timeoutMs: 20 * 60 * 1000,
        });

      let res = await runDesign();
      if (res.rateLimited) return this.pauseForRateLimit(taskId, 'DESIGNING', res.provider);

      // Exactly one retry, and only for failures a retry can plausibly fix.
      // A parse or schema failure gets an explicit structured-output reminder; an
      // execution failure (expired credentials, a transient API error) gets a
      // plain second attempt, because appending instructions to a request that
      // never reached a model is pointless. Never more than one.
      if (!res.ok) {
        const retryable =
          res.failureKind === 'ADAPTER_PARSE_ERROR' ||
          res.failureKind === 'AGENT_SCHEMA_ERROR' ||
          res.failureKind === 'AGENT_EXECUTION_ERROR';
        if (retryable) {
          this.d.events.append({
            taskId,
            type: 'DESIGN_RETRY',
            actor: 'orchestrator',
            payload: {
              attempt: 2,
              failureKind: res.failureKind ?? 'UNKNOWN',
              reason: res.error ?? 'no structured output',
              providerStatus: res.providerStatus ?? null,
              rawArtifactHash: res.rawArtifactHash,
            },
          });
          const remind =
            res.failureKind === 'AGENT_EXECUTION_ERROR'
              ? ''
              : '\n\nIMPORTANT: your previous reply could not be used. Reply with a single ' +
                'JSON object and nothing else — no prose before or after, no markdown fence. ' +
                'It must contain the keys: scopeAllowlist, outOfScope, invariants, requiredTests.';
          res = await runDesign(remind);
          if (res.rateLimited) return this.pauseForRateLimit(taskId, 'DESIGNING', res.provider);
        }
      }

      if (!res.ok || !res.structured) {
        // The failure class is part of the reason. "no JSON object found" for an
        // expired OAuth token sent a previous investigation at the parser.
        const kind = res.failureKind ?? 'ADAPTER_PARSE_ERROR';
        return this.escalate(
          taskId,
          `design phase failed [${kind}]: ${res.error ?? 'no structured output'}`,
        );
      }
      this.recordAgent(taskId, 'DESIGN_DECISION', 'claude-advisor', res, {
        design: res.structured,
        final: false,
      });
      rec = this.d.tasks.deriveTask(taskId)!;
    }

    let design = this.currentDesign(taskId);
    if (!design) return this.escalate(taskId, 'no design available after design phase');

    // ---- DESIGN REVIEW (mandatory, independent) ---------------------------
    if (rec.state === 'DESIGNING') {
      this.transition(taskId, rec.state, 'DESIGN_REVIEW');
      const res = await this.d.reviewer.run({
        taskId,
        role: 'design-review',
        prompt: designReviewPrompt(this.d.repoRoot, rec, design),
        schemaName: 'design-review',
        cwd: this.d.repoRoot,
        timeoutMs: 20 * 60 * 1000,
      });
      if (res.rateLimited) return this.pauseForRateLimit(taskId, 'DESIGN_REVIEW', res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, `design review failed: ${res.error ?? 'no structured output'}`);
      }
      const findings = (res.structured.findings as Finding[]) ?? [];
      this.recordAgent(taskId, 'DESIGN_REVIEW', 'codex', res, {
        verdict: res.structured.verdict,
        findingCount: findings.length,
        findings,
      });
      rec = this.d.tasks.deriveTask(taskId)!;

      const blockers = findings.filter((f) => f.severity === 'BLOCKER');
      if (blockers.length > 0) {
        this.transition(taskId, rec.state, 'DESIGN_ADJUDICATION');
        const adj = await this.adjudicate(taskId, rec, blockers, design);
        if (adj === null) return this.escalate(taskId, 'design adjudication produced no structured verdict');

        const unresolved = adj.filter((a) => a.verdict === 'CONFIRMED' && !a.requiredFix);
        if (unresolved.length > 0) {
          return this.escalate(
            taskId,
            `unresolved BLOCKER design dispute after adjudication (${unresolved.length})`,
            { findingIds: unresolved.map((u) => u.findingId) },
          );
        }
        // Fold confirmed design fixes into a FINAL design.
        design = {
          ...design,
          implementationConstraints: [
            ...design.implementationConstraints,
            ...adj.filter((a) => a.requiredFix).map((a) => `[from ${a.findingId}] ${a.requiredFix}`),
          ],
        };
        this.d.events.append({
          taskId,
          type: 'DESIGN_DECISION',
          actor: 'claude-advisor',
          parents: blockers.map((b) => b.findingId),
          payload: { design, final: true, note: 'FINAL_DESIGN after adjudication' },
        });
        rec = this.d.tasks.deriveTask(taskId)!;
        this.transition(taskId, rec.state, 'READY_TO_IMPLEMENT');
      } else {
        this.d.events.append({
          taskId,
          type: 'DESIGN_DECISION',
          actor: 'claude-advisor',
          payload: { design, final: true, note: 'FINAL_DESIGN — reviewer raised no blockers' },
        });
        rec = this.d.tasks.deriveTask(taskId)!;
        this.transition(taskId, rec.state, 'READY_TO_IMPLEMENT');
      }
      rec = this.d.tasks.deriveTask(taskId)!;
    }

    design = this.currentDesign(taskId) ?? design;

    // ---- IMPLEMENT --------------------------------------------------------
    if (rec.state === 'READY_TO_IMPLEMENT') {
      this.transition(taskId, rec.state, 'IMPLEMENTING');
      const res = await this.d.builder.run({
        taskId,
        role: 'implement',
        prompt: implementPrompt(this.d.repoRoot, rec, design),
        schemaName: 'implementation',
        cwd: this.d.repoRoot,
        timeoutMs: 60 * 60 * 1000,
      });
      if (res.rateLimited) return this.pauseForRateLimit(taskId, 'IMPLEMENTING', res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, `implementation failed: ${res.error ?? 'no structured output'}`);
      }
      this.recordAgent(taskId, 'IMPLEMENTATION', 'claude-code', res, res.structured);

      if (res.structured.status === 'SCOPE_EXPANSION_REQUIRED') {
        return this.escalate(taskId, 'SCOPE_EXPANSION_REQUIRED outside the finalized design', {
          requestedPaths: res.structured.requestedPaths,
          builderReason: res.structured.reason,
        });
      }
      if (res.structured.status !== 'IMPLEMENTED') {
        return this.escalate(taskId, `builder returned status ${String(res.structured.status)}`);
      }

      const violations = this.checkChangedFiles(taskId, baseRef, design.scopeAllowlist);
      if (violations) return violations;
      rec = this.d.tasks.deriveTask(taskId)!;
    }

    // ---- TEST + PRE-REVIEW ACCEPTANCE -------------------------------------
    const acceptance = (this.d.acceptanceFactory ?? ((t, p) => new AcceptanceRunner(t, p)))(
      taskId,
      this.d.policy,
    );
    if (rec.state === 'IMPLEMENTING') {
      this.transition(taskId, rec.state, 'TESTING');
      const pre = acceptance.preReview(rec.risk);
      this.recordAcceptance(taskId, pre);
      rec = this.d.tasks.deriveTask(taskId)!;
      this.transition(taskId, rec.state, 'PRE_REVIEW_ACCEPTANCE');
      if (!pre.ok) {
        // Cheap gate failures go straight back to the builder, never to a human.
        return this.escalate(taskId, 'pre-review acceptance failed', {
          violations: pre.violations,
          outcomes: pre.outcomes.map((o) => ({ name: o.name, ok: o.ok, blockedReason: o.blockedReason })),
        });
      }
      rec = this.d.tasks.deriveTask(taskId)!;
    }

    // ---- REVIEW / ADJUDICATE / FIX LOOP -----------------------------------
    let round = 0;
    let previousBlockerCount = Number.POSITIVE_INFINITY;
    let noProgressRounds = 0;

    while (round < this.d.policy.maxReviewRounds) {
      round += 1;
      rec = this.d.tasks.deriveTask(taskId)!;
      const reviewState: TaskState = round === 1 ? 'CODEX_REVIEW' : 'RE_REVIEW';
      this.transition(taskId, rec.state, reviewState);

      const diff = this.d.git.diff(baseRef);
      const res = await this.d.reviewer.run({
        taskId,
        role: round === 1 ? 'review' : 're-review',
        prompt: reviewPrompt(this.d.repoRoot, rec, diff, design),
        schemaName: 'review',
        cwd: this.d.repoRoot,
        timeoutMs: 30 * 60 * 1000,
      });
      if (res.rateLimited) return this.pauseForRateLimit(taskId, reviewState, res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, `implementation review failed: ${res.error ?? 'no structured output'}`);
      }
      const findings = (res.structured.findings as Finding[]) ?? [];
      this.d.events.append({
        taskId,
        type: 'FINDING',
        actor: 'codex',
        payload: {
          roundStart: true,
          round,
          findings,
          rawArtifactHash: res.rawArtifactHash,
          provider: res.provider,
        },
        simulated: res.simulated,
      });

      const blockers = findings.filter((f) => f.severity === 'BLOCKER');
      if (blockers.length === 0) {
        rec = this.d.tasks.deriveTask(taskId)!;
        this.transition(taskId, rec.state, 'FINAL_ACCEPTANCE');
        break;
      }

      if (blockers.length >= previousBlockerCount) {
        noProgressRounds += 1;
        if (noProgressRounds >= 2) {
          return this.escalate(taskId, 'two consecutive rounds did not reduce the blocker count', {
            round,
            blockerCount: blockers.length,
          });
        }
      } else {
        noProgressRounds = 0;
      }
      previousBlockerCount = blockers.length;

      rec = this.d.tasks.deriveTask(taskId)!;
      this.transition(taskId, rec.state, 'ADJUDICATION');
      const adj = await this.adjudicate(taskId, rec, blockers, design);
      if (adj === null) return this.escalate(taskId, 'adjudication produced no structured verdict');

      const confirmed = adj.filter((a) => a.verdict === 'CONFIRMED' || a.verdict === 'PARTIAL');
      if (confirmed.length === 0) {
        // Everything rejected: the reviewer and adjudicator disagree with no
        // fix to make, which is exactly the dispute case that must escalate.
        return this.escalate(taskId, 'BLOCKER findings all rejected in adjudication — unresolved dispute', {
          findingIds: blockers.map((b) => b.findingId),
        });
      }

      rec = this.d.tasks.deriveTask(taskId)!;
      this.transition(taskId, rec.state, 'FIXING');
      const fixRes = await this.d.builder.run({
        taskId,
        role: 'implement',
        prompt: implementPrompt(this.d.repoRoot, rec, design, confirmed),
        schemaName: 'implementation',
        cwd: this.d.repoRoot,
        timeoutMs: 60 * 60 * 1000,
      });
      if (fixRes.rateLimited) return this.pauseForRateLimit(taskId, 'FIXING', fixRes.provider);
      if (!fixRes.ok || !fixRes.structured) {
        return this.escalate(taskId, `fix round ${round} failed: ${fixRes.error ?? 'no structured output'}`);
      }
      this.d.events.append({
        taskId,
        type: 'FIX',
        actor: 'claude-code',
        parents: confirmed.map((c) => c.findingId),
        payload: { round, ...fixRes.structured, rawArtifactHash: fixRes.rawArtifactHash },
        simulated: fixRes.simulated,
      });
      if (fixRes.structured.status === 'SCOPE_EXPANSION_REQUIRED') {
        return this.escalate(taskId, 'fix requires scope outside the finalized design', {
          requestedPaths: fixRes.structured.requestedPaths,
        });
      }

      const violations = this.checkChangedFiles(taskId, baseRef, design.scopeAllowlist);
      if (violations) return violations;

      rec = this.d.tasks.deriveTask(taskId)!;
      this.transition(taskId, rec.state, 'TESTING');
      const post = acceptance.preReview(rec.risk);
      this.recordAcceptance(taskId, post);
      if (!post.ok) {
        return this.escalate(taskId, `tests failed after fix round ${round}`, {
          violations: post.violations,
        });
      }
      rec = this.d.tasks.deriveTask(taskId)!;
      this.transition(taskId, rec.state, 'PRE_REVIEW_ACCEPTANCE');
    }

    rec = this.d.tasks.deriveTask(taskId)!;
    if (rec.state !== 'FINAL_ACCEPTANCE') {
      return this.escalate(taskId, `review loop exhausted after ${this.d.policy.maxReviewRounds} rounds`);
    }

    // ---- FINAL ACCEPTANCE -------------------------------------------------
    const finalRes = acceptance.final(rec.risk);
    this.recordAcceptance(taskId, finalRes);
    if (finalRes.evidenceConflict) {
      this.d.events.append({
        taskId,
        type: 'EVIDENCE_CONFLICT',
        actor: 'acceptance-runner',
        payload: finalRes.evidenceConflict,
      });
      return this.escalate(taskId, `EVIDENCE_CONFLICT: ${finalRes.evidenceConflict.detail}`);
    }
    if (!finalRes.ok) {
      return this.escalate(taskId, 'final acceptance failed', { violations: finalRes.violations });
    }

    // A simulated reviewer can drive the pipeline but never certifies a merge.
    const lastReview = this.d.tasks.latest(taskId, 'FINDING');
    if (lastReview?.simulated) {
      return this.escalate(
        taskId,
        'final acceptance reached with a SIMULATED reviewer — reviewer independence not satisfied',
        { policy: 'NO_SAME_PROVIDER_REVIEW_FALLBACK' },
      );
    }

    this.d.events.append({
      taskId,
      type: 'VERDICT',
      actor: 'orchestrator',
      payload: {
        verdict: 'ACCEPTED',
        verified: finalRes.verified,
        notVerified: finalRes.notVerified,
      },
    });
    this.d.events.append({
      taskId,
      type: 'READY_TO_MERGE',
      actor: 'orchestrator',
      payload: {
        branch: rec.branch,
        head: this.d.git.head(),
        autoMerge: false,
        reason:
          rec.risk === 'high'
            ? 'HIGH-risk accounting task: auto-merge disabled in V1'
            : 'auto-merge disabled in V1',
      },
    });
    rec = this.d.tasks.deriveTask(taskId)!;
    this.d.tasks.writeCache(rec);
    this.log('  READY_TO_MERGE (no auto-merge in V1)');
    return 'READY_TO_MERGE';
  }

  // -- helpers ------------------------------------------------------------

  private currentDesign(taskId: string): Design | null {
    const all = this.d.tasks.byType(taskId, 'DESIGN_DECISION');
    if (!all.length) return null;
    const finals = all.filter((e) => (e.payload as any).final);
    const chosen = finals.length ? finals[finals.length - 1] : all[all.length - 1];
    return (chosen.payload as any).design as Design;
  }

  private recordAgent(
    taskId: string,
    type: 'DESIGN_DECISION' | 'DESIGN_REVIEW' | 'IMPLEMENTATION',
    actor: 'claude-advisor' | 'claude-code' | 'codex',
    res: AgentResult,
    payload: Record<string, unknown>,
  ): void {
    this.d.events.append({
      taskId,
      type,
      actor,
      payload: {
        ...payload,
        provider: res.provider,
        rawArtifactHash: res.rawArtifactHash,
        durationMs: res.durationMs,
        // Absent when the provider does not report it. Never fabricated.
        usage: res.usage,
      },
      simulated: res.simulated,
    });
  }

  private recordAcceptance(taskId: string, r: ReturnType<AcceptanceRunner['preReview']>): void {
    for (const o of r.outcomes) {
      this.d.events.append({
        taskId,
        type: 'TEST_RESULT',
        actor: 'test-runner',
        payload: {
          tier: r.tier,
          name: o.name,
          command: o.command,
          exitCode: o.exitCode,
          passed: o.passed,
          failed: o.failed,
          skipped: o.skipped,
          total: o.total,
          classifications: o.classifications ?? null,
          stdoutHash: o.stdoutHash,
          ok: o.ok,
          blockedReason: o.blockedReason ?? null,
        },
      });
    }
    this.d.events.append({
      taskId,
      type: 'RUNTIME_EVIDENCE',
      actor: 'acceptance-runner',
      payload: { tier: r.tier, ok: r.ok, verified: r.verified, notVerified: r.notVerified },
    });
    for (const v of r.violations) {
      this.d.events.append({
        taskId,
        type: 'POLICY_BLOCK',
        actor: 'policy-engine',
        payload: { rule: v.rule, detail: v.detail },
      });
    }
  }

  private async adjudicate(
    taskId: string,
    rec: TaskRecord,
    findings: Finding[],
    design: Design | null,
  ): Promise<AdjudicationResult[] | null> {
    const res = await this.d.advisor.run({
      taskId,
      role: 'adjudication',
      prompt: adjudicationPrompt(this.d.repoRoot, rec, findings, design),
      schemaName: 'adjudication',
      cwd: this.d.repoRoot,
      timeoutMs: 20 * 60 * 1000,
    });
    if (!res.ok || !res.structured) return null;
    const adjudications = (res.structured.adjudications as AdjudicationResult[]) ?? [];
    for (const a of adjudications) {
      this.d.events.append({
        taskId,
        type: 'ADJUDICATION',
        actor: 'claude-advisor',
        parents: [a.findingId],
        payload: { ...a, rawArtifactHash: res.rawArtifactHash },
        simulated: res.simulated,
      });
    }
    return adjudications;
  }

  /** Returns 'ESCALATED' when the change set violates scope or protection. */
  private checkChangedFiles(taskId: string, baseRef: string, allowlist: string[]): 'ESCALATED' | null {
    const changed = this.d.git.changedFiles(baseRef);
    const violations = [
      ...this.d.policy.checkScope(changed, allowlist),
      ...this.d.policy.checkProtectedPaths(changed),
    ];
    if (violations.length === 0) return null;
    for (const v of violations) {
      this.d.events.append({
        taskId,
        type: 'POLICY_BLOCK',
        actor: 'policy-engine',
        payload: { rule: v.rule, detail: v.detail },
      });
    }
    return this.escalate(taskId, `policy blocked the change set (${violations.length} violation(s))`, {
      violations,
    });
  }
}
