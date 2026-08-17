#!/usr/bin/env ts-node
/**
 * Regression test for the TASK-0007 contamination.
 *
 * The failure: while the Autopilot was being repaired mid-task, the scope check
 * reported eleven `tools/autopilot/**` and `tools/control-center/**` files as
 * out-of-allowlist edits by the builder. The builder had touched none of them.
 * It happened twice, and adding those paths to the allowlist would have
 * "fixed" it by deleting the safety property.
 *
 * There were three compounding causes, and this test pins all three:
 *   1. the scope check ran in the control-plane checkout, not the task worktree;
 *   2. the task branch was cut from a control-plane commit, so infrastructure
 *      was inside its own history;
 *   3. runtime event writes dirtied the tracked tree being measured.
 *
 * The shape that matters: control-plane edits are invisible to the scope check
 * because they are physically outside the tree, while a forbidden edit *inside*
 * the task worktree is still blocked. A filter would satisfy the first and
 * quietly weaken the second.
 *
 *   pnpm ai isolation-selftest
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PolicyEngine, DEFAULT_POLICY } from './policy-engine';
import { GitManager } from './git-manager';
import { WorktreeManager } from './worktree-manager';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ALLOWLIST = [
  'packages/server/src/modules/Attachments/Attachments.controller.ts',
  'packages/server/src/modules/Attachments/Attachments.controller.spec.ts',
];

/** A control-plane repo with accounting source, an origin, and a task branch. */
function buildFixture(root: string) {
  const origin = path.join(root, 'origin.git');
  const control = path.join(root, 'control-plane');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'isolation', GIT_AUTHOR_EMAIL: 'iso@localhost',
    GIT_COMMITTER_NAME: 'isolation', GIT_COMMITTER_EMAIL: 'iso@localhost',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env });

  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  fs.mkdirSync(control, { recursive: true });
  git(control, ['init', '-b', 'main']);
  git(control, ['config', 'user.email', 'iso@localhost']);
  git(control, ['config', 'user.name', 'isolation']);
  git(control, ['config', 'core.hooksPath', '/dev/null']);
  git(control, ['remote', 'add', 'origin', origin]);

  // Accounting source + the Autopilot's own source, same repo — the condition
  // that made this possible at all.
  for (const f of ALLOWLIST) {
    fs.mkdirSync(path.join(control, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(control, f), 'original\n');
  }
  fs.mkdirSync(path.join(control, 'tools/autopilot'), { recursive: true });
  fs.writeFileSync(path.join(control, 'tools/autopilot/orchestrator.ts'), 'v1\n');
  fs.writeFileSync(path.join(control, 'tools/autopilot/parsers.ts'), 'v1\n');
  git(control, ['add', '-A']);
  git(control, ['commit', '-m', 'accounting base']);
  git(control, ['push', '-q', '-u', 'origin', 'main']);

  return { origin, control, git };
}

export function runIsolationSelfTests(): number {
  console.log('worktree isolation regression test (TASK-0007 contamination)\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
  try {
    const f = buildFixture(root);
    const policy = new PolicyEngine({ ...DEFAULT_POLICY, protectedPaths: [], forbiddenPathPatterns: [] });
    const wtRoot = path.join(root, 'worktrees');
    const wtm = new WorktreeManager(f.control, wtRoot);

    // TASK_BASE_SHA: the approved accounting base, resolved before any work.
    const baseSha = wtm.accountingBase('origin/main');
    check('task base resolves to origin/main, not the control-plane branch',
      baseSha === f.git(f.control, ['rev-parse', 'origin/main']).trim(), baseSha.slice(0, 9));

    const wt = wtm.ensure('TASK-9100', 'ai/task-9100', baseSha);
    check('isolated worktree created', fs.existsSync(wt.path), wt.path);
    check('worktree is outside the control-plane checkout',
      !wt.path.startsWith(f.control + path.sep));

    // --- the contamination: repair the Autopilot while the task is open -----
    fs.writeFileSync(path.join(f.control, 'tools/autopilot/orchestrator.ts'), 'v2 repaired\n');
    fs.writeFileSync(path.join(f.control, 'tools/autopilot/parsers.ts'), 'v2 repaired\n');
    f.git(f.control, ['add', '-A']);
    f.git(f.control, ['commit', '-m', 'fix: repair the autopilot mid-task']);

    // --- the candidate: only the two allowed files, inside the worktree -----
    for (const rel of ALLOWLIST) {
      fs.writeFileSync(path.join(wt.path, rel), 'candidate fix\n');
    }

    const taskGit = new GitManager(wt.path, policy);
    const changed = taskGit.changedFiles(baseSha);
    console.log(`    scope sees: ${JSON.stringify(changed)}`);

    check('control-plane repair is invisible to the task scope check',
      !changed.some((c) => c.startsWith('tools/')),
      changed.filter((c) => c.startsWith('tools/')).join(', ') || 'no tools/ paths');
    check('the two candidate files are seen',
      ALLOWLIST.every((a) => changed.includes(a)));

    const violations = [
      ...policy.checkScope(changed, ALLOWLIST),
      ...policy.checkProtectedPaths(changed),
    ];
    check('scope policy PASSES for an in-allowlist candidate', violations.length === 0,
      violations.map((v) => v.detail).join('; '));

    // --- and the safety property still holds --------------------------------
    fs.mkdirSync(path.join(wt.path, 'packages/server/src/modules/Ledger'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, 'packages/server/src/modules/Ledger/Ledger.service.ts'), 'tampered\n');
    const changed2 = taskGit.changedFiles(baseSha);
    const violations2 = [
      ...policy.checkScope(changed2, ALLOWLIST),
      ...policy.checkProtectedPaths(changed2),
    ];
    check('scope policy BLOCKS a forbidden edit inside the task worktree',
      violations2.length > 0,
      violations2.map((v) => `${v.rule}:${v.detail}`).join('; '));
    check('the block names the tampered file itself, not just its directory',
      violations2.some((v) => v.detail.includes('Ledger.service.ts')),
      violations2.map((v) => v.detail).join('; '));
    check('nothing outside the worktree is blamed',
      !violations2.some((v) => v.detail.startsWith('tools/')),
      violations2.map((v) => v.detail).join('; '));

    // --- runtime state must not dirty the measured tree ---------------------
    const stateRoot = path.join(root, 'state', 'ai', 'tasks', 'TASK-9100');
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'events.jsonl'), '{"seq":1}\n');
    check('event writes land outside the task worktree',
      !fs.existsSync(path.join(wt.path, '.ai', 'tasks', 'TASK-9100', 'events.jsonl')));
    const afterState = taskGit.changedFiles(baseSha);
    check('writing runtime state does not change the task diff',
      JSON.stringify(afterState) === JSON.stringify(changed2));

    // --- a worktree with real work is never silently destroyed --------------
    f.git(wt.path, ['add', '-A']);
    f.git(wt.path, ['commit', '-m', 'builder work']);
    const rm = wtm.remove('TASK-9100', 'ai/task-9100', baseSha);
    check('refuses to remove a worktree holding commits since base',
      rm.removed === false, rm.reason ?? '');
  } finally {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: path.join(root, 'control-plane'), stdio: 'ignore' });
    } catch { /* fixture already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nisolation self-tests: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}
