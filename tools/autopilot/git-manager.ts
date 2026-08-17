/**
 * Git access for the orchestrator.
 *
 * Everything that could leave the machine or rewrite shared history is absent
 * by construction: there is no push, no rebase, no reset --hard, no force. The
 * only mutating operations are branch creation, add, and commit.
 */
import { execFileSync } from 'child_process';
import { PolicyEngine } from './policy-engine';

export class GitManager {
  constructor(private readonly cwd: string, private readonly policy: PolicyEngine) {}

  private git(args: string[]): string {
    const violations = this.policy.checkCommand(['git', ...args].join(' '));
    if (violations.length) {
      throw new Error(`policy blocked git command: ${violations.map((v) => v.rule).join(', ')}`);
    }
    return execFileSync('git', args, { cwd: this.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }

  head(): string {
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  currentBranch(): string {
    return this.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  }

  isClean(): boolean {
    return this.git(['status', '--porcelain']).trim().length === 0;
  }

  status(): string {
    return this.git(['status', '--porcelain']).trim();
  }

  branchExists(name: string): boolean {
    try {
      // stdio silenced: a missing branch is an expected answer here, not an
      // error worth printing over the orchestrator's own output.
      execFileSync('git', ['rev-parse', '--verify', `refs/heads/${name}`], {
        cwd: this.cwd,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Commits on `name` that are not reachable from HEAD. */
  private unmergedCommits(name: string): string[] {
    if (!this.branchExists(name)) return [];
    return this.git(['log', '--format=%H', `HEAD..${name}`])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * Puts the working tree on the task branch, creating it if necessary.
   *
   * A retry re-enters an existing task branch that was cut before the fix that
   * made the retry necessary, so it points at a stale commit. Checking it out
   * would try to roll the tree back — and the Autopilot's own event log lives in
   * `.ai/tasks/`, which is tracked, so the checkout is refused outright with
   * "local changes would be overwritten".
   *
   * When the branch carries no commits of its own there is nothing to preserve,
   * so it is retargeted onto HEAD (`checkout -B`), which moves the ref without
   * touching a single file. When it DOES carry commits they are the builder's
   * work: it is checked out normally and never discarded.
   */
  createBranch(name: string): { retargeted: boolean } {
    if (!this.branchExists(name)) {
      this.git(['checkout', '-b', name]);
      return { retargeted: false };
    }
    const hasOwnWork = this.unmergedCommits(name).length > 0;
    if (hasOwnWork) {
      if (this.currentBranch() !== name) this.git(['checkout', name]);
      return { retargeted: false };
    }
    // No commits of its own: safe to move the ref onto HEAD. Reports the move so
    // the caller can re-anchor the scope baseline, which would otherwise still
    // point at the commit the branch was originally cut from.
    const before = this.git(['rev-parse', name]).trim();
    this.git(['checkout', '-B', name]);
    return { retargeted: this.git(['rev-parse', name]).trim() !== before };
  }

  /**
   * Files changed relative to a base ref, plus anything uncommitted.
   *
   * The autopilot's own state (`.ai/`) is excluded: the orchestrator writes its
   * event log there on every run, so counting it as task output made each run
   * trip its own scope check. It is bookkeeping, not something the builder
   * produced, and it is covered by the append-only integrity check instead.
   */
  changedFiles(baseRef: string): string[] {
    const committed = this.git(['diff', '--name-only', `${baseRef}...HEAD`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    // --untracked-files=all: without it git collapses a new directory to
    // "path/dir/", and the scope report names a directory instead of the file
    // that was actually added. It still blocks either way, but an operator
    // reading POLICY_BLOCK should see the file.
    const working = this.git(['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .map((l) => l.slice(3).trim())
      // Renames report "old -> new"; the new path is what changed.
      .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1].trim() : l))
      .filter(Boolean);
    return Array.from(new Set([...committed, ...working]))
      .filter((f) => !f.startsWith('.ai/'))
      .sort();
  }

  diff(baseRef: string): string {
    return this.git(['diff', `${baseRef}...HEAD`]);
  }

  /**
   * Commits without ever using --no-verify. If a hook rejects the commit the
   * error propagates; suppressing hooks is a policy violation, not a fallback.
   */
  commit(message: string, files: string[]): string {
    if (files.length === 0) throw new Error('refusing to commit an empty file list');
    this.git(['add', '--', ...files]);
    this.git(['commit', '-m', message]);
    return this.head();
  }

  commitsBetween(baseRef: string, headRef = 'HEAD'): Array<{ sha: string; subject: string }> {
    const out = this.git(['log', '--format=%H%x1f%s', `${baseRef}..${headRef}`]).trim();
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, subject };
    });
  }

  showFileAtRef(ref: string, file: string): string | null {
    try {
      return this.git(['show', `${ref}:${file}`]);
    } catch {
      return null;
    }
  }
}
