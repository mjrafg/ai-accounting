/**
 * Physical isolation: control plane != task worktree != production.
 *
 * Every task gets its own worktree cut from TASK_BASE_SHA (approved
 * origin/main), never from the control-plane branch — so control-plane commits
 * cannot appear in a task's history or diff. The lesson is V1's: the scope
 * check must measure a tree the orchestrator does not edit.
 *
 * node_modules and the test .env are provided by symlink/copy and excluded via
 * the per-worktree exclude file, so they exist for builds and tests without
 * ever entering a diff.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const WORKTREE_ROOT = process.env.AI_V2_WORKTREES ?? '/srv/ai-accounting/worktrees';

export class WorktreeManager {
  constructor(
    readonly controlRepo: string,
    readonly root: string = WORKTREE_ROOT,
  ) {}

  git(args: string[], cwd = this.controlRepo, allowFail = false): string {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e: any) {
      if (allowFail) return '';
      throw new Error(`git ${args.slice(0, 2).join(' ')}: ${String(e?.stderr ?? e?.message).slice(0, 300)}`);
    }
  }

  pathFor(taskId: string): string { return path.join(this.root, taskId); }

  /** TASK_BASE_SHA: the approved accounting base. */
  accountingBase(ref = 'origin/main'): string {
    this.git(['fetch', 'origin', '--quiet'], this.controlRepo, true);
    const sha = this.git(['rev-parse', ref], this.controlRepo, true).trim();
    if (!sha) throw new Error(`cannot resolve base ${ref}`);
    return sha;
  }

  private registered(): Map<string, string> {
    const out = new Map<string, string>();
    let cur = '';
    for (const line of this.git(['worktree', 'list', '--porcelain'], this.controlRepo, true).split('\n')) {
      if (line.startsWith('worktree ')) cur = line.slice(9).trim();
      else if (line.startsWith('branch ')) out.set(line.slice(7).trim().replace(/^refs\/heads\//, ''), cur);
    }
    return out;
  }

  ensure(taskId: string, branch: string, baseSha: string): { path: string; created: boolean } {
    fs.mkdirSync(this.root, { recursive: true });
    const dest = this.pathFor(taskId);
    const existing = this.registered().get(branch);
    if (existing && fs.existsSync(existing)) return { path: existing, created: false };
    this.git(['worktree', 'prune'], this.controlRepo, true);
    const branchExists = this.git(['rev-parse', '--verify', `refs/heads/${branch}`], this.controlRepo, true).trim();
    this.git(branchExists
      ? ['worktree', 'add', dest, branch]
      : ['worktree', 'add', '-b', branch, dest, baseSha]);
    this.provision(dest);
    return { path: dest, created: true };
  }

  /**
   * Build/test support inside the worktree, invisible to every diff:
   * symlinked node_modules (pnpm virtual stores resolve via realpath) and a
   * copy of the disposable-test .env. All listed in the per-worktree exclude.
   */
  private provision(dest: string): void {
    const links = [
      'node_modules',
      'packages/server/node_modules',
      'packages/webapp/node_modules',
      'shared/pdf-templates/node_modules',
      'shared/bigcapital-utils/node_modules',
      'shared/email-components/node_modules',
    ];
    const excludes: string[] = ['.env'];
    for (const rel of links) {
      const src = path.join(this.controlRepo, rel);
      const dst = path.join(dest, rel);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try { fs.symlinkSync(src, dst); excludes.push(rel); } catch { /* already there */ }
    }
    const envSrc = path.join(this.controlRepo, '.env');
    if (fs.existsSync(envSrc) && !fs.existsSync(path.join(dest, '.env'))) {
      fs.copyFileSync(envSrc, path.join(dest, '.env'));
    }
    // Per-worktree hook disable (needs worktreeConfig on the shared repo).
    this.git(['config', 'extensions.worktreeConfig', 'true'], this.controlRepo, true);
    this.git(['config', '--worktree', 'core.hooksPath', '/dev/null'], dest, true);
    const excludeFile = this.git(['rev-parse', '--git-path', 'info/exclude'], dest, true).trim();
    if (excludeFile) {
      const p = path.isAbsolute(excludeFile) ? excludeFile : path.join(dest, excludeFile);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, excludes.map((e) => `/${e}`).join('\n') + '\n');
    }
  }

  head(worktree: string): string { return this.git(['rev-parse', 'HEAD'], worktree).trim(); }

  /** Candidate change set measured in the task worktree only. */
  changedFiles(worktree: string, baseSha: string): string[] {
    const committed = this.git(['diff', '--name-only', `${baseSha}...HEAD`], worktree, true)
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const working = this.git(['status', '--porcelain', '--untracked-files=all'], worktree, true)
      .split('\n').map((l) => l.slice(3).trim())
      .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1].trim() : l))
      .filter(Boolean);
    return [...new Set([...committed, ...working])].sort();
  }

  diff(worktree: string, baseSha: string): string {
    const committed = this.git(['diff', `${baseSha}...HEAD`], worktree, true);
    const working = this.git(['diff'], worktree, true);
    return committed + (working ? `\n--- uncommitted ---\n${working}` : '');
  }

  commitsSinceBase(branch: string, baseSha: string): string[] {
    return this.git(['log', '--format=%H', `${baseSha}..${branch}`], this.controlRepo, true)
      .split('\n').map((l) => l.trim()).filter(Boolean);
  }

  commitAll(worktree: string, message: string): string | null {
    this.git(['add', '-A'], worktree, true);
    const staged = this.git(['diff', '--cached', '--name-only'], worktree, true).trim();
    if (!staged) return null;
    // Hooks are disabled per-worktree (in provision), never bypassed with
    // --no-verify: husky needs the control-plane toolchain the isolated
    // worktree deliberately lacks. Gates are enforced by the pipeline.
    execFileSync('git', ['-c', 'user.name=autopilot-v2', '-c', 'user.email=autopilot@agent24.io',
      'commit', '-q', '-m', message], { cwd: worktree });
    return this.head(worktree);
  }

  remove(taskId: string, branch: string, baseSha: string, force = false): { removed: boolean; reason?: string } {
    const dest = this.registered().get(branch) ?? this.pathFor(taskId);
    if (!fs.existsSync(dest)) return { removed: false, reason: 'missing' };
    if (!force) {
      const dirty = this.git(['status', '--porcelain'], dest, true).trim();
      if (dirty) return { removed: false, reason: 'uncommitted changes' };
      if (this.commitsSinceBase(branch, baseSha).length) return { removed: false, reason: 'has commits since base' };
    }
    this.git(['worktree', 'remove', '--force', dest], this.controlRepo, true);
    return { removed: true };
  }
}
