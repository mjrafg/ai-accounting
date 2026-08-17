/**
 * Deterministic test gate.
 *
 * Wraps the suites that already exist -- it does not replace Stage -1. Output
 * is parsed structurally (counts, comparator classifications) because an exit
 * code alone cannot distinguish "everything passed" from "the tests are gone".
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TestOutcome } from './types';
import { AI_ROOT, sha256 } from './storage/event-store';

export interface CommandSpec {
  name: string;
  /** Executable + args, run without a shell so nothing can be injected. */
  argv: string[];
  cwd: string;
  timeoutMs?: number;
}

/**
 * Suites run natively on this host. Linux is the execution source of truth: the
 * filesystem is case-sensitive (the EE/ee collision that forced a container
 * workaround on macOS does not exist here), and node is installed for the
 * service user, so there is no container hop between the orchestrator and the
 * tests it is judging.
 *
 * A login shell is used so nvm's node/pnpm are on PATH under systemd too.
 */
export const SERVER_DIR =
  process.env.AI_SERVER_DIR ?? '/srv/ai-accounting/repo/packages/server';

export function serverCmd(name: string, shellCommand: string): CommandSpec {
  return {
    name,
    argv: ['bash', '-lc', `cd ${SERVER_DIR} && ${shellCommand}`],
    cwd: SERVER_DIR,
    timeoutMs: 60 * 60 * 1000,
  };
}

export const SUITES = {
  typecheck: () => serverCmd('typecheck', 'npx tsc --noEmit -p tsconfig.build.json'),
  stage0: () => serverCmd('stage0', 'pnpm test:stage0'),
  baseline: () => serverCmd('stage-minus-1-baseline', 'node test/e2e-runner.mjs'),
};

const JEST_COUNTS = /Tests:\s+(.+)/;
const COMPARATOR = {
  regressions: /regressions\s*:\s*(\d+)/,
  reviewRequired: /review required\s*:\s*(\d+)/,
  improvements: /improvements\s*:\s*(\d+)/,
  newTests: /new tests\s*:\s*(\d+)/,
  clean: /\((\d+) clean \/ (\d+) dirty bootstraps\)/,
};

function parseJestCounts(stdout: string): { passed: number; failed: number; skipped: number; total: number } {
  const m = JEST_COUNTS.exec(stdout);
  if (!m) return { passed: 0, failed: 0, skipped: 0, total: 0 };
  const line = m[1];
  const grab = (label: string) => {
    const r = new RegExp(`(\\d+)\\s+${label}`).exec(line);
    return r ? parseInt(r[1], 10) : 0;
  };
  return {
    passed: grab('passed'),
    failed: grab('failed'),
    skipped: grab('skipped'),
    total: grab('total'),
  };
}

function parseComparator(stdout: string): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  let any = false;
  for (const [key, re] of Object.entries(COMPARATOR)) {
    if (key === 'clean') continue;
    const m = (re as RegExp).exec(stdout);
    if (m) {
      out[key] = parseInt(m[1], 10);
      any = true;
    }
  }
  const c = COMPARATOR.clean.exec(stdout);
  if (c) {
    out.clean = parseInt(c[1], 10);
    out.dirty = parseInt(c[2], 10);
    any = true;
  }
  // `totals: N passed, M failed` from the canonical runner.
  const t = /totals:\s*(\d+) passed,\s*(\d+) failed,\s*(\d+) skipped/.exec(stdout);
  if (t) {
    out.passed = parseInt(t[1], 10);
    out.failed = parseInt(t[2], 10);
    out.skipped = parseInt(t[3], 10);
    any = true;
  }
  return any ? out : undefined;
}

export class TestRunner {
  constructor(private readonly taskId: string) {}

  run(spec: CommandSpec): TestOutcome {
    const started = Date.now();
    const res = spawnSync(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      encoding: 'utf8',
      timeout: spec.timeoutMs ?? 30 * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const stdout = (res.stdout ?? '') + (res.stderr ?? '');
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');

    const dir = path.join(AI_ROOT, 'runs', this.taskId, 'raw');
    fs.mkdirSync(dir, { recursive: true });
    const rawPath = path.join(dir, `test-${spec.name}-${started}.log`);
    fs.writeFileSync(rawPath, clean, 'utf8');

    const counts = parseJestCounts(clean);
    const classifications = parseComparator(clean);

    // The canonical runner reports its own totals; prefer them when present.
    const passed = classifications?.passed ?? counts.passed;
    const failed = classifications?.failed ?? counts.failed;
    const skipped = classifications?.skipped ?? counts.skipped;
    const total = counts.total || passed + failed + skipped;

    // The baseline comparator exits non-zero when individual specs fail while
    // still matching the recorded baseline, so its acceptance is classification
    // based rather than exit-code based.
    const isComparator = spec.name === 'stage-minus-1-baseline';
    const comparatorOk =
      isComparator &&
      classifications !== undefined &&
      (classifications.regressions ?? 1) === 0 &&
      (classifications.reviewRequired ?? 1) === 0 &&
      (classifications.dirty ?? 1) === 0;

    return {
      name: spec.name,
      command: spec.argv.join(' '),
      exitCode: res.status,
      passed,
      failed,
      skipped,
      total,
      classifications,
      stdoutHash: sha256(clean),
      rawPath,
      ok: isComparator ? comparatorOk : res.status === 0,
    };
  }
}
