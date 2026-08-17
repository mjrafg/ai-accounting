/**
 * How an adapter actually reaches a model.
 *
 * Two transports exist:
 *   exec    - spawn a real installed CLI (discovered, never assumed).
 *   fixture - replay a recorded structured response from disk.
 *
 * The fixture transport is a test double for exercising the pipeline, not a
 * provider. Everything it produces is stamped `simulated: true` all the way
 * into the event log and the report, and it refuses to run unless
 * AI_ALLOW_FIXTURES=1 is set explicitly.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentResult, AgentTask } from '../types';
import { AI_ROOT, writeRawArtifact } from '../storage/event-store';
import { extractUsage, parseStructured } from '../parsers/structured-output';

export interface TransportSpec {
  kind: 'exec' | 'fixture';
  /** argv template for exec; {{PROMPT}} is replaced with the rendered prompt. */
  argv?: string[];
  /** Directory of recorded responses for fixture. */
  fixtureDir?: string;
  provider: string;
}

export function fixturesAllowed(): boolean {
  return process.env.AI_ALLOW_FIXTURES === '1';
}

/**
 * Subscription-only billing. The user pays for Claude and ChatGPT already; an
 * API key present in the agent environment would silently bill per token, so
 * adapters strip these rather than inherit them. Removing the variable is safe:
 * both CLIs fall back to their stored subscription credentials.
 */
export const BILLING_MODE = 'SUBSCRIPTION_CLI_ONLY' as const;
const BANNED_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of BANNED_ENV) delete env[k];
  return env;
}

export function bannedKeysPresent(): string[] {
  return BANNED_ENV.filter((k) => (process.env[k] ?? '').length > 0);
}

/**
 * Quota exhaustion looks like an error but must not be treated as one: the
 * correct response is to pause and retry later, never to switch to paid API
 * billing.
 */
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /quota (?:exceeded|exhausted)/i,
  /usage limit/i,
  /too many requests/i,
  /\b429\b/,
  /you(?:'| ha)ve (?:reached|hit) your/i,
  /upgrade to (?:pro|max)/i,
  /resets? at/i,
];

export function looksRateLimited(raw: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(raw));
}

function requiredKeysFor(schemaName: string): string[] {
  switch (schemaName) {
    case 'design':
      return ['scopeAllowlist', 'outOfScope', 'invariants', 'requiredTests'];
    case 'design-review':
      return ['verdict', 'findings'];
    case 'adjudication':
      return ['adjudications'];
    case 'implementation':
      return ['status', 'filesChanged'];
    case 'review':
      return ['findings'];
    default:
      return [];
  }
}

export function runExec(spec: TransportSpec, task: AgentTask): AgentResult {
  const argv = (spec.argv ?? []).map((a) => a.replace('{{PROMPT}}', task.prompt));
  const started = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: task.cwd,
    encoding: 'utf8',
    timeout: task.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    env: subscriptionEnv(),
    // Closed stdin: codex otherwise waits for more input after its turn and the
    // call never returns.
    input: '',
  });
  const raw = (res.stdout ?? '') + (res.stderr ?? '');
  const { rawArtifactPath, rawArtifactHash } = writeRawArtifact(
    task.taskId,
    `${spec.provider}-${task.role}-${started}.raw.txt`,
    raw,
  );
  const parsed = parseStructured(raw, requiredKeysFor(task.schemaName));

  // Quota exhaustion must be detected from the provider's own message, not from
  // the exit code. The Claude CLI reports transport failures inside a
  // well-formed envelope and can still exit 0, so gating on `status !== 0`
  // silently reclassified a real 429 as a parse failure — and a pause is the
  // one outcome that must never be confused with anything else, because the
  // alternative is falling back to paid API billing.
  const rateLimited = looksRateLimited(parsed.providerMessage ?? '') ||
    (res.status !== 0 && looksRateLimited(raw));

  // A timeout or signal kill leaves status null; that is an execution failure
  // whatever the partial output looked like.
  const killed = res.status === null;
  const failureKind = parsed.ok
    ? undefined
    : killed
      ? 'AGENT_EXECUTION_ERROR'
      : parsed.failureKind;

  return {
    ok: res.status === 0 && parsed.ok,
    structured: parsed.value,
    rawArtifactPath,
    rawArtifactHash,
    durationMs: Date.now() - started,
    exitCode: res.status,
    usage: extractUsage(raw),
    error: rateLimited
      ? 'subscription quota or rate limit reached'
      : killed
        ? `agent did not run: process terminated without an exit code${res.error ? ` (${res.error.message})` : ''}`
        : parsed.ok
          ? undefined
          : parsed.error,
    failureKind,
    providerStatus: parsed.providerStatus,
    simulated: false,
    provider: spec.provider,
    rateLimited,
  };
}

export function runFixture(spec: TransportSpec, task: AgentTask): AgentResult {
  const started = Date.now();
  if (!fixturesAllowed()) {
    return {
      ok: false,
      structured: null,
      rawArtifactPath: '',
      rawArtifactHash: '',
      durationMs: 0,
      exitCode: null,
      usage: null,
      error: 'fixture transport requires AI_ALLOW_FIXTURES=1',
      simulated: true,
      provider: spec.provider,
    };
  }
  const dir = spec.fixtureDir ?? path.join(AI_ROOT, 'fixtures', spec.provider);
  const file = path.join(dir, `${task.taskId}.${task.role}.json`);
  const fallback = path.join(dir, `default.${task.role}.json`);
  const chosen = fs.existsSync(file) ? file : fallback;
  if (!fs.existsSync(chosen)) {
    return {
      ok: false,
      structured: null,
      rawArtifactPath: '',
      rawArtifactHash: '',
      durationMs: Date.now() - started,
      exitCode: null,
      usage: null,
      error: `no fixture for role ${task.role} at ${file} or ${fallback}`,
      simulated: true,
      provider: spec.provider,
    };
  }
  const raw = fs.readFileSync(chosen, 'utf8');
  const { rawArtifactPath, rawArtifactHash } = writeRawArtifact(
    task.taskId,
    `${spec.provider}-${task.role}-${started}.fixture.json`,
    raw,
  );
  const parsed = parseStructured(raw, requiredKeysFor(task.schemaName));
  return {
    ok: parsed.ok,
    structured: parsed.value,
    rawArtifactPath,
    rawArtifactHash,
    durationMs: Date.now() - started,
    exitCode: 0,
    // Fixtures never claim token or cost data.
    usage: null,
    error: parsed.ok ? undefined : parsed.error,
    failureKind: parsed.ok ? undefined : parsed.failureKind,
    simulated: true,
    provider: spec.provider,
  };
}

export function runTransport(spec: TransportSpec, task: AgentTask): AgentResult {
  return spec.kind === 'fixture' ? runFixture(spec, task) : runExec(spec, task);
}

/** Resolves an executable without assuming it is on PATH. */
export function which(bin: string): string | null {
  const res = spawnSync('sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  const out = (res.stdout ?? '').trim();
  return out.length ? out.split('\n')[0] : null;
}
