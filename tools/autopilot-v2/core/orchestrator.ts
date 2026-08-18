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
import * as procs from './procs';
import { WorktreeManager } from './worktrees';
import * as checks from './checks';
import * as policy from './policy';
import { automaticDeploymentEnabled } from './settings';
import { generateReport } from './report';
import * as models from './models';
import * as graphify from './graphify';
import * as ctx from './context';
import { buildTaskPack, buildFixPack, buildCodexMap } from './contextbuild';
import { eventCoupling } from './eventindex';
import { ToolEvidence, reconcileClaims, findingIsSupported } from './toolevidence';

const CONTROL_REPO = process.env.AI_V2_REPO ?? '/srv/ai-accounting/repo';
const DEPLOY_BIN = process.env.AI_DEPLOY_BIN ?? '/srv/ai-accounting/bin/deploy-production';
const MERGE_WT = path.join(STATE_ROOT, 'merge-main');

export class Orchestrator {
  readonly wtm: WorktreeManager;
  private running = new Set<string>();
  /** Cancellation tokens: set the moment the owner clicks Cancel. */
  private cancelled = new Set<string>();

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

  createTask(description: string, risk: Risk,
    opts?: { modelOverrides?: Record<string, { model?: string; reasoning?: string | null }> }): TaskRecord {
    // Model policy is resolved and validated BEFORE the task exists, then
    // snapshotted immutably — later global changes never rewrite a task.
    const rp = models.resolvePolicy(opts?.modelOverrides);
    if (!rp.ok) throw new Error(rp.error);
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
    this.events.append({ taskId, type: 'TASK_MODEL_POLICY', payload: {
      policy: rp.policy, source: opts?.modelOverrides ? 'task-overrides' : 'global-defaults',
      overrides: opts?.modelOverrides ?? null } });
    // Entitle this task to exactly one graph: the one matching its base SHA.
    // graphify-task resolves through this pointer, so a task can never reach
    // another task's graph or an arbitrary path.
    graphify.registerTask(taskId, baseSha);
    this.ensureGraphFor(baseSha);
    return deriveTask(this.events, taskId)!;
  }

  task(taskId: string): TaskRecord | null { return deriveTask(this.events, taskId); }

  private setState(taskId: string, from: TaskState, to: TaskState, phase = '', subPhase = '',
    extra: Record<string, unknown> = {}): void {
    // No state progression may survive cancellation. deriveTask also ignores
    // such events, but refusing to write them keeps the log honest.
    if (this.isCancelled(taskId) && to !== 'CANCELLED' && to !== 'CANCELLING') {
      this.noteAfterCancel(taskId, `state transition ${from} → ${to} refused`);
      return;
    }
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

  /**
   * Real cancellation: state first goes to CANCELLING, the task's own process
   * groups are terminated (TERM, brief grace, then KILL), and only once the
   * tree is verified gone does the task become CANCELLED. The task stays in the
   * `running` set until then so no second pipeline can start underneath us.
   */
  async cancel(taskId: string, by: string, reason: string): Promise<{ cancelled: boolean; evidence: unknown }> {
    const rec = this.task(taskId);
    if (rec && (rec.state === 'CANCELLED' || rec.state === 'CANCELLING')) {
      return { cancelled: rec.state === 'CANCELLED', evidence: 'already cancelling/cancelled' };
    }
    this.cancelled.add(taskId);
    this.events.append({ taskId, type: 'CANCEL_REQUESTED', payload: { cancelledBy: by, reason } });
    this.stream.append(taskId, 'system', 'lifecycle', `cancelling: ${reason} — stopping task processes`);

    const before = procs.runsForTask(taskId).map((h) => ({ pid: h.pid, kind: h.kind, label: h.label }));
    const term = await procs.terminateTaskRuns(taskId, 5000);
    this.events.append({ taskId, type: 'PROCESS_TERMINATED', payload: {
      requestedBy: by, runsFound: before.length, runs: term.attempted, allGone: term.allGone } });
    for (const a of term.attempted) {
      this.stream.append(taskId, 'system', 'lifecycle',
        `terminated ${a.label} pid ${a.pid} (group ${a.pgid})${a.forced ? ' [SIGKILL]' : ''}${a.alive ? ' — STILL ALIVE' : ''}`);
    }

    if (!term.allGone) {
      // Stay in CANCELLING and say so; never claim CANCELLED over a live tree.
      this.stream.append(taskId, 'system', 'error',
        'some task processes survived termination; task stays CANCELLING for owner attention');
      return { cancelled: false, evidence: term };
    }

    this.events.append({ taskId, type: 'TASK_CANCELLED', payload: {
      cancelledBy: by, reason, processesTerminated: term.attempted.length, verifiedNoSurvivors: true } });
    this.stream.append(taskId, 'system', 'lifecycle',
      `cancelled: ${reason} (${term.attempted.length} process group(s) terminated and verified gone)`);
    this.running.delete(taskId);
    this.maybeAutoFinalReport(taskId, 'CANCELLED');
    return { cancelled: true, evidence: term };
  }

  /**
   * Explicit owner recovery of a cancelled task — deliberately NOT the Resume
   * button. Clears the cancellation token and re-enters at the last live state.
   */
  recoverCancelled(taskId: string, by: string): boolean {
    const rec = this.task(taskId);
    if (!rec || (rec.state !== 'CANCELLED' && rec.state !== 'CANCELLING')) return false;
    if (procs.runsForTask(taskId).length) return false; // never recover over live processes
    this.cancelled.delete(taskId);
    let last: TaskState = 'DESIGN';
    for (const e of this.events.read(taskId)) {
      if (e.type === 'STATE_CHANGED') {
        const to = (e.payload as any).to as TaskState;
        if (!['ESCALATED', 'FAILED', 'CANCELLED', 'CANCELLING', 'AWAITING_HUMAN', 'PAUSED', 'PAUSED_RATE_LIMIT'].includes(to)) last = to;
      }
    }
    this.events.append({ taskId, type: 'TASK_RECOVERED', payload: { recoveredBy: by, reenteringAt: last } });
    this.events.append({ taskId, type: 'STATE_CHANGED', phase: 'recovery', payload: { from: rec.state, to: last, recoveredBy: by } });
    this.stream.append(taskId, 'system', 'lifecycle', `recovered from CANCELLED by ${by} → ${last}`);
    return true;
  }

  /**
   * Keeps the graph cache moving with origin/main.
   *
   * When main advances, the existing graph becomes stale for every new task and
   * — until this existed — stayed stale until somebody pressed Rebuild, so task
   * after task silently reviewed without blast-radius context. The rebuild is
   * asynchronous and never gates the task: the task proceeds on direct source
   * inspection and later tasks on the same SHA get the finished graph.
   */
  private ensureGraphFor(baseSha: string): void {
    if (!graphify.isAvailable()) return;
    if (graphify.graphFor(baseSha).usable) return;
    if (graphify.isBuilding()) return;
    setImmediate(() => {
      graphify.buildGraph(baseSha, this.repo, (dir, atSha) => {
        execFileSync('git', ['-C', this.repo, 'worktree', 'add', '--detach', dir, atSha],
          { encoding: 'utf8', timeout: 600_000 });
      }).then((r) => {
        this.events.append({ taskId: 'SYSTEM-SETTINGS', type: 'NOTE', payload: {
          graphAutoRebuild: { sha: baseSha, ok: r.ok, detail: r.detail } } });
      }).catch(() => { /* the graph is an optimisation, never a dependency */ });
    });
  }

  /** True once cancellation was requested — checked everywhere before mutating. */
  isCancelled(taskId: string): boolean {
    if (this.cancelled.has(taskId)) return true;
    const s = this.task(taskId)?.state;
    return s === 'CANCELLED' || s === 'CANCELLING';
  }

  /**
   * Records an event that arrived from a cancelled run as diagnostics only:
   * clearly marked, never state-mutating.
   */
  private noteAfterCancel(taskId: string, what: string, detail: Record<string, unknown> = {}): void {
    this.events.append({ taskId, type: 'NOTE', payload: {
      afterCancel: 'AFTER_CANCEL / IGNORED', what, ...detail } });
    this.stream.append(taskId, 'system', 'lifecycle', `AFTER_CANCEL / IGNORED: ${what}`);
  }

  isRunning(taskId: string): boolean { return this.running.has(taskId); }

  // -------------------------------------------------------------------------
  // Agent helpers
  // -------------------------------------------------------------------------

  /** The task's immutable model-policy snapshot (created at task start; legacy tasks get one on first use). */
  taskModelPolicy(taskId: string): Record<string, models.ResolvedRole> {
    const evs = this.events.read(taskId);
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].type === 'TASK_MODEL_POLICY') return (evs[i].payload as any).policy ?? {};
    }
    const r = models.resolvePolicy();
    const policy = r.ok ? r.policy : {};
    this.events.append({ taskId, type: 'TASK_MODEL_POLICY', payload: {
      policy, source: 'global-defaults', note: 'backfilled for a task created before role-based models' } });
    return policy;
  }

  /** Explicit owner action: re-snapshot this task's models from current defaults. */
  updateTaskModels(taskId: string, by: string): boolean {
    const r = models.resolvePolicy();
    if (!r.ok) return false;
    this.events.append({ taskId, type: 'TASK_MODEL_POLICY', payload: {
      policy: r.policy, source: 'owner-update', actor: by } });
    this.stream.append(taskId, 'system', 'lifecycle', `task model policy updated to current defaults by ${by}`);
    return true;
  }

  private static MODEL_UNAVAILABLE =
    /model metadata for .* not found|invalid model|unknown model|no such model|model .*not (found|available|exist)/i;

  private async agent(taskId: string, spec: Omit<AgentSpec, 'taskId'>, phase: string) {
    // Role → concrete model/reasoning from the task's snapshot, never live
    // globals: a task keeps the semantics it started with.
    const rr = spec.role ? this.taskModelPolicy(taskId)[spec.role] : undefined;
    let runSpec: Omit<AgentSpec, 'taskId'> = {
      ...spec,
      model: spec.model ?? rr?.model,
      reasoning: spec.reasoning !== undefined ? spec.reasoning : (rr?.reasoning ?? null),
    };
    // Gate 1: never start an agent for a task that is cancelling.
    if (this.isCancelled(taskId)) {
      this.noteAfterCancel(taskId, `agent ${spec.agent} (${spec.phase}) not started`);
      return { ok: false, structured: null, text: '', exitCode: null, durationMs: 0, rateLimited: false,
        failureKind: 'AGENT_EXECUTION_ERROR', error: 'task cancelled', attempts: 0, usage: null, cancelled: true };
    }
    // Graphify status is generated here from the real cache state and handed to
    // the agent, so availability is never something the agent has to discover
    // (TASK-V2-0011 probed `command -v graphify`, found nothing, and silently
    // gave up on a graph that existed).
    const rec0 = this.task(taskId);
    const gfyStatus = rec0 ? graphify.statusBlockFor(rec0.baseSha) : null;
    if (gfyStatus && !spec.prompt.includes('GRAPHIFY STATUS')) {
      runSpec = { ...runSpec, prompt: `${gfyStatus}\n\n${runSpec.prompt}` };
    }
    // Structured Context Memory. Codex receives the structural MAP only —
    // never another agent's conclusions — so reviewer independence survives
    // the optimisation.
    const pack = spec.contextPack ?? null;
    if (pack && !spec.prompt.includes('TASK CONTEXT') && !spec.prompt.includes('FIX CONTEXT')
        && !spec.prompt.includes('STRUCTURAL MAP')) {
      runSpec = { ...runSpec, prompt: `${pack.text}\n\n${runSpec.prompt}` };
    }
    const startedAt = new Date().toISOString();
    this.events.append({ taskId, type: 'AGENT_STARTED', agent: spec.agent as any, phase, payload: {
      subPhase: spec.phase, role: spec.role ?? null, provider: spec.agent,
      requestedModel: runSpec.model ?? null, reasoningEffort: runSpec.reasoning ?? null, startedAt,
      graphifyStatus: gfyStatus ? gfyStatus.split('\n').slice(1).join('; ') : null,
      contextPackUsed: !!pack,
      contextPackType: pack?.type ?? null,
      contextBytes: pack?.bytes ?? 0,
      contextTokensApprox: pack?.tokensApprox ?? 0,
      contextEntries: pack?.entries ?? 0,
      contextCounts: pack?.counts ?? null,
      contextCondensed: pack?.condensed ?? false,
      contextBaseSha: rec0?.baseSha ?? null } });

    const onRetry = (kind: string, err: string) => {
      this.events.append({ taskId, type: 'NOTE', agent: spec.agent as any, phase, attempt: 2,
        payload: { retry: true, failureKind: kind, reason: err.slice(0, 300) } });
    };
    const isCancelled = () => this.isCancelled(taskId);
    let res = await runAgentBounded({ ...runSpec, taskId, isCancelled }, this.stream, onRetry);
    let fallbackModel: string | null = null;

    // Gate 2: the run finished (or was killed) after cancellation — its result
    // is diagnostics, never state. This is the path that previously wrote
    // AGENT_FAILED and escalated a cancelled task.
    if (this.isCancelled(taskId)) {
      this.noteAfterCancel(taskId, `${spec.agent} result discarded (${spec.phase})`, {
        exitCode: res.exitCode ?? null, failureKind: res.failureKind ?? null, durationMs: res.durationMs });
      return { ...res, ok: false, cancelled: true, structured: null };
    }

    // Model-unavailable → the role's configured fallback, SAME provider only.
    // A silent provider switch is architecturally forbidden.
    if (!res.ok && !res.rateLimited && rr && Orchestrator.MODEL_UNAVAILABLE.test(res.error ?? '')) {
      const fb = models.fallbackFor(rr);
      if (fb.action === 'model') {
        fallbackModel = fb.model;
        this.events.append({ taskId, type: 'NOTE', payload: { modelFallback: {
          role: rr.role, provider: rr.provider, requested: rr.model, fallbackTo: fb.model,
          policy: rr.fallback, reason: (res.error ?? '').slice(0, 200) } } });
        this.stream.append(taskId, 'system', 'lifecycle',
          `model ${rr.model} unavailable for ${rr.role}; fallback → ${fb.model} (same provider)`);
        res = await runAgentBounded({ ...runSpec, model: fb.model, taskId }, this.stream, onRetry);
        // Keep the ORIGINAL request visible so the fallback is never hidden.
        res = { ...res, requestedModel: rr.model };
      } else {
        this.events.append({ taskId, type: 'NOTE', payload: { modelUnavailablePaused: {
          role: rr.role, provider: rr.provider, requested: rr.model, policy: rr.fallback } } });
        this.setState(taskId, this.task(taskId)!.state, 'PAUSED', phase, 'model-unavailable', {
          note: `${rr.model} unavailable for ${rr.role}; fallback policy is '${rr.fallback}'. Resume after changing the role's model or availability.` });
      }
    }

    // A contradiction is a data-quality signal about our own memory: it marks
    // the entry and never interrupts the owner by itself.
    const claimedDisputes = ((res.structured as any)?.contextDisputes ?? []) as ctx.Dispute[];
    const disputes = Array.isArray(claimedDisputes) && claimedDisputes.length
      ? ctx.applyDisputes(taskId, claimedDisputes, this.events, `${spec.agent}/${spec.role ?? spec.phase}`)
      : { applied: 0, unknown: [] as string[] };

    this.events.append({
      taskId, type: res.ok ? 'AGENT_FINISHED' : 'AGENT_FAILED', agent: spec.agent as any, phase,
      attempt: res.attempts,
      payload: {
        ok: res.ok, durationMs: res.durationMs, exitCode: res.exitCode,
        failureKind: res.failureKind ?? null, error: res.error ?? null,
        firstChunkMs: res.firstChunkMs ?? null, rateLimited: res.rateLimited,
        requestedModel: res.requestedModel ?? null, effectiveModel: res.effectiveModel ?? null,
        cliVersion: res.cliVersion ?? null, authMode: res.authMode ?? null,
        role: spec.role ?? null, provider: spec.agent,
        reasoningEffort: runSpec.reasoning ?? null,
        fallbackModel, startedAt, finishedAt: new Date().toISOString(),
        contextPackUsed: !!pack, contextPackType: pack?.type ?? null,
        contextTokensApprox: pack?.tokensApprox ?? 0, contextEntries: pack?.entries ?? 0,
        contextDisputes: disputes.applied, contextDisputesUnknown: disputes.unknown.length,
        filesInspected: res.toolEvidence?.filesInspected?.length ?? 0,
        toolCalls: res.toolEvidence?.toolCallCount ?? 0,
        graphifyUsed: res.toolEvidence?.graphifyUsed ?? false,
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
    // Cancellation outranks failure: a killed agent must not escalate the task
    // the owner just cancelled (the TASK-V2-0007 resurrection path).
    if (this.isCancelled(taskId)) {
      this.noteAfterCancel(taskId, `escalation refused: ${reason.slice(0, 160)}`);
      return this.task(taskId)?.state ?? 'CANCELLED';
    }
    // A pause decided by fallback policy holds; the failure that follows it
    // must not overwrite the owner-facing PAUSED state.
    if (this.task(taskId)?.state === 'PAUSED') return 'PAUSED';
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
    // A cancelled task never runs again without an explicit owner recovery.
    if (this.isCancelled(taskId)) return this.task(taskId)?.state ?? 'CANCELLED';
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
    if (['CANCELLED', 'CANCELLING', 'FAILED', 'DEPLOYED', 'ESCALATED'].includes(rec.state)) return rec.state;

    const banned = bannedKeysPresent();
    if (banned.length) return this.escalate(taskId, rec.state, `paid API keys present (${banned.join(',')}); SUBSCRIPTION_CLI_ONLY`);

    const wt = this.wtm.ensure(taskId, rec.branch, rec.baseSha);
    const cwd = wt.path;

    // ---- DESIGN ----------------------------------------------------------
    if (rec.state === 'NEW' || (rec.state === 'DESIGN' && !currentDesign(this.events, taskId))) {
      if (rec.state === 'NEW') this.setState(taskId, 'NEW', 'DESIGN', 'design', 'claude');
      // Investigation runs FIRST for bug-hunting/root-cause tasks and feeds the
      // architect a ranked, source-verified shortlist instead of a blank repo.
      const investigation = await this.investigate(taskId, cwd, rec);
      const res = await this.agent(taskId, {
        agent: 'claude', cwd, readOnly: true, phase: 'design/claude', role: 'claude.design',
        timeoutMs: 15 * 60_000,
        contextPack: buildTaskPack(this.events, taskId, cwd),
        requiredKeys: ['scopeAllowlist', 'plan', 'invariants', 'predictions', 'requiredTests', 'acceptance'],
        prompt: designPrompt(rec, investigation),
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
        agent: 'codex', cwd, phase: 'design/codex-review', role: 'codex.designReview', timeoutMs: 15 * 60_000,
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
          agent: 'claude-code', cwd, phase: 'implement', role: 'claudeCode.implementation', timeoutMs: 40 * 60_000,
          contextPack: buildTaskPack(this.events, taskId, cwd),
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
      const merged = await this.performMerge(taskId, rec, this.wtm.head(cwd), 'autopilot-policy');
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

  /**
   * Reconciles the reviewer's CLAIMED evidence against what it actually
   * executed, and records the machine-observed version. Prose never becomes
   * evidence: observed always wins, and overclaims are logged.
   */
  private recordReviewEvidence(taskId: string, phase: string, res: any,
    window?: { startedAt: string; finishedAt: string }): ToolEvidence {
    const observed: ToolEvidence = res.toolEvidence ?? {
      sourceInspected: false, filesInspected: [], commandsExecuted: [], graphifyUsed: false,
      graphSourceSha: null, runtimeVerified: false, toolCallCount: 0, claimMismatch: [],
    };
    // The graphify-task wrapper writes its own invocation log. That log — not
    // the transcript, and never agent prose — decides graphifyUsed, because
    // only a real execution can produce an entry in it.
    // Two machine sources, never prose:
    //   1. the wrapper's own append-only log (richest, but unwritable from a
    //      read-only agent sandbox such as codex's)
    //   2. the wrapper's JSON receipt captured in the provider transcript
    // Either is proof of a real execution; the log wins on detail when present.
    const runs = window ? graphify.invocationsDuring(taskId, window.startedAt, window.finishedAt) : [];
    const successful = runs.filter((r) => r.ok);
    if (successful.length) {
      observed.graphifyUsed = true;
      observed.graphSourceSha = successful[0].graphSourceSha ?? observed.graphSourceSha;
      observed.analyzedSourceSha = successful[0].analyzedSourceSha ?? observed.analyzedSourceSha;
      observed.graphifyVersion = successful[0].graphifyVersion ?? observed.graphifyVersion;
      observed.graphifyOperations = Math.max(observed.graphifyOperations ?? 0, successful.length);
    }
    const ev = reconcileClaims(observed, (res.structured as any)?.evidence);
    const rec = this.task(taskId);
    const gfyDetail = ev.graphifyUsed ? {
      graphifyOperations: successful.length || ev.graphifyOperations || 1,
      graphifyVersion: successful[0]?.graphifyVersion ?? ev.graphifyVersion ?? null,
      graphifyQueries: successful.map((r) => `${r.operation}: ${(r.query ?? '').slice(0, 80)}`).slice(0, 8),
      graphifyFailures: runs.length - successful.length,
      analyzedSourceSha: successful[0]?.analyzedSourceSha ?? ev.analyzedSourceSha ?? rec?.baseSha ?? null,
      // "current" means the graph queried was built from the analyzed SHA.
      graphCurrent: successful.length
        ? successful.every((r) => r.graphCurrent !== false)
        : !!(ev.graphSourceSha && ev.analyzedSourceSha && ev.graphSourceSha === ev.analyzedSourceSha),
      graphifyEvidenceSource: successful.length ? 'wrapper-log' : 'wrapper-receipt',
    } : { graphifyOperations: 0, graphifyFailures: runs.length, graphifyAttempted: !!ev.graphifyAttempted };
    this.events.append({ taskId, type: 'EVIDENCE', phase, agent: res.provider ?? 'codex', payload: {
      reviewEvidence: {
        sourceInspected: ev.sourceInspected,
        filesInspected: ev.filesInspected,
        commandsExecuted: ev.commandsExecuted.slice(0, 20),
        graphifyUsed: ev.graphifyUsed,
        graphSourceSha: ev.graphSourceSha,
        runtimeVerified: ev.runtimeVerified,
        toolCallCount: ev.toolCallCount,
        claimMismatch: ev.claimMismatch,
        ...gfyDetail,
        summary: String((res.structured as any)?.evidence?.evidenceSummary ?? '').slice(0, 300),
      },
    } });
    for (const m of ev.claimMismatch) this.stream.append(taskId, 'system', 'error', m);
    return ev;
  }

  /** Tasks whose wording asks for discovery/root-cause rather than a known change. */
  private static INVESTIGATION_TASK =
    /\b(find|discover|hunt)\b[^.]{0,40}\bbug|investigate|root ?cause|why (does|is|are|did)|diagnose|reproduce\b/i;

  /**
   * Bug Investigation funnel (claude.investigation, optionally corroborated by
   * codex.investigation). Deliberately narrow: structural context → ranked
   * hotspots → targeted source reads → a few candidates → mechanical
   * reproduction. It must NOT read thousands of files.
   */
  private async investigate(taskId: string, cwd: string, rec: TaskRecord): Promise<string | null> {
    if (!Orchestrator.INVESTIGATION_TASK.test(rec.description)) return null;
    if (this.events.read(taskId).some((e) => e.phase === 'investigation' && e.type === 'AGENT_FINISHED')) return null;

    let graphContext = '';
    const use = graphify.graphFor(rec.baseSha);
    if (graphify.worthUsing('claude.investigation', rec.risk, 0) && use.usable) {
      const hubs = await graphify.query(rec.baseSha, rec.title.slice(0, 200), 1500);
      if (hubs?.ok) {
        graphContext = `\nGRAPHIFY STRUCTURAL CONTEXT (graph ${hubs.graphSourceSha.slice(0, 9)}, matches the code under analysis).\n` +
          `Navigation only — confirm everything in current source:\n${hubs.out.slice(0, 3500)}\n`;
        this.events.append({ taskId, type: 'EVIDENCE', phase: 'investigation', payload: {
          graphify: { used: true, graphSourceSha: hubs.graphSourceSha, command: hubs.command,
            durationMs: hubs.durationMs, analyzedSha: rec.baseSha, shaMatches: hubs.graphSourceSha === rec.baseSha } } });
      }
    } else {
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'investigation', payload: {
        graphify: { used: false, reason: use.usable ? 'NOT_NEEDED' : use.reason, detail: use.usable ? '' : use.detail } } });
    }

    const invStartedAt = new Date().toISOString();
    const res = await this.agent(taskId, {
      agent: 'claude', cwd, readOnly: true, phase: 'investigation/claude', role: 'claude.investigation',
      timeoutMs: 20 * 60_000, requiredKeys: ['candidates'],
      contextPack: buildTaskPack(this.events, taskId, cwd),
      prompt: investigationPrompt(rec, cwd, graphContext),
    }, 'investigation');
    if (!res.ok || !res.structured) {
      this.events.append({ taskId, type: 'NOTE', phase: 'investigation', payload: {
        investigationSkipped: res.error ?? 'no structured result' } });
      return null;
    }
    const invWindow = { startedAt: invStartedAt, finishedAt: new Date().toISOString() };
    const ev = this.recordReviewEvidence(taskId, 'investigation', res, invWindow);
    const cands = ((res.structured as any).candidates ?? []).slice(0, 5);
    this.events.append({ taskId, type: 'EVIDENCE', phase: 'investigation', payload: {
      investigation: { candidateCount: cands.length, candidates: cands,
        filesInspected: ev.filesInspected.length, sourceInspected: ev.sourceInspected,
        runtimeVerified: ev.runtimeVerified } } });
    this.stream.append(taskId, 'system', 'lifecycle',
      `investigation: ${cands.length} candidate(s) from ${ev.filesInspected.length} inspected file(s)`);
    return `INVESTIGATION FINDINGS (already source-verified — do not redo this work):\n${JSON.stringify(cands, null, 1).slice(0, 5000)}`;
  }

  private recordFindings(taskId: string, phase: string, raw: any[], evidence?: ToolEvidence): Finding[] {
    const findings: Finding[] = raw.map((f: any, i: number) => {
      const severity = (['CRITICAL', 'IMPORTANT', 'SUGGESTION'].includes(f.severity) ? f.severity : 'IMPORTANT');
      // Evidence gate: a material source claim raised without inspecting the
      // source and without running any verification is UNVERIFIED. It stays on
      // the record and can still be adjudicated, but it cannot block by itself.
      const gate = evidence ? findingIsSupported(severity, evidence) : { supported: true, reason: '' };
      return {
        findingId: String(f.findingId ?? `${phase.toUpperCase()}-${i + 1}`),
        severity,
        category: String(f.category ?? 'general'),
        claim: String(f.claim ?? ''),
        file: f.file ? String(f.file) : undefined,
        scenario: f.scenario ? String(f.scenario) : undefined,
        confidence: f.confidence ? String(f.confidence) : undefined,
        status: 'UNRESOLVED' as const,
        ...(gate.supported ? {} : { unverified: true, unverifiedReason: gate.reason }),
        ...(f.verifiedBy ? { verifiedBy: String(f.verifiedBy).slice(0, 300) } : {}),
      };
    });
    if (findings.length) this.events.append({ taskId, type: 'FINDING', phase, payload: { findings } });
    return findings;
  }

  /**
   * Assembles navigation context for a review. Graphify is consulted only when
   * it is materially useful (multi-file / high risk / investigation) and only
   * when its graph SHA matches the code under review; otherwise the review
   * proceeds on source inspection alone and the reason is recorded.
   */
  private async buildReviewContext(taskId: string, cwd: string, rec: TaskRecord, role: string): Promise<ReviewContext> {
    const ctx: ReviewContext = { cwd, graphify: null, eventCoupling: null };
    const changed = this.wtm.changedFiles(cwd, rec.baseSha);

    // Event coupling is cheap, deterministic, and imports-blind — always useful.
    try {
      const ec = eventCoupling(cwd, changed);
      if (ec.events.length || ec.coupledFiles.length) {
        ctx.eventCoupling = [
          `events touched: ${ec.events.join(', ') || 'none'}`,
          ...ec.rationale.slice(0, 12),
        ].join('\n');
        this.events.append({ taskId, type: 'EVIDENCE', phase: 'review', payload: {
          eventCoupling: { events: ec.events, coupledFiles: ec.coupledFiles, specs: ec.specs } } });
      }
    } catch { /* coupling is additive; never fail a review over it */ }

    if (!graphify.worthUsing(role, rec.risk, changed.length)) {
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'review', payload: {
        graphify: { used: false, reason: 'NOT_NEEDED', detail: `${role} on ${rec.risk} risk, ${changed.length} changed file(s)` } } });
      return ctx;
    }
    const use = graphify.graphFor(rec.baseSha);
    if (!use.usable) {
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'review', payload: {
        graphify: { used: false, reason: use.reason, detail: use.detail, haveSha: (use as any).haveSha ?? null } } });
      this.stream.append(taskId, 'system', 'lifecycle',
        `graphify ${use.reason}: ${use.detail} — review continues on current source`);
      return ctx;
    }
    const primary = changed[0] ? path.basename(changed[0]) : rec.title.slice(0, 60);
    const r = await graphify.affected(rec.baseSha, primary, 2);
    if (r?.ok) {
      ctx.graphify = { out: r.out, graphSourceSha: r.graphSourceSha };
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'review', payload: {
        graphify: { used: true, graphSourceSha: r.graphSourceSha, command: r.command,
          durationMs: r.durationMs, analyzedSha: rec.baseSha,
          shaMatches: r.graphSourceSha === rec.baseSha,
          filesSuggested: graphify.filesFromAffected(r.out).slice(0, 25) } } });
      this.stream.append(taskId, 'system', 'lifecycle',
        `graphify blast radius for ${primary} (graph ${r.graphSourceSha.slice(0, 9)}, ${r.durationMs}ms)`);
    }
    return ctx;
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
      agent: 'claude', cwd, readOnly: true, phase: `${phase}/adjudication`, role: 'claude.adjudication', timeoutMs: 10 * 60_000,
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
      let proposedCheck: string | null = null;
      if (status === 'TEST_TO_DECIDE') {
        // TEST_TO_DECIDE may never leave adjudication undecided: the check runs
        // and the exit code decides, or the finding is explicitly UNRESOLVED.
        proposedCheck = a.check ? String(a.check) : null;
        const d = await checks.decideTestToDecide(cwd, String(a.findingId), proposedCheck ?? undefined, taskId);
        if (d.result) this.check(taskId, phase, d.result);
        status = d.status;
        source = d.decisionSource;
        evidence = d.evidence;
      }
      this.events.append({ taskId, type: 'ADJUDICATION', phase,
        payload: { findingId: a.findingId, status, decisionSource: source, evidence, selfAdjudicationRisk: selfRisk,
          ...(proposedCheck ? { check: proposedCheck } : {}) } });
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

    const impact = checks.affectedSpecs(cwd, changed, rec.baseSha);
    this.events.append({ taskId, type: 'EVIDENCE', phase: 'verify',
      payload: { impactSpecs: impact.specs, impactRationale: impact.rationale.slice(0, 30) } });

    const results: CheckResult[] = [];
    results.push(this.check(taskId, 'verify', await checks.typecheck(cwd, taskId)));
    results.push(this.check(taskId, 'verify', await checks.targetedTests(cwd, impact.specs, taskId)));
    if (rec.risk === 'high') results.push(this.check(taskId, 'verify', await checks.stage0(cwd, taskId)));
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
    // The repair run receives the ADJUDICATED scope, saved for audit, rather
    // than the reviewer's raw proposal.
    const fixPack = buildFixPack(this.events, taskId, cwd, fixes.map((f) => f.findingId));
    if (fixPack) {
      for (const f of fixes) ctx.saveFixContext(taskId, f.findingId, fixPack.body);
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'fix', payload: {
        fixContext: { findings: fixes.map((f) => f.findingId), entries: fixPack.rendered.entries,
          tokensApprox: fixPack.rendered.tokensApprox,
          divergences: fixPack.body.findings.filter((f: any) => f.adjudicationDivergence).map((f: any) => f.findingId) } } });
    }
    const res = await this.agent(taskId, {
      agent: 'claude-code', cwd, phase: 'fix', role: 'claudeCode.repair', timeoutMs: 25 * 60_000,
      requiredKeys: ['status', 'filesChanged'],
      contextPack: fixPack?.rendered ?? null,
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
      const reviewCtx = await this.buildReviewContext(taskId, cwd, rec, 'codex.codeReview');
      const revStartedAt = new Date().toISOString();
      const rev = await this.agent(taskId, {
        agent: 'codex', cwd, phase: `review/cycle-${cycle + 1}`, role: 'codex.codeReview', timeoutMs: 20 * 60_000,
        contextPack: buildCodexMap(this.events, taskId, cwd, {
          graphFiles: reviewCtx.graphify ? graphify.filesFromAffected(reviewCtx.graphify.out) : [],
          protectedPaths: policy.PROTECTED_PATHS,
        }),
        requiredKeys: ['findings'],
        prompt: reviewPrompt(rec, design, diff, reviewCtx),
      }, 'review');
      if (rev.rateLimited) return this.pauseRateLimit(taskId, 'REVIEW', 'review');
      if (!rev.ok) {
        // A failed reviewer is an execution problem, not a blocker for LOW.
        if (rec.risk === 'low') { this.events.append({ taskId, type: 'NOTE', payload: { reviewSkipped: rev.error } }); return 'ok'; }
        return this.escalate(taskId, 'REVIEW', `review failed [${rev.failureKind}]: ${rev.error}`);
      }
      const revWindow = { startedAt: revStartedAt, finishedAt: new Date().toISOString() };
      const reviewEvidence = this.recordReviewEvidence(taskId, 'review', rev, revWindow);
      const findings = this.recordFindings(taskId, 'review', (rev.structured as any)?.findings ?? [], reviewEvidence);
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

      if (!toFix.length) {
        // Nothing adjudicated-FIX, but any still-open material finding must be
        // on the record as a documented disagreement, never a silent pass.
        if (openMaterial.length) this.events.append({ taskId, type: 'NOTE', payload: {
          disagreementRecorded: openMaterial.map((f) => f.findingId),
          resolution: 'no adjudicated-FIX findings; unresolved material documented, deterministic gates decide' } });
        return 'ok';
      }
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

    const preds = await checks.runPredictionChecks(cwd, design.predictions, taskId);
    preds.results.forEach(record);
    if (preds.unverified.length) {
      this.events.append({ taskId, type: 'EVIDENCE', phase: 'final',
        payload: { notVerified: preds.unverified } });
    }

    if (rec.risk === 'low') {
      // fast gate already covered LOW; predictions above complete it.
    } else if (rec.risk === 'medium') {
      record(await checks.stage0(cwd, taskId));
    } else {
      // HIGH: stage0, then Stage -1 (locked) in parallel with nothing else that
      // touches the DB — reconciliation runs after the suite completes.
      record(await checks.stage0(cwd, taskId));
      record(await checks.stageMinus1(cwd, taskId));
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
  async performMerge(taskId: string, rec: TaskRecord, approvedSha: string, approvedBy: string):
    Promise<{ ok: boolean; detail: string; mergeSha?: string }> {
    if (this.isCancelled(taskId)) {
      this.noteAfterCancel(taskId, 'merge refused');
      return { ok: false, detail: 'task is cancelled; merge refused' };
    }
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
      const t = await checks.typecheck(MERGE_WT, taskId);
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
    if (this.isCancelled(taskId)) {
      this.noteAfterCancel(taskId, 'deploy refused');
      return { ok: false, detail: 'task is cancelled; deploy refused' };
    }
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
    // Cancelled tasks are not resumable. Recovery is a deliberate, separate
    // owner action (recoverCancelled), never an ordinary Resume click.
    if (this.isCancelled(taskId)) return false;
    if (!rec || (rec.state !== 'ESCALATED' && rec.state !== 'PAUSED')) return false;
    const evs = this.events.read(taskId);
    let last: TaskState = 'DESIGN';
    for (const e of evs) {
      if (e.type === 'STATE_CHANGED') {
        const to = (e.payload as any).to as TaskState;
        if (!['ESCALATED', 'FAILED', 'CANCELLED', 'AWAITING_HUMAN', 'PAUSED', 'PAUSED_RATE_LIMIT'].includes(to)) last = to;
      }
    }
    this.events.append({ taskId, type: 'NOTE', payload: { retryAuthorized: by, reenteringAt: last } });
    this.setState(taskId, rec.state, last, 'retry', `by ${by}`);
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
    if (this.isCancelled(taskId)) return false;
    if (!rec?.awaitingHuman || rec.awaitingHuman.decisionId !== decisionId) return false;
    this.events.append({ taskId, type: 'HUMAN_DECISION', payload: { decisionId, choice, decidedBy: by } });
    this.setState(taskId, 'AWAITING_HUMAN', 'REVIEW', 'human', 'resolved', {});
    return true;
  }
}

// ---------------------------------------------------------------------------
// Prompts — concise, risk-scaled (a two-line fix does not get a treatise)
// ---------------------------------------------------------------------------

/**
 * Investigation funnel. The explicit budget matters: an earlier bug-hunt task
 * read 200+ files sequentially before producing anything.
 */
function investigationPrompt(rec: TaskRecord, cwd: string, graphContext: string): string {
  return `You are the Bug Investigation role. Find real, reproducible defects — efficiently.

WORKTREE (read-only, you CAN run commands): ${cwd}

TASK ${rec.taskId} (risk=${rec.risk}):
${rec.description.slice(0, 4000)}
${graphContext}
GRAPHIFY: if the status block above says available: true, start with the V2
interface — it is pinned to a graph built from exactly this code:
    graphify-task query "<what you are tracing>"
    graphify-task affected "<File.ts>"
Never probe with \`command -v graphify\` or ./graphify-out/, and never read the
graphify skill docs under .agents/skills or .claude/skills — they report nothing
useful here. THIS PROMPT OVERRIDES AGENTS.md / CLAUDE.md on the subject of
graphify: graphify-task is the only interface in this runtime. Graphify ranks where to look; current source decides what is true.

FUNNEL — keep to this budget, do not sequentially read the repository:
1. use the structural context above (if present) to rank suspicious modules/hotspots
2. open roughly 10-30 genuinely relevant files — no more
3. narrow to 3-5 concrete candidate defects
4. MECHANICALLY REPRODUCE each candidate: run a node one-liner, an existing spec,
   or tsc. Discard anything you cannot demonstrate.
5. return only what survived

Every candidate needs a concrete incorrect behaviour, a plausible user-facing
scenario, evidence from CURRENT source, and a deterministic reproduction. Never
assert library/compiler/runtime behaviour from memory — run it and quote output.
If nothing genuine survives, return an empty candidates array; do not invent one.

If any statement in the context block above disagrees with current source, report it in contextDisputes.

Reply ONLY JSON:
{"evidence": {"sourceInspected": true, "filesInspected": ["packages/..."], "commandsExecuted": ["..."], "graphifyUsed": false, "runtimeVerified": true, "evidenceSummary": "..."},
 "contextDisputes": [],
 "candidates": [{"title": "...", "file": "packages/...", "incorrectBehaviour": "...", "userScenario": "...", "reproduction": "exact command or spec", "reproductionOutput": "what it printed", "confidence": "high|medium|low"}]}

Your evidence block is cross-checked against your actual tool executions.`;
}

function designPrompt(rec: TaskRecord, investigation?: string | null): string {
  const depth = rec.risk === 'high'
    ? `This is a HIGH accounting-impact task. Include:
- precise invariants (each one falsifiable),
- predictions with an executable "check" where possible (jest/tsc/node -e commands relative to packages/server),
- required tests and acceptance requirements.`
    : `This is a ${rec.risk.toUpperCase()} task. Keep the design CONCISE: a short plan, the affected scope, realistic risk, required tests. Do not write long invariants for a small change.`;
  return `You are the architect for an autonomous development task. Investigate the repository (read-only) and produce a design.
If the GRAPHIFY STATUS block says available: true, you may use \`graphify-task query "..."\` / \`graphify-task affected "File.ts"\` for architecture and blast radius; never probe for the graphify binary or ./graphify-out/ yourself. Graph output is navigation only — confirm anything it suggests in current source.

TASK ${rec.taskId} (risk=${rec.risk}):
${rec.description}
${investigation ? `\n${investigation}\n` : ''}
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
  return `Adjudicate these findings CONCISELY. For each: status FIX | TEST_TO_DECIDE | DEFER | REJECT, one short reasoning. If TEST_TO_DECIDE, provide "check": ONE executable command (node_modules/.bin/jest …, node_modules/.bin/tsc …, or node -e "…") whose exit code decides it (exit 0 = the code is correct = finding refuted) — the evidence outranks both of you. The command already runs inside packages/server: no "cd", no "&&" chains, no shell redirection.
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

interface ReviewContext {
  cwd: string;
  graphify?: { out: string; graphSourceSha: string } | null;
  eventCoupling?: string | null;
}

function reviewPrompt(rec: TaskRecord, d: DesignRevision, diff: string, ctx: ReviewContext): string {
  return `Independently review this implementation. Severities: CRITICAL (realistic financial corruption / tenant leakage / security breach / irreversible loss / fundamentally wrong result), IMPORTANT (concrete bug or meaningful weakness), SUGGESTION (style/preference — never blocks). A CRITICAL finding must include a concrete scenario; theory alone cannot block.

YOU ARE RUNNING INSIDE THE TASK WORKTREE: ${ctx.cwd}
Your sandbox is read-only but you CAN run commands. Reviewing from the diff text alone is NOT acceptable for a material finding.

REQUIRED WORKFLOW — targeted, not exhaustive. Do NOT browse the whole repository:
1. read the diff below
2. open the changed files and the implementation immediately around them
3. open the relevant tests/config where the change interacts with them
4. VERIFY CHEAP FACTS INSTEAD OF GUESSING — if a check takes under ~30 seconds, run it:
     node -e "console.log(require('some-pkg').someFn('x'))"
     node -e "console.log(require('some-pkg/package.json').version)"
     node_modules/.bin/tsc --noEmit -p tsconfig.json
     node_modules/.bin/jest <spec> --silent
   Never assert library behaviour, return values, versions, exports or compiler
   output from memory. Run it and quote the output.
5. only then write findings

GRAPHIFY: the status block at the top of this prompt tells you whether a graph
matching this exact code is available. If it says available: true, you may query
it with the V2 interface — it is already pinned to the right graph:
    graphify-task status
    graphify-task query "<question>"
    graphify-task affected "<File.ts>"
    graphify-task explain "<symbol>"
Do NOT run \`command -v graphify\`, do NOT look for ./graphify-out/, do NOT
invoke the graphify binary directly, and do NOT read the graphify skill docs
under .agents/skills or .claude/skills — those all report "missing" or waste
your budget and tell you nothing about the real graph. THIS PROMPT OVERRIDES
AGENTS.md / CLAUDE.md: any instruction there about graphify-out/ or running the
graphify binary is stale in this runtime; graphify-task is the only interface. Graphify is NAVIGATION ONLY, never evidence:
anything it suggests must be confirmed in current source before you raise it.
${ctx.graphify ? `
Pre-fetched blast radius (graph sourceSha ${ctx.graphify.graphSourceSha}):
${ctx.graphify.out.slice(0, 4000)}` : ''}${ctx.eventCoupling ? `
EVENT COUPLING (deterministic index — imports alone miss these):
${ctx.eventCoupling.slice(0, 1500)}` : ''}

TASK ${rec.taskId} (risk=${rec.risk}): ${rec.title}
DESIGN: ${JSON.stringify(d).slice(0, 6000)}

DIFF (task worktree vs base):
${diff}

If any statement in the context block above disagrees with what you actually observe in current source, report it (this corrects our records; it does not change your task):
"contextDisputes": [{"entryId": "CTX-...", "observed": "what current source shows", "evidence": "file:line or command output"}]

Reply ONLY JSON:
{"evidence": {"sourceInspected": true, "filesInspected": ["packages/..."], "commandsExecuted": ["..."], "graphifyUsed": false, "runtimeVerified": false, "evidenceSummary": "one line"},
 "contextDisputes": [],
 "findings": [{"findingId": "R-1", "severity": "...", "category": "...", "claim": "...", "file": "...", "scenario": "...", "confidence": "...", "verifiedBy": "what you actually ran or read"}]}

Your evidence block is cross-checked against your real tool executions. Claiming a tool you did not run is recorded as TOOL_CLAIM_MISMATCH, and an IMPORTANT/CRITICAL source claim with no inspection and no executed verification is downgraded to UNVERIFIED and cannot block on its own.`;
}

function fixPrompt(rec: TaskRecord, d: DesignRevision, fixes: Finding[], reason: string): string {
  return `Apply these adjudicated fixes (${reason}). Only these — do not refactor beyond them. Stay inside the design scopeAllowlist.

TASK ${rec.taskId}
DESIGN SCOPE: ${JSON.stringify(d.scopeAllowlist)}
FIXES:
${JSON.stringify(fixes.map((f) => ({ findingId: f.findingId, claim: f.claim, file: f.file, evidence: f.evidence })), null, 1).slice(0, 8000)}

Finish before you answer. Reply ONLY JSON: {"status": "IMPLEMENTED"|"FAILED", "filesChanged": [], "reason": ""}`;
}
