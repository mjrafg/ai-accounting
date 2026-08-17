/**
 * Hard production guard.
 *
 * Stage 0 acceptance deliberately injects faults, kills connections mid-commit
 * and truncates logs. None of that may ever reach the production accounting
 * stack. This is enforced structurally rather than by naming convention: the
 * test path must positively match a known-disposable endpoint, and anything
 * carrying a production marker is refused outright.
 */
import * as fs from 'fs';
import * as path from 'path';

export class ProductionEndpointError extends Error {
  constructor(detail: string) {
    super(`refusing to run destructive tests against production: ${detail}`);
    this.name = 'ProductionEndpointError';
  }
}

/** Endpoints the disposable test stack is allowed to use. */
const ALLOWED_DB_HOSTS = ['mariadb', '127.0.0.1', 'localhost', 'ai-accounting-mariadb-1'];
const ALLOWED_REDIS_HOSTS = ['redis', '127.0.0.1', 'localhost', 'ai-accounting-redis-1'];

/** Anything matching these is production and is never a valid test target. */
const PRODUCTION_MARKERS = [
  /bigcapital[-_]prod/i,
  /(^|[^a-z])prod(uction)?([^a-z]|$)/i,
  /acc\.agent24\.io/i,
];

function parseEnvFile(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export interface GuardResult {
  ok: boolean;
  dbHost: string;
  dbUser: string;
  dbName: string;
  redisHost: string;
  reason?: string;
}

/**
 * Inspects the environment the suites will actually connect with. Called before
 * any destructive suite runs; throws rather than returning on a production hit.
 */
export function assertDisposableTargets(serverDir: string): GuardResult {
  const env = { ...parseEnvFile(path.join(serverDir, '.env')), ...process.env };
  const dbHost = String(env.DB_HOST ?? '');
  const dbUser = String(env.DB_USER ?? '');
  const dbName = String(env.SYSTEM_DB_NAME ?? '');
  const dbPrefix = String(env.TENANT_DB_NAME_PERFIX ?? '');
  const redisHost = String(env.REDIS_HOST ?? '');
  const baseUrl = String(env.BASE_URL ?? '');

  const result: GuardResult = { ok: true, dbHost, dbUser, dbName, redisHost };

  for (const [label, value] of Object.entries({ dbHost, dbUser, dbName, dbPrefix, redisHost, baseUrl })) {
    for (const marker of PRODUCTION_MARKERS) {
      if (value && marker.test(value)) {
        result.ok = false;
        result.reason = `${label}="${value}" matches production marker ${marker}`;
        throw new ProductionEndpointError(result.reason);
      }
    }
  }
  if (dbHost && !ALLOWED_DB_HOSTS.includes(dbHost)) {
    result.ok = false;
    result.reason = `DB_HOST="${dbHost}" is not a known disposable endpoint`;
    throw new ProductionEndpointError(result.reason);
  }
  if (redisHost && !ALLOWED_REDIS_HOSTS.includes(redisHost)) {
    result.ok = false;
    result.reason = `REDIS_HOST="${redisHost}" is not a known disposable endpoint`;
    throw new ProductionEndpointError(result.reason);
  }
  return result;
}
