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
  AgentTask,
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
import { WorktreeManager } from './worktree-manager';
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
  /** Control-plane git. Used only to resolve the accounting base. */
  git: GitManager;
  /** Creates and locates the per-task worktree the builder is confined to. */
  worktrees: WorktreeManager;
  /** Accounting base ref new tasks are cut from. Never the control-plane branch. */
  accountingBaseRef?: string;
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
    worktrees: new WorktreeManager(repoRoot),
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

Finish the work before you answer. Do not end your turn while a build or test
is still running, and do not promise to report the result later — a turn that
ends without the JSON below is a failed run, whatever was accomplished.

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
        // TASK_BASE_SHA. The approved accounting base, resolved once and never
        // recomputed: a task cut from the control-plane branch inherits
        // Autopilot development it must never be held responsible for.
        baseRef: this.d.worktrees.accountingBase(this.d.accountingBaseRef ?? 'origin/main'),
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
  authorizeRetry(taskId: string, owner: string, reason: string, freshDesign = false): TaskRecord | null {
    const rec = this.d.tasks.deriveTask(taskId);
    if (!rec) return null;
    // ESCALATED is the usual case. DESIGNING is also accepted: a run that died
    // mid-design leaves the task there, and requiring an artificial escalation
    // first would add a fake event to the log purely to satisfy a check.
    if (rec.state !== 'ESCALATED' && rec.state !== 'DESIGNING') {
      throw new Error(`task ${taskId} is ${rec.state}; retry applies to ESCALATED or DESIGNING`);
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
        retryingFrom: rec.state,
        reenteringAt: 'DESIGNING',
        // When the recorded design is internally inconsistent, re-reviewing it
        // is pointless — it has to be produced again, once, with the prior
        // adjudications applied into the text rather than appended beside it.
        freshDesign,
        priorEscalations,
      },
    });
    if (rec.state === 'ESCALATED') this.transition(taskId, 'ESCALATED', 'DESIGNING');
    const updated = this.d.tasks.deriveTask(taskId)!;
    this.d.tasks.writeCache(updated);
    return updated;
  }


  /**
   * Runs an agent step, and retries exactly once when the failure is one a
   * retry can plausibly fix.
   *
   * Every phase needs this, not just design. TASK-0007 got past a design-phase
   * failure only to lose a 41-turn implementation because the builder ended its
   * turn with "the e2e gate is running; I'll report the JSON once it lands" —
   * a healthy envelope (is_error:false, terminal_reason:completed) carrying no
   * structured result. One reminder recovers that; nothing else did.
   *
   * A retry is NOT attempted for a rate-limit pause (the caller handles it) and
   * the reminder is omitted for execution failures, where no model saw the
   * prompt at all.
   */
  private async runAgentStep(
    taskId: string,
    phase: string,
    agent: AgentAdapter,
    task: AgentTask,
    requiredKeys: string[],
  ): Promise<AgentResult> {
    let res = await agent.run(task);
    if (res.ok || res.rateLimited) return res;

    const retryable =
      res.failureKind === 'ADAPTER_PARSE_ERROR' ||
      res.failureKind === 'AGENT_SCHEMA_ERROR' ||
      res.failureKind === 'AGENT_EXECUTION_ERROR';
    if (!retryable) return res;

    this.d.events.append({
      taskId,
      type: 'DESIGN_RETRY',
      actor: 'orchestrator',
      payload: {
        phase,
        attempt: 2,
        failureKind: res.failureKind ?? 'UNKNOWN',
        reason: res.error ?? 'no structured output',
        providerStatus: res.providerStatus ?? null,
        rawArtifactHash: res.rawArtifactHash,
      },
    });
    this.log(`  retrying ${phase} once after ${res.failureKind}`);

    const reminder =
      res.failureKind === 'AGENT_EXECUTION_ERROR'
        ? ''
        : `\n\nIMPORTANT: your previous reply could not be used (${res.failureKind}). ` +
          'Do not end your turn until you have finished the work AND emitted the result. ' +
          'Reply with a single JSON object and nothing else — no prose before or after, ' +
          'no markdown fence, no promise to report later. Required keys: ' +
          `${requiredKeys.join(', ')}.`;

    res = await agent.run({ ...task, prompt: task.prompt + reminder });
    return res;
  }

  /**
   * The corrections a re-design must incorporate, taken from the immutable log.
   *
   * Previous rounds appended the adjudicated fixes next to the wording they were
   * meant to replace, so the design kept both and reviewers could reach opposite
   * conclusions from it. The instruction is explicit that superseded text is to
   * be removed, not annotated.
   */
  private priorAdjudicationsBrief(taskId: string): string {
    const adj = this.d.tasks.byType(taskId, 'ADJUDICATION').map((e) => e.payload as any);
    if (!adj.length) return '';
    const lines = adj
      .filter((a) => a.verdict === 'CONFIRMED' || a.verdict === 'PARTIAL')
      .map((a) => `- ${a.findingId} (${a.verdict}): ${a.requiredFix ?? a.reasoning}`);
    if (!lines.length) return '';
    return (
      '\n\nThis is a re-design. The design previously recorded for this task is ' +
      'internally inconsistent: earlier corrections were appended beside the wording ' +
      'they replace, so both survive and the acceptance criteria contradict each other.\n\n' +
      'Apply every correction below IN PLACE. Delete the superseded wording entirely — ' +
      'do not append, annotate or keep it as history. The result must contain exactly one ' +
      'statement of each invariant and each acceptance requirement.\n\n' +
      'ADJUDICATED CORRECTIONS TO APPLY:\n' +
      lines.join('\n')
    );
  }

  /** Escalation text that names which layer failed. */
  private agentFailure(phase: string, res: AgentResult): string {
    const kind = res.failureKind ?? 'ADAPTER_PARSE_ERROR';
    return `${phase} failed [${kind}]: ${res.error ?? 'no structured output'}`;
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

    // The base this attempt is measured against.
    //
    // A retry retargets the task branch onto current HEAD, which by definition
    // has moved since the task was created — that is why the retry exists. The
    // baseRef recorded at creation is then stale, and diffing against it
    // attributes every unrelated commit made in between to the builder. That is
    // exactly what happened on TASK-0007: eleven tooling files from the fix that
    // enabled the retry were reported as out-of-allowlist builder edits.
    //
    // BASE_REF_UPDATED is appended rather than TASK_CREATED being rewritten, so
    // the rebasing is visible in the log instead of silently changing history.
    // ---- ISOLATION -------------------------------------------------------
    // Everything this task may touch lives in its own worktree, cut from the
    // recorded TASK_BASE_SHA. The control-plane checkout this process runs from
    // is never measured: that is what made eleven Autopilot files look like
    // builder edits. The boundary is physical — the infrastructure is simply not
    // in the tree being diffed — not a path filter applied afterwards.
    // Latest recorded base wins. Tasks created before task worktrees existed
    // recorded a control-plane commit as their base; re-anchoring is an appended
    // BASE_REF_UPDATED rather than a rewrite of TASK_CREATED, so the change of
    // baseline stays visible instead of being swapped underneath the history.
    const baseUpdates = this.d.tasks.byType(taskId, 'BASE_REF_UPDATED');
    const baseRef = String(
      baseUpdates.length
        ? (baseUpdates[baseUpdates.length - 1].payload as any).baseRef
        : (this.d.tasks.byType(taskId, 'TASK_CREATED')[0].payload as any).baseRef,
    );
    const wt = this.d.worktrees.ensure(taskId, rec.branch, baseRef);
    if (wt.created) {
      this.d.events.append({
        taskId,
        type: 'TASK_WORKTREE_RECREATED',
        actor: 'orchestrator',
        payload: {
          taskId,
          worktreePath: wt.path,
          branch: wt.branch,
          newTaskBase: baseRef,
          reason: 'isolated task worktree created from the recorded task base',
        },
      });
    }
    this.log(`  task worktree: ${wt.path} (base ${baseRef.slice(0, 9)})`);

    // Every task git operation runs here, never in the control-plane checkout.
    const taskGit = new GitManager(wt.path, this.d.policy);

    // ---- DESIGN -----------------------------------------------------------
    // Also runs when the task is already DESIGNING but has no design recorded:
    // a crash (or an operator retry after an escalation) must re-run the phase
    // rather than fall through to "no design available".
    // A fresh design is requested if the most recent RETRY_AUTHORIZED asked for
    // one and was recorded after the last design.
    const lastDesignSeq = Math.max(
      0,
      ...this.d.tasks.byType(taskId, 'DESIGN_DECISION').map((e) => e.seq),
    );
    const lastRetry = this.d.tasks.byType(taskId, 'RETRY_AUTHORIZED').slice(-1)[0];
    const freshDesignRequested =
      !!lastRetry && (lastRetry.payload as any).freshDesign === true && lastRetry.seq > lastDesignSeq;

    if (
      rec.state === 'NEW' ||
      (rec.state === 'DESIGNING' && (!this.currentDesign(taskId) || freshDesignRequested))
    ) {
      if (rec.state === 'NEW') this.transition(taskId, rec.state, 'DESIGNING');

      const res = await this.runAgentStep(
        taskId,
        'design phase',
        this.d.advisor,
        {
          taskId,
          role: 'design',
          prompt:
            designPrompt(this.d.repoRoot, rec) +
            (freshDesignRequested ? this.priorAdjudicationsBrief(taskId) : ''),
          schemaName: 'design',
          cwd: wt.path,
          timeoutMs: 20 * 60 * 1000,
        },
        ['scopeAllowlist', 'outOfScope', 'invariants', 'requiredTests'],
      );
      if (res.rateLimited) return this.pauseForRateLimit(taskId, 'DESIGNING', res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, this.agentFailure('design phase', res));
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
      const res = await this.runAgentStep(
        taskId,
        'design review',
        this.d.reviewer,
        {
        taskId,
        role: 'design-review',
        prompt: designReviewPrompt(this.d.repoRoot, rec, design),
        schemaName: 'design-review',
        cwd: wt.path,
        timeoutMs: 20 * 60 * 1000,
      },
        'verdict,findings'.split(','),
      );
      if (res.rateLimited) return this.pauseForRateLimit(taskId, 'DESIGN_REVIEW', res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, this.agentFailure('design review', res));
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
        const adj = await this.adjudicate(
        wt.path,
        taskId, rec, blockers, design);
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
      const res = await this.runAgentStep(
        taskId,
        'implementation',
        this.d.builder,
        {
        taskId,
        role: 'implement',
        prompt: implementPrompt(this.d.repoRoot, rec, design),
        schemaName: 'implementation',
        cwd: wt.path,
        timeoutMs: 60 * 60 * 1000,
      },
        'status,filesChanged'.split(','),
      );
      if (res.rateLimited) return this.pauseForRateLimit(taskId, 'IMPLEMENTING', res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, this.agentFailure('implementation', res));
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

      const violations = this.checkChangedFiles(taskId, taskGit, baseRef, design.scopeAllowlist);
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

      const diff = taskGit.diff(baseRef);
      const res = await this.runAgentStep(
        taskId,
        'implementation review',
        this.d.reviewer,
        {
        taskId,
        role: round === 1 ? 'review' : 're-review',
        prompt: reviewPrompt(this.d.repoRoot, rec, diff, design),
        schemaName: 'review',
        cwd: wt.path,
        timeoutMs: 30 * 60 * 1000,
      },
        'findings'.split(','),
      );
      if (res.rateLimited) return this.pauseForRateLimit(taskId, reviewState, res.provider);
      if (!res.ok || !res.structured) {
        return this.escalate(taskId, this.agentFailure('implementation review', res));
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
      const adj = await this.adjudicate(
        wt.path,
        taskId, rec, blockers, design);
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
      const fixRes = await this.runAgentStep(
        taskId,
        'fix round',
        this.d.builder,
        {
        taskId,
        role: 'implement',
        prompt: implementPrompt(this.d.repoRoot, rec, design, confirmed),
        schemaName: 'implementation',
        cwd: wt.path,
        timeoutMs: 60 * 60 * 1000,
      },
        'status,filesChanged'.split(','),
      );
      if (fixRes.rateLimited) return this.pauseForRateLimit(taskId, 'FIXING', fixRes.provider);
      if (!fixRes.ok || !fixRes.structured) {
        return this.escalate(taskId, this.agentFailure(`fix round ${round}`, fixRes));
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

      const violations = this.checkChangedFiles(taskId, taskGit, baseRef, design.scopeAllowlist);
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
        head: taskGit.head(),
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
    cwd: string,
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
      cwd,
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
  private checkChangedFiles(
    taskId: string,
    taskGit: GitManager,
    baseRef: string,
    allowlist: string[],
  ): 'ESCALATED' | null {
    // Measured in the task worktree only.
    const changed = taskGit.changedFiles(baseRef);
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
