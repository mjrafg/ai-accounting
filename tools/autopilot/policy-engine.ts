/**
 * Hard policy engine.
 *
 * These checks are deliberately enforced here rather than asked of the agents:
 * an agent that is wrong about scope, or that has been talked into deleting a
 * test, must still be stopped. Every violation is a hard stop (ESCALATED), not
 * a warning, and none of them can be waived by anything an agent returns.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Risk, TestOutcome } from './types';

export interface PolicyViolation {
  rule: string;
  detail: string;
}

export interface PolicyConfig {
  maxReviewRounds: number;
  autoMergeRisk: Risk[];
  protectedPaths: string[];
  forbiddenPathPatterns: string[];
  forbiddenCommandPatterns: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  maxReviewRounds: 3,
  // Empty on purpose: V1 never auto-merges anything.
  autoMergeRisk: [],
  protectedPaths: [
    'packages/server/src/database/migrations',
    'packages/server/test/e2e-baseline.json',
    '.github',
    '.gitignore',
    'package.json',
    'pnpm-lock.yaml',
  ],
  forbiddenPathPatterns: [
    '(^|/)\\.github/',
    '(^|/)\\.gitignore$',
    '(^|/)pnpm-lock\\.yaml$',
    '(^|/)package-lock\\.json$',
    '(^|/)migrations?/',
    '(^|/)Dockerfile',
    '(^|/)docker-compose',
  ],
  forbiddenCommandPatterns: [
    '--no-verify',
    'git\\s+push',
    'git\\s+rebase',
    'git\\s+reset\\s+--hard',
    'force-push',
    '--write-baseline',
    'FLUSHDB',
    'FLUSHALL',
  ],
};

export function loadPolicy(root: string): PolicyConfig {
  const p = path.join(root, '.ai', 'policies', 'default.json');
  if (!fs.existsSync(p)) return DEFAULT_POLICY;
  return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
}

export class PolicyEngine {
  constructor(private readonly policy: PolicyConfig) {}

  get maxReviewRounds(): number {
    return this.policy.maxReviewRounds;
  }

  /** V1 answer is always false for HIGH; kept explicit so the rule is testable. */
  autoMergeAllowed(risk: Risk): boolean {
    return this.policy.autoMergeRisk.includes(risk) && risk !== 'high';
  }

  /** Changed files must all be inside the finalized design allowlist. */
  checkScope(changedFiles: string[], allowlist: string[]): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    if (allowlist.length === 0 && changedFiles.length > 0) {
      out.push({
        rule: 'SCOPE_ALLOWLIST_EMPTY',
        detail: `${changedFiles.length} file(s) changed with no finalized allowlist`,
      });
      return out;
    }
    for (const f of changedFiles) {
      const allowed = allowlist.some((a) => f === a || f.startsWith(a.replace(/\/*$/, '/')));
      if (!allowed) {
        out.push({ rule: 'OUT_OF_ALLOWLIST', detail: f });
      }
    }
    return out;
  }

  /** Structurally protected paths, independent of what the design allowed. */
  checkProtectedPaths(changedFiles: string[]): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    for (const f of changedFiles) {
      for (const pat of this.policy.forbiddenPathPatterns) {
        if (new RegExp(pat).test(f)) {
          out.push({ rule: 'PROTECTED_PATH', detail: `${f} matches /${pat}/` });
        }
      }
    }
    return out;
  }

  checkCommand(command: string): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    for (const pat of this.policy.forbiddenCommandPatterns) {
      if (new RegExp(pat, 'i').test(command)) {
        out.push({ rule: 'FORBIDDEN_COMMAND', detail: `${command} matches /${pat}/` });
      }
    }
    return out;
  }

  /**
   * A green exit code is not acceptance. Tests that vanish, baselines that
   * drift, and required scenarios that quietly start skipping all look like
   * success to CI, so they are checked explicitly against the prior run.
   */
  checkTestOutcome(current: TestOutcome, baseline?: TestOutcome): PolicyViolation[] {
    const out: PolicyViolation[] = [];

    if (baseline) {
      if (current.total < baseline.total) {
        out.push({
          rule: 'TEST_COUNT_REDUCTION',
          detail: `${current.name}: total went ${baseline.total} -> ${current.total}`,
        });
      }
      if (current.passed < baseline.passed) {
        out.push({
          rule: 'PASS_COUNT_REDUCTION',
          detail: `${current.name}: passed went ${baseline.passed} -> ${current.passed}`,
        });
      }
      if (current.skipped > baseline.skipped) {
        out.push({
          rule: 'UNEXPECTED_SKIP',
          detail: `${current.name}: skipped went ${baseline.skipped} -> ${current.skipped}`,
        });
      }
    }

    const cls = current.classifications ?? {};
    for (const key of ['regressions', 'reviewRequired', 'dirty']) {
      const v = cls[key];
      if (typeof v === 'number' && v > 0) {
        out.push({ rule: 'BASELINE_DRIFT', detail: `${current.name}: ${key}=${v}` });
      }
    }
    if (typeof cls.newTests === 'number' && cls.newTests > 0 && current.name === 'stage-minus-1-baseline') {
      // New rows in the canonical comparator mean the baseline no longer
      // describes the suite; that needs a human decision, not an auto-rebaseline.
      out.push({ rule: 'BASELINE_NEW_TESTS', detail: `newTests=${cls.newTests}` });
    }
    if (current.exitCode !== 0 && current.ok) {
      out.push({ rule: 'INCONSISTENT_RESULT', detail: `${current.name}: ok=true but exit=${current.exitCode}` });
    }
    return out;
  }
}
