/**
 * V2 orchestrator.
 *
 * NEW → DESIGN → IMPLEMENT → VERIFY (fast gate) → REVIEW → FIX* →
 * FINAL_ACCEPTANCE → [auto-merge?] → MERGED → [auto-deploy?] → DEPLOYED
 *
 * Autonomy is the default. Risk raises the evidence bar, not the human bar:
 * the owner is interrupted only by the enumerated CRITICAL triggers, with a
 * decision package. Consensus between agents is not a gate; deterministic
 * evidence ends arguments.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  TaskRecord, TaskState, Risk, Finding, DesignRevision, CheckResult, HumanDecisionRequest,
} from './types';
import { EventStore, StreamLog, deriveTask, currentDesign, allFindings, STATE_ROOT } from './store';
import { runAgentBounded, bannedKeysPresent, AgentSpec } from './agents';
import { WorktreeManager } from './worktrees';
import * as checks from './checks';
import * as policy from './policy';
import { automaticDeploymentEnabled } from './settings';
import { generateReport } from './report';

const CONTROL_REPO = process.env.AI_V2_REPO ?? '/srv/ai-accounting/repo';
const DEPLOY_BIN = process.env.AI_DEPLOY_BIN ?? '/srv/ai-accounting/bin/deploy-production';
const MERGE_WT = path.join(STATE_ROOT, 'merge-main');

export class Orchestrator {
  readonly wtm: WorktreeManager;
  private running = new Set<string>();

  constructor(
    readonly events: EventStore,
    readonly stream: StreamLog,
    readonly repo: string = CONTROL_REPO,
  ) {
    this.wtm = new WorktreeManager(repo);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  nextTaskId(): string {
    const ids = this.events.listTasks().filter((t) => /^TASK-V2-\d+$/.test(t));
    const n = ids.length ? Math.max(...ids.map((t) => Number(t.split('-')[2]))) + 1 : 1;
    return `TASK-V2-${String(n).padStart(4, '0')}`;
  }

  createTask(description: string, risk: Risk): TaskRecord {
    const taskId = this.nextTaskId();
    const branch = `ai/${taskId.toLowerCase()}`;
    const baseSha = this.wtm.accountingBase('origin/main');
    const title = description.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? taskId;
    this.events.append({
      taskId, type: 'TASK_CREATED', payload: {
        title, description, risk, branch, baseSha,
        worktree: this.wtm.pathFor(taskId),
      },
    });
    return deriveTask(this.events, taskId)!;
  }

  task(taskId: string): TaskRecord | null { return deriveTask(this.events, taskId); }

  private setState(taskId: string, from: TaskState, to: TaskState, phase = '', subPhase = '',
    extra: Record<string, unknown> = {}): void {
    this.events.append({ taskId, type: 'STATE_CHANGED', phase, subPhase, payload: { from, to, ...extra } });
    this.stream.append(taskId, 'system', 'lifecycle', `state: ${from} → ${to}${subPhase ? ` (${subPhase})` : ''}`, phase);
    this.maybeAutoFinalReport(taskId, to);
  }

  /**
   * Automatic Persian FINAL report on outcome states. Strictly fire-and-forget:
   * report generation observes the event log and must never block or fail a task.
   */
  private maybeAutoFinalReport(taskId: string, to: TaskState): void {
    const finals: TaskState[] = ['READY_TO_MERGE', 'MERGED', 'READY_TO_DEPLOY', 'DEPLOYED',
      'FAILED', 'ESCALATED', 'CANCELLED'];
    if (!finals.includes(to)) return;
    setImmediate(() => {
      generateReport(this.events, taskId, 'NORMAL').then((r) => {
        if (r) this.stream.append(taskId, 'system', 'report',
          `automatic Persian FINAL report generated (${r.generator}, ${r.generationMs}ms)`);
      }).catch(() => { /* reporting must never affect the task */ });
    });
  }

  cancel(taskId: string, by: string, reason: string): void {
    this.events.append({ taskId, type: 'TASK_CANCELLED', payload: { cancelledBy: by, reason } });
    this.stream.append(taskId, 'system', 'lifecycle', `cancelled: ${reason}`);
    this.running.delete(taskId);
    this.maybeAutoFinalReport(taskId, 'CANCELLED');
  }

  isRunning(taskId: string): boolean { return this.running.has(taskId); }

  // -------------------------------------------------------------------------
  // Agent helpers
  // -------------------------------------------------------------------------

  private async agent(taskId: string, spec: Omit<AgentSpec, 'taskId'>, phase: string) {
    this.events.append({ taskId, type: 'AGENT_STARTED', agent: spec.agent as any, phase, payload: { subPhase: spec.phase } });
    const res = await runAgentBounded({ ...spec, taskId }, this.stream, (kind, err) => {
      this.events.append({ taskId, type: 'NOTE', agent: spec.agent as any, phase, attempt: 2,
        payload: { retry: true, failureKind: kind, reason: err.slice(0, 300) } });
    });
    this.events.append({
      taskId, type: res.ok ? 'AGENT_FINISHED' : 'AGENT_FAILED', agent: spec.agent as any, phase,
      attempt: res.attempts,
      payload: {
        ok: res.ok, durationMs: res.durationMs, exitCode: res.exitCode,
        failureKind: res.failureKind ?? null, error: res.error ?? null,
        firstChunkMs: res.firstChunkMs ?? null, rateLimited: res.rateLimited,
        requestedModel: res.requestedModel ?? null, effectiveModel: res.effectiveModel ?? null,
        cliVersion: res.cliVersion ?? null, authMode: res.authMode ?? null,
      },
    });
    return res;
  }

  private pauseRateLimit(taskId: string, from: TaskState, phase: string): TaskState {
    this.setState(taskId, from, 'PAUSED_RATE_LIMIT', phase, 'quota', {
      note: 'subscription quota reached; resume when the window resets. No paid API fallback exists.',
    });
    return 'PAUSED_RATE_LIMIT';
  }

  private escalate(taskId: string, from: TaskState, reason: string): TaskState {
    this.events.append({ taskId, type: 'NOTE', payload: { lastError: reason } });
    this.setState(taskId, from, 'ESCALATED', '', '', { reason });
    return 'ESCALATED';
  }

  private awaitHuman(taskId: string, from: TaskState, req: HumanDecisionRequest): TaskState {
    this.setState(taskId, from, 'AWAITING_HUMAN', 'human', req.decisionId, { awaiting: req });
    return 'AWAITING_HUMAN';
  }

  private check(taskId: string, phase: string, c: CheckResult): CheckResult {
    this.events.append({ taskId, type: 'DETERMINISTIC_CHECK', phase, payload: { ...c } });
    this.stream.append(taskId, 'system', c.ok ? 'event' : 'error',
      `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`, phase);
    return c;
  }

  // -------------------------------------------------------------------------
  // Main pipeline
  // -------------------------------------------------------------------------

  async run(taskId: string): Promise<TaskState> {
    if (this.running.has(taskId)) return this.task(taskId)!.state;
    this.running.add(taskId);
    try {
      return await this.pipeline(taskId);
    } catch (e: any) {
      return this.escalate(taskId, this.task(taskId)?.state ?? 'NEW', `pipeline crashed: ${String(e?.message).slice(0, 300)}`);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async pipeline(taskId: string): Promise<TaskState> {
    let rec = this.task(taskId);
    if (!rec) throw new Error(`unknown task ${taskId}`);
    if (['CANCELLED', 'FAILED', 'DEPLOYED', 'ESCALATED'].includes(rec.state)) return rec.state;

    const banned = bannedKeysPresent();
    if (banned.length) return this.escalate(taskId, rec.state, `paid API keys present (${banned.join(',')}); SUBSCRIPTION_CLI_ONLY`);

    const wt = this.wtm.ensure(taskId, rec.branch, rec.baseSha);
    const cwd = wt.path;

    // ---- DESIGN ----------------------------------------------------------
    if (rec.state === 'NEW' || (rec.state === 'DESIGN' && !currentDesign(this.events, taskId))) {
      if (rec.state === 'NEW') this.setState(taskId, 'NEW', 'DESIGN', 'design', 'claude');
      const res = await this.agent(taskId, {
        agent: 'claude', cwd, readOnly: true, phase: 'design/claude',
        timeoutMs: 15 * 60_000,
        requiredKeys: ['scopeAllowlist', 'plan', 'invariants', 'predictions', 'requiredTests', 'acceptance'],
        prompt: designPrompt(rec),
      }, 'design');
      if (res.rateLimited) return this.pauseRateLimit(taskId, 'DESIGN', 'design');
      if (!res.ok || !res.structured) return this.escalate(taskId, 'DESIGN', `design failed [${res.failureKind}]: ${res.error}`);
      this.recordRevision(taskId, res.structured as any, 1, []);
      rec = this.task(taskId)!;
    }

    let design = currentDesign(this.events, taskId)!;

    // HIGH only: one independent design review, adjudicated concisely.
    const budget = policy.budgetFor(rec.risk);
    const hadDesignReview = this.events.read(taskId).some((e) => e.type === 'FINDING' && e.phase === 'design');
    if (rec.state === 'DESIGN' && budget.designReview && !hadDesignReview) {
      const rev = await this.agent(taskId, {
        agent: 'codex', cwd, phase: 'design/codex-review', timeoutMs: 15 * 60_000,
        requiredKeys: ['findings'],
        prompt: designReviewPrompt(rec, design),
      }, 'design');
      if (rev.rateLimited) return this.pauseRateLimit(taskId, 'DESIGN', 'design');
      const findings = this.recordFindings(taskId, 'design', (rev.structured as any)?.findings ?? []);
      const material = findings.filter((f) => f.severity !== 'SUGGESTION');
      if (material.length) {
        const adj = await this.adjudicate(taskId, cwd, rec, material, design, 'design');
        if (adj === 'RATE_LIMIT') return this.pauseRateLimit(taskId, 'DESIGN', 'design');
        design = currentDesign(this.events, taskId)!;
      }
    }

    if (rec.state === 'DESIGN' || rec.state === 'NEW') {
      this.setState(taskId, 'DESIGN', 'IMPLEMENT', 'implement', 'claude-code');
      rec = this.task(taskId)!;
    }

    // ---- IMPLEMENT -------------------------------------------------------
    if (rec.state === 'IMPLEMENT') {
      const done = this.events.read(taskId).some((e) => e.type === 'CODE_CHANGE');
      if (!done) {
        const impl = await this.agent(taskId, {
          agent: 'claude-code', cwd, phase: 'implement', timeoutMs: 40 * 60_000,
          requiredKeys: ['status', 'filesChanged'],
          prompt: implementPrompt(rec, design),
        }, 'implement');
        if (impl.rateLimited) return this.pauseRateLimit(taskId, 'IMPLEMENT', 'implement');
        if (!impl.ok || !impl.structured) return this.escalate(taskId, 'IMPLEMENT', `implementation failed [${impl.failureKind}]: ${impl.error}`);
        const st = impl.structured as any;
        if (st.status === 'SCOPE_EXPANSION_REQUIRED') {
          const dec = policy.scopeExpansionDecision(rec.risk, st.requestedPaths ?? [], String(st.reason ?? ''));
          if (dec.allow) {
            design = { ...design, revision: design.revision + 1,
              scopeAllowlist: [...design.scopeAllowlist, ...(st.requestedPaths ?? [])],
              appliedFindings: [...design.appliedFindings, `scope-expansion:${dec.detail.slice(0, 80)}`] };
            this.recordRevision(taskId, design, design.revision, design.appliedFindings);
            this.events.append({ taskId, type: 'EVIDENCE', phase: 'implement', payload: { scopeExpansion: st.requestedPaths, reason: st.reason } });
            return this.pipeline(taskId); // one re-entry with the expanded scope
          }
          if (dec.needsHuman) {
            return this.awaitHuman(taskId, 'IMPLEMENT', policy.decisionRequest('TRUST_BOUNDARY_EXPANSION', {
              issue: `Builder requests protected paths: ${(st.requestedPaths ?? []).join(', ')}`,
              why: dec.detail, evidence: [String(st.reason ?? '')],
              recommended: 'Reject the expansion; re-scope the task explicitly if these paths are truly needed.',
              whyRecommended: 'Protected paths carry accounting/security invariants a task must not cross implicitly.',
              alternatives: ['Approve expansion', 'Cancel the task'],
              riskApproved: 'Task modifies protected files under review-only supervision.',
              riskRejected: 'Task escalates unfinished.',
            }));
          }
          return this.escalate(taskId, 'IMPLEMENT', `scope expansion refused: ${dec.detail}`);
        }
        const head = this.wtm.commitAll(cwd, `${taskId}: ${rec.title}`.slice(0, 100)) ?? this.wtm.head(cwd);
        this.events.append({ taskId, type: 'CODE_CHANGE', phase: 'implement',
          payload: { headSha: head, filesChanged: st.filesChanged ?? [], testsAdded: st.testsAdded ?? [] } });
      }
      this.setState(taskId, 'IMPLEMENT', 'VERIFY', 'verify', 'fast-gate');
      rec = this.task(taskId)!;
    }

    // ---- VERIFY (fast gate) ---------------------------------------------
    if (rec.state === 'VERIFY') {
      const gate = await this.fastGate(taskId, cwd, rec, design);
      if (gate === 'ESCALATED' || gate === 'AWAITING_HUMAN') return gate as TaskState;
      if (!gate) {
        // fast gate failed → one fix pass before review
        const fixed = await this.fixCycle(taskId, cwd, rec, design, [], 'fast-gate failure');
        if (fixed !== 'ok') return fixed as TaskState;
        const again = await this.fastGate(taskId, cwd, rec, design);
        if (!again) return this.escalate(taskId, 'VERIFY', 'fast gate still failing after one fix pass');
      }
      this.setState(taskId, 'VERIFY', 'REVIEW', 'review', 'codex');
      rec = this.task(taskId)!;
    }

    // ---- REVIEW + bounded FIX loop --------------------------------------
    if (rec.state === 'REVIEW' || rec.state === 'FIX') {
      const out = await this.reviewLoop(taskId, cwd, rec, design);
      if (out !== 'ok') return out as TaskState;
      this.setState(taskId, this.task(taskId)!.state, 'FINAL_ACCEPTANCE', 'final', '');
      rec = this.task(taskId)!;
    }

    // ---- FINAL ACCEPTANCE ------------------------------------------------
    if (rec.state === 'FINAL_ACCEPTANCE') {
      const final = await this.finalAcceptance(taskId, cwd, rec, design);
      if (final !== 'ok') return final as TaskState;
    }

    // ---- MERGE -----------------------------------------------------------
    rec = this.task(taskId)!;
    const gates = this.gateSummary(taskId);
    const mergeCall = policy.autoMergeAllowed(rec.risk, gates);
    if (!['READY_TO_MERGE', 'MERGED', 'READY_TO_DEPLOY'].includes(rec.state)) {
      this.setState(taskId, rec.state, 'READY_TO_MERGE', 'merge', '', { autoMerge: mergeCall });
      rec = this.task(taskId)!;
    }
    if (rec.state === 'READY_TO_MERGE') {
      if (!mergeCall.allowed) {
        this.events.append({ taskId, type: 'NOTE', payload: { holdingForHumanMerge: mergeCall.reason } });
        return 'READY_TO_MERGE'; // owner approves from the UI (with MFA when enrolled)
      }
      const merged = this.performMerge(taskId, rec, this.wtm.head(cwd), 'autopilot-policy');
      if (!merged.ok) return this.escalate(taskId, 'READY_TO_MERGE', `merge failed: ${merged.detail}`);
      this.setState(taskId, 'READY_TO_MERGE', 'MERGED', 'merge', '', {});
      rec = this.task(taskId)!;
    }

    // ---- DEPLOY ----------------------------------------------------------
    if (rec.state === 'MERGED' || rec.state === 'READY_TO_DEPLOY') {
      const g2 = this.gateSummary(taskId);
      const dep = policy.autoDeployAllowed(rec.risk, g2);
      if (rec.state === 'MERGED') this.setState(taskId, 'MERGED', 'READY_TO_DEPLOY', 'deploy', '', { autoDeploy: dep });
      // The owner's web toggle, read at DECISION TIME so a change is effective
      // immediately, no restart. This is a global operational hold, not a task
      // uncertainty — the task stays READY_TO_DEPLOY, never AWAITING_HUMAN,
      // and continues the moment the toggle is enabled.
      if (!automaticDeploymentEnabled()) {
        this.events.append({ taskId, type: 'AUTOMATIC_DEPLOYMENT_HELD', payload: {
          reason: 'automatic production deployment is paused by the owner setting',
          setting: 'automaticProductionDeployment=false',
        } });
        this.stream.append(taskId, 'system', 'lifecycle',
          'waiting: automatic production deployment is paused (owner setting)');
        return 'READY_TO_DEPLOY';
      }
      if (!dep.allowed) {
        this.events.append({ taskId, type: 'NOTE', payload: { holdingForHumanDeploy: dep.reason } });
        return 'READY_TO_DEPLOY';
      }
      const deployed = this.performDeploy(taskId, 'autopilot-policy');
      if (!deployed.ok) return this.escalate(taskId, 'READY_TO_DEPLOY', `deploy failed: ${deployed.detail}`);
      this.setState(taskId, 'READY_TO_DEPLOY', 'DEPLOYED', 'deploy', '', {});
      return 'DEPLOYED';
    }

    return this.task(taskId)!.state;
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private recordRevision(taskId: string, raw: any, revision: number, applied: string[]): DesignRevision {
    const design: DesignRevision = {
      revision, createdAt: new Date().toISOString(), author: 'claude',
      scopeAllowlist: (raw.scopeAllowlist ?? []).map(String),
      outOfScope: (raw.outOfScope ?? []).map(String),
      plan: String(raw.plan ?? ''),
      invariants: (raw.invariants ?? []).map(String),
      predictions: (raw.predictions ?? []).map((p: any) =>
        typeof p === 'string' ? { text: p } : { text: String(p.text ?? ''), check: p.check ? String(p.check) : undefined }),
      requiredTests: (raw.requiredTests ?? []).map(String),
      acceptance: (raw.acceptance ?? []).map(String),
      appliedFindings: applied,
    };
    this.events.append({ taskId, type: 'DESIGN_REVISION', phase: 'design', payload: { design } });
    this.stream.append(taskId, 'system', 'event', `design revision ${revision} recorded (${design.scopeAllowlist.length} files in scope)`);
    return design;
  }

  private recordFindings(taskId: string, phase: string, raw: any[]): Finding[] {
    const findings: Finding[] = raw.map((f: any, i: number) => ({
      findingId: String(f.findingId ?? `${phase.toUpperCase()}-${i + 1}`),
      severity: (['CRITICAL', 'IMPORTANT', 'SUGGESTION'].includes(f.severity) ? f.severity : 'IMPORTANT'),
      category: String(f.category ?? 'general'),
      claim: String(f.claim ?? ''),
      file: f.file ? String(f.file) : undefined,
      scenario: f.scenario ? String(f.scenario) : undefined,
      confidence: f.confidence ? String(f.confidence) : undefined,
      status: 'UNRESOLVED',
    }));
    if (findings.length) this.events.append({ taskId, type: 'FINDING', phase, payload: { findings } });
    return findings;
  }

  /**
   * Concise adjudication: FIX / TEST_TO_DECIDE / DEFER / REJECT per finding.
   * TEST_TO_DECIDE runs the named deterministic check and the evidence decides.
   * A design authored by Claude and adjudicated by Claude carries
   * SELF_ADJUDICATION_RISK — flagged, not escalated, unless CRITICAL survives.
   */
  private async adjudicate(taskId: string, cwd: string, rec: TaskRecord, findings: Finding[],
    design: DesignRevision, phase: string): Promise<'ok' | 'RATE_LIMIT'> {
    const adj = await this.agent(taskId, {
      agent: 'claude', cwd, readOnly: true, phase: `${phase}/adjudication`, timeoutMs: 10 * 60_000,
      requiredKeys: ['adjudications'],
      prompt: adjudicatePrompt(rec, findings, design, phase === 'design'),
    }, phase);
    if (adj.rateLimited) return 'RATE_LIMIT';
    const selfRisk = phase === 'design';
    const items: any[] = (adj.structured as any)?.adjudications ?? [];
    let revised: any = (adj.structured as any)?.revisedDesign ?? null;
    for (const a of items) {
      let status = ['FIX', 'TEST_TO_DECIDE', 'DEFER', 'REJECT'].includes(a.status) ? a.status : 'DEFER';
      let source: Finding['decisionSource'] = 'agent';
      let evidence = String(a.reasoning ?? '').slice(0, 400);
      if (status === 'TEST_TO_DECIDE' && a.check) {
        const { results } = checks.runPredictionChecks(cwd, [{ text: a.findingId, check: String(a.check) }]);
        const r = results[0];
        if (r) {
          this.check(taskId, phase, r);
          status = r.ok ? 'DETERMINISTICALLY_REJECTED' : 'DETERMINISTICALLY_CONFIRMED';
          source = 'deterministic';
          evidence = r.detail;
        }
      }
      this.events.append({ taskId, type: 'ADJUDICATION', phase,
        payload: { findingId: a.findingId, status, decisionSource: source, evidence, selfAdjudicationRisk: selfRisk } });
    }
    if (revised && phase === 'design') {
      // ONE canonical artifact: corrections applied in place, next revision.
      const applied = items.filter((a) => a.status === 'FIX').map((a) => String(a.findingId));
      this.recordRevision(taskId, revised, design.revision + 1, [...design.appliedFindings, ...applied]);
    }
    return 'ok';
  }

  /** Fast gate: typecheck + affected tests (+stage0 for HIGH). No full Stage -1. */
  private async fastGate(taskId: string, cwd: string, rec: TaskRecord, design: DesignRevision):
    Promise<boolean | 'ESCALATED' | 'AWAITING_HUMAN'> {
    const changed = this.wtm.changedFiles(cwd, rec.baseSha);

    const scope = [...policy.checkScope(changed, design.scopeAllowlist), ...policy.checkProtectedPaths(changed)];
    if (scope.length) {
      for (const v of scope) this.events.append({ taskId, type: 'POLICY_BLOCK', phase: 'verify', payload: { ...v } });
      const protectedHit = scope.some((v) => v.rule === 'PROTECTED_PATH');
      if (protectedHit) return this.escalate(taskId, 'VERIFY', `protected path in change set: ${scope[0].detail}`) as any;
      // Non-protected out-of-scope: auto-expand with the record, per policy.
      const extra = scope.filter((v) => v.rule === 'OUT_OF_ALLOWLIST').map((v) => v.detail);
      const dec = policy.scopeExpansionDecision(rec.risk, extra, `files touched during implementation: ${extra.join(', ')}`);
      if (!dec.allow) return this.escalate(taskId, 'VERIFY', `out-of-scope changes refused: ${extra.join(', ')}`) as any;
      const d2 = { ...design, revision: design.revision + 1, scopeAllowlist: [...design.scopeAllowlist, ...extra],
        appliedFindings: [...design.appliedFindings, `scope-expansion:auto`] };
      this.recordRevision(taskId, d2, d2.revision, d2.appliedFindings);
    }

    const impact = checks.affectedSpecs(cwd, changed);
    this.events.append({ taskId, type: 'EVIDENCE', phase: 'verify',
      payload: { impactSpecs: impact.specs, impactRationale: impact.rationale.slice(0, 30) } });

    const results: CheckResult[] = [];
    results.push(this.check(taskId, 'verify', checks.typecheck(cwd)));
    results.push(this.check(taskId, 'verify', checks.targetedTests(cwd, impact.specs)));
    if (rec.risk === 'high') results.push(this.check(taskId, 'verify', checks.stage0(cwd)));
    for (const r of results) {
      this.events.append({ taskId, type: 'TEST_RESULT', phase: 'verify',
        payload: { name: r.name, ok: r.ok, detail: r.detail, tier: 'fast-gate', durationMs: r.durationMs } });
    }
    return results.every((r) => r.ok);
  }

  /** One fix invocation (fast loop: targeted tests only afterwards). */
  private async fixCycle(taskId: string, cwd: string, rec: TaskRecord, design: DesignRevision,
    fixes: Finding[], reason: string): Promise<'ok' | TaskState> {
    this.setState(taskId, this.task(taskId)!.state, 'FIX', 'fix', reason.slice(0, 40));
    const res = await this.agent(taskId, {
      agent: 'claude-code', cwd, phase: 'fix', timeoutMs: 25 * 60_000,
      requiredKeys: ['status', 'filesChanged'],
      prompt: fixPrompt(rec, design, fixes, reason),
    }, 'fix');
    if (res.rateLimited) return this.pauseRateLimit(taskId, 'FIX', 'fix');
    if (!res.ok) return this.escalate(taskId, 'FIX', `fix failed [${res.failureKind}]: ${res.error}`);
    const head = this.wtm.commitAll(cwd, `${taskId}: fix — ${reason}`.slice(0, 100)) ?? this.wtm.head(cwd);
    this.events.append({ taskId, type: 'CODE_CHANGE', phase: 'fix',
      payload: { headSha: head, filesChanged: (res.structured as any)?.filesChanged ?? [] } });
    this.setState(taskId, 'FIX', 'VERIFY', 'verify', 'post-fix');
    return 'ok';
  }

  /** Review + bounded fix loop with the blocker-progress rule. */
  private async reviewLoop(taskId: string, cwd: string, rec: TaskRecord, design: DesignRevision):
    Promise<'ok' | TaskState> {
    const budget = policy.budgetFor(rec.risk);
    const materialHistory: number[] = [];

    for (let cycle = 0; cycle <= budget.materialCycles; cycle++) {
      const diff = this.wtm.diff(cwd, rec.baseSha).slice(0, 350_000);
      const rev = await this.agent(taskId, {
        agent: 'codex', cwd, phase: `review/cycle-${cycle + 1}`, timeoutMs: 20 * 60_000,
        requiredKeys: ['findings'],
        prompt: reviewPrompt(rec, design, diff),
      }, 'review');
      if (rev.rateLimited) return this.pauseRateLimit(taskId, 'REVIEW', 'review');
      if (!rev.ok) {
        // A failed reviewer is an execution problem, not a blocker for LOW.
        if (rec.risk === 'low') { this.events.append({ taskId, type: 'NOTE', payload: { reviewSkipped: rev.error } }); return 'ok'; }
        return this.escalate(taskId, 'REVIEW', `review failed [${rev.failureKind}]: ${rev.error}`);
      }
      const findings = this.recordFindings(taskId, 'review', (rev.structured as any)?.findings ?? []);
      const material = findings.filter((f) => f.severity !== 'SUGGESTION' && policy.findingMayBlock(f) || f.severity === 'IMPORTANT');
      if (!material.length) return 'ok';

      const adj = await this.adjudicate(taskId, cwd, rec, material, design, 'review');
      if (adj === 'RATE_LIMIT') return this.pauseRateLimit(taskId, 'REVIEW', 'review');

      const after = allFindings(this.events, taskId);
      const toFix = after.filter((f) => f.status === 'FIX' || f.status === 'DETERMINISTICALLY_CONFIRMED');
      const openMaterial = policy.materialFindings(after).filter((f) => f.status === 'UNRESOLVED' || f.status === 'FIX' || f.status === 'DETERMINISTICALLY_CONFIRMED');
      materialHistory.push(openMaterial.length);

      if (policy.blockerProgressStalled(materialHistory)) {
        const crit = policy.unresolvedCritical(after);
        if (crit.length) {
          return this.awaitHuman(taskId, 'REVIEW', policy.decisionRequest('UNRESOLVED_CRITICAL_DISPUTE', {
            issue: `${crit.length} CRITICAL finding(s) unresolved after ${materialHistory.length} cycles`,
            why: 'Material blocker count has not decreased for two consecutive cycles; automatic debate stopped.',
            evidence: crit.map((f) => `${f.findingId}: ${f.claim.slice(0, 160)}`),
            recommended: 'Reject the findings and continue: deterministic gates are green.',
            whyRecommended: 'No deterministic evidence supports the claims; tests and checks pass.',
            alternatives: ['Fix as demanded', 'Cancel the task'],
            riskApproved: 'A theoretically-argued defect ships if the reviewer was right.',
            riskRejected: 'Another fix cycle with no new evidence.',
          }));
        }
        this.events.append({ taskId, type: 'NOTE', payload: {
          disagreementRecorded: openMaterial.map((f) => f.findingId),
          resolution: 'best-supported implementation continues; non-critical disagreement documented' } });
        return 'ok';
      }

      if (!toFix.length) return 'ok';
      if (cycle >= budget.materialCycles) {
        const crit = policy.unresolvedCritical(after);
        if (crit.length) {
          return this.awaitHuman(taskId, 'REVIEW', policy.decisionRequest('UNRESOLVED_CRITICAL_DISPUTE', {
            issue: 'CRITICAL findings remain at review budget exhaustion',
            why: `Review budget for risk=${rec.risk} is ${budget.materialCycles} material cycle(s).`,
            evidence: crit.map((f) => `${f.findingId}: ${f.claim.slice(0, 160)}`),
            recommended: 'Approve one additional fix cycle.',
            whyRecommended: 'The findings are concrete and adjudicated FIX.',
            alternatives: ['Reject findings and continue', 'Cancel'],
            riskApproved: 'One more bounded cycle of time.',
            riskRejected: 'Ship with an adjudicated-confirmed critical finding — not permitted.',
          }));
        }
        this.events.append({ taskId, type: 'NOTE', payload: { deferredAtBudget: toFix.map((f) => f.findingId) } });
        return 'ok';
      }

      const fixed = await this.fixCycle(taskId, cwd, rec, design, toFix, `review cycle ${cycle + 1}`);
      if (fixed !== 'ok') return fixed;
      const gate = await this.fastGate(taskId, cwd, rec, design);
      if (gate === 'ESCALATED' || gate === 'AWAITING_HUMAN') return gate as TaskState;
      if (!gate) return this.escalate(taskId, 'VERIFY', 'fast gate failing after fix cycle');
      this.setState(taskId, 'VERIFY', 'REVIEW', 'review', `re-review-${cycle + 2}`);
    }
    return 'ok';
  }

  /**
   * Final authoritative acceptance on the final candidate HEAD. HIGH runs the
   * full battery; Stage -1 runs behind the global lock while the independent
   * final review proceeds in parallel on the same immutable SHA.
   */
  private async finalAcceptance(taskId: string, cwd: string, rec: TaskRecord, design: DesignRevision):
    Promise<'ok' | TaskState> {
    const results: CheckResult[] = [];
    const record = (r: CheckResult) => {
      results.push(this.check(taskId, 'final', r));
      this.events.append({ taskId, type: 'TEST_RESULT', phase: 'final',
        payload: { name: r.name, ok: r.ok, detail: r.detail, tier: 'final-acceptance', durationMs: r.durationMs } });
    };

    const preds = checks.runPredictionChecks(cwd, design.predictions);
    preds.results.forEach(record);
    if (preds.unverified.length) {
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'final',
        payload: { notVerified: preds.unverified } });
    }

    if (rec.risk === 'low') {
      // fast gate already covered LOW; predictions above complete it.
    } else if (rec.risk === 'medium') {
      record(checks.stage0(cwd));
    } else {
      // HIGH: stage0, then Stage -1 (locked) in parallel with nothing else that
      // touches the DB — reconciliation runs after the suite completes.
      record(checks.stage0(cwd));
      record(checks.stageMinus1(cwd, taskId));
      record(checks.perDocumentReconciliation());
      record(checks.cacheLedgerReconciliation());
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      const sigDrift = failed.find((r) => /SIGNATURE DRIFT/i.test(r.detail));
      if (sigDrift) {
        return this.awaitHuman(taskId, 'FINAL_ACCEPTANCE', policy.decisionRequest('REBASELINE', {
          issue: 'Known-failing Stage -1 tests changed failure signature',
          why: 'A known failure failing for a NEW reason cannot be auto-accepted; the baseline is never auto-rewritten.',
          evidence: [sigDrift.detail],
          recommended: 'Investigate the drifted tests before accepting.',
          whyRecommended: 'Signature drift is how silent regressions hide inside known failures.',
          alternatives: ['Accept drift and rebaseline (records HUMAN_DECISION)', 'Cancel'],
          riskApproved: 'A masked regression may ship.',
          riskRejected: 'Task stays blocked until investigated.',
        }));
      }
      return this.escalate(taskId, 'FINAL_ACCEPTANCE', `final acceptance failed: ${failed.map((f) => f.name).join(', ')}`);
    }

    this.events.append({ taskId, type: 'EVIDENCE', phase: 'final', payload: {
      verified: results.map((r) => `${r.name}: ${r.detail}`.slice(0, 200)),
      notVerified: preds.unverified,
    } });
    return 'ok';
  }

  // -------------------------------------------------------------------------
  // Merge + deploy (distinct audited operations, even when both automatic)
  // -------------------------------------------------------------------------

  gateSummary(taskId: string): policy.GateSummary {
    const evs = this.events.read(taskId);
    // Only the LATEST result of each named check/test gates anything: a re-run
    // after a fix supersedes its failure. Without this, one historical red
    // check vetoed auto-merge forever. Merge/deploy-phase checks are outcomes
    // of the operation itself, not preconditions, and are excluded.
    const latest = (type: string) => {
      const m = new Map<string, any>();
      for (const e of evs) {
        if (e.type !== type) continue;
        if (e.phase === 'merge' || e.phase === 'deploy') continue;
        const p = e.payload as any;
        m.set(`${e.phase ?? ''}:${p.name}`, p);
      }
      return [...m.values()];
    };
    const tests = latest('TEST_RESULT');
    const findings = allFindings(this.events, taskId);
    const rel = this.releaseState();
    const backup = fs.existsSync('/srv/ai-accounting/backups/production/latest');
    return {
      deterministicOk: latest('DETERMINISTIC_CHECK').every((p) => p.ok !== false),
      testsOk: tests.length > 0 && tests.every((t) => t.ok),
      criticalOpen: policy.unresolvedCritical(findings).length,
      evidenceConflict: false,
      backupVerified: backup,
      rollbackShaExists: Boolean(rel.currentSha),
      protectedTriggerHit: Boolean(this.task(taskId)?.awaitingHuman),
    };
  }

  releaseState(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      for (const line of fs.readFileSync('/srv/ai-accounting/state/release.env', 'utf8').split('\n')) {
        const m = /^([a-zA-Z]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2];
      }
    } catch { /* none */ }
    return out;
  }

  /** Merge SHA safety: approved == reviewed == branch HEAD, verified server-side. */
  performMerge(taskId: string, rec: TaskRecord, approvedSha: string, approvedBy: string):
    { ok: boolean; detail: string; mergeSha?: string } {
    const branchHead = this.wtm.git(['rev-parse', rec.branch], this.repo, true).trim();
    const reviewedSha = rec.headSha;
    if (!policy.mergeShaSafe(approvedSha, reviewedSha, branchHead)) {
      const detail = `SHA mismatch: approved=${approvedSha.slice(0, 9)} reviewed=${reviewedSha.slice(0, 9)} head=${branchHead.slice(0, 9)}`;
      this.events.append({ taskId, type: 'MERGE_RESULT', payload: { ok: false, detail, approvedBy } });
      return { ok: false, detail };
    }
    if (!checks.mergeLock.tryAcquire(taskId)) return { ok: false, detail: `merge lock busy: ${checks.mergeLock.holder()}` };
    try {
      const g = (args: string[], cwd: string, allowFail = false) => this.wtm.git(args, cwd, allowFail);
      if (!fs.existsSync(MERGE_WT)) {
        g(['worktree', 'add', MERGE_WT, 'main'], this.repo);
      }
      // Build support (node_modules links) so the post-merge typecheck can
      // actually run; without it tsc "fails" in 10ms having never started.
      this.wtm.provision(MERGE_WT);
      g(['fetch', 'origin', '--quiet'], MERGE_WT, true);
      g(['checkout', 'main'], MERGE_WT, true);
      // The merge worktree holds no local work; hard-sync to origin is safe here
      // and is the only reset in the system.
      g(['reset', '--hard', 'origin/main'], MERGE_WT);
      try {
        g(['merge', '--no-ff', '--no-edit', rec.branch], MERGE_WT);
      } catch (e: any) {
        g(['merge', '--abort'], MERGE_WT, true);
        const detail = `merge conflict or hook refusal: ${String(e?.message).slice(0, 200)}`;
        this.events.append({ taskId, type: 'MERGE_RESULT', payload: { ok: false, detail, approvedBy } });
        return { ok: false, detail };
      }
      const mergeSha = g(['rev-parse', 'HEAD'], MERGE_WT).trim();
      // Post-merge sanity on the merged tree before publishing.
      const t = checks.typecheck(MERGE_WT);
      this.check(taskId, 'merge', t);
      if (!t.ok) {
        g(['reset', '--hard', 'origin/main'], MERGE_WT);
        this.events.append({ taskId, type: 'MERGE_RESULT', payload: { ok: false, detail: `post-merge typecheck failed`, approvedBy } });
        return { ok: false, detail: 'post-merge typecheck failed; nothing pushed' };
      }
      try {
        g(['push', 'origin', 'main'], MERGE_WT);
      } catch (e: any) {
        g(['reset', '--hard', 'origin/main'], MERGE_WT);
        const detail = `push failed: ${String(e?.message).slice(0, 200)}`;
        this.events.append({ taskId, type: 'MERGE_RESULT', payload: { ok: false, detail, approvedBy } });
        return { ok: false, detail };
      }
      this.events.append({ taskId, type: 'MERGE_RESULT', payload: {
        ok: true, mergeSha, approvedBy, approvedSha, targetBranch: 'main',
        originMain: g(['rev-parse', 'origin/main'], MERGE_WT, true).trim(),
      } });
      return { ok: true, detail: 'merged and pushed', mergeSha };
    } finally {
      checks.mergeLock.release();
    }
  }

  performDeploy(taskId: string, approvedBy: string): { ok: boolean; detail: string } {
    if (!checks.deployLock.tryAcquire(taskId)) return { ok: false, detail: `deploy lock busy` };
    try {
      const pre = spawnSync(DEPLOY_BIN, ['preflight'], { encoding: 'utf8', timeout: 180_000 });
      const preJson = /RESULT:(\{[\s\S]*?\})\s*$/m.exec((pre.stdout ?? '') + (pre.stderr ?? ''));
      const preflight = preJson ? JSON.parse(preJson[1]) : { ok: false, problems: ['no preflight result'] };
      this.events.append({ taskId, type: 'DETERMINISTIC_CHECK', phase: 'deploy', payload: { name: 'deploy-preflight', ...preflight } });
      if (!preflight.ok) {
        this.events.append({ taskId, type: 'DEPLOY_RESULT', payload: { ok: false, detail: preflight.problems?.join('; '), approvedBy } });
        return { ok: false, detail: `preflight refused: ${preflight.problems?.join('; ')}` };
      }
      const r = spawnSync(DEPLOY_BIN, ['apply', '--sha', preflight.candidateSha], { encoding: 'utf8', timeout: 45 * 60_000 });
      const rel = this.releaseState();
      const ok = r.status === 0 && rel.result === 'DEPLOYED' && rel.currentSha === preflight.candidateSha;
      this.events.append({ taskId, type: 'DEPLOY_RESULT', payload: {
        ok, approvedBy, deployedSha: rel.currentSha ?? null, previousSha: rel.previousSha ?? null,
        detail: ok ? rel.detail : `deploy exited ${r.status}`, rollbackSha: preflight.rollbackTarget ?? null,
      } });
      return ok ? { ok: true, detail: `deployed ${rel.currentSha?.slice(0, 9)}` }
        : { ok: false, detail: `deploy exited ${r.status}: ${((r.stdout ?? '') + (r.stderr ?? '')).slice(-300)}` };
    } finally {
      checks.deployLock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Human decisions
  // -------------------------------------------------------------------------

  /**
   * Re-enters an escalated task at the last non-terminal state it held. The
   * cause is expected to be fixed (or explicitly accepted) by the operator;
   * the re-entry is recorded, never silent.
   */
  retryFromEscalation(taskId: string, by: string): boolean {
    const rec = this.task(taskId);
    if (!rec || rec.state !== 'ESCALATED') return false;
    const evs = this.events.read(taskId);
    let last: TaskState = 'DESIGN';
    for (const e of evs) {
      if (e.type === 'STATE_CHANGED') {
        const to = (e.payload as any).to as TaskState;
        if (!['ESCALATED', 'FAILED', 'CANCELLED', 'AWAITING_HUMAN'].includes(to)) last = to;
      }
    }
    this.events.append({ taskId, type: 'NOTE', payload: { retryAuthorized: by, reenteringAt: last } });
    this.setState(taskId, 'ESCALATED', last, 'retry', `by ${by}`);
    return true;
  }

  /** READY_TO_DEPLOY tasks eligible to continue when the toggle turns on. */
  readyToDeployTasks(): string[] {
    return this.events.listTasks()
      .filter((id) => /^TASK-V2-\d+$/.test(id))
      .filter((id) => this.task(id)?.state === 'READY_TO_DEPLOY');
  }

  resolveHumanDecision(taskId: string, decisionId: string, choice: string, by: string): boolean {
    const rec = this.task(taskId);
    if (!rec?.awaitingHuman || rec.awaitingHuman.decisionId !== decisionId) return false;
    this.events.append({ taskId, type: 'HUMAN_DECISION', payload: { decisionId, choice, decidedBy: by } });
    this.setState(taskId, 'AWAITING_HUMAN', 'REVIEW', 'human', 'resolved', {});
    return true;
  }
}

// ---------------------------------------------------------------------------
// Prompts — concise, risk-scaled (a two-line fix does not get a treatise)
// ---------------------------------------------------------------------------

function designPrompt(rec: TaskRecord): string {
  const depth = rec.risk === 'high'
    ? `This is a HIGH accounting-impact task. Include:
- precise invariants (each one falsifiable),
- predictions with an executable "check" where possible (jest/tsc/node -e commands relative to packages/server),
- required tests and acceptance requirements.`
    : `This is a ${rec.risk.toUpperCase()} task. Keep the design CONCISE: a short plan, the affected scope, realistic risk, required tests. Do not write long invariants for a small change.`;
  return `You are the architect for an autonomous development task. Investigate the repository (read-only) and produce a design.

TASK ${rec.taskId} (risk=${rec.risk}):
${rec.description}

${depth}

Reply with ONLY a JSON object:
{"scopeAllowlist": ["path", ...], "outOfScope": ["path — why", ...], "plan": "...",
 "invariants": ["..."], "predictions": [{"text": "...", "check": "node_modules/.bin/jest ... (optional)"}],
 "requiredTests": ["..."], "acceptance": ["..."]}`;
}

function designReviewPrompt(rec: TaskRecord, d: DesignRevision): string {
  return `Independently review this design before implementation. You are a reviewer, not a veto: a blocking finding must state a concrete claim, a plausible scenario, affected behaviour and why tests would miss it. Use severities CRITICAL (realistic financial corruption / tenant leakage / security breach / data loss / fundamentally wrong result), IMPORTANT (concrete real bug or meaningful weakness), SUGGESTION (style, preference, theory — never blocks).

TASK ${rec.taskId} (risk=${rec.risk}): ${rec.title}

DESIGN:
${JSON.stringify(d, null, 2)}

Reply ONLY JSON: {"findings": [{"findingId": "D-1", "severity": "...", "category": "...", "claim": "...", "file": "...", "scenario": "...", "confidence": "..."}]}`;
}

function adjudicatePrompt(rec: TaskRecord, findings: Finding[], d: DesignRevision, isDesign: boolean): string {
  return `Adjudicate these findings CONCISELY. For each: status FIX | TEST_TO_DECIDE | DEFER | REJECT, one short reasoning. If TEST_TO_DECIDE, provide "check": an executable command (node_modules/.bin/jest …, node_modules/.bin/tsc …, or node -e "…") relative to packages/server whose exit code decides it — the evidence outranks both of you.
${isDesign ? 'If any finding is FIX, also return "revisedDesign": the COMPLETE corrected design object (same shape as the original) with every correction applied IN PLACE. Superseded wording must be deleted, not annotated. There is exactly one canonical design.' : ''}

TASK ${rec.taskId} (risk=${rec.risk})
DESIGN: ${JSON.stringify(d).slice(0, 8000)}
FINDINGS: ${JSON.stringify(findings, null, 1).slice(0, 8000)}

Reply ONLY JSON: {"adjudications": [{"findingId": "...", "status": "...", "reasoning": "...", "check": "..."}]${isDesign ? ', "revisedDesign": {...}' : ''}}`;
}

function implementPrompt(rec: TaskRecord, d: DesignRevision): string {
  return `Implement this design in the current repository (an isolated task worktree — commit nothing yourself; the orchestrator commits).

TASK ${rec.taskId} (risk=${rec.risk}): ${rec.description}

CANONICAL DESIGN (revision ${d.revision} — authoritative):
${JSON.stringify(d, null, 2).slice(0, 12000)}

Rules:
- Modify only files inside scopeAllowlist. If genuinely impossible, return status SCOPE_EXPANSION_REQUIRED with requestedPaths and a concrete reason.
- Add the required tests. Never delete or skip a test to make a gate pass. Never use --no-verify.
- Finish before you answer. A turn that ends without the JSON below is a failed run.

Reply ONLY JSON: {"status": "IMPLEMENTED"|"SCOPE_EXPANSION_REQUIRED"|"FAILED", "filesChanged": [], "testsAdded": [], "requestedPaths": [], "reason": ""}`;
}

function reviewPrompt(rec: TaskRecord, d: DesignRevision, diff: string): string {
  return `Independently review this implementation. Severities: CRITICAL (realistic financial corruption / tenant leakage / security breach / irreversible loss / fundamentally wrong result), IMPORTANT (concrete bug or meaningful weakness), SUGGESTION (style/preference — never blocks). A CRITICAL finding must include a concrete scenario; theory alone cannot block.

TASK ${rec.taskId} (risk=${rec.risk}): ${rec.title}
DESIGN: ${JSON.stringify(d).slice(0, 6000)}

DIFF (task worktree vs base):
${diff}

Reply ONLY JSON: {"findings": [{"findingId": "R-1", "severity": "...", "category": "...", "claim": "...", "file": "...", "scenario": "...", "confidence": "..."}]}`;
}

function fixPrompt(rec: TaskRecord, d: DesignRevision, fixes: Finding[], reason: string): string {
  return `Apply these adjudicated fixes (${reason}). Only these — do not refactor beyond them. Stay inside the design scopeAllowlist.

TASK ${rec.taskId}
DESIGN SCOPE: ${JSON.stringify(d.scopeAllowlist)}
FIXES:
${JSON.stringify(fixes.map((f) => ({ findingId: f.findingId, claim: f.claim, file: f.file, evidence: f.evidence })), null, 1).slice(0, 8000)}

Finish before you answer. Reply ONLY JSON: {"status": "IMPLEMENTED"|"FAILED", "filesChanged": [], "reason": ""}`;
}
