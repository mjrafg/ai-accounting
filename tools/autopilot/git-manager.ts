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

  createBranch(name: string): void {
    if (this.branchExists(name)) {
      this.git(['checkout', name]);
      return;
    }
    this.git(['checkout', '-b', name]);
  }

  /** Files changed relative to a base ref, plus anything uncommitted. */
  changedFiles(baseRef: string): string[] {
    const committed = this.git(['diff', '--name-only', `${baseRef}...HEAD`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const working = this.git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    return Array.from(new Set([...committed, ...working])).sort();
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
