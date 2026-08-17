/**
 * Controlled production deployment.
 *
 * Same posture as the merge: the owner approves, the approval is written
 * BEFORE the attempt and never edited, and everything is re-verified at
 * approval time rather than trusted from when it was inspected.
 *
 * The deployable source is origin/main and nothing else. That is enforced by
 * `deploy-production` on the server — this class refuses on top of it rather
 * than instead of it, so neither layer alone is load-bearing.
 *
 * Deploying is a separate act from merging. A HIGH-risk task that has just
 * merged does not deploy itself; the owner has to approve twice.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import { EventStore } from './storage/event-store';
import { TaskStore } from './storage/task-store';

/** Deployments not tied to a task still need an immutable home. */
export const DEPLOY_LOG_ID = 'DEPLOY-PRODUCTION';

const DEPLOY_BIN = process.env.AI_DEPLOY_BIN ?? '/srv/ai-accounting/bin/deploy-production';

export interface DeployPreflight {
  ok: boolean;
  problems: string[];
  candidateSha: string;
  currentSha: string;
  previousSha: string;
  originMainSha: string;
  localMainSha: string;
  migrationsChanged: number;
  commitsAhead: number;
  healthOk: boolean;
  backupReady: boolean;
  backupAgeHours: number;
  backupPath: string;
  rollbackTarget: string;
  targetBranch: string;
  /** Present only when the deployment is being made on behalf of a task. */
  taskId?: string;
  taskState?: string;
  taskMergedSha?: string;
}

export class DeployManager {
  constructor(
    private readonly events: EventStore,
    private readonly tasks: TaskStore,
  ) {}

  private runDeployScript(args: string[], timeoutMs: number): { out: string; code: number } {
    // Invoked directly, never through sudo. The control plane runs with
    // NoNewPrivileges=true, so it cannot escalate even if asked to; instead the
    // script and everything it touches are group-readable by `aiaccounting`.
    // `deploy-production` is mode 0750 root:aiaccounting — executable here,
    // not writable here.
    const r = spawnSync(DEPLOY_BIN, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 };
  }

  private parseResult(out: string): any | null {
    const m = /RESULT:(\{[\s\S]*?\})\s*$/m.exec(out);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }

  /**
   * Everything the owner must see before the deploy button is enabled, and
   * every reason it can be refused.
   */
  preflight(taskId?: string): DeployPreflight {
    const { out } = this.runDeployScript(['preflight'], 120_000);
    const base = this.parseResult(out);
    const pre: DeployPreflight = base ?? {
      ok: false,
      problems: ['deployment preflight produced no parseable result'],
      candidateSha: '', currentSha: '', previousSha: '', originMainSha: '', localMainSha: '',
      migrationsChanged: -1, commitsAhead: -1, healthOk: false, backupReady: false,
      backupAgeHours: -1, backupPath: '', rollbackTarget: '', targetBranch: 'main',
    };

    if (!taskId) return pre;

    // Task-linked deployment: the task must actually have merged, and what it
    // merged must be what is about to ship.
    const rec = this.tasks.deriveTask(taskId);
    const merged = this.tasks.latest(taskId, 'MERGED');
    const mergedSha = String((merged?.payload as any)?.mainSha ?? '');

    pre.taskId = taskId;
    pre.taskState = rec?.state ?? 'UNKNOWN';
    pre.taskMergedSha = mergedSha;

    if (!rec) pre.problems.push('unknown task');
    else if (rec.state !== 'MERGED') pre.problems.push(`task state is ${rec.state}, not MERGED`);
    if (!mergedSha) pre.problems.push('task has no recorded merged SHA');
    else if (pre.candidateSha && mergedSha !== pre.candidateSha) {
      pre.problems.push(
        `task merged ${mergedSha.slice(0, 9)} but the deploy candidate is ${pre.candidateSha.slice(0, 9)}`,
      );
    }
    pre.ok = pre.problems.length === 0;
    return pre;
  }

  /**
   * Approve and deploy. `owner` is the authenticated session user and is what
   * gets written into the immutable approval record — never anything the
   * client supplied.
   */
  approveAndDeploy(
    owner: string,
    taskId?: string,
  ): { ok: boolean; state: string; detail: string; deployedSha?: string } {
    const logId = taskId ?? DEPLOY_LOG_ID;
    const pre = this.preflight(taskId);
    if (!pre.ok) {
      return { ok: false, state: 'REFUSED', detail: pre.problems.join('; ') };
    }

    // Written first, and never touched again whatever happens next.
    this.events.append({
      taskId: logId,
      type: 'DEPLOYMENT_APPROVED',
      actor: 'human',
      payload: {
        taskId: taskId ?? null,
        authenticatedOwner: owner,
        targetSha: pre.candidateSha,
        previousProductionSha: pre.currentSha || null,
        originMainSha: pre.originMainSha,
        migrationsChanged: pre.migrationsChanged,
        backupPath: pre.backupPath,
        rollbackTarget: pre.rollbackTarget,
      },
    });

    // --sha pins the deployment to exactly what the owner was shown. It does
    // not widen what is allowed: the script still requires it to be origin/main.
    const { out, code } = this.runDeployScript(['apply', '--sha', pre.candidateSha], 45 * 60_000);
    const tail = out.slice(-4000);

    // release.env is only meaningful if the script ran to completion. On a
    // refusal it still holds the PREVIOUS deployment's values, and reading it
    // anyway reports a failed attempt with the last success's detail — which
    // is exactly the kind of false "it worked" this whole path exists to
    // prevent. On failure the reason comes from the script's own output.
    const post = code === 0 ? this.readReleaseState() : {};

    if (code !== 0 || post.result !== 'DEPLOYED') {
      const reason = code !== 0
        ? (/REFUSED:.*/.exec(tail)?.[0] ?? /ABORTED:.*/.exec(tail)?.[0] ?? `deploy exited ${code}`)
        : (post.detail ?? 'deployment did not report success');
      this.events.append({
        taskId: logId,
        type: 'DEPLOYMENT_FAILED',
        actor: 'orchestrator',
        payload: {
          taskId: taskId ?? null,
          attemptedSha: pre.candidateSha,
          previousProductionSha: pre.currentSha || null,
          exitCode: code,
          result: post.result ?? 'NOT_DEPLOYED',
          detail: reason,
          rolledBackTo: post.currentSha && post.currentSha !== pre.candidateSha ? post.currentSha : null,
          // Migrations are never auto-reversed; say so in the record rather
          // than letting a reader assume a clean rollback.
          migrationsReversed: false,
        },
      });
      return { ok: false, state: 'DEPLOYMENT_FAILED', detail: reason.slice(0, 500) };
    }

    this.events.append({
      taskId: logId,
      type: 'DEPLOYED',
      actor: 'orchestrator',
      payload: {
        taskId: taskId ?? null,
        deployedSha: post.currentSha,
        previousProductionSha: post.previousSha || null,
        approvedBy: owner,
        deployedAt: post.deployedAt,
        healthResult: this.healthSummary(),
        backupState: pre.backupReady ? `verified backup at ${pre.backupPath}` : 'none',
        result: post.result,
        detail: post.detail,
      },
    });
    return { ok: true, state: 'DEPLOYED', detail: post.detail ?? 'deployed', deployedSha: post.currentSha };
  }

  readReleaseState(): Record<string, string> {
    const p = process.env.AI_RELEASE_FILE ?? '/srv/ai-accounting/state/release.env';
    const out: Record<string, string> = {};
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^([a-zA-Z]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  }

  private healthSummary(): string {
    try {
      const out = execFileSync('/srv/ai-accounting/bin/production-health', {
        encoding: 'utf8',
        timeout: 120_000,
      });
      const last = out.trim().split('\n').pop() ?? '';
      return last.trim();
    } catch (e: any) {
      const out = String(e?.stdout ?? '').trim().split('\n').pop() ?? 'health check failed';
      return out.trim();
    }
  }
}
