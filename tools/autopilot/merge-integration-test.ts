#!/usr/bin/env ts-node
/**
 * Integration test for the controlled merge workflow.
 *
 * Runs the real MergeManager — real git, real event store, real policy engine —
 * against a repository built from scratch in a temp directory, with a local
 * bare remote standing in for origin. The accounting repository is never
 * touched: the whole point is to watch a merge actually happen and actually be
 * refused, and neither is something to do to production code.
 *
 * The only substituted part is the post-merge acceptance gate, because running
 * the accounting test suites against a three-file fixture would prove nothing.
 * Every gate *decision* is still made by MergeManager.
 *
 *   pnpm ai merge-selftest
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from './storage/event-store';
import { TaskStore } from './storage/task-store';
import { PolicyEngine, loadPolicy } from './policy-engine';
import { MergeManager } from './merge-manager';

const TASK = 'TASK-9001';

interface Case {
  name: string;
  /** What must be true of the outcome. */
  expect: 'MERGED' | 'REFUSED';
  /** Substring that must appear in the refusal detail. */
  because?: string;
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A throwaway repo with a bare remote, a main branch and a feature branch. */
function buildFixture(root: string) {
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'work');
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'merge-selftest', GIT_AUTHOR_EMAIL: 'selftest@localhost',
        GIT_COMMITTER_NAME: 'merge-selftest', GIT_COMMITTER_EMAIL: 'selftest@localhost',
        // The fixture must not inherit the monorepo's husky hooks.
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });

  fs.mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'merge-selftest']);
  git(repo, ['config', 'user.email', 'selftest@localhost']);
  git(repo, ['config', 'core.hooksPath', '/dev/null']);
  git(repo, ['remote', 'add', 'origin', remote]);

  fs.writeFileSync(path.join(repo, 'ledger.txt'), 'opening balance\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'chore: seed']);
  git(repo, ['push', '-u', 'origin', 'main']);

  git(repo, ['checkout', '-b', 'ai/task-9001']);
  fs.writeFileSync(path.join(repo, 'ledger.txt'), 'opening balance\nposting\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fix: post the entry']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['checkout', 'main']);
  return { repo, remote, git, head };
}

/** A synthetic event log for a task that legitimately reached READY_TO_MERGE. */
function seedLog(events: EventStore, head: string, opts: { branch?: string } = {}) {
  const branch = opts.branch ?? 'ai/task-9001';
  events.append({ taskId: TASK, type: 'TASK_CREATED', actor: 'orchestrator',
    payload: { title: 'merge workflow selftest', risk: 'low', branch, autoMerge: false } });
  events.append({ taskId: TASK, type: 'STATE_TRANSITION', actor: 'orchestrator',
    payload: { from: 'NEW', to: 'FINAL_ACCEPTANCE' } });
  events.append({ taskId: TASK, type: 'RUNTIME_EVIDENCE', actor: 'acceptance-runner',
    payload: { tier: 'final', ok: true, verified: ['fixture gate'], notVerified: [] } });
  events.append({ taskId: TASK, type: 'STATE_TRANSITION', actor: 'orchestrator',
    payload: { from: 'FINAL_ACCEPTANCE', to: 'READY_TO_MERGE' } });
  events.append({ taskId: TASK, type: 'READY_TO_MERGE', actor: 'orchestrator',
    payload: { branch, head, autoMerge: false } });
}

interface Scenario {
  name: string;
  expect: 'MERGED' | 'REFUSED';
  because?: string;
  /** Mutate the fixture to create the condition under test. */
  arrange?: (f: ReturnType<typeof buildFixture>) => void;
  gatesPass?: boolean;
  policy?: PolicyEngine;
}

async function runScenario(repoRoot: string, s: Scenario): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-it-'));
  try {
    const f = buildFixture(root);
    const aiRoot = path.join(root, 'ai');
    const events = new EventStore(aiRoot);
    const tasks = new TaskStore(events);
    const policy = s.policy ?? new PolicyEngine(loadPolicy(repoRoot));
    seedLog(events, f.head);
    if (s.arrange) s.arrange(f);

    const gatesPass = s.gatesPass !== false;
    const mm = new MergeManager(f.repo, events, tasks, policy, {
      lockPath: path.join(root, 'merge.lock'),
      acceptance: () => ({
        final: () => ({
          ok: gatesPass,
          outcomes: [{
            name: 'fixture-gate', command: 'true', exitCode: gatesPass ? 0 : 1,
            passed: gatesPass ? 1 : 0, failed: gatesPass ? 0 : 1, skipped: 0, total: 1,
            stdoutHash: 'fixture', ok: gatesPass,
          }],
          violations: gatesPass ? [] : [{ rule: 'fixture', detail: 'post-merge gate failed' }],
        }),
      }),
    });

    const mainBefore = execFileSync('git', ['rev-parse', 'main'], { cwd: f.repo, encoding: 'utf8' }).trim();
    const remoteBefore = execFileSync('git', ['rev-parse', 'main'], { cwd: f.remote, encoding: 'utf8' }).trim();

    const r = await mm.approveAndMerge(TASK, 'selftest-owner', 'low');

    const mainAfter = execFileSync('git', ['rev-parse', 'main'], { cwd: f.repo, encoding: 'utf8' }).trim();
    const remoteAfter = execFileSync('git', ['rev-parse', 'main'], { cwd: f.remote, encoding: 'utf8' }).trim();

    if (s.expect === 'MERGED') {
      check(s.name, r.ok && r.state === 'MERGED', r.detail);
      check(`${s.name}: main advanced`, mainAfter !== mainBefore);
      check(`${s.name}: remote received it`, remoteAfter === mainAfter);
      const log = events.read(TASK);
      check(`${s.name}: MERGE_APPROVED before MERGED`,
        log.findIndex((e) => e.type === 'MERGE_APPROVED') < log.findIndex((e) => e.type === 'MERGED') &&
        log.some((e) => e.type === 'MERGED'));
      const approved = log.find((e) => e.type === 'MERGE_APPROVED');
      check(`${s.name}: approval names the authenticated owner`,
        (approved?.payload as any)?.authenticatedOwner === 'selftest-owner');
      // No force, no squash: the merge must be a real merge commit with two
      // parents, and the pre-merge main must still be reachable.
      const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'],
        { cwd: f.repo, encoding: 'utf8' }).trim().split(' ');
      check(`${s.name}: --no-ff merge commit (2 parents)`, parents.length === 3);
      check(`${s.name}: previous main still reachable`,
        execFileSync('git', ['merge-base', '--is-ancestor', mainBefore, 'HEAD'],
          { cwd: f.repo, encoding: 'utf8' }) !== undefined);
    } else {
      check(s.name, !r.ok, `${r.state}: ${r.detail}`);
      if (s.because) {
        check(`${s.name}: reason`, r.detail.includes(s.because), `expected "${s.because}", got "${r.detail}"`);
      }
      check(`${s.name}: remote main untouched`, remoteAfter === remoteBefore);
      const log = events.read(TASK);
      check(`${s.name}: never recorded MERGED`, !log.some((e) => e.type === 'MERGED'));
    }

    const integrity = events.verifyIntegrity(TASK);
    check(`${s.name}: event log unmodified`, integrity.ok, integrity.problems.join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function runMergeIntegrationTests(repoRoot: string): Promise<number> {
  console.log('merge workflow integration test (disposable repository)\n');

  // Both protection lists must actually block. `protectedPaths` is the literal
  // list; `forbiddenPathPatterns` is the regex list. They are tested separately
  // because for a while only the second was consulted, and a file listed in the
  // first merged straight through.
  const protectedLiteralPolicy = new PolicyEngine({
    ...loadPolicy(repoRoot),
    protectedPaths: ['ledger.txt'],
    forbiddenPathPatterns: [],
  } as any);
  const protectedPatternPolicy = new PolicyEngine({
    ...loadPolicy(repoRoot),
    protectedPaths: [],
    forbiddenPathPatterns: ['^ledger\\.txt$'],
  } as any);

  const scenarios: Scenario[] = [
    { name: 'happy path merges and pushes', expect: 'MERGED' },

    { name: 'source branch moved since review', expect: 'REFUSED', because: 'source branch moved',
      arrange: (f) => {
        f.git(f.repo, ['checkout', 'ai/task-9001']);
        fs.appendFileSync(path.join(f.repo, 'ledger.txt'), 'sneaky extra change\n');
        f.git(f.repo, ['commit', '-am', 'fix: unreviewed change']);
        f.git(f.repo, ['checkout', 'main']);
      } },

    { name: 'local main ahead of origin/main', expect: 'REFUSED', because: 'differs from origin/main',
      arrange: (f) => {
        fs.writeFileSync(path.join(f.repo, 'other.txt'), 'divergent\n');
        f.git(f.repo, ['add', '.']);
        f.git(f.repo, ['commit', '-m', 'chore: local only']);
      } },

    { name: 'dirty working tree', expect: 'REFUSED', because: 'working tree is not clean',
      arrange: (f) => { fs.writeFileSync(path.join(f.repo, 'ledger.txt'), 'uncommitted edit\n'); } },

    { name: 'protected path (literal list) in the diff', expect: 'REFUSED', because: 'protected path',
      policy: protectedLiteralPolicy },

    { name: 'protected path (regex list) in the diff', expect: 'REFUSED', because: 'protected path',
      policy: protectedPatternPolicy },

    { name: 'post-merge gate fails', expect: 'REFUSED', gatesPass: false },
  ];

  for (const s of scenarios) {
    console.log(`- ${s.name}`);
    await runScenario(repoRoot, s);
  }

  // The failing-gate case has an extra invariant: the merge is rolled back
  // locally as well as not pushed, so a broken main never exists anywhere.
  console.log('- post-merge failure leaves local main untouched too');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-it-'));
    try {
      const f = buildFixture(root);
      const aiRoot = path.join(root, 'ai');
      const events = new EventStore(aiRoot);
      const tasks = new TaskStore(events);
      seedLog(events, f.head);
      const before = execFileSync('git', ['rev-parse', 'main'], { cwd: f.repo, encoding: 'utf8' }).trim();
      const mm = new MergeManager(f.repo, events, tasks, new PolicyEngine(loadPolicy(repoRoot)), {
        lockPath: path.join(root, 'merge.lock'),
        acceptance: () => ({ final: () => ({ ok: false, outcomes: [], violations: [{ rule: 'fixture', detail: 'gate failed' }] }) }),
      });
      await mm.approveAndMerge(TASK, 'selftest-owner', 'low');
      const after = execFileSync('git', ['rev-parse', 'main'], { cwd: f.repo, encoding: 'utf8' }).trim();
      check('local main rolled back after failing gate', after === before, `${before.slice(0, 9)} -> ${after.slice(0, 9)}`);
      check('escalation recorded', events.read(TASK).some((e) => e.type === 'ESCALATION'));
      check('approval was NOT rewritten', events.read(TASK).filter((e) => e.type === 'MERGE_APPROVED').length === 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // A held lock must stop a second merge outright.
  console.log('- concurrent merge is refused by the lock');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-it-'));
    try {
      const f = buildFixture(root);
      const events = new EventStore(path.join(root, 'ai'));
      const tasks = new TaskStore(events);
      seedLog(events, f.head);
      const lockPath = path.join(root, 'merge.lock');
      fs.writeFileSync(lockPath, 'held by another merge\n');
      const mm = new MergeManager(f.repo, events, tasks, new PolicyEngine(loadPolicy(repoRoot)), {
        lockPath,
        acceptance: () => ({ final: () => ({ ok: true, outcomes: [], violations: [] }) }),
      });
      const r = await mm.approveAndMerge(TASK, 'selftest-owner', 'low');
      check('locked merge refused', !r.ok && r.state === 'LOCKED', r.detail);
      check('no approval written while locked', !events.read(TASK).some((e) => e.type === 'MERGE_APPROVED'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`\nmerge integration: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}
