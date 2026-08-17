#!/usr/bin/env node
/**
 * Stage -1 ISOLATED DETERMINISTIC E2E RUNNER.
 *
 * One Jest process per spec, sequential, deterministic canonical output.
 *
 * Usage:
 *   node test/e2e-runner.mjs                       run + compare against baseline
 *   node test/e2e-runner.mjs --write-baseline      run + (over)write the baseline
 *   node test/e2e-runner.mjs --out <file>          canonical output path
 *   node test/e2e-runner.mjs --only a.e2e-spec.ts  restrict to given basenames (diagnostic)
 *   node test/e2e-runner.mjs --no-provision        reuse the existing tenant (diagnostic)
 *
 * Exit codes (only these three):
 *   0  run completed reliably and matches the baseline (improvements allowed)
 *   1  test-result drift: regression / review-required / missing test
 *   2  harness or infrastructure failure; results are NOT trustworthy and no
 *      baseline comparison is attempted
 *
 * WHY ONE PROCESS PER SPEC
 * ------------------------
 * `EventEmitterModule.forRoot()` builds its EventEmitter2 with `useValue`, i.e.
 * a single instance captured at module-definition time. Every Nest app built
 * from the same required AppModule therefore SHARES it, and listeners
 * accumulate linearly (measured: 500 / 1000 / 1500 / 2000 / 2500 for 1..5 apps
 * in one process). Running all specs in one process also exhausts the heap.
 * Process isolation avoids both without redesigning the suite.
 *
 * WHY --forceExit IS USED
 * -----------------------
 * `app.close()` does not release BullMQ/Redis connections: measured 28 live
 * sockets to Redis after close (the 34 I18n FSWatchers are released correctly).
 * Without --forceExit, Jest hangs after the tests pass ("Jest did not exit one
 * second after the test run has completed"). This is a genuine lifecycle leak
 * and it is NOT fixed here -- it is out of Stage -1 scope. Using --forceExit is
 * safe ONLY because every spec runs in its own short-lived process, so the
 * leaked handles are reclaimed by the OS at process exit and cannot accumulate
 * across specs. If the suite ever moves to a shared app, this reasoning is void.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  TEST_DIR,
  SERVER_DIR,
  loadEnv,
  dbConfig,
  redisConfig,
} from './e2e-env.mjs';
import { resetAndProvision } from './e2e-reset-tenant.mjs';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');
const knex = require('knex');

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_HARNESS = 2;

const PER_SPEC_TIMEOUT_MS = parseInt(
  process.env.E2E_SPEC_TIMEOUT_MS || '300000',
  10,
);
const BASELINE_PATH = path.join(TEST_DIR, 'e2e-baseline.json');

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, dflt) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const WRITE_BASELINE = hasFlag('--write-baseline');
const NO_PROVISION = hasFlag('--no-provision');
const OUT_PATH = path.resolve(
  flagValue('--out', path.join(TEST_DIR, 'e2e-results.json')),
);
const ONLY = (() => {
  const i = argv.indexOf('--only');
  if (i === -1) return null;
  return argv.slice(i + 1).filter((a) => !a.startsWith('--'));
})();

const log = (m) => console.log(m);
const fail = (m) => {
  console.error(`\nHARNESS FAILURE: ${m}`);
  process.exit(EXIT_HARNESS);
};

// ---------------------------------------------------------------------------
// Redis helpers: TARGETED cleanup only. FLUSHDB/FLUSHALL are never used.
// ---------------------------------------------------------------------------

/**
 * Key namespaces this harness is allowed to delete between specs.
 *
 * Justification (measured): a full Redis key scan of a live E2E environment
 * contains ONLY `bull:*` keys. Tenant, user, auth and organization state all
 * live in MariaDB, not Redis. Throttler counters (`{...}:hits`) are explicitly
 * NOT matched here, so rate-limit state is preserved.
 *
 * `inventory-cost-compute-debounce:*` is written by
 * InventoryComputeCostService.scheduleComputeItemCost() with a 10s PX and gates
 * whether a new cost job is queued; a stale one can suppress a later spec's job.
 */
const CLEANUP_PATTERNS = ['bull:*', 'inventory-cost-compute-debounce:*'];

async function redisClient() {
  const cfg = redisConfig();
  return new Redis({
    host: cfg.host,
    port: cfg.port,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
}

async function scanDelete(client, pattern) {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length) deleted += await client.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

async function cleanupQueueState(client) {
  let total = 0;
  for (const pattern of CLEANUP_PATTERNS)
    total += await scanDelete(client, pattern);
  return total;
}

/**
 * Detect a competing BullMQ worker. Measured signal: an attached worker parks
 * connections in a blocking `bzpopmin` read (13 such clients with one server
 * running, 0 with none). Any such client means jobs this run enqueues could be
 * consumed elsewhere, so results would not be trustworthy.
 */
async function detectCrossTalk(client) {
  const list = await client.client('LIST');
  const blocking = String(list)
    .split('\n')
    .filter((l) => /cmd=(bzpopmin|blmpop|brpoplpush|blpop|bzpopmax)/.test(l));
  return blocking.length;
}

// ---------------------------------------------------------------------------
// Discovery: exact filesystem enumeration, deterministic order.
// ---------------------------------------------------------------------------
function discoverSpecs() {
  const files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.e2e-spec.ts'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const unique = [...new Set(files)];
  if (unique.length !== files.length)
    fail('duplicate spec filenames discovered');
  return ONLY ? unique.filter((f) => ONLY.includes(f)) : unique;
}

/** Escape a literal absolute path for use as an anchored Jest testRegex. */
function anchoredPathRegex(absPath) {
  return `^${absPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

// ---------------------------------------------------------------------------
// Spec execution
// ---------------------------------------------------------------------------
function runSpec(basename) {
  const absPath = path.join(TEST_DIR, basename);
  const jsonOut = path.join(
    os.tmpdir(),
    `e2e-json-${basename.replace(/[^a-zA-Z0-9]/g, '_')}.json`,
  );
  if (fs.existsSync(jsonOut)) fs.unlinkSync(jsonOut);

  const res = spawnSync(
    'npx',
    [
      'jest',
      '--config',
      './test/jest-e2e.json',
      '--testRegex',
      anchoredPathRegex(absPath),
      '--forceExit',
      '--json',
      `--outputFile=${jsonOut}`,
    ],
    {
      cwd: SERVER_DIR,
      encoding: 'utf8',
      timeout: PER_SPEC_TIMEOUT_MS,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=2048',
        CI: 'true',
      },
    },
  );

  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const exitCode = timedOut
    ? 124
    : typeof res.status === 'number'
      ? res.status
      : 1;
  const stderr = String(res.stderr || '');

  let report = null;
  if (fs.existsSync(jsonOut)) {
    try {
      report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    } catch {
      report = null;
    }
    fs.unlinkSync(jsonOut);
  }

  return { report, exitCode, timedOut, stderr };
}

/** Classify one spec's outcome into the canonical shape. */
function canonicaliseSpec(basename, { report, exitCode, timedOut, stderr }) {
  const specPath = `test/${basename}`;
  const sortStrings = (a) =>
    [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

  if (timedOut) {
    return {
      bootstrap: 'FAILED',
      bootstrapErrorClass: 'SPEC_TIMEOUT',
      exitCode,
      passed: [],
      failed: [
        {
          name: `<entire spec: ${specPath}>`,
          classification: 'TIMEOUT',
          evidence: `exceeded ${PER_SPEC_TIMEOUT_MS}ms`,
        },
      ],
      skipped: [],
    };
  }

  if (
    !report ||
    !Array.isArray(report.testResults) ||
    report.testResults.length === 0
  ) {
    return {
      bootstrap: 'FAILED',
      bootstrapErrorClass: classifyBootstrapError(stderr),
      exitCode,
      passed: [],
      failed: [
        {
          name: `<entire spec: ${specPath}>`,
          classification: 'UNKNOWN',
          evidence: 'no jest json report produced',
        },
      ],
      skipped: [],
    };
  }

  const suite = report.testResults[0];
  const assertions = suite.assertionResults || [];

  // A suite-level message with no failing assertions means the suite itself
  // failed to run (bootstrap). Jest still reports any assertions it managed.
  const suiteMessage = String(suite.message || '');
  const bootstrapFailed =
    suiteMessage.trim().length > 0 && (report.numFailedTests || 0) === 0
      ? true
      : /Test suite failed to run/.test(suiteMessage);

  const passed = sortStrings(
    assertions.filter((a) => a.status === 'passed').map((a) => a.fullName),
  );
  const skipped = sortStrings(
    assertions
      .filter(
        (a) =>
          a.status === 'pending' ||
          a.status === 'skipped' ||
          a.status === 'todo',
      )
      .map((a) => a.fullName),
  );
  const failedNames = sortStrings(
    assertions.filter((a) => a.status === 'failed').map((a) => a.fullName),
  );

  const bootstrap = bootstrapFailed ? 'FAILED' : 'CLEAN';
  const bootstrapErrorClass = bootstrapFailed
    ? classifyBootstrapError(suiteMessage)
    : null;

  const failed = failedNames.map((name) => ({
    name,
    // CRITICAL RULE: never ASSERTION while the bootstrap is dirty.
    classification:
      bootstrap === 'CLEAN' ? classifyFailure(suite, name) : 'BOOTSTRAP',
    evidence:
      bootstrap === 'CLEAN'
        ? 'failed after a CLEAN bootstrap'
        : 'bootstrap did not complete; result is not trustworthy',
  }));

  if (bootstrapFailed && failed.length === 0) {
    failed.push({
      name: `<entire spec: ${specPath}>`,
      classification: 'BOOTSTRAP',
      evidence: bootstrapErrorClass || 'suite failed to run',
    });
  }

  return { bootstrap, bootstrapErrorClass, exitCode, passed, failed, skipped };
}

function classifyBootstrapError(message) {
  if (/ERR_INVALID_ARG_TYPE|emitWarning|MaxListenersExceeded/.test(message))
    return 'EVENT_SUBSCRIBER_REGISTRATION_TYPEERROR';
  if (/ECONNREFUSED|ER_ACCESS_DENIED|ENOTFOUND|getaddrinfo/.test(message))
    return 'INFRASTRUCTURE_UNREACHABLE';
  if (/heap out of memory|Allocation failed/.test(message))
    return 'OUT_OF_MEMORY';
  if (/Exceeded timeout|Timeout - Async/.test(message)) return 'TIMEOUT';
  if (!message || !message.trim()) return 'UNKNOWN';
  return 'UNCLASSIFIED_BOOTSTRAP_ERROR';
}

/** Conservative per-test classification. UNKNOWN is preferred over guessing. */
function classifyFailure(suite, testName) {
  const detail = (suite.assertionResults || [])
    .filter((a) => a.fullName === testName)
    .flatMap((a) => a.failureMessages || [])
    .join('\n');
  if (
    /ECONNREFUSED|ENOTFOUND|S3|Stripe|Plaid|SMTP|getaddrinfo|socket hang up/i.test(
      detail,
    )
  )
    return 'INFRASTRUCTURE';
  if (/Exceeded timeout|Timeout - Async callback/i.test(detail))
    return 'TIMEOUT';

  // supertest status assertion, e.g. `expected 200 "OK", got 404 "Not Found"`.
  const status = detail.match(/expected\s+\d{3}\s+"[^"]*",\s*got\s+(\d{3})\s/);
  if (status) {
    // A 4xx is the application deliberately rejecting the request: that is a
    // genuine assertion failure. A 5xx is an unhandled server error whose cause
    // (application bug vs missing external dependency) is not attributable from
    // the test output alone, so it stays UNKNOWN rather than being guessed.
    return status[1].startsWith('4') ? 'ASSERTION' : 'UNKNOWN';
  }

  if (/expect\(|Expected|toEqual|toBe\b|toMatchObject/.test(detail))
    return 'ASSERTION';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Bootstrap-integrity preflight (runs inside Jest, where truncation reproduces)
// ---------------------------------------------------------------------------
function runBootstrapPreflight() {
  const absPath = path.join(TEST_DIR, 'bootstrap-integrity.preflight.ts');
  if (!fs.existsSync(absPath))
    fail('bootstrap-integrity.preflight.ts is missing');
  const res = spawnSync(
    'npx',
    [
      'jest',
      '--config',
      './test/jest-e2e.json',
      '--testRegex',
      anchoredPathRegex(absPath),
      '--forceExit',
    ],
    {
      cwd: SERVER_DIR,
      encoding: 'utf8',
      timeout: PER_SPEC_TIMEOUT_MS,
      env: { ...process.env, CI: 'true' },
    },
  );
  const out = String(res.stdout || '') + String(res.stderr || '');
  const m = out.match(
    /__LISTENER_SIGNATURE_BEGIN__([\s\S]*?)__LISTENER_SIGNATURE_END__/,
  );
  if (res.status !== 0) {
    console.error(out.slice(-3000));
    fail(
      'bootstrap-integrity preflight failed; the application does not initialise completely',
    );
  }
  if (!m) fail('bootstrap-integrity preflight produced no listener signature');
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------
function compareToBaseline(baseline, current) {
  const regressions = [];
  const reviewRequired = [];
  const improvements = [];
  const newTests = [];

  const specs = [
    ...new Set([...Object.keys(baseline.specs), ...Object.keys(current.specs)]),
  ].sort();
  for (const spec of specs) {
    const b = baseline.specs[spec];
    const c = current.specs[spec];
    if (!b) {
      reviewRequired.push(`${spec}: spec file is new (not in baseline)`);
      continue;
    }
    if (!c) {
      regressions.push(`${spec}: spec file missing from this run`);
      continue;
    }

    if (b.bootstrap === 'CLEAN' && c.bootstrap !== 'CLEAN') {
      regressions.push(`${spec}: bootstrap CLEAN -> ${c.bootstrap}`);
    }

    const bClass = new Map(
      (b.failed || []).map((f) => [f.name, f.classification]),
    );
    const cClass = new Map(
      (c.failed || []).map((f) => [f.name, f.classification]),
    );
    const bPass = new Set(b.passed || []);
    const cPass = new Set(c.passed || []);
    const bAll = new Set([...bPass, ...bClass.keys(), ...(b.skipped || [])]);
    const cAll = new Set([...cPass, ...cClass.keys(), ...(c.skipped || [])]);

    for (const name of [...bAll].sort()) {
      if (!cAll.has(name)) {
        regressions.push(
          `${spec} :: ${name}: present in baseline, missing in run`,
        );
        continue;
      }
      if (bPass.has(name) && cClass.has(name)) {
        regressions.push(`${spec} :: ${name}: passed -> failed`);
        continue;
      }
      if (bClass.has(name) && cPass.has(name)) {
        improvements.push(`${spec} :: ${name}: failed -> passed`);
        continue;
      }
      if (bClass.has(name) && cClass.has(name)) {
        const from = bClass.get(name);
        const to = cClass.get(name);
        if (from === to) continue;
        if (to === 'BOOTSTRAP')
          regressions.push(
            `${spec} :: ${name}: ${from} -> BOOTSTRAP (trustworthiness lost)`,
          );
        else
          reviewRequired.push(
            `${spec} :: ${name}: classification ${from} -> ${to}`,
          );
      }
    }
    for (const name of [...cAll].sort())
      if (!bAll.has(name)) newTests.push(`${spec} :: ${name}`);
  }

  // Listener-signature drift is REVIEW_REQUIRED, never a hard harness failure.
  const bSig = baseline.listenerSignature || {};
  const cSig = current.listenerSignature || {};
  if (
    JSON.stringify(bSig.perEvent || {}) !== JSON.stringify(cSig.perEvent || {})
  ) {
    reviewRequired.push(
      `listener signature changed: ${bSig.uniqueEventNames}/${bSig.totalListenerRegistrations} -> ` +
        `${cSig.uniqueEventNames}/${cSig.totalListenerRegistrations} (REVIEW_REQUIRED)`,
    );
  }

  return { regressions, reviewRequired, improvements, newTests };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  loadEnv();
  const cfg = dbConfig();
  const rcfg = redisConfig();

  log('Stage -1 isolated E2E runner');
  log(`  server dir : ${SERVER_DIR}`);
  log(`  database   : ${cfg.host}:${cfg.port}/${cfg.systemDb}`);
  log(`  redis      : ${rcfg.host}:${rcfg.port}`);

  // --- infrastructure preflight -------------------------------------------
  let redis;
  try {
    redis = await redisClient();
    await redis.connect();
    await redis.ping();
  } catch (e) {
    fail(`Redis unreachable at ${rcfg.host}:${rcfg.port}: ${e.message}`);
  }

  const sysDb = knex({
    client: 'mysql',
    connection: {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.systemDb,
      charset: 'utf8',
    },
    pool: { min: 0, max: 2 },
  });
  let mariadbVersion = 'unknown';
  try {
    const [v] = await sysDb.raw('SELECT VERSION() AS v');
    mariadbVersion = String(v[0].v);
  } catch (e) {
    fail(`MariaDB unreachable at ${cfg.host}:${cfg.port}: ${e.message}`);
  } finally {
    await sysDb.destroy();
  }

  let redisVersion = 'unknown';
  try {
    const info = await redis.info('server');
    const m = String(info).match(/redis_version:([^\r\n]+)/);
    if (m) redisVersion = m[1].trim();
  } catch {
    /* non-fatal: ping already succeeded */
  }

  // --- cross-talk detection ------------------------------------------------
  const blocking = await detectCrossTalk(redis);
  if (blocking > 0) {
    await redis.quit();
    fail(
      `${blocking} competing BullMQ worker connection(s) are attached to Redis ` +
        `(blocking reads detected). Another server/worker would consume this run's jobs ` +
        `and the results would not be trustworthy. Stop it and re-run.`,
    );
  }
  log('  cross-talk : none detected (0 blocking queue consumers)');

  // --- clean queue state before starting -----------------------------------
  const preCleaned = await cleanupQueueState(redis);
  log(`  redis pre-clean: removed ${preCleaned} stale queue/debounce key(s)`);

  // --- database lifecycle ---------------------------------------------------
  if (NO_PROVISION) {
    log('  tenant     : reusing existing (--no-provision)');
  } else {
    log('  tenant     : fresh tenant per run');
    try {
      await resetAndProvision((m) => log(m));
    } catch (e) {
      await redis.quit();
      fail(`tenant provisioning failed: ${e.message}`);
    }
    // Provisioning briefly ran a server; make sure it left no consumer behind.
    const after = await detectCrossTalk(redis);
    if (after > 0) {
      await redis.quit();
      fail(
        `${after} queue consumer(s) still attached after provisioning shut down`,
      );
    }
    await cleanupQueueState(redis);
  }

  // --- bootstrap integrity --------------------------------------------------
  log('  running bootstrap-integrity preflight ...');
  const listenerSignature = runBootstrapPreflight();
  log(
    `  bootstrap  : OK (${listenerSignature.uniqueEventNames} events / ${listenerSignature.totalListenerRegistrations} listeners)`,
  );
  await cleanupQueueState(redis);

  // --- run specs ------------------------------------------------------------
  const specs = discoverSpecs();
  log(`  discovered ${specs.length} spec file(s)\n`);

  const results = {};
  let idx = 0;
  for (const basename of specs) {
    idx += 1;
    process.stdout.write(
      `  [${String(idx).padStart(2)}/${specs.length}] ${basename} ... `,
    );
    const raw = runSpec(basename);
    const canon = canonicaliseSpec(basename, raw);
    results[`test/${basename}`] = canon;
    const removed = await cleanupQueueState(redis);
    console.log(
      `${canon.bootstrap}  pass=${canon.passed.length} fail=${canon.failed.length} skip=${canon.skipped.length}` +
        `  exit=${canon.exitCode} (redis keys purged: ${removed})`,
    );
  }
  await redis.quit();

  // --- canonical artifact ---------------------------------------------------
  const sortedSpecs = {};
  for (const key of Object.keys(results).sort())
    sortedSpecs[key] = results[key];

  const totals = Object.values(sortedSpecs).reduce(
    (acc, s) => ({
      passed: acc.passed + s.passed.length,
      failed: acc.failed + s.failed.length,
      skipped: acc.skipped + s.skipped.length,
      bootstrapClean: acc.bootstrapClean + (s.bootstrap === 'CLEAN' ? 1 : 0),
      bootstrapFailed: acc.bootstrapFailed + (s.bootstrap === 'CLEAN' ? 0 : 1),
    }),
    { passed: 0, failed: 0, skipped: 0, bootstrapClean: 0, bootstrapFailed: 0 },
  );

  const canonical = {
    schemaVersion: 1,
    provenance: {
      ...readProvenance(),
      mariadb: mariadbVersion,
      redis: redisVersion,
    },
    executionOrder: specs.map((s) => `test/${s}`),
    listenerSignature,
    totals: { specFiles: specs.length, ...totals },
    specs: sortedSpecs,
  };

  const json = JSON.stringify(canonical, null, 2) + '\n';
  fs.writeFileSync(OUT_PATH, json);
  log(`\n  canonical output -> ${OUT_PATH}`);
  log(
    `  totals: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped ` +
      `(${totals.bootstrapClean} clean / ${totals.bootstrapFailed} dirty bootstraps)`,
  );

  if (WRITE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, json);
    log(`  baseline written -> ${BASELINE_PATH}`);
    return EXIT_OK;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(
      '\nNo baseline present. Run with --write-baseline to record one.',
    );
    return EXIT_DRIFT;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const cmp = compareToBaseline(baseline, canonical);

  log('\n  --- baseline comparison ---');
  log(`  regressions      : ${cmp.regressions.length}`);
  log(`  review required  : ${cmp.reviewRequired.length}`);
  log(`  improvements     : ${cmp.improvements.length}`);
  log(`  new tests        : ${cmp.newTests.length}`);
  for (const r of cmp.regressions) console.log(`    REGRESSION      ${r}`);
  for (const r of cmp.reviewRequired) console.log(`    REVIEW_REQUIRED ${r}`);
  for (const r of cmp.improvements) console.log(`    improvement     ${r}`);
  for (const r of cmp.newTests) console.log(`    new             ${r}`);

  // Improvements never offset regressions.
  return cmp.regressions.length === 0 && cmp.reviewRequired.length === 0
    ? EXIT_OK
    : EXIT_DRIFT;
}

function readProvenance() {
  const pkg = (p) => {
    try {
      return require(p).version;
    } catch {
      return 'unknown';
    }
  };
  // eventemitter2 is a transitive dependency of @nestjs/event-emitter, so under
  // pnpm it is not resolvable from the test directory. Resolve it relative to
  // its parent package instead -- its exact version is load-bearing for the
  // emitWarning shim, so it belongs in the baseline provenance.
  const nestedPkg = (parent, child) => {
    try {
      const parentRequire = createRequire(
        require.resolve(`${parent}/package.json`),
      );
      return parentRequire(`${child}/package.json`).version;
    } catch {
      return 'unknown';
    }
  };
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
  });
  return {
    commit: git.status === 0 ? git.stdout.trim() : 'unknown',
    node: process.version.replace(/^v/, ''),
    jest: pkg('jest/package.json'),
    nestCore: pkg('@nestjs/core/package.json'),
    knex: pkg('knex/package.json'),
    objection: pkg('objection/package.json'),
    mysqlDriver: pkg('mysql/package.json'),
    eventemitter2: nestedPkg('@nestjs/event-emitter', 'eventemitter2'),
    executionMode: 'one-process-per-spec-sequential',
    dbPolicy: 'fresh-tenant-per-run-shared-across-specs',
  };
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\nHARNESS FAILURE: ${e.stack || e.message}`);
    process.exit(EXIT_HARNESS);
  });
