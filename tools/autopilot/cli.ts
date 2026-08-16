#!/usr/bin/env ts-node
/**
 * `pnpm ai` — the operator interface.
 *
 * Commands are intentionally small: create a task, run it, and inspect what
 * happened. Everything the pipeline decides is recoverable from the event log,
 * so `status`/`report`/`validate` read only, and `run`/`resume` share one code
 * path so a resumed task cannot take a different route than a fresh one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventStore, AI_ROOT } from './storage/event-store';
import { TaskStore } from './storage/task-store';
import { PolicyEngine, loadPolicy } from './policy-engine';
import { GitManager } from './git-manager';
import { Orchestrator, defaultDeps } from './orchestrator';
import { buildReport } from './report';
import { backfillStage0, STAGE0_TASK_ID } from './backfill-stage0';
import { ClaudeAdvisorAdapter } from './agents/claude-advisor';
import { ClaudeCodeAdapter } from './agents/claude-code';
import { CodexAdapter } from './agents/codex';
import { Risk } from './types';
import { runSelfTests } from './selftest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function out(s = ''): void {
  process.stdout.write(s + '\n');
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function parseRisk(argv: string[]): Risk {
  const i = argv.indexOf('--risk');
  if (i === -1) return 'high'; // fail safe
  const v = argv[i + 1];
  if (v !== 'low' && v !== 'medium' && v !== 'high') fail(`invalid --risk ${v}`);
  return v;
}

async function cmdDoctor(): Promise<number> {
  const policy = new PolicyEngine(loadPolicy(REPO_ROOT));
  const git = new GitManager(REPO_ROOT, policy);
  let problems = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    out(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) problems += 1;
  };

  out('autopilot doctor');
  out('');
  check('git repository', fs.existsSync(path.join(REPO_ROOT, '.git')), REPO_ROOT);
  check('working tree clean', git.isClean(), git.isClean() ? git.currentBranch() : git.status().split('\n')[0]);

  for (const dir of ['tasks', 'runs', 'reports', 'policies', 'roles']) {
    const p = path.join(AI_ROOT, dir);
    fs.mkdirSync(p, { recursive: true });
    let writable = true;
    try {
      const probe = path.join(p, '.write-probe');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
    } catch {
      writable = false;
    }
    check(`.ai/${dir} writable`, writable, p);
  }

  const gitignore = path.join(AI_ROOT, 'runs', '.gitignore');
  check('raw artifacts gitignored', fs.existsSync(gitignore), gitignore);

  // Secret handling must actually refuse, not just claim to.
  let refused = false;
  try {
    new EventStore().append({
      taskId: '__doctor__',
      type: 'TASK_CREATED',
      actor: 'orchestrator',
      payload: { token: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
    });
  } catch {
    refused = true;
  }
  check('secret scanner refuses credential writes', refused, refused ? '' : 'scanner did NOT block');
  fs.rmSync(path.join(AI_ROOT, 'tasks', '__doctor__'), { recursive: true, force: true });

  for (const adapter of [
    new ClaudeAdvisorAdapter(REPO_ROOT),
    new ClaudeCodeAdapter(REPO_ROOT),
    new CodexAdapter(REPO_ROOT),
  ]) {
    const a = await adapter.available();
    check(`adapter ${adapter.name} (${adapter.provider})`, a.ok, a.ok ? a.mechanism ?? '' : a.reason ?? '');
  }

  const server = path.join(REPO_ROOT, 'packages', 'server');
  check('Stage 0 script present', /"test:stage0"/.test(fs.readFileSync(path.join(server, 'package.json'), 'utf8')), 'packages/server');
  check('Stage -1 runner present', fs.existsSync(path.join(server, 'test', 'e2e-runner.mjs')), 'test/e2e-runner.mjs');
  check('Stage -1 baseline present', fs.existsSync(path.join(server, 'test', 'e2e-baseline.json')), 'test/e2e-baseline.json');
  check('ts-node available', fs.existsSync(path.join(server, 'node_modules', '.bin', 'ts-node')), 'packages/server/node_modules/.bin');

  out('');
  out(problems === 0 ? 'doctor: all checks passed' : `doctor: ${problems} problem(s)`);
  return problems === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const events = new EventStore();
  const tasks = new TaskStore(events);
  const policy = new PolicyEngine(loadPolicy(REPO_ROOT));

  switch (cmd) {
    case 'doctor':
      return cmdDoctor();

    case 'task': {
      if (argv[1] !== 'create') fail('usage: ai task create --risk <low|medium|high> "title"');
      const risk = parseRisk(argv);
      const title = argv.filter((a, i) => i > 1 && a !== '--risk' && a !== risk).join(' ').trim();
      if (!title) fail('a task title is required');
      const orch = new Orchestrator(defaultDeps(REPO_ROOT, policy));
      const rec = orch.createTask(title, risk);
      out(`created ${rec.taskId} (risk=${rec.risk}, branch=${rec.branch}, auto-merge=${rec.autoMerge})`);
      return 0;
    }

    case 'run':
    case 'resume': {
      const taskId = argv[1];
      if (!taskId) fail(`usage: ai ${cmd} TASK-XXXX`);
      if (!tasks.exists(taskId)) fail(`unknown task ${taskId}`);
      const orch = new Orchestrator(defaultDeps(REPO_ROOT, policy));
      const state = await orch.run(taskId);
      const rec = tasks.deriveTask(taskId)!;
      tasks.writeCache(rec);
      out(`${taskId} finished in state ${state}`);
      return state === 'READY_TO_MERGE' || state === 'MERGED' ? 0 : state === 'ESCALATED' ? 2 : 1;
    }

    case 'status': {
      const taskId = argv[1];
      if (!taskId) fail('usage: ai status TASK-XXXX');
      const rec = tasks.deriveTask(taskId);
      if (!rec) fail(`unknown task ${taskId}`);
      out(JSON.stringify(rec, null, 2));
      return 0;
    }

    case 'report': {
      const taskId = argv[1];
      if (!taskId) fail('usage: ai report TASK-XXXX');
      if (!tasks.exists(taskId)) fail(`unknown task ${taskId}`);
      const md = buildReport(taskId, events, tasks);
      const dir = path.join(AI_ROOT, 'reports');
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, `${taskId}.md`);
      fs.writeFileSync(p, md, 'utf8');
      out(`wrote ${path.relative(REPO_ROOT, p)} (${md.length} bytes)`);
      return 0;
    }

    case 'validate': {
      const taskId = argv[1];
      if (!taskId) fail('usage: ai validate TASK-XXXX');
      const integrity = events.verifyIntegrity(taskId);
      out(`log integrity: ${integrity.ok ? 'ok' : 'FAILED'}`);
      integrity.problems.forEach((p) => out(`  - ${p}`));
      const md = buildReport(taskId, events, tasks);
      const p = path.join(AI_ROOT, 'reports', `${taskId}.md`);
      const onDisk = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      const identical = onDisk !== null && onDisk === md;
      out(`report rebuild: ${onDisk === null ? 'no report on disk' : identical ? 'byte-identical' : 'DIFFERS'}`);
      return integrity.ok && (onDisk === null || identical) ? 0 : 1;
    }

    case 'backfill': {
      if (argv[1] !== 'stage0') fail('usage: ai backfill stage0');
      const git = new GitManager(REPO_ROOT, policy);
      const res = backfillStage0(events, tasks, git);
      out(`backfilled ${res.taskId}: ${res.eventsWritten} events, ${res.commitsMatched} commits matched, ${res.gaps} evidence gap(s)`);
      res.commitsMissing.forEach((c) => out(`  MISSING commit: ${c}`));
      out(`(reconstructed history — see .ai/tasks/${STAGE0_TASK_ID}/events.jsonl)`);
      return 0;
    }

    case 'selftest':
      return await runSelfTests(REPO_ROOT);

    default:
      out('usage: pnpm ai <command>');
      out('');
      out('  doctor                                   check the environment and adapters');
      out('  task create --risk <low|medium|high> "…" create a task (default risk: high)');
      out('  run TASK-XXXX                            run a task to a terminal state');
      out('  resume TASK-XXXX                         continue a task after a crash');
      out('  status TASK-XXXX                         derived task state');
      out('  report TASK-XXXX                         rebuild the markdown report');
      out('  validate TASK-XXXX                       verify log integrity + report determinism');
      out('  backfill stage0                          reconstruct Stage 0 history');
      out('  selftest                                 run the autopilot self-tests');
      return cmd ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
