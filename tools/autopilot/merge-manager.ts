/**
 * Controlled merge.
 *
 * A HIGH-risk accounting change never merges itself. This runs only after the
 * authenticated owner approves, and it re-verifies everything at approval time
 * rather than trusting the state that was reviewed: the branch may have moved,
 * main may have advanced, the gates may no longer pass.
 *
 * The approval record is written BEFORE the attempt and is never edited. A
 * failed merge appends a failure event beside it; it does not rewrite history.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventStore } from './storage/event-store';
import { TaskStore } from './storage/task-store';
import { PolicyEngine } from './policy-engine';
import { AcceptanceRunner } from './acceptance-runner';
import { Risk } from './types';

export interface MergePreflight {
  ok: boolean;
  problems: string[];
  taskId: string;
  sourceBranch: string;
  reviewedHead: string;
  currentHead: string;
  targetBranch: string;
  mainSha: string;
  originMainSha: string;
  commits: Array<{ sha: string; subject: string }>;
  changedFiles: string[];
  diffStat: string;
}

const LOCK = '/srv/ai-accounting/state/merge.lock';

/**
 * Seams for testing the merge workflow itself.
 *
 * The blocking behaviour here — stale branch, moved main, dirty tree, protected
 * path, failing post-merge gate — is the part that must never regress, and the
 * only honest way to prove it works is to run a real merge and watch it be
 * refused. That cannot be done against the accounting repository, so these let
 * an integration test point the same code at a disposable one.
 *
 * Production always uses the defaults; nothing is injected at runtime.
 */
export interface MergeManagerOptions {
  lockPath?: string;
  /** Substituted only by the integration test; real gates are the default. */
  acceptance?: (taskId: string, policy: PolicyEngine) => { final(risk: Risk): {
    ok: boolean;
    outcomes: any[];
    violations: any[];
    evidenceConflict?: { detail: string };
  } };
}

export class MergeManager {
  private readonly lock: string;
  private readonly makeAcceptance: NonNullable<MergeManagerOptions['acceptance']>;

  constructor(
    private readonly repo: string,
    private readonly events: EventStore,
    private readonly tasks: TaskStore,
    private readonly policy: PolicyEngine,
    opts: MergeManagerOptions = {},
  ) {
    this.lock = opts.lockPath ?? LOCK;
    this.makeAcceptance = opts.acceptance ?? ((id, p) => new AcceptanceRunner(id, p));
  }

  private git(args: string[], allowFail = false): string {
    try {
      return execFileSync('git', args, { cwd: this.repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e: any) {
      if (allowFail) return '';
      throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${String(e?.stderr ?? e?.message).slice(0, 400)}`);
    }
  }

  /** Everything the owner must see, and every reason it could be refused. */
  preflight(taskId: string, targetBranch = 'main'): MergePreflight {
    const problems: string[] = [];
    const rec = this.tasks.deriveTask(taskId);
    const rtm = this.tasks.latest(taskId, 'READY_TO_MERGE');
    const sourceBranch = rec?.branch ?? '';
    const reviewedHead = String((rtm?.payload as any)?.head ?? '');

    if (!rec) problems.push('unknown task');
    if (rec && rec.state !== 'READY_TO_MERGE') problems.push(`task state is ${rec.state}, not READY_TO_MERGE`);
    if (!reviewedHead) problems.push('no reviewed HEAD recorded');

    const currentHead = sourceBranch
      ? this.git(['rev-parse', sourceBranch], true).trim()
      : '';
    if (reviewedHead && currentHead && reviewedHead !== currentHead) {
      problems.push(`source branch moved since review (reviewed ${reviewedHead.slice(0, 9)}, now ${currentHead.slice(0, 9)})`);
    }

    // Unresolved blockers: any BLOCKER finding without a CONFIRMED/REJECTED
    // adjudication is by definition unreviewed.
    const adjudicated = new Set(
      this.tasks.byType(taskId, 'ADJUDICATION').map((e) => String((e.payload as any).findingId)),
    );
    let unresolved = 0;
    for (const e of this.events.read(taskId)) {
      if (e.type !== 'FINDING' && e.type !== 'DESIGN_REVIEW') continue;
      for (const f of ((e.payload as any).findings ?? []) as any[]) {
        if (f.severity === 'BLOCKER' && !adjudicated.has(f.findingId)) unresolved += 1;
      }
    }
    if (unresolved > 0) problems.push(`${unresolved} unresolved BLOCKER finding(s)`);

    const finalAcceptance = this.tasks
      .byType(taskId, 'RUNTIME_EVIDENCE')
      .filter((e) => (e.payload as any).tier === 'final' && (e.payload as any).ok === true);
    if (finalAcceptance.length === 0) problems.push('final acceptance has not passed');

    if (this.git(['status', '--porcelain'], true).trim().length > 0) {
      problems.push('working tree is not clean');
    }

    this.git(['fetch', 'origin', '--quiet'], true);
    const mainSha = this.git(['rev-parse', targetBranch], true).trim();
    const originMainSha = this.git(['rev-parse', `origin/${targetBranch}`], true).trim();
    if (mainSha && originMainSha && mainSha !== originMainSha) {
      problems.push(`local ${targetBranch} (${mainSha.slice(0, 9)}) differs from origin/${targetBranch} (${originMainSha.slice(0, 9)})`);
    }

    const commits = sourceBranch
      ? this.git(['log', '--format=%H%x1f%s', `${targetBranch}..${sourceBranch}`], true)
          .trim().split('\n').filter(Boolean)
          .map((l) => { const [sha, subject] = l.split('\x1f'); return { sha, subject }; })
      : [];
    const changedFiles = sourceBranch
      ? this.git(['diff', '--name-only', `${targetBranch}...${sourceBranch}`], true).trim().split('\n').filter(Boolean)
      : [];
    const diffStat = sourceBranch
      ? this.git(['diff', '--shortstat', `${targetBranch}...${sourceBranch}`], true).trim()
      : '';

    const protectedHits = this.policy.checkProtectedPaths(changedFiles);
    for (const v of protectedHits) problems.push(`protected path: ${v.detail}`);

    return {
      ok: problems.length === 0,
      problems, taskId, sourceBranch, reviewedHead, currentHead,
      targetBranch, mainSha, originMainSha, commits, changedFiles, diffStat,
    };
  }

  /**
   * Approve and merge. `owner` is the authenticated session user; it is written
   * into the immutable approval record.
   */
  async approveAndMerge(
    taskId: string,
    owner: string,
    risk: Risk,
    targetBranch = 'main',
  ): Promise<{ ok: boolean; state: string; detail: string; mergeSha?: string }> {
    if (fs.existsSync(this.lock)) {
      return { ok: false, state: 'LOCKED', detail: 'another merge is in progress' };
    }
    const pre = this.preflight(taskId, targetBranch);
    if (!pre.ok) {
      return { ok: false, state: 'REFUSED', detail: pre.problems.join('; ') };
    }

    fs.mkdirSync(path.dirname(this.lock), { recursive: true });
    fs.writeFileSync(this.lock, `${taskId} ${owner} ${new Date().toISOString()}\n`);
    try {
      // Written first, and never touched again whatever happens next.
      this.events.append({
        taskId,
        type: 'MERGE_APPROVED',
        actor: 'human',
        payload: {
          taskId,
          authenticatedOwner: owner,
          reviewedHead: pre.reviewedHead,
          sourceBranch: pre.sourceBranch,
          targetBranch,
          risk,
          commits: pre.commits.map((c) => c.sha),
        },
      });

      const startingMain = this.git(['rev-parse', targetBranch]).trim();
      this.git(['checkout', targetBranch]);
      // No force, no squash, no rebase. `--no-commit` then `commit -m` so the
      // repo's commit-msg hook receives a message file it can actually read.
      this.git(['merge', '--no-ff', '--no-commit', pre.sourceBranch]);
      let mergeSha = '';
      try {
        this.git(['commit', '-m', `merge: ${taskId} approved by ${owner}`]);
        mergeSha = this.git(['rev-parse', 'HEAD']).trim();
      } catch (e: any) {
        this.git(['merge', '--abort'], true);
        this.events.append({
          taskId, type: 'ESCALATION', actor: 'orchestrator',
          payload: { reason: `merge commit refused: ${String(e?.message).slice(0, 300)}`, phase: 'MERGE' },
        });
        return { ok: false, state: 'ESCALATED', detail: 'merge commit refused' };
      }

      // Post-merge gates on the merged result, before anything is published.
      const acceptance = this.makeAcceptance(taskId, this.policy);
      const gates = acceptance.final(risk);
      for (const o of gates.outcomes) {
        this.events.append({
          taskId, type: 'TEST_RESULT', actor: 'test-runner',
          payload: {
            tier: 'post-merge', name: o.name, command: o.command, exitCode: o.exitCode,
            passed: o.passed, failed: o.failed, skipped: o.skipped, total: o.total,
            classifications: o.classifications ?? null, stdoutHash: o.stdoutHash,
            ok: o.ok, blockedReason: o.blockedReason ?? null,
          },
        });
      }
      if (!gates.ok) {
        // A broken main is never pushed. The merge stays local as evidence.
        this.git(['reset', '--merge', startingMain], true);
        this.events.append({
          taskId, type: 'ESCALATION', actor: 'orchestrator',
          payload: {
            reason: 'post-merge gates failed; main was not pushed and the merge was rolled back locally',
            violations: gates.violations, evidenceConflict: gates.evidenceConflict ?? null,
          },
        });
        return { ok: false, state: 'ESCALATED', detail: 'post-merge gates failed; nothing pushed' };
      }

      let pushResult = 'not attempted';
      try {
        this.git(['push', 'origin', targetBranch]);
        pushResult = 'pushed';
      } catch (e: any) {
        pushResult = `push failed: ${String(e?.message).slice(0, 200)}`;
        this.events.append({
          taskId, type: 'ESCALATION', actor: 'orchestrator',
          payload: { reason: `merge succeeded locally but ${pushResult}`, mergeSha },
        });
        return { ok: false, state: 'ESCALATED', detail: pushResult, mergeSha };
      }

      this.events.append({
        taskId, type: 'MERGED', actor: 'orchestrator',
        payload: {
          mergeSha, mainSha: this.git(['rev-parse', targetBranch]).trim(),
          originMainSha: this.git(['rev-parse', `origin/${targetBranch}`], true).trim(),
          pushResult, targetBranch, approvedBy: owner,
        },
      });
      const rec = this.tasks.deriveTask(taskId);
      if (rec) this.tasks.writeCache(rec);
      return { ok: true, state: 'MERGED', detail: 'merged and pushed', mergeSha };
    } finally {
      fs.rmSync(this.lock, { force: true });
    }
  }
}
