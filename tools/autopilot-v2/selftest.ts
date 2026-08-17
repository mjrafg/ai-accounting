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

import { EventStore, StreamLog, deriveTask, currentDesign } from './core/store';
import { redact, loadKnownSecrets, looksSecret } from './core/redact';
import { parseStructured, inspectEnvelope, looksRateLimited } from './core/parsers';
import { WorktreeManager } from './core/worktrees';
import {
  assertDisposableTargets, ProductionEndpointError, GlobalLock, normalizeFailure, compareSignatures,
} from './core/checks';
import * as policy from './core/policy';
import { totp, verifyTotp, base32Encode } from './core/mfa';
import { getDeploymentSettings, setAutomaticDeployment, automaticDeploymentEnabled } from './core/settings';
import { CLAUDE_MODEL } from './core/agents';
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
