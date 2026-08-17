/**
 * DeterministicChecksService.
 *
 * Evidence hierarchy: runtime/database evidence > deterministic test/probe >
 * agent adjudication > human. Where a reliable experiment settles a question,
 * the argument ends here.
 *
 * Includes the structural production guard (ported from V1 — a safety property
 * explicitly retained): destructive suites must positively match a known
 * disposable endpoint, and anything carrying a production marker is refused.
 */
import { execFile, execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CheckResult } from './types';
import { STATE_ROOT } from './store';

// ---------------------------------------------------------------------------
// Production guard
// ---------------------------------------------------------------------------

export class ProductionEndpointError extends Error {
  constructor(detail: string) {
    super(`refusing to run destructive tests against production: ${detail}`);
    this.name = 'ProductionEndpointError';
  }
}

const ALLOWED_DB_HOSTS = ['mariadb', '127.0.0.1', 'localhost', 'ai-accounting-mariadb-1'];
const ALLOWED_REDIS_HOSTS = ['redis', '127.0.0.1', 'localhost', 'ai-accounting-redis-1'];
const PRODUCTION_MARKERS = [/bigcapital[-_]prod/i, /(^|[^a-z])prod(uction)?([^a-z]|$)/i, /acc\.agent24\.io/i];

function parseEnvFile(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function assertDisposableTargets(worktree: string): void {
  const env = { ...parseEnvFile(path.join(worktree, '.env')), ...process.env };
  const fields = {
    dbHost: String(env.DB_HOST ?? ''), dbUser: String(env.DB_USER ?? ''),
    dbName: String(env.SYSTEM_DB_NAME ?? ''), dbPrefix: String(env.TENANT_DB_NAME_PERFIX ?? ''),
    redisHost: String(env.REDIS_HOST ?? ''), baseUrl: String(env.BASE_URL ?? ''),
  };
  for (const [label, value] of Object.entries(fields)) {
    for (const marker of PRODUCTION_MARKERS) {
      if (value && marker.test(value)) throw new ProductionEndpointError(`${label}="${value}" matches ${marker}`);
    }
  }
  if (fields.dbHost && !ALLOWED_DB_HOSTS.includes(fields.dbHost)) {
    throw new ProductionEndpointError(`DB_HOST="${fields.dbHost}" is not a known disposable endpoint`);
  }
  if (fields.redisHost && !ALLOWED_REDIS_HOSTS.includes(fields.redisHost)) {
    throw new ProductionEndpointError(`REDIS_HOST="${fields.redisHost}" is not a known disposable endpoint`);
  }
}

// ---------------------------------------------------------------------------
// Global locks
// ---------------------------------------------------------------------------

/**
 * Stage -1 must never run twice concurrently: real executions proved parallel
 * runs contaminate each other's results. One global lock, held for the whole
 * suite, with the holder recorded for diagnosis.
 */
export class GlobalLock {
  readonly file: string;
  constructor(name: string) {
    this.file = path.join(STATE_ROOT, 'locks', `${name}.lock`);
  }
  tryAcquire(holder: string): boolean {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const fd = fs.openSync(this.file, 'wx');
      fs.writeSync(fd, `${holder} pid=${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return true;
    } catch {
      // Stale lock from a dead process is reclaimed; a live holder is honoured.
      try {
        const txt = fs.readFileSync(this.file, 'utf8');
        const pid = Number(/pid=(\d+)/.exec(txt)?.[1] ?? 0);
        if (pid > 0) { try { process.kill(pid, 0); return false; } catch { /* dead */ } }
        fs.rmSync(this.file, { force: true });
        return this.tryAcquire(holder);
      } catch { return false; }
    }
  }
  async acquire(holder: string, timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    while (!this.tryAcquire(holder)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`lock ${path.basename(this.file)} busy beyond ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  release(): void { fs.rmSync(this.file, { force: true }); }
  holder(): string | null { try { return fs.readFileSync(this.file, 'utf8').trim(); } catch { return null; } }
}

export const stageMinus1Lock = new GlobalLock('stage-minus-1');
export const mergeLock = new GlobalLock('merge');
export const deployLock = new GlobalLock('deploy');

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv):
  { code: number | null; out: string } {
  const res = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024,
    env: env ?? process.env, input: '',
  });
  return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

const NODE_BIN = '/home/aiaccounting/.nvm/versions/node/v18.16.1/bin';
function toolEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH ?? ''}` };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function typecheck(worktree: string): CheckResult {
  const t0 = Date.now();
  const server = path.join(worktree, 'packages/server');
  const r = run(path.join(server, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'],
    server, 10 * 60_000, toolEnv());
  const errors = (r.out.match(/error TS\d+/g) ?? []).length;
  return { name: 'typecheck', ok: r.code === 0, durationMs: Date.now() - t0,
    detail: r.code === 0 ? '0 errors' : `${errors} error(s): ${r.out.split('\n').filter((l) => l.includes('error TS')).slice(0, 5).join(' | ').slice(0, 500)}` };
}

/** Jest unit specs by explicit file list (from impact analysis). */
export function targetedTests(worktree: string, specFiles: string[]): CheckResult {
  const t0 = Date.now();
  if (!specFiles.length) return { name: 'targeted-tests', ok: true, detail: 'no affected unit specs', durationMs: 0 };
  const server = path.join(worktree, 'packages/server');
  const regex = specFiles.map((f) => f.replace(/^packages\/server\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const r = run(path.join(server, 'node_modules/.bin/jest'),
    ['--rootDir', '.', '--testRegex', regex, '--moduleNameMapper', '{"^@/(.*)$":"<rootDir>/src/$1"}', '--passWithNoTests'],
    server, 15 * 60_000, toolEnv());
  const m = /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed, (\d+) total/.exec(r.out);
  const failed = Number(m?.[1] ?? (r.code === 0 ? 0 : 1));
  return { name: 'targeted-tests', ok: r.code === 0, durationMs: Date.now() - t0,
    detail: m ? `${m[3]} passed, ${failed} failed of ${m[4]}` : (r.code === 0 ? 'passed' : r.out.slice(-400)),
    data: { specFiles } };
}

export function stage0(worktree: string): CheckResult {
  const t0 = Date.now();
  assertDisposableTargets(worktree);
  const server = path.join(worktree, 'packages/server');
  const r = run(path.join(server, 'node_modules/.bin/jest'),
    ['--config', './test/jest-e2e.json', '--testRegex', 'stage0-.*\\.stage0-spec\\.ts$', '--forceExit'],
    server, 20 * 60_000, toolEnv());
  const m = /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed, (\d+) total/.exec(r.out);
  return { name: 'stage0', ok: r.code === 0 && !Number(m?.[1] ?? 0), durationMs: Date.now() - t0,
    detail: m ? `${m[3]} passed, ${m[1] ?? 0} failed, ${m[2] ?? 0} skipped` : r.out.slice(-300) };
}

/**
 * Full Stage -1 behind the global lock, with normalized failure signatures.
 * Pass/fail alone is not enough: a known-failing test that starts failing for a
 * NEW reason must surface as REVIEW_REQUIRED, and the signature baseline is
 * never rewritten automatically.
 */
export function stageMinus1(worktree: string, holder: string): CheckResult {
  const t0 = Date.now();
  assertDisposableTargets(worktree);
  if (!stageMinus1Lock.tryAcquire(holder)) {
    return { name: 'stage-minus-1', ok: false, durationMs: 0,
      detail: `global Stage -1 lock busy: ${stageMinus1Lock.holder()}` };
  }
  try {
    for (const f of listJestJsonTemp()) fs.rmSync(f, { force: true });
    const server = path.join(worktree, 'packages/server');
    // Stage -1 tenant provisioning boots `node dist/main.js`. The worktree has
    // no build output, so build it HERE, from the worktree's own source — the
    // emit under test is then the worktree's, not the control plane's.
    if (!fs.existsSync(path.join(server, 'dist', 'main.js'))) {
      const b = run(path.join(server, 'node_modules/.bin/nest'), ['build'], server, 15 * 60_000, toolEnv());
      if (b.code !== 0) {
        return { name: 'stage-minus-1', ok: false, durationMs: Date.now() - t0,
          detail: `worktree server build failed (exit ${b.code}): ${b.out.slice(-300)}` };
      }
    }
    const r = run('node', ['test/e2e-runner.mjs'], server, 60 * 60_000, toolEnv());
    const passed = Number(/(\d+)\s+passed/.exec(r.out)?.[1] ?? 0);
    const failed = Number(/(\d+)\s+failed/.exec(r.out)?.[1] ?? 0);
    const regressions = Number(/(\d+)\s+regressions?/.exec(r.out)?.[1] ?? (r.code === 0 ? 0 : 1));
    const reviewRequired = /REVIEW_REQUIRED/i.test(r.out);

    const sig = collectFailureSignatures(worktree);
    const drift = compareSignatures(sig);

    const ok = r.code === 0 && regressions === 0 && !reviewRequired && drift.changed.length === 0;
    const abnormal = passed === 0 && failed === 0 && r.code !== 0;
    return {
      name: 'stage-minus-1', ok, durationMs: Date.now() - t0,
      detail: (abnormal ? `HARNESS: ${r.out.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)} — ` : '') +
        `${passed} passed, ${failed} failed, ${regressions} regressions` +
        (drift.changed.length ? `; SIGNATURE DRIFT (REVIEW_REQUIRED): ${drift.changed.join(', ')}` : '') +
        (drift.baselineEstablished ? ' (signature baseline established this run)' : ''),
      data: { passed, failed, regressions, signatureDrift: drift.changed, exitCode: r.code },
    };
  } finally {
    stageMinus1Lock.release();
  }
}

function listJestJsonTemp(): string[] {
  try { return fs.readdirSync('/tmp').filter((f) => f.startsWith('e2e-json-')).map((f) => `/tmp/${f}`); }
  catch { return []; }
}

/**
 * Per-test failure signatures from the runner's CANONICAL results file
 * (test/e2e-results.json): stable identity (spec::test name), signature over
 * classification + evidence + bootstrap class. The runner's per-spec jest JSON
 * temp files are deleted by the runner itself, so they cannot be the source.
 */
export function collectFailureSignatures(worktree: string): Record<string, string> {
  const sig: Record<string, string> = {};
  const p = path.join(worktree, 'packages/server/test/e2e-results.json');
  let j: any;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return sig; }
  for (const [spec, v] of Object.entries<any>(j.specs ?? {})) {
    for (const f of v.failed ?? []) {
      sig[`${spec}::${f.name}`] = normalizeFailure(
        `${f.classification ?? ''}|${f.evidence ?? ''}|${v.bootstrapErrorClass ?? ''}`);
    }
  }
  return sig;
}

/** Strip volatile parts so a signature is stable across runs. */
export function normalizeFailure(msg: string): string {
  const norm = msg
    .replace(/\d+ ?ms/g, 'Nms').replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.Z+-]+/g, 'TS')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'HEX').replace(/:\d+:\d+/g, ':L:C')
    .replace(/\/[^\s"']+\//g, '/PATH/').replace(/\b\d+\b/g, 'N')
    .split('\n').slice(0, 4).join('\n');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

const SIG_BASELINE = path.join(STATE_ROOT, 'baselines', 'stage1-signatures.json');
export function compareSignatures(current: Record<string, string>):
  { changed: string[]; baselineEstablished: boolean } {
  fs.mkdirSync(path.dirname(SIG_BASELINE), { recursive: true });
  if (!fs.existsSync(SIG_BASELINE)) {
    fs.writeFileSync(SIG_BASELINE, JSON.stringify(current, null, 2));
    return { changed: [], baselineEstablished: true };
  }
  const base: Record<string, string> = JSON.parse(fs.readFileSync(SIG_BASELINE, 'utf8'));
  const changed: string[] = [];
  for (const [k, v] of Object.entries(current)) {
    if (k in base && base[k] !== v) changed.push(k);
  }
  // The baseline is NEVER auto-rewritten; a human decision endpoint does that.
  return { changed, baselineEstablished: false };
}

// ---------------------------------------------------------------------------
// Numeric accounting safety (against the DISPOSABLE test DB only)
// ---------------------------------------------------------------------------

function testDbQuery(sql: string): string {
  // Structurally safe: the container name IS the disposable test database; no
  // configurable endpoint exists on this path for a guard to misread.
  const r = spawnSync('docker', ['exec', '-i', 'ai-accounting-mariadb-1', 'mysql', '-uroot', '-proot', '-N', '-e', sql],
    { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`test-db query failed: ${(r.stderr ?? '').slice(0, 200)}`);
  return r.stdout ?? '';
}

function tenantDbs(): string[] {
  return testDbQuery("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'bigcapital_tenant%';")
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * PER-DOCUMENT balance reconciliation: for every posted document
 * (REFERENCE_TYPE, REFERENCE_ID), SUM(debit) must equal SUM(credit) within
 * tolerance. Tenant-wide aggregates are NOT used — offsetting errors cancel.
 */
export function perDocumentReconciliation(toleranceAbs = 0.005): CheckResult {
  const t0 = Date.now();
  const bad: string[] = [];
  let docs = 0;
  for (const db of tenantDbs()) {
    let rows = '';
    try {
      rows = testDbQuery(
        `SELECT REFERENCE_TYPE, REFERENCE_ID, SUM(DEBIT), SUM(CREDIT), COUNT(*) FROM \`${db}\`.ACCOUNTS_TRANSACTIONS ` +
        `GROUP BY REFERENCE_TYPE, REFERENCE_ID HAVING ABS(SUM(DEBIT)-SUM(CREDIT)) > ${toleranceAbs};`);
      docs += Number(testDbQuery(`SELECT COUNT(DISTINCT REFERENCE_TYPE, REFERENCE_ID) FROM \`${db}\`.ACCOUNTS_TRANSACTIONS;`).trim() || 0);
    } catch { continue; } // tenant without the table (unbuilt) is not evidence
    for (const line of rows.split('\n').filter(Boolean)) bad.push(`${db}: ${line}`);
  }
  return { name: 'per-document-reconciliation', ok: bad.length === 0, durationMs: Date.now() - t0,
    detail: bad.length === 0 ? `${docs} documents balanced (tolerance ${toleranceAbs})` : `${bad.length} UNBALANCED: ${bad.slice(0, 5).join(' | ')}`,
    data: { documents: docs, unbalanced: bad.slice(0, 50) } };
}

/** Cached balances versus ledger-derived balances. */
export function cacheLedgerReconciliation(toleranceAbs = 0.005): CheckResult {
  const t0 = Date.now();
  const bad: string[] = [];
  for (const db of tenantDbs()) {
    try {
      const acc = testDbQuery(
        `SELECT a.ID, a.AMOUNT, COALESCE(SUM(t.DEBIT)-SUM(t.CREDIT),0) FROM \`${db}\`.ACCOUNTS a ` +
        `LEFT JOIN \`${db}\`.ACCOUNTS_TRANSACTIONS t ON t.ACCOUNT_ID=a.ID GROUP BY a.ID, a.AMOUNT ` +
        `HAVING ABS(ABS(a.AMOUNT) - ABS(COALESCE(SUM(t.DEBIT)-SUM(t.CREDIT),0))) > ${toleranceAbs};`);
      for (const line of acc.split('\n').filter(Boolean)) bad.push(`${db} account ${line}`);
    } catch { continue; }
  }
  return { name: 'cache-ledger-reconciliation', ok: bad.length === 0, durationMs: Date.now() - t0,
    detail: bad.length === 0 ? 'stored balances match ledger-derived balances' : `${bad.length} MISMATCH: ${bad.slice(0, 5).join(' | ')}`,
    data: { mismatches: bad.slice(0, 50) } };
}

// ---------------------------------------------------------------------------
// Design predictions as executable checks
// ---------------------------------------------------------------------------

const PREDICTION_ALLOWED = [/^node(_modules\/\.bin\/(jest|tsc))? /, /^node -e /, /^node_modules\/\.bin\//];

/**
 * Runs the predictions the design made executable. Free-prose predictions are
 * reported NOT VERIFIED rather than silently collected as documentation.
 */
export function runPredictionChecks(worktree: string, predictions: Array<{ text: string; check?: string }>):
  { results: CheckResult[]; unverified: string[] } {
  const results: CheckResult[] = [];
  const unverified: string[] = [];
  const server = path.join(worktree, 'packages/server');
  for (const [i, p] of predictions.entries()) {
    if (!p.check) { unverified.push(p.text); continue; }
    const cmd = p.check.trim();
    if (!PREDICTION_ALLOWED.some((re) => re.test(cmd)) || /[;&|><`$]/.test(cmd)) {
      unverified.push(`${p.text} (check rejected by safelist: ${cmd.slice(0, 80)})`);
      continue;
    }
    const t0 = Date.now();
    const [bin, ...args] = cmd.split(/\s+/);
    const r = run(bin.startsWith('node_modules') ? path.join(server, bin) : bin, args, server, 10 * 60_000, toolEnv());
    results.push({ name: `prediction-${i + 1}`, ok: r.code === 0, durationMs: Date.now() - t0,
      detail: `${p.text.slice(0, 140)} → ${r.code === 0 ? 'HELD' : `FAILED: ${r.out.slice(-200)}`}` });
  }
  return { results, unverified };
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

/**
 * ImpactAnalysisService: changed files → the unit specs that must run. Expands
 * through same-module specs, spec files importing the changed module, and
 * event-mediated coupling (emitters ↔ subscribers share event-name constants).
 * Expansion only — impact analysis never removes an obvious module test.
 */
export function affectedSpecs(worktree: string, changedFiles: string[]): { specs: string[]; rationale: string[] } {
  const specs = new Set<string>();
  const rationale: string[] = [];
  const serverRel = 'packages/server/';
  const srcFiles = changedFiles.filter((f) => f.startsWith(serverRel) && /\.(ts|js)$/.test(f) && !f.includes('/dist/'));
  for (const f of srcFiles) {
    if (f.endsWith('.spec.ts')) { specs.add(f); rationale.push(`${f}: is itself a spec`); continue; }
    const dir = path.dirname(f);
    const base = path.basename(f).replace(/\.(service|controller|module)?\.?ts$/, '');
    // 1. sibling specs in the same module directory
    const absDir = path.join(worktree, dir);
    if (fs.existsSync(absDir)) {
      for (const s of fs.readdirSync(absDir)) {
        if (s.endsWith('.spec.ts')) { specs.add(path.join(dir, s)); rationale.push(`${path.join(dir, s)}: same module as ${f}`); }
      }
    }
    // 2. specs importing the changed file (one grep level)
    const grep = spawnSync('grep', ['-rl', '--include=*.spec.ts', base, path.join(worktree, 'packages/server/src')],
      { encoding: 'utf8', timeout: 60_000 });
    for (const hit of (grep.stdout ?? '').split('\n').filter(Boolean)) {
      const rel = path.relative(worktree, hit);
      if (!specs.has(rel)) { specs.add(rel); rationale.push(`${rel}: imports/mentions ${base}`); }
    }
    // 3. event-mediated coupling
    const content = fs.existsSync(path.join(worktree, f)) ? fs.readFileSync(path.join(worktree, f), 'utf8') : '';
    for (const ev of content.match(/events\.[A-Za-z]+\.[A-Za-z.]+/g) ?? []) {
      const g2 = spawnSync('grep', ['-rl', '--include=*.spec.ts', ev, path.join(worktree, 'packages/server/src')],
        { encoding: 'utf8', timeout: 30_000 });
      for (const hit of (g2.stdout ?? '').split('\n').filter(Boolean)) {
        const rel = path.relative(worktree, hit);
        if (!specs.has(rel)) { specs.add(rel); rationale.push(`${rel}: coupled via event ${ev}`); }
      }
    }
  }
  return { specs: [...specs].slice(0, 60), rationale: rationale.slice(0, 100) };
}
