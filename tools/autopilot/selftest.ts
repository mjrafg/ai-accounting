/**
 * Autopilot self-tests.
 *
 * These test the harness, not the accounting code. Several of them are attacks:
 * the point is to confirm the policy engine actually refuses, rather than to
 * confirm the happy path works. Nothing here may touch accounting source, so
 * every test operates on a scratch event store under .ai/selftest.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore, SecretDetectedError } from './storage/event-store';
import { TaskStore } from './storage/task-store';
import { PolicyEngine, DEFAULT_POLICY } from './policy-engine';
import { buildReport } from './report';
import { backfillStage0 } from './backfill-stage0';
import { GitManager } from './git-manager';
import { Orchestrator, OrchestratorDeps } from './orchestrator';
import { AgentAdapter, AgentResult, AgentTask, TestOutcome } from './types';
import { AcceptanceRunner } from './acceptance-runner';
import { canTransition } from './state-machine';

type Case = { name: string; run: () => void | Promise<void> };

function scratch(): { root: string; events: EventStore; tasks: TaskStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-selftest-'));
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  const events = new EventStore(root);
  return { root, events, tasks: new TaskStore(events) };
}

/**
 * A throwaway git repo. Self-tests must never create branches or commits in the
 * real repository, so any test that exercises the orchestrator gets its own.
 */
function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-repo-'));
  const run = (args: string[]) =>
    require('child_process').execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run(['init', '-q']);
  run(['config', 'user.email', 'autopilot@example.invalid']);
  run(['config', 'user.name', 'autopilot selftest']);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'seed']);
  return dir;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Adapter that returns a canned structured result. */
function stubAdapter(
  name: string,
  provider: string,
  byRole: Record<string, Record<string, unknown> | null>,
  opts: { available?: boolean; reason?: string; simulated?: boolean } = {},
): AgentAdapter {
  return {
    name,
    provider,
    async available() {
      return opts.available === false
        ? { ok: false, reason: opts.reason ?? 'unavailable' }
        : { ok: true, mechanism: 'stub' };
    },
    async run(task: AgentTask): Promise<AgentResult> {
      const structured = byRole[task.role] ?? null;
      return {
        ok: structured !== null,
        structured,
        rawArtifactPath: '',
        rawArtifactHash: 'stub',
        durationMs: 1,
        exitCode: structured ? 0 : 1,
        usage: null,
        error: structured ? undefined : `no stub for role ${task.role}`,
        simulated: opts.simulated === true,
        provider,
      };
    },
  };
}

export async function runSelfTests(repoRoot: string): Promise<number> {
  const policy = new PolicyEngine(DEFAULT_POLICY);
  const cases: Case[] = [];

  // A. Deterministic rebuild -------------------------------------------------
  cases.push({
    name: 'A. event-store rebuild is byte-identical',
    run: () => {
      const { events, tasks } = scratch();
      const git = new GitManager(repoRoot, policy);
      backfillStage0(events, tasks, git);
      const first = buildReport('TASK-0000', events, tasks);
      const second = buildReport('TASK-0000', events, tasks);
      assert(first === second, 'two rebuilds differed');
      assert(first.length > 500, 'report suspiciously short');
      // Rebuild from a fresh reader over the same immutable log.
      const reread = new EventStore((events as any).root ?? '');
      const third = buildReport('TASK-0000', reread, new TaskStore(reread));
      assert(third === first, 'rebuild from a fresh store differed');
    },
  });

  // B. Secret rejection -------------------------------------------------------
  cases.push({
    name: 'B. secret writes are refused',
    run: () => {
      const { events } = scratch();
      const attempts: Array<[string, unknown]> = [
        ['bearer token', { note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' }],
        ['db connection string', { dsn: 'mysql://root:hunter2supersecret@10.0.0.4:3306/prod' }],
        ['anthropic key', { key: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' }],
        ['password assignment', { cfg: 'password = correcthorsebattery' }],
      ];
      for (const [label, payload] of attempts) {
        let refused = false;
        try {
          events.append({ taskId: 'T', type: 'TASK_CREATED', actor: 'human', payload: payload as any });
        } catch (e) {
          refused = e instanceof SecretDetectedError;
        }
        assert(refused, `${label} was NOT refused`);
      }
      // And the refusal must leave no partial log behind.
      assert(events.read('T').length === 0, 'a refused write still created events');
    },
  });

  // C. Test-deletion attack ---------------------------------------------------
  cases.push({
    name: 'C. vanishing tests are blocked even when the command exits 0',
    run: () => {
      const before: TestOutcome = {
        name: 'stage0', command: 'x', exitCode: 0, passed: 29, failed: 0, skipped: 0,
        total: 29, stdoutHash: 'a', rawPath: '', ok: true,
      };
      const after: TestOutcome = { ...before, passed: 24, total: 24, stdoutHash: 'b' };
      const v = policy.checkTestOutcome(after, before);
      assert(v.some((x) => x.rule === 'TEST_COUNT_REDUCTION'), 'test-count reduction not blocked');
      assert(v.some((x) => x.rule === 'PASS_COUNT_REDUCTION'), 'pass-count reduction not blocked');

      const skipped: TestOutcome = { ...before, passed: 28, skipped: 1, stdoutHash: 'c' };
      assert(
        policy.checkTestOutcome(skipped, before).some((x) => x.rule === 'UNEXPECTED_SKIP'),
        'new skip not blocked',
      );

      const drifted: TestOutcome = {
        ...before, name: 'stage-minus-1-baseline',
        classifications: { regressions: 1, reviewRequired: 0, dirty: 0 },
      };
      assert(
        policy.checkTestOutcome(drifted).some((x) => x.rule === 'BASELINE_DRIFT'),
        'baseline drift not blocked',
      );
    },
  });

  // D. Scope attack -----------------------------------------------------------
  cases.push({
    name: 'D. out-of-allowlist and protected-path edits are blocked',
    run: () => {
      const allow = ['packages/server/src/modules/Ledger', 'packages/server/test'];
      const scope = policy.checkScope(
        ['packages/server/src/modules/Ledger/LedgerStorage.service.ts', 'packages/webapp/src/App.tsx'],
        allow,
      );
      assert(scope.length === 1 && scope[0].rule === 'OUT_OF_ALLOWLIST', 'out-of-scope edit not blocked');

      const protectedPaths = policy.checkProtectedPaths([
        'packages/server/src/database/migrations/20260101_x.ts',
        '.github/workflows/ci.yml',
        '.gitignore',
        'pnpm-lock.yaml',
      ]);
      assert(protectedPaths.length >= 4, `expected >=4 protected-path blocks, got ${protectedPaths.length}`);

      assert(
        policy.checkCommand('git commit --no-verify -m x').some((v) => v.rule === 'FORBIDDEN_COMMAND'),
        '--no-verify not blocked',
      );
      assert(
        policy.checkCommand('node test/e2e-runner.mjs --write-baseline').length > 0,
        'silent rebaseline not blocked',
      );
      assert(policy.checkCommand('git push origin main').length > 0, 'push not blocked');
      assert(!policy.autoMergeAllowed('high'), 'HIGH risk must never auto-merge');
    },
  });

  // E. Same-provider fallback -------------------------------------------------
  cases.push({
    name: 'E. unavailable reviewer escalates instead of falling back to Claude',
    run: async () => {
      const { root, events, tasks } = scratch();
      const repo = scratchRepo();
      const deps: OrchestratorDeps = {
        repoRoot: repo,
        events,
        tasks,
        policy,
        git: new GitManager(repo, policy),
        advisor: stubAdapter('claude-advisor', 'anthropic', { design: { scopeAllowlist: [], outOfScope: [], invariants: [], requiredTests: [] } }),
        builder: stubAdapter('claude-code', 'anthropic', {}),
        reviewer: stubAdapter('codex', 'openai', {}, { available: false, reason: 'codex binary not installed' }),
        log: () => undefined,
      };
      const orch = new Orchestrator(deps);
      const rec = orch.createTask('reviewer outage', 'high');
      const state = await orch.run(rec.taskId);
      assert(state === 'ESCALATED', `expected ESCALATED, got ${state}`);
      const esc = tasks.byType(rec.taskId, 'ESCALATION');
      assert(esc.length === 1, 'no escalation recorded');
      assert(
        String((esc[0].payload as any).reason).includes('reviewer unavailable'),
        'escalation did not name the reviewer outage',
      );
      // Nothing may have been designed or built after the outage was detected.
      assert(tasks.byType(rec.taskId, 'IMPLEMENTATION').length === 0, 'builder ran despite no reviewer');
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  });

  // F. Crash / resume ---------------------------------------------------------
  cases.push({
    name: 'F. resume does not replay completed write steps',
    run: async () => {
      const { root, events, tasks } = scratch();
      // Simulate a crash right after IMPLEMENTING was persisted.
      events.append({
        taskId: 'TASK-9001', type: 'TASK_CREATED', actor: 'human',
        payload: { title: 'crash', risk: 'high', branch: 'ai/task-9001', autoMerge: false, allowlist: [], baseRef: 'HEAD' },
      });
      events.append({ taskId: 'TASK-9001', type: 'STATE_TRANSITION', actor: 'orchestrator', payload: { from: 'NEW', to: 'DESIGNING' } });
      events.append({ taskId: 'TASK-9001', type: 'STATE_TRANSITION', actor: 'orchestrator', payload: { from: 'DESIGNING', to: 'DESIGN_REVIEW' } });
      events.append({ taskId: 'TASK-9001', type: 'STATE_TRANSITION', actor: 'orchestrator', payload: { from: 'DESIGN_REVIEW', to: 'READY_TO_IMPLEMENT' } });
      events.append({ taskId: 'TASK-9001', type: 'STATE_TRANSITION', actor: 'orchestrator', payload: { from: 'READY_TO_IMPLEMENT', to: 'IMPLEMENTING' } });
      events.append({
        taskId: 'TASK-9001', type: 'IMPLEMENTATION', actor: 'claude-code',
        payload: { status: 'IMPLEMENTED', commit: 'deadbeef', filesChanged: ['a.ts'] },
      });

      const derived = tasks.deriveTask('TASK-9001')!;
      assert(derived.state === 'IMPLEMENTING', `state not recovered: ${derived.state}`);
      // The pipeline may only move forward from here; re-entering the build
      // step would mean a second commit for the same work.
      assert(!canTransition('IMPLEMENTING', 'IMPLEMENTING'), 'IMPLEMENTING may not re-enter itself');
      assert(canTransition('IMPLEMENTING', 'TESTING'), 'resume cannot advance to TESTING');
      const implCount = tasks.byType('TASK-9001', 'IMPLEMENTATION').length;
      assert(implCount === 1, `expected exactly 1 implementation event, got ${implCount}`);

      const integrity = events.verifyIntegrity('TASK-9001');
      assert(integrity.ok, `log integrity broken: ${integrity.problems.join('; ')}`);
      fs.rmSync(root, { recursive: true, force: true });
    },
  });

  // G. Stage 0 replay ---------------------------------------------------------
  cases.push({
    name: 'G. Stage 0 replay preserves the historical distinctions',
    run: () => {
      const { root, events, tasks } = scratch();
      const git = new GitManager(repoRoot, policy);
      const res = backfillStage0(events, tasks, git);
      const md = buildReport('TASK-0000', events, tasks);

      // The trx-propagation fix and the suppressErrors annotation are different
      // fixes for different failure modes; collapsing them would lose the point
      // of Stage 0.
      assert(/inside owning transaction/i.test(md), 'trx-propagation fix missing from replay');
      assert(/fail closed/i.test(md), 'fail-closed annotation work missing from replay');
      assert(/CDX-S0-0[1-4]/.test(md), 'blocker chain missing from replay');
      assert(/BACKFILL_GAP|EVIDENCE GAP/.test(md), 'evidence gaps not surfaced');
      assert(/DEFERRED/.test(md), 'deferred items not surfaced');
      assert(/NOT VERIFIED/.test(md), 'NOT VERIFIED section missing');
      assert(/SAMPLE SIZE: 1 TASK/.test(md), 'sample-size warning missing');
      assert(res.gaps >= 2, `expected recorded evidence gaps, got ${res.gaps}`);

      // Replay must not have touched accounting source.
      assert(git.isClean() || !git.status().includes('packages/server/src'), 'replay modified accounting source');
      fs.rmSync(root, { recursive: true, force: true });
    },
  });

  // H. Simulated reviewer cannot certify a merge -------------------------------
  cases.push({
    name: 'H. a simulated reviewer never yields READY_TO_MERGE',
    run: async () => {
      const { root, events, tasks } = scratch();
      const design = {
        scopeAllowlist: ['tools/autopilot'], outOfScope: [], invariants: [], requiredTests: [],
      };
      const repo = scratchRepo();
      const deps: OrchestratorDeps = {
        repoRoot: repo,
        events,
        tasks,
        policy,
        git: new GitManager(repo, policy),
        advisor: stubAdapter('claude-advisor', 'anthropic', { design, adjudication: { adjudications: [] } }),
        builder: stubAdapter('claude-code', 'anthropic', { implement: { status: 'IMPLEMENTED', filesChanged: [] } }),
        reviewer: stubAdapter('codex', 'openai', {
          'design-review': { verdict: 'APPROVE', findings: [] },
          review: { findings: [] },
        }, { simulated: true }),
        log: () => undefined,
      };
      const orch = new Orchestrator(deps);
      const rec = orch.createTask('simulated reviewer', 'high');
      const state = await orch.run(rec.taskId);
      assert(state !== 'READY_TO_MERGE', 'a simulated reviewer produced READY_TO_MERGE');
      // The real repository must be untouched by the self-tests.
      const realGit = new GitManager(repoRoot, policy);
      assert(!realGit.branchExists('ai/task-0001'), 'self-test created a branch in the real repo');
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  });

  // I. Full happy path -------------------------------------------------------
  cases.push({
    name: 'I. a clean HIGH-risk task reaches READY_TO_MERGE without auto-merging',
    run: async () => {
      const { root, events, tasks } = scratch();
      const repo = scratchRepo();
      const design = {
        taskId: 'x',
        risk: 'high',
        scopeAllowlist: ['seed.txt'],
        outOfScope: ['everything else'],
        invariants: ['seed stays seeded'],
        falsifiablePredictions: ['editing seed.txt changes its contents'],
        implementationConstraints: [],
        requiredTests: ['a deterministic test'],
        requiredRuntimeAcceptance: ['gates green'],
        knownUnverified: ['numeric tax correctness'],
      };
      // Stubbed gates: this test is about the state machine and the merge
      // policy, not about re-running the accounting suites.
      const stubAcceptance = (taskId: string, pol: PolicyEngine) => {
        const r = new AcceptanceRunner(taskId, pol);
        const green = (tier: 'pre-review' | 'final') => ({
          ok: true,
          tier,
          outcomes: [] as TestOutcome[],
          violations: [],
          verified: ['stubbed gate: pipeline exercise only'],
          notVerified: ['everything a real gate would have checked'],
        });
        (r as any).preReview = () => green('pre-review');
        (r as any).final = () => green('final');
        return r;
      };
      const deps: OrchestratorDeps = {
        repoRoot: repo,
        events,
        tasks,
        policy,
        git: new GitManager(repo, policy),
        acceptanceFactory: stubAcceptance,
        advisor: stubAdapter('claude-advisor', 'anthropic', { design, adjudication: { adjudications: [] } }),
        builder: stubAdapter('claude-code', 'anthropic', {
          implement: { status: 'IMPLEMENTED', filesChanged: [], testsAdded: ['t'], commits: [] },
        }),
        reviewer: stubAdapter('codex', 'openai', {
          'design-review': { verdict: 'APPROVE', findings: [] },
          review: { findings: [] },
        }),
        log: () => undefined,
      };
      const orch = new Orchestrator(deps);
      const rec = orch.createTask('clean high-risk task', 'high');
      const state = await orch.run(rec.taskId);
      assert(state === 'READY_TO_MERGE', `expected READY_TO_MERGE, got ${state}`);

      const rtm = tasks.byType(rec.taskId, 'READY_TO_MERGE');
      assert(rtm.length === 1, 'no READY_TO_MERGE event');
      assert((rtm[0].payload as any).autoMerge === false, 'HIGH-risk task auto-merged');
      assert(tasks.byType(rec.taskId, 'MERGED').length === 0, 'task was merged');

      const transitions = tasks
        .byType(rec.taskId, 'STATE_TRANSITION')
        .map((e) => (e.payload as any).to);
      for (const required of ['DESIGNING', 'DESIGN_REVIEW', 'READY_TO_IMPLEMENT', 'IMPLEMENTING', 'TESTING', 'PRE_REVIEW_ACCEPTANCE', 'CODEX_REVIEW', 'FINAL_ACCEPTANCE']) {
        assert(transitions.includes(required as any), `pipeline skipped ${required}`);
      }

      // The report must still name what was not verified.
      const md = buildReport(rec.taskId, events, tasks);
      assert(/NOT VERIFIED/.test(md), 'report omitted NOT VERIFIED');
      assert(/READY_TO_MERGE/.test(md), 'report omitted the merge verdict');
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  });

  // J. Confirmed-finding fix loop ---------------------------------------------
  cases.push({
    name: 'J. a BLOCKER is adjudicated, fixed and re-reviewed without a human',
    run: async () => {
      const { root, events, tasks } = scratch();
      const repo = scratchRepo();
      const design = {
        taskId: 'x', risk: 'high', scopeAllowlist: ['seed.txt'], outOfScope: [],
        invariants: ['i'], falsifiablePredictions: [], implementationConstraints: [],
        requiredTests: [], requiredRuntimeAcceptance: [], knownUnverified: [],
      };
      const blocker = {
        findingId: 'F-1', severity: 'BLOCKER', category: 'correctness', file: 'seed.txt',
        claim: 'seed is wrong', scenario: 'read seed.txt', violatedInvariant: 'i',
        confidence: 'HIGH', evidenceAvailable: 'diff',
      };
      let reviewCall = 0;
      const reviewer: AgentAdapter = {
        name: 'codex', provider: 'openai',
        async available() { return { ok: true, mechanism: 'stub' }; },
        async run(task: AgentTask): Promise<AgentResult> {
          let structured: Record<string, unknown>;
          if (task.role === 'design-review') structured = { verdict: 'APPROVE', findings: [] };
          else {
            reviewCall += 1;
            // Blocker on the first pass, clean on the focused re-review.
            structured = { findings: reviewCall === 1 ? [blocker] : [] };
          }
          return { ok: true, structured, rawArtifactPath: '', rawArtifactHash: 'stub',
            durationMs: 1, exitCode: 0, usage: null, simulated: false, provider: 'openai' };
        },
      };
      const stubAcceptance = (taskId: string, pol: PolicyEngine) => {
        const r = new AcceptanceRunner(taskId, pol);
        const green = (tier: 'pre-review' | 'final') => ({
          ok: true, tier, outcomes: [] as TestOutcome[], violations: [],
          verified: ['stubbed gate'], notVerified: ['everything else'],
        });
        (r as any).preReview = () => green('pre-review');
        (r as any).final = () => green('final');
        return r;
      };
      const deps: OrchestratorDeps = {
        repoRoot: repo, events, tasks, policy,
        git: new GitManager(repo, policy),
        acceptanceFactory: stubAcceptance,
        advisor: stubAdapter('claude-advisor', 'anthropic', {
          design,
          adjudication: {
            adjudications: [{
              findingId: 'F-1', verdict: 'CONFIRMED', reasoning: 'real',
              requiredFix: 'reseed', requiredEvidence: 'a test',
            }],
          },
        }),
        builder: stubAdapter('claude-code', 'anthropic', {
          implement: { status: 'IMPLEMENTED', filesChanged: [], testsAdded: [], commits: [] },
        }),
        reviewer,
        log: () => undefined,
      };
      const orch = new Orchestrator(deps);
      const rec = orch.createTask('fix loop', 'high');
      const state = await orch.run(rec.taskId);
      assert(state === 'READY_TO_MERGE', `expected READY_TO_MERGE, got ${state}`);

      // The finding must have gone through adjudication before any fix.
      const log = events.read(rec.taskId);
      const iFinding = log.findIndex((e) => e.type === 'FINDING');
      const iAdj = log.findIndex((e) => e.type === 'ADJUDICATION');
      const iFix = log.findIndex((e) => e.type === 'FIX');
      assert(iFinding >= 0 && iAdj > iFinding, 'finding was not adjudicated');
      assert(iFix > iAdj, 'a fix was applied before adjudication');
      assert(log[iFix].parents.includes('F-1'), 'fix is not linked to the finding');
      assert(reviewCall === 2, `expected a focused re-review, got ${reviewCall} review call(s)`);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  });

  // K. Rate limit -------------------------------------------------------------
  cases.push({
    name: 'K. subscription quota exhaustion pauses instead of billing an API',
    run: async () => {
      const { root, events, tasks } = scratch();
      const repo = scratchRepo();
      const rateLimited: AgentAdapter = {
        name: 'claude-advisor', provider: 'anthropic',
        async available() { return { ok: true, mechanism: 'stub' }; },
        async run(): Promise<AgentResult> {
          return {
            ok: false, structured: null, rawArtifactPath: '', rawArtifactHash: 'stub',
            durationMs: 1, exitCode: 1, usage: null, simulated: false,
            provider: 'anthropic', rateLimited: true,
            error: 'subscription quota or rate limit reached',
          };
        },
      };
      const deps: OrchestratorDeps = {
        repoRoot: repo, events, tasks, policy,
        git: new GitManager(repo, policy),
        advisor: rateLimited,
        builder: stubAdapter('claude-code', 'anthropic', {}),
        reviewer: stubAdapter('codex', 'openai', {}),
        log: () => undefined,
      };
      const orch = new Orchestrator(deps);
      const rec = orch.createTask('quota exhausted', 'high');
      const state = await orch.run(rec.taskId);
      assert(state === 'PAUSED_RATE_LIMIT', `expected PAUSED_RATE_LIMIT, got ${state}`);

      const pause = tasks.byType(rec.taskId, 'PAUSED_RATE_LIMIT');
      assert(pause.length === 1, 'no pause event recorded');
      assert((pause[0].payload as any).billingMode === 'SUBSCRIPTION_CLI_ONLY', 'billing mode not recorded');
      // The pause must be durable so `resume` can pick it up later.
      assert(tasks.deriveTask(rec.taskId)!.state === 'PAUSED_RATE_LIMIT', 'pause not persisted');
      assert(tasks.byType(rec.taskId, 'ESCALATION').length === 0, 'quota pause was treated as a failure');
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  });

  // L. Paid-API refusal --------------------------------------------------------
  cases.push({
    name: 'L. a paid API key in the environment stops the run',
    run: async () => {
      const { root, events, tasks } = scratch();
      const repo = scratchRepo();
      const prev = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-000000';
      try {
        const deps: OrchestratorDeps = {
          repoRoot: repo, events, tasks, policy,
          git: new GitManager(repo, policy),
          advisor: stubAdapter('claude-advisor', 'anthropic', {}),
          builder: stubAdapter('claude-code', 'anthropic', {}),
          reviewer: stubAdapter('codex', 'openai', {}),
          log: () => undefined,
        };
        const orch = new Orchestrator(deps);
        const rec = orch.createTask('api key present', 'high');
        const state = await orch.run(rec.taskId);
        assert(state === 'ESCALATED', `expected ESCALATED, got ${state}`);
        const esc = tasks.byType(rec.taskId, 'ESCALATION');
        assert(
          String((esc[0].payload as any).reason).includes('SUBSCRIPTION_CLI_ONLY'),
          'escalation did not cite the billing policy',
        );
      } finally {
        if (prev === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prev;
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  });

  // run ----------------------------------------------------------------------
  let failed = 0;
  const results: Array<[string, boolean, string]> = [];
  for (const c of cases) {
    try {
      await c.run();
      results.push([c.name, true, '']);
    } catch (e: any) {
      failed += 1;
      results.push([c.name, false, e?.message ?? String(e)]);
    }
  }

  process.stdout.write('\nautopilot self-tests\n\n');
  for (const [name, ok, err] of results) {
    process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : ` — ${err}`}\n`);
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
  return failed === 0 ? 0 : 1;
}
