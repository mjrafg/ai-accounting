/**
 * Physical isolation between the control plane and the code a task touches.
 *
 * The Autopilot's own source lives in the same repository as the accounting
 * source. Before this existed, the orchestrator ran every git operation in the
 * checkout it was itself running from, so a task's "change set" was the diff of
 * the control-plane branch — and repairing the Autopilot mid-task made eleven
 * infrastructure files appear as out-of-allowlist edits by the builder, twice.
 * The builder had touched none of them.
 *
 * The boundary is structural, not a filter:
 *
 *   control plane   /srv/ai-accounting/repo         the running orchestrator
 *   task worktree   /srv/ai-accounting/worktrees/<TASK-ID>   what the task may change
 *   runtime state   /srv/ai-accounting/state/ai     events and raw artifacts
 *
 * A task worktree is cut from TASK_BASE_SHA — the approved accounting base —
 * never from the control-plane branch, so control-plane commits cannot enter a
 * task's history in the first place. Nothing here filters paths after the fact;
 * the infrastructure is simply not present in the tree being measured.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_WORKTREE_ROOT =
  process.env.AI_WORKTREE_ROOT ?? '/srv/ai-accounting/worktrees';

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  created: boolean;
}

export class WorktreeManager {
  constructor(
    private readonly controlRepo: string,
    private readonly root: string = DEFAULT_WORKTREE_ROOT,
  ) {}

  private git(args: string[], cwd = this.controlRepo, allowFail = false): string {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e: any) {
      if (allowFail) return '';
      throw new Error(
        `git ${args.slice(0, 2).join(' ')} failed: ${String(e?.stderr ?? e?.message).slice(0, 400)}`,
      );
    }
  }

  pathFor(taskId: string): string {
    return path.join(this.root, taskId);
  }

  /** Worktree paths git currently knows about, keyed by branch. */
  private registered(): Map<string, string> {
    const out = new Map<string, string>();
    let current = '';
    for (const line of this.git(['worktree', 'list', '--porcelain'], this.controlRepo, true).split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) {
        out.set(line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''), current);
      }
    }
    return out;
  }

  /**
   * The approved accounting base a task is cut from.
   *
   * origin/main is the only correct answer: the control-plane branch carries
   * Autopilot development that no accounting task should inherit.
   */
  accountingBase(ref = 'origin/main'): string {
    this.git(['fetch', 'origin', '--quiet'], this.controlRepo, true);
    const sha = this.git(['rev-parse', ref], this.controlRepo, true).trim();
    if (!sha) throw new Error(`cannot resolve accounting base ${ref}`);
    return sha;
  }

  /**
   * Ensures an isolated worktree for the task exists at `baseSha`.
   *
   * Never destroys a worktree holding commits that are not reachable from the
   * base — that would discard the builder's work. Such a worktree is reused as
   * it stands and reported, so the caller can decide.
   */
  ensure(taskId: string, branch: string, baseSha: string): WorktreeInfo {
    fs.mkdirSync(this.root, { recursive: true });
    const dest = this.pathFor(taskId);
    const existing = this.registered().get(branch);

    if (existing && fs.existsSync(existing)) {
      return { path: existing, branch, baseSha, created: false };
    }
    // A stale registration (directory deleted underneath git) blocks re-adding.
    this.git(['worktree', 'prune'], this.controlRepo, true);

    const branchExists = this.git(['rev-parse', '--verify', `refs/heads/${branch}`], this.controlRepo, true).trim();
    const args = branchExists
      ? ['worktree', 'add', dest, branch]
      : ['worktree', 'add', '-b', branch, dest, baseSha];
    this.git(args);
    return { path: dest, branch, baseSha, created: true };
  }

  /** Commits on the branch that are not reachable from the recorded base. */
  commitsSinceBase(branch: string, baseSha: string): string[] {
    return this.git(['log', '--format=%H', `${baseSha}..${branch}`], this.controlRepo, true)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * Removes a task worktree. Refuses when it holds uncommitted changes or
   * commits not reachable from `baseSha`, so recovery can never silently
   * discard work.
   */
  remove(taskId: string, branch: string, baseSha: string, force = false): { removed: boolean; reason?: string } {
    const dest = this.registered().get(branch) ?? this.pathFor(taskId);
    if (!fs.existsSync(dest)) return { removed: false, reason: 'worktree does not exist' };
    if (!force) {
      const dirty = this.git(['status', '--porcelain'], dest, true).trim();
      if (dirty) return { removed: false, reason: `worktree has uncommitted changes:\n${dirty}` };
      const own = this.commitsSinceBase(branch, baseSha);
      if (own.length) return { removed: false, reason: `worktree branch has ${own.length} commit(s) since base` };
    }
    this.git(['worktree', 'remove', force ? '--force' : '--', force ? dest : dest].filter(Boolean) as string[]);
    return { removed: true };
  }
}
