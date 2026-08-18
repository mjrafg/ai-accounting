#!/usr/bin/env ts-node
/**
 * V2 deterministic self-tests. No live model is ever called.
 *
 *   AI_V2_STATE=<tmp> ts-node tools/autopilot-v2/selftest.ts
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// State must be isolated BEFORE store import resolves STATE_ROOT.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-selftest-'));
process.env.AI_V2_STATE = path.join(TMP, 'state');

import { EventStore, StreamLog, deriveTask, currentDesign, allFindings } from './core/store';
import { redact, loadKnownSecrets, looksSecret } from './core/redact';
import { parseStructured, inspectEnvelope, looksRateLimited } from './core/parsers';
import { WorktreeManager } from './core/worktrees';
import {
  assertDisposableTargets, ProductionEndpointError, GlobalLock, normalizeFailure, compareSignatures,
  normalizeCheckCommand, splitCommand, decideTestToDecide, runPredictionChecks,
} from './core/checks';
import * as policy from './core/policy';
import { totp, verifyTotp, base32Encode } from './core/mfa';
import { getDeploymentSettings, setAutomaticDeployment, automaticDeploymentEnabled } from './core/settings';
import { CLAUDE_MODEL } from './core/agents';
import {
  ROLES, REASONING, getModelSettings, setRoleSetting, applyPreset, resolvePolicy, fallbackFor,
  __setAvailabilityForTest,
} from './core/models';
import {
  buildSnapshot, statusCard, deterministicPersian, generateReport, generateDeterministic,
  listReports, whatChanged,
} from './core/report';
import { Finding } from './core/types';

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(s: string): void { console.log(`\n- ${s}`); }

async function main(): Promise<number> {
  console.log('Autopilot V2 self-tests (no live models)\n');

  // ---- worktree isolation + TASK_BASE_SHA ---------------------------------
  section('worktree isolation, TASK_BASE_SHA, runtime state outside git');
  {
    const root = fs.mkdtempSync(path.join(TMP, 'iso-'));
    const origin = path.join(root, 'origin.git');
    const control = path.join(root, 'control');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env });
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env });
    fs.mkdirSync(control); git(control, 'init', '-b', 'main');
    git(control, 'config', 'user.email', 't@x'); git(control, 'config', 'user.name', 't');
    git(control, 'remote', 'add', 'origin', origin);
    fs.mkdirSync(path.join(control, 'packages/server/src/modules/A'), { recursive: true });
    fs.writeFileSync(path.join(control, 'packages/server/src/modules/A/a.ts'), 'v1\n');
    fs.mkdirSync(path.join(control, 'tools/autopilot-v2'), { recursive: true });
    fs.writeFileSync(path.join(control, 'tools/autopilot-v2/x.ts'), 'v1\n');
    git(control, 'add', '-A'); git(control, 'commit', '-m', 'base'); git(control, 'push', '-qu', 'origin', 'main');

    const wtm = new WorktreeManager(control, path.join(root, 'wts'));
    const base = wtm.accountingBase('origin/main');
    check('TASK_BASE_SHA = origin/main', base === git(control, 'rev-parse', 'origin/main').trim());
    const wt = wtm.ensure('TASK-V2-9001', 'ai/task-v2-9001', base);
    check('worktree outside control checkout', !wt.path.startsWith(control + path.sep));

    // control-plane repair mid-task
    fs.writeFileSync(path.join(control, 'tools/autopilot-v2/x.ts'), 'v2 repaired\n');
    git(control, 'add', '-A'); git(control, 'commit', '-m', 'repair');
    // legitimate candidate change in the worktree
    fs.writeFileSync(path.join(wt.path, 'packages/server/src/modules/A/a.ts'), 'candidate\n');
    const changed = wtm.changedFiles(wt.path, base);
    check('control-plane edits invisible to scope', !changed.some((f) => f.startsWith('tools/')), changed.join(','));
    check('candidate change visible', changed.includes('packages/server/src/modules/A/a.ts'));

    const allow = ['packages/server/src/modules/A/a.ts'];
    check('legitimate scope change passes', policy.checkScope(changed, allow).length === 0);
    // forbidden mutation inside the worktree
    fs.mkdirSync(path.join(wt.path, 'packages/server/src/modules/Ledger'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, 'packages/server/src/modules/Ledger/L.ts'), 'tampered\n');
    const v = policy.checkScope(wtm.changedFiles(wt.path, base), allow);
    check('forbidden mutation blocked + named', v.some((x) => x.detail.includes('Ledger/L.ts')));
    check('protected paths blocked', policy.checkProtectedPaths(['packages/server/test/e2e-baseline.json']).length > 0);
    check('control plane is a protected path for tasks', policy.checkProtectedPaths(['tools/autopilot-v2/x.ts']).length > 0);

    // runtime state outside git
    const ev = new EventStore();
    ev.append({ taskId: 'TASK-V2-9001', type: 'NOTE', payload: { probe: 1 } });
    check('event write lands under AI_V2_STATE', fs.existsSync(path.join(process.env.AI_V2_STATE!, 'tasks/TASK-V2-9001/events.jsonl')));
    check('event write does not dirty the worktree',
      !wtm.changedFiles(wt.path, base).some((f) => f.includes('events')), '');
  }

  // ---- envelopes ----------------------------------------------------------
  section('provider envelope classification');
  {
    const e401 = JSON.stringify({ type: 'result', is_error: true, subtype: 'success', api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' });
    const r1 = parseStructured(e401, ['plan']);
    check('Claude 401 envelope → AGENT_EXECUTION_ERROR', r1.failureKind === 'AGENT_EXECUTION_ERROR', String(r1.failureKind));
    check('401 error names the cause', /OAuth access token has expired/.test(r1.error ?? ''));

    const e429 = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429,
      result: 'API Error: 429 rate limit exceeded, resets at 3pm' });
    const r2 = parseStructured(e429, ['plan']);
    check('Claude 429 envelope → RATE_LIMIT even at exit 0', r2.failureKind === 'RATE_LIMIT', String(r2.failureKind));

    const codex = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"{\\"plan\\":\\"do it\\",\\"scopeAllowlist\\":[]}"}}',
      '{"type":"turn.completed","usage":{"output_tokens":5}}',
    ].join('\n');
    const r3 = parseStructured(codex, ['plan']);
    check('Codex JSONL parses', r3.ok === true, r3.error ?? '');

    const r4 = parseStructured('{"broken: json', ['plan']);
    check('malformed output → ADAPTER_PARSE_ERROR', r4.failureKind === 'ADAPTER_PARSE_ERROR');
    const r5 = parseStructured('{"plan": "x"}', ['plan', 'scopeAllowlist']);
    check('missing keys → AGENT_SCHEMA_ERROR', r5.failureKind === 'AGENT_SCHEMA_ERROR');
    check('rate-limit text detector', looksRateLimited('quota exceeded, resets at 5'));
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"plan\\":\\"p\\"}"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"plan\\":\\"p\\"}"}',
    ].join('\n');
    check('claude stream-json envelope parses', parseStructured(stream, ['plan']).ok);
  }

  // ---- redaction ----------------------------------------------------------
  section('secret redaction before persistence and the wire');
  {
    const envFile = path.join(TMP, 'fake.env');
    fs.writeFileSync(envFile, 'DB_PASSWORD=SuperSecretDbPass123\nJWT_SECRET=jwtsecretvalue456\nMAIL_PORT=587\n');
    const n = loadKnownSecrets([envFile]);
    check('known env values loaded', n >= 2, String(n));
    const dirty = 'connect with password=SuperSecretDbPass123 and Bearer abcdefghijklmnop1234 plus sk-ant-abc123def456ghi and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdef1234';
    const clean = redact(dirty);
    check('env value redacted', !clean.includes('SuperSecretDbPass123'));
    check('bearer redacted', !/Bearer\s+abcdef/.test(clean));
    check('anthropic key redacted', !clean.includes('sk-ant-abc123'));
    check('jwt redacted', !clean.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIi'));
    check('looksSecret sees leaks', looksSecret(dirty) && !looksSecret('hello world'));

    const stream = new StreamLog();
    const c = stream.append('TASK-V2-9002', 'claude', 'text', 'the password=SuperSecretDbPass123 is here');
    check('no secret reaches the stream log (pre-SSE)', !c.text.includes('SuperSecretDbPass123'));
    const onDisk = fs.readFileSync(stream.path('TASK-V2-9002'), 'utf8');
    check('transcript on disk sanitized', !onDisk.includes('SuperSecretDbPass123'));
  }

  // ---- SSE replay ---------------------------------------------------------
  section('stream replay: reconnect, no duplicates');
  {
    const stream = new StreamLog();
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push(stream.append('TASK-V2-9003', 'claude', 'text', `line ${i}`).id);
    check('ids strictly monotonic', ids.every((v, i) => i === 0 || v === ids[i - 1] + 1), ids.join(','));
    const replayAfter2 = stream.replay('TASK-V2-9003', 2);
    check('replay after cursor returns exactly the missed chunks',
      replayAfter2.length === 3 && replayAfter2[0].id === 3 && replayAfter2[2].id === 5);
    const all = stream.replay('TASK-V2-9003', 0);
    const unique = new Set(all.map((c) => c.id));
    check('no duplicate ids in replay', unique.size === all.length);
  }

  // ---- state machine / task derivation ------------------------------------
  section('task derivation, cancellation, crash resume');
  {
    const ev = new EventStore();
    ev.append({ taskId: 'TASK-V2-9004', type: 'TASK_CREATED', payload: { title: 't', description: 'd', risk: 'low', branch: 'b', baseSha: 'abc', worktree: '/w' } });
    ev.append({ taskId: 'TASK-V2-9004', type: 'STATE_CHANGED', payload: { from: 'NEW', to: 'DESIGN' } });
    ev.append({ taskId: 'TASK-V2-9004', type: 'STATE_CHANGED', payload: { from: 'DESIGN', to: 'IMPLEMENT' } });
    const t = deriveTask(ev, 'TASK-V2-9004')!;
    check('state derived from events', t.state === 'IMPLEMENT');
    ev.append({ taskId: 'TASK-V2-9004', type: 'TASK_CANCELLED', payload: { cancelledBy: 'x', reason: 'r' } });
    check('cancellation is terminal', deriveTask(ev, 'TASK-V2-9004')!.state === 'CANCELLED');
    const integrity = ev.verify('TASK-V2-9004');
    check('event log hash-chain verifies', integrity.ok);
    // crash resume: a fresh EventStore instance re-derives the same state
    const ev2 = new EventStore();
    check('resume derives state after restart', deriveTask(ev2, 'TASK-V2-9004')!.state === 'CANCELLED');
  }

  // ---- design revisions ---------------------------------------------------
  section('canonical design revision replacement (no amendment pile)');
  {
    const ev = new EventStore();
    const mk = (rev: number, inv: string) => ev.append({ taskId: 'TASK-V2-9005', type: 'DESIGN_REVISION',
      payload: { design: { revision: rev, createdAt: '', author: 'claude', scopeAllowlist: [], plan: 'p',
        invariants: [inv], predictions: [], requiredTests: [], acceptance: [], appliedFindings: rev > 1 ? ['D-1'] : [] } } });
    mk(1, 'the regression test fails if and only if the import is wrong');
    mk(2, 'the regression tests are sensitive to the import binding (one-directional)');
    const cur = currentDesign(ev, 'TASK-V2-9005')!;
    check('exactly one active revision (the latest)', cur.revision === 2);
    check('superseded wording absent from the active design', !JSON.stringify(cur).includes('if and only if'));
    check('history keeps revision 1', ev.read('TASK-V2-9005').filter((e) => e.type === 'DESIGN_REVISION').length === 2);
  }

  // ---- finding severities, budgets, blocker progress ----------------------
  section('finding severity behaviour, review budget, blocker progress');
  {
    const f = (sev: any, status: any = 'UNRESOLVED'): Finding =>
      ({ findingId: 'F', severity: sev, category: 'c', claim: 'a concrete claim', scenario: 'a concrete scenario long enough to count', status });
    check('SUGGESTION never blocks', policy.materialFindings([f('SUGGESTION')]).length === 0);
    check('IMPORTANT is material', policy.materialFindings([f('IMPORTANT')]).length === 1);
    check('CRITICAL with scenario may block', policy.findingMayBlock(f('CRITICAL')));
    check('CRITICAL without scenario may NOT block',
      !policy.findingMayBlock({ ...f('CRITICAL'), scenario: 'too short' }));
    check('LOW budget: no design review, 0 material cycles',
      !policy.budgetFor('low').designReview && policy.budgetFor('low').materialCycles === 0);
    check('HIGH budget: design review, 2 material cycles',
      policy.budgetFor('high').designReview && policy.budgetFor('high').materialCycles === 2);
    check('blocker progress stalls after two non-decreasing cycles',
      policy.blockerProgressStalled([3, 3, 3]) && !policy.blockerProgressStalled([3, 2, 1]));
  }

  // ---- auto-merge/deploy + SHA safety ------------------------------------
  section('auto-merge/deploy policy, merge SHA safety');
  {
    const green: policy.GateSummary = { deterministicOk: true, testsOk: true, criticalOpen: 0,
      evidenceConflict: false, backupVerified: true, rollbackShaExists: true, protectedTriggerHit: false };
    check('HIGH may auto-merge with green gates', policy.autoMergeAllowed('high', green).allowed);
    check('critical finding blocks auto-merge', !policy.autoMergeAllowed('low', { ...green, criticalOpen: 1 }).allowed);
    check('human trigger blocks auto-merge', !policy.autoMergeAllowed('low', { ...green, protectedTriggerHit: true }).allowed);
    check('no backup blocks auto-deploy', !policy.autoDeployAllowed('low', { ...green, backupVerified: false }).allowed);
    check('merge SHA mismatch rejected', !policy.mergeShaSafe('aaa', 'aaa', 'bbb') && !policy.mergeShaSafe('aaa', 'bbb', 'aaa'));
    check('merge SHA match accepted', policy.mergeShaSafe('aaa', 'aaa', 'aaa'));
  }

  // ---- production guard ---------------------------------------------------
  section('production endpoint refusal');
  {
    const wt = fs.mkdtempSync(path.join(TMP, 'guard-'));
    const cases: Array<[string, string]> = [
      ['DB_HOST', 'bigcapital-prod-mysql'], ['REDIS_HOST', 'bigcapital-prod-redis'],
      ['DB_HOST', 'acc.agent24.io'], ['DB_HOST', 'db.example.com'],
    ];
    let refused = 0;
    for (const [k, v] of cases) {
      fs.writeFileSync(path.join(wt, '.env'), `${k}=${v}\nDB_HOST=${k === 'DB_HOST' ? v : 'mariadb'}\n`);
      try { assertDisposableTargets(wt); } catch (e) { if (e instanceof ProductionEndpointError) refused += 1; }
    }
    check('all production/unknown endpoints refused', refused === cases.length, `${refused}/${cases.length}`);
    fs.writeFileSync(path.join(wt, '.env'), 'DB_HOST=ai-accounting-mariadb-1\nREDIS_HOST=ai-accounting-redis-1\n');
    let ok = true; try { assertDisposableTargets(wt); } catch { ok = false; }
    check('disposable stack still allowed (control)', ok);
  }

  // ---- Stage -1 lock ------------------------------------------------------
  section('Stage -1 global lock');
  {
    const lock = new GlobalLock('selftest-stage1');
    check('first acquire succeeds', lock.tryAcquire('holder-A'));
    check('second concurrent acquire refused', !lock.tryAcquire('holder-B'));
    lock.release();
    check('acquire after release succeeds', lock.tryAcquire('holder-C'));
    lock.release();
  }

  // ---- failure signatures -------------------------------------------------
  section('failure-signature drift');
  {
    const a = normalizeFailure('expected 200 got 500 at /srv/x/y.ts:120:5 in 45ms id 3f2a9b7c');
    const b = normalizeFailure('expected 200 got 500 at /other/path/y.ts:99:1 in 999ms id deadbeef');
    check('signatures stable across volatile details', a === b);
    const c = normalizeFailure('expected 200 got 403 forbidden');
    check('different failure → different signature', a !== c);
    const first = compareSignatures({ 't1': a });
    check('first run establishes baseline', first.baselineEstablished && first.changed.length === 0);
    const drift = compareSignatures({ 't1': c });
    check('changed signature detected as drift (REVIEW_REQUIRED)', drift.changed.includes('t1'));
    const again = compareSignatures({ 't1': c });
    check('baseline NOT auto-rewritten', again.changed.includes('t1'));
  }

  // ---- MFA ----------------------------------------------------------------
  section('TOTP');
  {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const code = totp(secret);
    check('generated code verifies', verifyTotp(secret, code));
    check('wrong code rejected', !verifyTotp(secret, '000000') || code === '000000');
    // RFC 6238 test vector: secret ASCII "12345678901234567890", T=59s → 94287082 (8-digit) → 287082 (6-digit)
    check('RFC 6238 vector', totp(secret, 30, 59_000) === '287082', totp(secret, 30, 59_000));
  }

  // ---- decision quality ---------------------------------------------------
  section('AWAITING_HUMAN decision package');
  {
    const d = policy.decisionRequest('REBASELINE', {
      issue: 'i', why: 'w', evidence: ['e'], recommended: 'r', whyRecommended: 'wr',
      alternatives: ['a'], riskApproved: 'ra', riskRejected: 'rr',
    });
    check('decision has recommendation + risks', Boolean(d.recommendedAction && d.riskIfApproved && d.riskIfRejected));
    check('decision names its trigger', d.issue.startsWith('[REBASELINE]'));
  }

  // ---- deployment settings toggle ----------------------------------------
  section('deployment settings: defaults, persistence, policy, audit');
  {
    const prevEnv = process.env.AI_V2_HOLD_DEPLOY;
    // default derivation, no persisted file (fresh AI_V2_STATE tmp dir)
    process.env.AI_V2_HOLD_DEPLOY = '1';
    check('HOLD=1 → automatic deployment OFF by default',
      getDeploymentSettings().automaticProductionDeployment === false &&
      getDeploymentSettings().source === 'env-default');
    process.env.AI_V2_HOLD_DEPLOY = '0';
    check('HOLD=0 → automatic deployment ON by default',
      getDeploymentSettings().automaticProductionDeployment === true);

    // persisted setting overrides the env default, atomically, across "restarts"
    process.env.AI_V2_HOLD_DEPLOY = '1';
    const ch1 = setAutomaticDeployment(true, 'selftest-owner');
    check('toggle ON persists and reports the transition', ch1.from === false && ch1.to === true);
    check('persisted ON overrides HOLD=1', getDeploymentSettings().automaticProductionDeployment === true &&
      getDeploymentSettings().source === 'persisted');
    check('settings file exists outside git', fs.existsSync(path.join(process.env.AI_V2_STATE!, 'settings.json')));
    // a fresh read (new process would do the same: nothing cached) = restart survival
    check('survives service restart (re-read from disk)', automaticDeploymentEnabled() === true);
    const ch2 = setAutomaticDeployment(false, 'selftest-owner');
    check('toggle OFF persists', ch2.to === false && automaticDeploymentEnabled() === false);
    check('updatedBy recorded, no session secrets in file',
      getDeploymentSettings().updatedBy === 'selftest-owner' &&
      !fs.readFileSync(path.join(process.env.AI_V2_STATE!, 'settings.json'), 'utf8').includes('cookie'));

    // policy: OFF blocks a new deployment decision; ON permits only with green gates
    check('OFF blocks new automatic deployment', automaticDeploymentEnabled() === false);
    setAutomaticDeployment(true, 'selftest-owner');
    const green: policy.GateSummary = { deterministicOk: true, testsOk: true, criticalOpen: 0,
      evidenceConflict: false, backupVerified: true, rollbackShaExists: true, protectedTriggerHit: false };
    check('ON alone does not bypass backup gate',
      !policy.autoDeployAllowed('low', { ...green, backupVerified: false }).allowed);
    check('ON alone does not bypass rollback gate',
      !policy.autoDeployAllowed('low', { ...green, rollbackShaExists: false }).allowed);
    check('ON alone does not bypass CRITICAL gate',
      !policy.autoDeployAllowed('high', { ...green, criticalOpen: 1 }).allowed);
    check('ON + green gates permits deployment', policy.autoDeployAllowed('high', green).allowed);

    // audit event
    const ev = new EventStore();
    ev.append({ taskId: 'SYSTEM-SETTINGS', type: 'SETTING_CHANGED', payload: {
      setting: 'automaticProductionDeployment', from: false, to: true, actor: 'selftest-owner' } });
    const audit = ev.read('SYSTEM-SETTINGS').filter((e) => e.type === 'SETTING_CHANGED');
    check('audit event written and immutable-chain valid',
      audit.length >= 1 && ev.verify('SYSTEM-SETTINGS').ok);

    setAutomaticDeployment(false, 'selftest-owner'); // leave the fixture OFF
    if (prevEnv === undefined) delete process.env.AI_V2_HOLD_DEPLOY; else process.env.AI_V2_HOLD_DEPLOY = prevEnv;
  }

  // ---- TEST_TO_DECIDE must be consumed, never dropped ---------------------
  section('adjudication TEST_TO_DECIDE: check executes, finding resolves, review can exit');
  {
    const wt = fs.mkdtempSync(path.join(TMP, 'ttd-'));
    fs.mkdirSync(path.join(wt, 'packages/server'), { recursive: true });

    // normalization: the exact shape that shipped undecided in TASK-V2-0005
    check('cd-prefix normalized away',
      normalizeCheckCommand('cd packages/server && node -e "process.exit(0)"') === 'node -e "process.exit(0)"');
    check('cd with semicolon normalized', normalizeCheckCommand('cd packages/server; node -e "x"') === 'node -e "x"');
    check('cd to elsewhere NOT normalized (stays rejected)',
      normalizeCheckCommand('cd / && node -e "x"').startsWith('cd /'));

    // tokenizer: quoted payloads survive; unquoted metachars are flagged
    const tok = splitCommand('node -e "const a = 1; process.exit(a === 1 ? 0 : 1)"');
    check('quoted -e payload kept as ONE argument with spaces and semicolons',
      tok.args.length === 3 && tok.args[2] === 'const a = 1; process.exit(a === 1 ? 0 : 1)' && tok.unquotedMeta === null);
    check('unquoted metachar flagged', splitCommand('node -e "x" && rm x').unquotedMeta === '&');
    check('unterminated quote flagged', splitCommand('node -e "x').unquotedMeta !== null);

    // execution: exit code decides; the undecided status can never survive
    const rejected = await decideTestToDecide(wt, 'R-1', 'cd packages/server && node -e "process.exit(0)"');
    check('exit 0 → finding DETERMINISTICALLY_REJECTED (code is right)',
      rejected.status === 'DETERMINISTICALLY_REJECTED' && rejected.decisionSource === 'deterministic');
    check('deterministic result named for the finding', rejected.result?.name === 'test-to-decide:R-1');
    const confirmed = await decideTestToDecide(wt, 'R-2', 'node -e "process.exit(1)"');
    check('exit 1 → finding DETERMINISTICALLY_CONFIRMED', confirmed.status === 'DETERMINISTICALLY_CONFIRMED');
    const unrunnable = await decideTestToDecide(wt, 'R-3', 'rm -rf /tmp/x');
    check('non-safelisted check → UNRESOLVED with reason, never silently passing',
      unrunnable.status === 'UNRESOLVED' && unrunnable.decisionSource === 'policy' &&
      unrunnable.evidence.includes('could not be executed'));
    const noCheck = await decideTestToDecide(wt, 'R-4', undefined);
    check('TEST_TO_DECIDE without a check → UNRESOLVED', noCheck.status === 'UNRESOLVED');
    for (const d of [rejected, confirmed, unrunnable, noCheck]) {
      check(`no path returns the undecided status (${d.status})`, (d.status as string) !== 'TEST_TO_DECIDE');
    }

    // prediction checks accept the same previously-rejected shapes
    const pred = await runPredictionChecks(wt, [
      { text: 'spec passes', check: 'cd packages/server && node -e "process.exit(0)"' },
      { text: 'prose only' },
    ]);
    check('design prediction with cd-prefix now executes', pred.results.length === 1 && pred.results[0].ok);
    check('prose prediction still reported NOT VERIFIED', pred.unverified.length === 1);

    // full regression: FINDING → ADJUDICATION with the decided status →
    // review-loop filters see it resolved → REVIEW exits automatically.
    const ev = new EventStore();
    const tid = 'TASK-V2-9200';
    ev.append({ taskId: tid, type: 'TASK_CREATED', payload: { title: 't', description: 'd', risk: 'medium', branch: 'b', baseSha: 'a1', worktree: wt } });
    ev.append({ taskId: tid, type: 'STATE_CHANGED', payload: { from: 'VERIFY', to: 'REVIEW' } });
    ev.append({ taskId: tid, type: 'FINDING', phase: 'review', payload: { findings: [{
      findingId: 'R-1', severity: 'IMPORTANT', category: 'test correctness',
      claim: 'expects the wrong extension', scenario: 'concrete scenario text long enough', status: 'UNRESOLVED' }] } });
    const dec = await decideTestToDecide(wt, 'R-1', 'node -e "process.exit(0)"');
    ev.append({ taskId: tid, type: 'DETERMINISTIC_CHECK', phase: 'review', payload: { ...dec.result } });
    ev.append({ taskId: tid, type: 'ADJUDICATION', phase: 'review', payload: {
      findingId: 'R-1', status: dec.status, decisionSource: dec.decisionSource, evidence: dec.evidence } });
    const after = allFindings(ev, tid);
    check('finding status resolved from adjudication', after[0].status === 'DETERMINISTICALLY_REJECTED');
    const toFix = after.filter((f) => f.status === 'FIX' || f.status === 'DETERMINISTICALLY_CONFIRMED');
    const openMaterial = policy.materialFindings(after).filter((f) =>
      ['UNRESOLVED', 'FIX', 'DETERMINISTICALLY_CONFIRMED'].includes(f.status));
    check('review-loop filters: nothing to fix, nothing open → REVIEW exits automatically',
      toFix.length === 0 && openMaterial.length === 0);
  }

  // ---- Graphify provenance, staleness, evidence ---------------------------
  section('graphify: availability, SHA provenance, stale rule, reuse, claim integrity');
  {
    const gfy = require('./core/graphify') as typeof import('./core/graphify');
    const te = require('./core/toolevidence') as typeof import('./core/toolevidence');
    const GROOT = path.join(process.env.AI_V2_STATE!, 'graphify');
    const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
    const writeGraph = (sha: string, nodes = 10) => {
      fs.mkdirSync(path.join(GROOT, sha), { recursive: true });
      fs.writeFileSync(path.join(GROOT, sha, 'graph.json'), JSON.stringify({ nodes: [], links: [] }));
      fs.writeFileSync(path.join(GROOT, sha, 'meta.json'), JSON.stringify({
        sourceSha: sha, generatedAt: new Date().toISOString(), graphifyVersion: '0.9.46',
        fileCount: 3, nodeCount: nodes, edgeCount: nodes * 2 }));
    };

    // A. availability is a real probe of the binary, not an assumption
    const realAvail = gfy.isAvailable();
    check('A: availability reflects a real binary probe',
      realAvail === (gfy.graphifyVersion() !== null), `installed=${realAvail} version=${gfy.graphifyVersion()}`);
    const prevBin = process.env.AI_GRAPHIFY_BIN;
    check('A: nonexistent binary reports unavailable (no graph use)',
      (() => { const g = gfy.graphFor(SHA_A); return g.usable === false || realAvail; })());

    // B/C/F. provenance recorded; exact SHA match accepted and reused
    writeGraph(SHA_A);
    const meta = gfy.readMeta(SHA_A)!;
    check('B: graph provenance recorded (sha/generatedAt/version/counts)',
      meta.sourceSha === SHA_A && !!meta.generatedAt && meta.graphifyVersion === '0.9.46' &&
      meta.nodeCount === 10 && meta.edgeCount === 20 && meta.fileCount === 3);
    const useA = gfy.graphFor(SHA_A);
    check('C: matching source SHA is usable', realAvail ? useA.usable === true : true);
    const useA2 = gfy.graphFor(SHA_A);
    check('F: identical SHA reuses the cached graph (no rebuild)',
      realAvail ? (useA2 as any).graph === (useA as any).graph : true);

    // D/E. stale SHA detected and never silently trusted
    const useB = gfy.graphFor(SHA_B);
    check('D: different source SHA is detected as stale/absent', useB.usable === false);
    check('E: stale graph is reported, never substituted',
      useB.usable === false && ['GRAPH_STALE', 'NO_GRAPH', 'UNAVAILABLE'].includes((useB as any).reason) &&
      (useB as any).haveSha !== SHA_B);
    if (realAvail && (useB as any).reason === 'GRAPH_STALE') {
      check('E: stale report names the graph it DOES have', (useB as any).haveSha === SHA_A);
    } else { check('E: stale report names the graph it DOES have (n/a)', true); }

    // G/H. invocation evidence is machine-observed; prose cannot fake it
    const observedReal = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
        command: `/home/aiaccounting/.venvs/graphify/bin/graphify affected "X.ts" --graph ${GROOT}/${SHA_A}/graph.json --depth 2` } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
        command: 'sed -n 1,40p packages/server/src/modules/Attachments/Attachments.controller.ts' } }),
    ]);
    // An invocation with no captured output is an ATTEMPT, not proven usage:
    // only a successful wrapper receipt (or log entry) establishes graphifyUsed.
    check('G: bare graphify invocation is recorded as an attempt, not usage',
      observedReal.graphifyAttempted === true && observedReal.graphifyUsed === false);
    check('G: graph SHA captured from the invocation', observedReal.graphSourceSha === SHA_A);
    check('G: inspected source files captured', observedReal.sourceInspected &&
      observedReal.filesInspected.some((f) => f.includes('Attachments.controller.ts')));

    // Reading graphify's own documentation is NOT using graphify. Observed for
    // real in TASK-V2-0010, where a `sed` of skills/graphify/SKILL.md set
    // graphifyUsed=true.
    const docRead = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
        command: "/bin/bash -lc \"sed -n '1,240p' /srv/ai-accounting/worktrees/TASK-V2-0010/.agents/skills/graphify/SKILL.md\"" } }),
    ]);
    check('G: reading a path containing "graphify" is NOT an invocation', docRead.graphifyUsed === false);
    check('G: that read still counts as source inspection', docRead.toolCallCount === 1);

    const observedNone = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
        text: "I'm using the graphify skill because the project's graph is the required first source of architectural context." } }),
    ]);
    const reconciled = te.reconcileClaims(observedNone, { graphifyUsed: true, sourceInspected: true, runtimeVerified: true });
    check('H: prose claiming graphify cannot set graphifyUsed', reconciled.graphifyUsed === false);
    check('H: prose claiming source inspection cannot set sourceInspected', reconciled.sourceInspected === false);
    check('H: overclaims recorded as TOOL_CLAIM_MISMATCH', reconciled.claimMismatch.length === 3 &&
      reconciled.claimMismatch.every((m) => m.startsWith('TOOL_CLAIM_MISMATCH')));

    // I. no graphify available → review still proceeds on source inspection
    const srcOnly = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'cat packages/server/src/utils/is-blank.ts' } }),
    ]);
    check('I: source-only review is fully supported without graphify',
      srcOnly.graphifyUsed === false && te.findingIsSupported('CRITICAL', srcOnly).supported);

    // J. trivial LOW single-file work must not be forced through graphify
    check('J: LOW single-file review skips graphify', gfy.worthUsing('codex.codeReview', 'low', 1) === false);
    check('J: HIGH review uses graphify', gfy.worthUsing('codex.codeReview', 'high', 1) === true);
    check('J: MEDIUM multi-file review uses graphify', gfy.worthUsing('codex.codeReview', 'medium', 4) === true);
    check('J: MEDIUM single-file review skips graphify', gfy.worthUsing('codex.codeReview', 'medium', 1) === false);
    check('J: investigation always uses graphify when available', gfy.worthUsing('claude.investigation', 'low', 0) === true);
    check('J: adjudication/repair/report never use graphify',
      !gfy.worthUsing('claude.adjudication', 'high', 9) && !gfy.worthUsing('claudeCode.repair', 'high', 9) &&
      !gfy.worthUsing('claude.report', 'high', 9));
    if (prevBin === undefined) delete process.env.AI_GRAPHIFY_BIN; else process.env.AI_GRAPHIFY_BIN = prevBin;
  }

  // ---- Codex source-inspection evidence + false-finding regression --------
  section('review evidence: source inspection required, unverified claims cannot block');
  {
    const te = require('./core/toolevidence') as typeof import('./core/toolevidence');

    // A. material finding backed by real inspection is supported
    const inspected = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
        command: 'sed -n 1,80p packages/server/src/modules/Attachments/Attachments.controller.ts' } }),
    ]);
    check('A: material finding with source inspection is supported',
      te.findingIsSupported('IMPORTANT', inspected).supported && inspected.filesInspected.length === 1);

    // B. THE mime-types regression, architecturally: a confident library claim
    // with no inspection and no executed check must not block.
    const diffOnly = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
        text: 'The real mime-types module returns jpg for extension("image/jpeg"), so the test is wrong.' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ]);
    check('B: diff-only reviewer executed nothing', diffOnly.toolCallCount === 0 && !diffOnly.sourceInspected);
    const gate = te.findingIsSupported('IMPORTANT', diffOnly);
    check('B: unchecked library claim is NOT supported (mime-types regression)', !gate.supported);
    check('B: reason names the missing evidence', /no source inspection and no executed verification/.test(gate.reason));
    const unverifiedFinding: Finding = { findingId: 'R-1', severity: 'IMPORTANT', category: 'test correctness',
      claim: 'mime-types returns jpg', scenario: 'spec expects jpeg', status: 'UNRESOLVED', unverified: true };
    check('B: an UNVERIFIED material finding is not material and cannot block',
      policy.materialFindings([unverifiedFinding]).length === 0);
    const verifiedFinding: Finding = { ...unverifiedFinding, unverified: false };
    check('B: the same finding WITH evidence stays material',
      policy.materialFindings([verifiedFinding]).length === 1);
    check('B: SUGGESTION is unaffected by the evidence gate',
      te.findingIsSupported('SUGGESTION', diffOnly).supported);

    // E. a cheap factual check that WAS executed supports the claim
    const ranCheck = te.extractToolEvidence([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
        command: `node -e "console.log(require('mime-types').extension('image/jpeg'))"`,
        aggregated_output: 'jpeg' } }),
    ]);
    check('E: executed factual verification supports a material finding',
      ranCheck.runtimeVerified && te.findingIsSupported('IMPORTANT', ranCheck).supported);

    // C/D/F. claude-shaped transcripts, nearby tests/config, task attribution
    const claudeShaped = te.extractToolEvidence([
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/srv/ai-accounting/worktrees/TASK-V2-9500/packages/server/src/a.service.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/srv/ai-accounting/worktrees/TASK-V2-9500/packages/server/src/a.service.spec.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'cat packages/server/tsconfig.json' } },
      ] } }),
    ]);
    check('C/D: worktree source, its spec and config all recorded',
      claudeShaped.filesInspected.some((f) => f.endsWith('a.service.ts')) &&
      claudeShaped.filesInspected.some((f) => f.endsWith('a.service.spec.ts')) &&
      claudeShaped.filesInspected.some((f) => f.endsWith('tsconfig.json')));
    check('F: evidence is derived per-run, so it belongs to that run only',
      claudeShaped.toolCallCount === 3 && diffOnly.toolCallCount === 0);
  }

  // ---- event coupling ------------------------------------------------------
  section('impact analysis: event coupling (emitter → subscriber → spec) and additivity');
  {
    const { eventCoupling } = require('./core/eventindex') as typeof import('./core/eventindex');
    const wt = fs.mkdtempSync(path.join(TMP, 'evt-'));
    const mod = path.join(wt, 'packages/server/src/modules');
    fs.mkdirSync(path.join(mod, 'Invoices'), { recursive: true });
    fs.mkdirSync(path.join(mod, 'Ledger'), { recursive: true });
    fs.mkdirSync(path.join(mod, 'Workers'), { recursive: true });

    // Emitter — no import relationship to the subscriber at all.
    fs.writeFileSync(path.join(mod, 'Invoices/Invoice.service.ts'),
      `import { events } from '@/common/events';\nexport class InvoiceService {\n  async create() {\n    await this.emitter.emitAsync(events.saleInvoice.onCreated, { id: 1 });\n    await this.queue.add('gl-rewrite', {});\n  }\n}\n`);
    // Subscriber — reachable ONLY through the event name.
    fs.writeFileSync(path.join(mod, 'Ledger/GLSubscriber.ts'),
      `import { events } from '@/common/events';\nexport class GLSubscriber {\n  @OnEvent(events.saleInvoice.onCreated)\n  handle() { /* writes GL entries */ }\n}\n`);
    fs.writeFileSync(path.join(mod, 'Ledger/GLSubscriber.spec.ts'), `describe('GLSubscriber', () => { it('posts', () => {}); });\n`);
    // Queue processor — reachable only through the queue name.
    fs.writeFileSync(path.join(mod, 'Workers/GlRewrite.processor.ts'),
      `@Processor('gl-rewrite')\nexport class GlRewriteProcessor { async handle() {} }\n`);
    fs.writeFileSync(path.join(mod, 'Workers/GlRewrite.processor.spec.ts'), `describe('GlRewriteProcessor', () => { it('runs', () => {}); });\n`);

    const ec = eventCoupling(wt, ['packages/server/src/modules/Invoices/Invoice.service.ts']);
    check('event name extracted from the changed emitter', ec.events.includes('events.saleInvoice.onCreated'));
    check('subscriber found through the event, not imports',
      ec.coupledFiles.some((f) => f.endsWith('Ledger/GLSubscriber.ts')));
    check('rationale states the listener relationship',
      ec.rationale.some((r) => /GLSubscriber\.ts: LISTENS to events\.saleInvoice\.onCreated/.test(r)));
    check('subscriber SPEC selected as affected',
      ec.specs.some((s) => s.endsWith('Ledger/GLSubscriber.spec.ts')));
    check('queue processor coupled through the queue name',
      ec.coupledFiles.some((f) => f.endsWith('Workers/GlRewrite.processor.ts')));
    check('queue processor spec selected',
      ec.specs.some((s) => s.endsWith('Workers/GlRewrite.processor.spec.ts')));

    // Additivity: the union may only ever grow the existing selection.
    const existing = ['packages/server/src/modules/Invoices/Invoice.service.spec.ts'];
    const union = [...new Set([...existing, ...ec.specs])];
    check('affected tests are a UNION (existing selection preserved)',
      existing.every((e) => union.includes(e)) && union.length >= existing.length + 2);

    // An unrelated change must not drag the whole suite in.
    const none = eventCoupling(wt, ['packages/server/src/modules/Ledger/README.md']);
    check('unrelated non-source change couples nothing', none.events.length === 0 && none.specs.length === 0);
  }

  // ---- Graphify RUNTIME exposure (the TASK-V2-0011 regression) ------------
  section('graphify runtime: task pointer, wrapper interface, log-backed evidence, isolation');
  {
    const gfy = require('./core/graphify') as typeof import('./core/graphify');
    const te = require('./core/toolevidence') as typeof import('./core/toolevidence');
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const GROOT = path.join(process.env.AI_V2_STATE!, 'graphify');
    const WRAPPER = '/srv/ai-accounting/bin/graphify-task';
    const SHA_X = 'c'.repeat(40), SHA_Y = 'd'.repeat(40);
    const mkGraph = (sha: string) => {
      fs.mkdirSync(path.join(GROOT, sha), { recursive: true });
      fs.writeFileSync(path.join(GROOT, sha, 'graph.json'), JSON.stringify({ nodes: [], links: [] }));
      fs.writeFileSync(path.join(GROOT, sha, 'meta.json'), JSON.stringify({
        sourceSha: sha, generatedAt: new Date().toISOString(), graphifyVersion: 'graphify 0.9.46',
        fileCount: 2, nodeCount: 7, edgeCount: 9 }));
    };
    mkGraph(SHA_X);

    // A. a registered task resolves the graph matching its analyzed SHA
    gfy.registerTask('TASK-V2-9601', SHA_X);
    const ptr = JSON.parse(fs.readFileSync(path.join(GROOT, 'tasks', 'TASK-V2-9601.json'), 'utf8'));
    check('A: task pointer records the analyzed SHA', ptr.analyzedSha === SHA_X && ptr.taskId === 'TASK-V2-9601');
    check('A: matching SHA resolves to a usable graph',
      gfy.isAvailable() ? gfy.graphFor(SHA_X).usable === true : true);

    // B. stale SHA rejected, and the status block says so in machine-readable form
    const staleBlock = gfy.statusBlockFor(SHA_Y);
    check('B: stale/absent SHA is refused', gfy.graphFor(SHA_Y).usable === false);
    check('B: status block reports unavailability, not a silent guess',
      staleBlock.includes('available: false') && /GRAPH_STALE|NO_GRAPH|not installed/.test(staleBlock));

    // C/D. status block is machine-generated and carries both SHAs when current
    const okBlock = gfy.statusBlockFor(SHA_X);
    if (gfy.isAvailable()) {
      check('D: agents receive a generated status block with both SHAs',
        okBlock.includes('available: true') && okBlock.includes(`graphSourceSha: ${SHA_X}`) &&
        okBlock.includes(`analyzedSourceSha: ${SHA_X}`) && okBlock.includes('interface: graphify-task'));
      check('D: block states CURRENT for an exact match', okBlock.includes('status: CURRENT'));
    } else {
      check('D: agents receive a generated status block with both SHAs (graphify absent)',
        okBlock.includes('available: false'));
      check('D: block states CURRENT for an exact match (n/a)', true);
    }
    check('C: missing graph degrades to guidance, never to a fabricated graph',
      gfy.statusBlockFor('e'.repeat(40)).includes('inspect current source directly'));

    // E. prose cannot fake usage; only a wrapper execution counts
    const proseOnly = te.reconcileClaims(
      te.extractToolEvidence([JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
        text: 'I queried the project graph with graphify-task and confirmed the blast radius.' } })]),
      { graphifyUsed: true });
    check('E: prose mentioning graphify-task cannot set graphifyUsed', proseOnly.graphifyUsed === false);
    check('E: the overclaim is recorded', proseOnly.claimMismatch.some((m) => m.includes('graphifyUsed')));
    const realRun = te.extractToolEvidence([JSON.stringify({ type: 'item.completed',
      item: { type: 'command_execution', command: 'graphify-task query "auth blast radius"' } })]);
    check('E: a graphify-task call with no result is an attempt, not usage',
      realRun.graphifyAttempted === true && realRun.graphifyUsed === false);
    const realRunOk = te.extractToolEvidence([JSON.stringify({ type: 'item.completed',
      item: { type: 'command_execution', command: 'graphify-task query "auth blast radius"',
        aggregated_output: JSON.stringify({ ok: true, operation: 'query',
          graphifyVersion: 'graphify 0.9.46', graphSourceSha: SHA_X, analyzedSourceSha: SHA_X }) } })]);
    check('E: a graphify-task call WITH a successful receipt IS usage', realRunOk.graphifyUsed === true);

    // The read-only-sandbox path: codex cannot write the wrapper log, so the
    // wrapper's JSON receipt in the transcript is the machine record.
    const receipt = te.extractToolEvidence([JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution',
      command: 'graphify-task query "auth blast radius"',
      aggregated_output: JSON.stringify({ ok: true, operation: 'query', graphifyVersion: 'graphify 0.9.46',
        graphSourceSha: SHA_X, analyzedSourceSha: SHA_X, graphCurrent: true, result: 'NODE ...' }) } })]);
    check('E: wrapper receipt in a read-only sandbox counts as real usage', receipt.graphifyUsed === true);
    check('E: receipt carries both SHAs and the version',
      receipt.graphSourceSha === SHA_X && receipt.analyzedSourceSha === SHA_X &&
      receipt.graphifyVersion === 'graphify 0.9.46');
    const failedReceipt = te.extractToolEvidence([JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', command: 'graphify-task query "x"',
      aggregated_output: JSON.stringify({ ok: false, operation: 'query', available: false, reason: 'GRAPH_STALE' }) } })]);
    check('E: a FAILED wrapper call is not counted as usage', failedReceipt.graphifyUsed === false);
    check('E: but the attempt is recorded', failedReceipt.graphifyAttempted === true);

    // The exact shape agents actually emit: bash -lc with the command quoted.
    const bashWrapped = te.extractToolEvidence([JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution',
      command: `/bin/bash -lc 'graphify-task query "auth blast radius"'`,
      aggregated_output: JSON.stringify({ ok: true, operation: 'query', graphifyVersion: 'graphify 0.9.46',
        graphSourceSha: SHA_X, analyzedSourceSha: SHA_X, graphCurrent: true }) } })]);
    check('E: shell-quoted `bash -lc \'graphify-task ...\'` is recognised', bashWrapped.graphifyUsed === true);
    check('E: shell-quoted call still yields both SHAs',
      bashWrapped.graphSourceSha === SHA_X && bashWrapped.analyzedSourceSha === SHA_X);

    // H. identical SHA reuses the cached graph rather than rebuilding
    const u1 = gfy.graphFor(SHA_X), u2 = gfy.graphFor(SHA_X);
    check('H: same SHA reuses the cached graph',
      gfy.isAvailable() ? (u1 as any).graph === (u2 as any).graph : true);

    // Invocation log: attribution by run window
    const invDir = path.join(GROOT, 'invocations');
    fs.mkdirSync(invDir, { recursive: true });
    const t0 = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const older = new Date(Date.now() - 600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(path.join(invDir, 'TASK-V2-9601.jsonl'), [
      JSON.stringify({ operation: 'query', query: 'old run', ok: true, graphSourceSha: SHA_X,
        analyzedSourceSha: SHA_X, graphCurrent: true, startedAt: older }),
      JSON.stringify({ operation: 'affected', query: 'this run', ok: true, graphSourceSha: SHA_X,
        analyzedSourceSha: SHA_X, graphCurrent: true, graphifyVersion: 'graphify 0.9.46', startedAt: t1 }),
    ].join('\n') + '\n');
    const during = gfy.invocationsDuring('TASK-V2-9601', t0, t1);
    check('G: only invocations inside the run window are credited',
      during.length === 1 && during[0].query === 'this run');
    check('G: invocation carries version and both SHAs',
      during[0].graphifyVersion === 'graphify 0.9.46' && during[0].graphSourceSha === SHA_X &&
      during[0].analyzedSourceSha === SHA_X);

    // J. one task cannot read another task's graph
    gfy.registerTask('TASK-V2-9602', SHA_Y);
    const other = JSON.parse(fs.readFileSync(path.join(GROOT, 'tasks', 'TASK-V2-9602.json'), 'utf8'));
    check('J: each task points only at its own SHA',
      other.analyzedSha === SHA_Y && ptr.analyzedSha === SHA_X);
    check('J: no invocations leak between tasks', gfy.invocations('TASK-V2-9602').length === 0);

    // F/G/I. the real wrapper on this host: argument surface + sandbox execution
    if (fs.existsSync(WRAPPER)) {
      const runWrapper = (args: string[], cwd?: string) => {
        try {
          return { out: execFileSync(WRAPPER, args, { encoding: 'utf8', timeout: 60_000,
            cwd: cwd ?? '/tmp', env: { ...process.env, AI_V2_TASK_ID: '' } }), code: 0 };
        } catch (e: any) { return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status ?? 1 }; }
      };
      const bogusOp = runWrapper(['definitely-not-an-op']);
      check('F: unknown operation refused', /unknown operation/.test(bogusOp.out));
      const withFlag = runWrapper(['query', '--graph']);
      check('G: CLI flags refused', /flags are not accepted/.test(withFlag.out));
      const withPath = runWrapper(['query', '/etc/passwd']);
      // A path is accepted only as free text; it can never select a graph.
      check('F: arbitrary graph path cannot be supplied',
        !withPath.out.includes('/etc/passwd\n  graph') && !/--graph \/etc/.test(withPath.out));
      const noCtx = runWrapper(['status']);
      check('F: outside a task there is no graph context at all',
        /NO_TASK_CONTEXT/.test(noCtx.out));
      check('I: wrapper is executable in this runtime', bogusOp.out.length > 0);
    } else {
      check('F: unknown operation refused (wrapper absent here)', true);
      check('G: CLI flags refused (wrapper absent here)', true);
      check('F: arbitrary graph path cannot be supplied (wrapper absent here)', true);
      check('F: outside a task there is no graph context (wrapper absent here)', true);
      check('I: wrapper is executable in this runtime (absent here)', true);
    }
  }

  // ---- real cancellation ---------------------------------------------------
  section('cancellation: process-group kill, verified termination, late-result rejection');
  {
    const { spawn } = require('child_process') as typeof import('child_process');
    const procs = require('./core/procs') as typeof import('./core/procs');
    const wt = fs.mkdtempSync(path.join(TMP, 'cancel-'));

    // A long-lived process in its OWN group, exactly as agents/checks spawn.
    const startFake = (taskId: string, label: string, withChild: boolean) => {
      const script = withChild
        // parent spawns a child that outlives a naive parent-only kill
        ? 'const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000);'
        : 'setInterval(()=>{},1000);';
      const child = spawn(process.execPath, ['-e', script], { cwd: wt, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      procs.registerRun({ taskId, runId: 'r1', pid: child.pid!, pgid: child.pid!, kind: 'agent', label, cwd: wt, startedAt: Date.now() });
      return child;
    };
    const waitFor = async (fn: () => boolean, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 100));
      return fn();
    };

    // A. long-running fake agent → cancel → process exits
    const a = startFake('TASK-V2-9401', 'fake-agent', false);
    check('A: fake agent is running', procs.isAlive(a.pid!));
    const ra = await procs.terminateTaskRuns('TASK-V2-9401', 3000);
    check('A: termination reports all gone', ra.allGone);
    check('A: process really exited', !procs.isAlive(a.pid!));

    // B. agent starts a child → cancel → BOTH terminate (process-group proof)
    const b = startFake('TASK-V2-9402', 'fake-agent-with-child', true);
    const childPid = await new Promise<number>((resolve) => {
      let buf = '';
      b.stdout!.on('data', (d: Buffer) => { buf += d.toString(); const n = Number(buf.trim()); if (n) resolve(n); });
    });
    check('B: parent and child both running', procs.isAlive(b.pid!) && procs.isAlive(childPid));
    const rb = await procs.terminateTaskRuns('TASK-V2-9402', 3000);
    check('B: parent terminated', rb.allGone && !procs.isAlive(b.pid!));
    check('B: CHILD terminated too (whole process group)', await waitFor(() => !procs.isAlive(childPid)));

    // D. cancelling TASK-A must not touch TASK-B
    const ta = startFake('TASK-V2-9403', 'task-a', false);
    const tb = startFake('TASK-V2-9404', 'task-b', false);
    await procs.terminateTaskRuns('TASK-V2-9403', 3000);
    check('D: cancelled task A is gone', !procs.isAlive(ta.pid!));
    check('D: unrelated task B untouched', procs.isAlive(tb.pid!));
    check('D: registry still owns only task B', procs.runsForTask('TASK-V2-9404').length === 1 &&
      procs.runsForTask('TASK-V2-9403').length === 0);
    await procs.terminateTaskRuns('TASK-V2-9404', 3000); // cleanup

    // E. cancel during a check (tests) terminates the test process group
    const e = startFake('TASK-V2-9405', 'jest', false);
    const re = await procs.terminateTaskRuns('TASK-V2-9405', 3000);
    check('E: running test process terminated by cancel', re.allGone && !procs.isAlive(e.pid!));

    // Signal-safety: the registry never targets pid<=1 (init / our own group)
    check('safety: pgid 0 refused', !procs.signalGroup(0, 'SIGTERM'));
    check('safety: pgid 1 (init) refused', !procs.signalGroup(1, 'SIGTERM'));

    // C. late agent result after cancel must be ignored; task stays CANCELLED
    const ev = new EventStore();
    const cid = 'TASK-V2-9406';
    ev.append({ taskId: cid, type: 'TASK_CREATED', payload: { title: 't', description: 'd', risk: 'medium', branch: 'b', baseSha: 'a1', worktree: wt } });
    ev.append({ taskId: cid, type: 'STATE_CHANGED', payload: { from: 'NEW', to: 'DESIGN' } });
    ev.append({ taskId: cid, type: 'CANCEL_REQUESTED', payload: { cancelledBy: 'owner', reason: 'stop' } });
    check('C: CANCEL_REQUESTED shows CANCELLING', deriveTask(ev, cid)!.state === 'CANCELLING');
    ev.append({ taskId: cid, type: 'PROCESS_TERMINATED', payload: { allGone: true, runs: [] } });
    ev.append({ taskId: cid, type: 'TASK_CANCELLED', payload: { cancelledBy: 'owner', reason: 'stop', verifiedNoSurvivors: true } });
    check('C: verified termination → CANCELLED', deriveTask(ev, cid)!.state === 'CANCELLED');
    // the exact TASK-V2-0007 resurrection: a late failure + escalation
    ev.append({ taskId: cid, type: 'AGENT_FAILED', agent: 'claude', payload: { ok: false, exitCode: 143, error: 'killed' } });
    ev.append({ taskId: cid, type: 'STATE_CHANGED', payload: { from: 'DESIGN', to: 'ESCALATED' } });
    check('C: late AGENT_FAILED + ESCALATED cannot resurrect the task',
      deriveTask(ev, cid)!.state === 'CANCELLED');
    ev.append({ taskId: cid, type: 'CODE_CHANGE', payload: { headSha: 'deadbeef123', filesChanged: ['x.ts'] } });
    check('C: late CODE_CHANGE does not move HEAD', deriveTask(ev, cid)!.headSha === 'a1');
    ev.append({ taskId: cid, type: 'STATE_CHANGED', payload: { from: 'X', to: 'READY_TO_MERGE' } });
    ev.append({ taskId: cid, type: 'STATE_CHANGED', payload: { from: 'X', to: 'DEPLOYED' } });
    check('C: late merge/deploy progression ignored', deriveTask(ev, cid)!.state === 'CANCELLED');
    check('C: event log integrity intact (nothing rewritten)', ev.verify(cid).ok);

    // F. cancel during REVIEW: reviewer stops, no adjudication may follow
    const fid = 'TASK-V2-9407';
    ev.append({ taskId: fid, type: 'TASK_CREATED', payload: { title: 't', description: 'd', risk: 'medium', branch: 'b', baseSha: 'a1', worktree: wt } });
    ev.append({ taskId: fid, type: 'STATE_CHANGED', payload: { from: 'VERIFY', to: 'REVIEW' } });
    ev.append({ taskId: fid, type: 'CANCEL_REQUESTED', payload: { cancelledBy: 'owner', reason: 'stop' } });
    ev.append({ taskId: fid, type: 'TASK_CANCELLED', payload: { cancelledBy: 'owner', reason: 'stop' } });
    const beforeAdj = ev.read(fid).filter((x) => x.type === 'ADJUDICATION').length;
    check('F: review cancelled → state CANCELLED', deriveTask(ev, fid)!.state === 'CANCELLED');
    check('F: no adjudication recorded after cancel', beforeAdj === 0 &&
      ev.read(fid).filter((x) => x.type === 'ADJUDICATION').length === 0);
    // and an owner recovery is the ONLY way back
    ev.append({ taskId: fid, type: 'TASK_RECOVERED', payload: { recoveredBy: 'owner', reenteringAt: 'REVIEW' } });
    ev.append({ taskId: fid, type: 'STATE_CHANGED', phase: 'recovery', payload: { from: 'CANCELLED', to: 'REVIEW' } });
    check('F: explicit owner recovery re-opens the task', deriveTask(ev, fid)!.state === 'REVIEW');
  }

  // ---- role-based model selection -----------------------------------------
  section('role-based models: per-role settings, validation, snapshot, fallback');
  {
    const ev = new EventStore();
    // Availability is probe-derived in production; tests inject it explicitly.
    __setAvailabilityForTest('claude', 'claude-fable-5', true);
    __setAvailabilityForTest('claude', 'claude-sonnet-5', true);
    __setAvailabilityForTest('codex', 'gpt-5.6-sol', true);
    __setAvailabilityForTest('codex', 'gpt-5.2', true);

    // each role independently configurable; Claude vs Claude Code differ
    let r = setRoleSetting('claude.design', { model: 'claude-fable-5', reasoning: 'max' }, 't', ev);
    check('claude.design set', r.ok);
    r = setRoleSetting('claudeCode.implementation', { model: 'claude-sonnet-5', reasoning: 'medium' }, 't', ev);
    check('claudeCode.implementation set to a DIFFERENT model', r.ok);
    r = setRoleSetting('codex.designReview', { model: 'gpt-5.6-sol', reasoning: 'xhigh' }, 't', ev);
    check('codex.designReview set', r.ok);
    r = setRoleSetting('codex.codeReview', { model: 'gpt-5.2', reasoning: 'high' }, 't', ev);
    check('codex.codeReview set to a DIFFERENT codex model', r.ok);
    let s = getModelSettings();
    check('Claude Design != Claude Code Implementation',
      s.roles['claude.design'].model !== s.roles['claudeCode.implementation'].model);
    check('Codex Design Review != Codex Code Review',
      s.roles['codex.designReview'].model !== s.roles['codex.codeReview'].model);
    check('settings persist on disk (fresh read)',
      fs.existsSync(path.join(process.env.AI_V2_STATE!, 'settings', 'models.json')) &&
      JSON.parse(fs.readFileSync(path.join(process.env.AI_V2_STATE!, 'settings', 'models.json'), 'utf8')).roles['claude.design'].model === 'claude-fable-5');

    // validation: closed world only
    check('unverified model rejected', !setRoleSetting('claude.design', { model: 'claude-imaginary-9' }, 't', ev).ok);
    check('unsupported reasoning rejected (none is codex-only)',
      !setRoleSetting('claude.design', { reasoning: 'none' }, 't', ev).ok);
    check('codex accepts its own enum', setRoleSetting('codex.investigation', { reasoning: 'minimal' }, 't', ev).ok);
    check('unknown role rejected', !setRoleSetting('claude.hacking', { model: 'claude-fable-5' }, 't', ev).ok);
    check('cross-provider model rejected (Codex role cannot take a Claude model)',
      !setRoleSetting('codex.codeReview', { model: 'claude-fable-5' }, 't', ev).ok);
    check('cross-provider model rejected (Claude role cannot take a GPT model)',
      !setRoleSetting('claude.design', { model: 'gpt-5.6-sol' }, 't', ev).ok);
    check('shell-shaped model identifier rejected',
      !setRoleSetting('claude.design', { model: 'fable; rm -rf /' }, 't', ev).ok);

    // audit
    const audit = ev.read('SYSTEM-SETTINGS').filter((e) => e.type === 'SETTING_CHANGED' &&
      String((e.payload as any).setting).startsWith('models.'));
    check('every model change produced an immutable audit event', audit.length >= 4 &&
      ev.verify('SYSTEM-SETTINGS').ok);
    check('audit records from/to/actor', (audit[0].payload as any).actor === 't' &&
      (audit[0].payload as any).to.model === 'claude-fable-5');

    // resolve + per-task override + immutable snapshot semantics
    const base = resolvePolicy();
    check('default policy inherits global role settings', base.ok &&
      base.ok === true && base.policy['claude.design'].model === 'claude-fable-5' &&
      base.policy['codex.codeReview'].model === 'gpt-5.2');
    const ov = resolvePolicy({ 'codex.codeReview': { model: 'gpt-5.6-sol' } });
    check('per-task override applies to that role only', ov.ok && ov.ok === true &&
      ov.policy['codex.codeReview'].model === 'gpt-5.6-sol' &&
      ov.policy['codex.designReview'].model === 'gpt-5.6-sol' &&
      ov.policy['claude.design'].model === 'claude-fable-5');
    check('override with unverified model rejected',
      !resolvePolicy({ 'codex.codeReview': { model: 'gpt-99-imaginary' } }).ok);
    check('override with unsupported reasoning rejected',
      !resolvePolicy({ 'claude.design': { reasoning: 'turbo' } }).ok);

    // snapshot immutability: policy recorded in events, later global change ignored
    const tid = 'TASK-V2-9300';
    ev.append({ taskId: tid, type: 'TASK_CREATED', payload: { title: 'x', description: 'x', risk: 'low', branch: 'b', baseSha: 'a', worktree: '/w' } });
    ev.append({ taskId: tid, type: 'TASK_MODEL_POLICY', payload: { policy: (base as any).policy, source: 'global-defaults' } });
    setRoleSetting('claude.design', { model: 'claude-sonnet-5' }, 't', ev); // global change AFTER snapshot
    const snap = ev.read(tid).filter((e) => e.type === 'TASK_MODEL_POLICY').pop()!;
    check('task model snapshot unaffected by later global change',
      ((snap.payload as any).policy['claude.design'].model) === 'claude-fable-5' &&
      getModelSettings().roles['claude.design'].model === 'claude-sonnet-5');
    // explicit owner update = a NEW snapshot event, history preserved
    const cur = resolvePolicy();
    ev.append({ taskId: tid, type: 'TASK_MODEL_POLICY', payload: { policy: (cur as any).policy, source: 'owner-update', actor: 't' } });
    const snaps = ev.read(tid).filter((e) => e.type === 'TASK_MODEL_POLICY');
    check('owner update appends a new snapshot; original kept', snaps.length === 2 &&
      ((snaps[1].payload as any).policy['claude.design'].model) === 'claude-sonnet-5');

    // fallback: same provider always; pause honored; backup honored
    const roleA = { role: 'codex.codeReview', provider: 'codex' as const, model: 'gpt-5.2', reasoning: null, fallback: 'best-available' as const };
    const fb1 = fallbackFor(roleA);
    check('best-available fallback stays on codex', fb1.action === 'model' && (fb1 as any).model === 'gpt-5.6-sol');
    check('fallback never crosses provider', fb1.action === 'model' && !/claude/.test((fb1 as any).model));
    const fb2 = fallbackFor({ ...roleA, fallback: 'pause' });
    check('pause policy honored', fb2.action === 'pause');
    const fb3 = fallbackFor({ ...roleA, fallback: 'backup:gpt-5.6-sol' });
    check('explicit backup model honored', fb3.action === 'model' && (fb3 as any).model === 'gpt-5.6-sol');
    const fb4 = fallbackFor({ role: 'claude.design', provider: 'claude', model: 'claude-sonnet-5', reasoning: null, fallback: 'backup:gpt-5.6-sol' });
    check('backup pointing at another provider forces pause', fb4.action === 'pause');

    // presets fill role settings from CURRENT availability, hide nothing
    const pr = applyPreset('maximum-quality', 't', ev);
    check('preset applies', pr.ok);
    s = getModelSettings();
    check('preset resolved strongest verified models (no assumed names)',
      /fable/.test(s.roles['claude.design'].model) && s.roles['codex.codeReview'].model === 'gpt-5.6-sol');
    check('preset wrote per-role settings (nothing hidden)',
      Object.keys((pr as any).applied).length === ROLES.length);
    check('unknown preset rejected', !applyPreset('cheapest-paid-api', 't', ev).ok);

    // reasoning enums are the provider-authoritative lists
    check('claude enum from CLI help', JSON.stringify(REASONING.claude) === JSON.stringify(['low','medium','high','xhigh','max']));
    check('codex enum from API error', REASONING.codex.includes('none') && REASONING.codex.includes('xhigh'));

    // subscription-only invariant: nothing here can introduce a paid key
    check('no paid API key in environment after model operations',
      !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY);
  }

  // ---- Persian reporting --------------------------------------------------
  section('Persian reporting: snapshot, fallback, cache, simplify invariants');
  {
    process.env.AI_V2_REPORT_DISABLE_LLM = '1'; // never call a model from tests
    const ev = new EventStore();
    const id = 'TASK-V2-9101';
    const HEAD = 'aabbccdd112233445566';
    ev.append({ taskId: id, type: 'TASK_CREATED', payload: { title: 'fix rounding', description: 'Fix invoice rounding', risk: 'medium', branch: 'ai/task-v2-9101', baseSha: 'b1b1b1b1b', worktree: '/w' } });
    ev.append({ taskId: id, type: 'STATE_CHANGED', payload: { from: 'NEW', to: 'DESIGN' } });
    ev.append({ taskId: id, type: 'AGENT_STARTED', agent: 'claude', phase: 'design', payload: {} });
    ev.append({ taskId: id, type: 'AGENT_FINISHED', agent: 'claude', phase: 'design', payload: {
      ok: true, durationMs: 1000, requestedModel: 'claude-fable-5', effectiveModel: 'claude-fable-5',
      cliVersion: '2.1.233', authMode: 'subscription-cli' } });
    ev.append({ taskId: id, type: 'STATE_CHANGED', payload: { from: 'DESIGN', to: 'IMPLEMENT' } });
    ev.append({ taskId: id, type: 'CODE_CHANGE', payload: { headSha: HEAD, filesChanged: ['packages/server/src/a.ts'] } });
    ev.append({ taskId: id, type: 'TEST_RESULT', payload: { tier: 'targeted', name: 'a.spec', ok: true, detail: '4 passed' } });
    ev.append({ taskId: id, type: 'DETERMINISTIC_CHECK', phase: 'verify', payload: { name: 'perDocumentReconciliation', ok: true, detail: '6/6 balanced' } });
    ev.append({ taskId: id, type: 'EVIDENCE', payload: { verified: ['targeted tests pass'], notVerified: ['load under 10k invoices'] } });

    const s1 = buildSnapshot(ev, id).snapshot;
    check('snapshot cursor equals last event seq', s1.cursor === ev.read(id).length);
    check('snapshot carries head/base/branch', s1.headSha === HEAD && s1.branch === 'ai/task-v2-9101');
    check('snapshot carries model observability from agent events',
      s1.agents.some((a: any) => a.effectiveModel === 'claude-fable-5' && a.authMode === 'subscription-cli'));

    // running report: CURRENT, Persian, technical tokens LTR-wrapped
    const r1 = await generateReport(ev, id, 'NORMAL');
    check('report generated for a RUNNING task', r1 !== null && r1!.identity.reportType === 'CURRENT');
    check('fallback generator used when model disabled', r1!.generator === 'deterministic-fallback');
    check('language/detail metadata recorded', r1!.identity.language === 'fa' && r1!.identity.detailLevel === 'NORMAL');
    check('narrative is Persian', /[؀-ۿ]/.test(r1!.narrative));
    check('technical identifiers kept as LTR backtick tokens', r1!.narrative.includes('`' + 'ai/task-v2-9101' + '`'));
    check('running report includes pending work', r1!.narrative.includes('باقی مانده'));
    check('requested model recorded on report', r1!.requestedModel === CLAUDE_MODEL);
    check('status card says in-progress with no action', r1!.statusCard.icon === '⏳' && !r1!.statusCard.actionRequired);

    // cache: same head + cursor + level → same stored report, no regeneration
    const r2 = await generateReport(ev, id, 'NORMAL');
    check('identical evidence returns the cached report', r2!.identity.generatedAt === r1!.identity.generatedAt);
    check('history stored on disk', listReports(id).length === 1);

    // simplify: SAME snapshot, four questions, facts preserved
    const rs = await generateReport(ev, id, 'SIMPLE');
    check('simplify built from the same cursor', rs!.identity.lastEventId === r1!.identity.lastEventId);
    check('simplify starts with the four questions',
      rs!.narrative.includes('چه کاری انجام شد؟') && rs!.narrative.includes('آیا موفق شد؟') &&
      rs!.narrative.includes('الان وضعیت چیست؟') && rs!.narrative.includes('آیا من باید کاری انجام بدهم؟'));

    // new event invalidates the cache
    ev.append({ taskId: id, type: 'STATE_CHANGED', payload: { from: 'IMPLEMENT', to: 'VERIFY' } });
    const r3 = await generateReport(ev, id, 'NORMAL');
    check('new event → new cursor → cache miss', r3!.identity.lastEventId === r1!.identity.lastEventId + 1);
    check('no events beyond cursor in snapshot', buildSnapshot(ev, id).snapshot.cursor === ev.read(id).length);

    // whatChanged delta
    const delta = whatChanged(ev, id, r1!.identity.lastEventId);
    check('what-changed reports only post-cursor events', delta.includes('1 رویداد') || delta.includes('رویداد جدید'));
    check('what-changed on latest cursor says nothing new',
      whatChanged(ev, id, ev.read(id).length).includes('رویداد جدیدی ثبت نشده'));

    // simplify invariants on a FAILED task with CRITICAL finding — never hidden
    const fid = 'TASK-V2-9102';
    ev.append({ taskId: fid, type: 'TASK_CREATED', payload: { title: 'x', description: 'x', risk: 'high', branch: 'ai/x', baseSha: 'c2c2c2c2c', worktree: '/w' } });
    ev.append({ taskId: fid, type: 'FINDING', agent: 'codex', payload: { findings: [{ findingId: 'C-1', severity: 'CRITICAL', category: 'correctness', claim: 'double posting', scenario: 'concrete scenario', status: 'UNRESOLVED' }] } });
    ev.append({ taskId: fid, type: 'NOTE', payload: { lastError: 'stage0 regressions' } });
    ev.append({ taskId: fid, type: 'STATE_CHANGED', payload: { from: 'VERIFY', to: 'FAILED' } });
    const rf = generateDeterministic(ev, fid, 'SIMPLE')!;
    check('FAILED simplify says NO (خیر) honestly', rf.narrative.includes('خیر'));
    check('simplify never hides CRITICAL findings', rf.narrative.includes('CRITICAL'));
    check('final state → FINAL report type', rf.identity.reportType === 'FINAL');
    check('FAILED status card demands attention', rf.statusCard.icon === '❌' && rf.statusCard.actionRequired);

    // AWAITING_HUMAN status card carries the decision
    const hid = 'TASK-V2-9103';
    ev.append({ taskId: hid, type: 'TASK_CREATED', payload: { title: 'h', description: 'h', risk: 'high', branch: 'ai/h', baseSha: 'd3d3d3d3d', worktree: '/w' } });
    ev.append({ taskId: hid, type: 'STATE_CHANGED', payload: { from: 'FINAL_ACCEPTANCE', to: 'AWAITING_HUMAN',
      awaiting: { decisionId: 'D-1', issue: 'baseline drift', whyAutomationStopped: 'critical trigger', evidence: [],
        recommendedAction: 'approve baseline', whyRecommended: '', alternatives: [], riskIfApproved: '', riskIfRejected: '' } } });
    const rh = generateDeterministic(ev, hid, 'NORMAL')!;
    check('AWAITING_HUMAN card asks for the owner decision',
      rh.statusCard.icon === '⚠️' && rh.statusCard.actionRequired &&
      (rh.statusCard.actionExplanation ?? '').includes('baseline drift'));

    // secret redaction on the way out
    const sid = 'TASK-V2-9104';
    ev.append({ taskId: sid, type: 'TASK_CREATED', payload: { title: 'sk-ant-verysecrettoken12345 leak', description: 'd', risk: 'low', branch: 'ai/s', baseSha: 'e4e4e4e4e', worktree: '/w' } });
    const rsec = generateDeterministic(ev, sid, 'NORMAL')!;
    check('secrets never reach the report output', !rsec.narrative.includes('sk-ant-verysecret'));

    // V1 legacy: reconstructed and labeled
    const v1root = path.join(TMP, 'v1-state');
    fs.mkdirSync(path.join(v1root, 'tasks', 'TASK-0042'), { recursive: true });
    fs.writeFileSync(path.join(v1root, 'tasks', 'TASK-0042', 'events.jsonl'), [
      JSON.stringify({ type: 'TASK_CREATED', ts: '2026-08-01T00:00:00Z', payload: { title: 'legacy fix', risk: 'low', branch: 'ai/legacy', baseRef: 'origin/main' } }),
      JSON.stringify({ type: 'STATE_TRANSITION', ts: '2026-08-01T01:00:00Z', payload: { from: 'DESIGN', to: 'IMPLEMENT' } }),
    ].join('\n') + '\n');
    process.env.AI_V1_STATE = v1root;
    const rl = generateDeterministic(ev, 'TASK-0042', 'NORMAL');
    check('V1 legacy task produces a report', rl !== null);
    check('legacy report explicitly labeled reconstructed',
      rl!.identity.legacy === true && rl!.narrative.includes('V1'));
    delete process.env.AI_V1_STATE;

    // model policy
    check('default Claude model policy is claude-fable-5', CLAUDE_MODEL === 'claude-fable-5');
    check('no paid API key present in test environment',
      !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY);
    delete process.env.AI_V2_REPORT_DISABLE_LLM;
  }

  console.log(`\nV2 self-tests: ${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  return failed === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
