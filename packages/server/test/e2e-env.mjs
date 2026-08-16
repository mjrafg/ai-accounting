/**
 * Shared environment/config helpers for the Stage -1 isolated E2E harness.
 *
 * Test-tree only. Never imported by the application.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(TEST_DIR, '..');

/** Minimal .env loader (does not override values already in process.env). */
export function loadEnv() {
  const envPath = path.join(SERVER_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function dbConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'bigcapital',
    password: process.env.DB_PASSWORD || 'bigcapital',
    systemDb: process.env.SYSTEM_DB_NAME || 'bigcapital_system',
    tenantPrefix: process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_',
  };
}

export function redisConfig() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  };
}

/** Fixed credentials that `init-app-test.ts` signs in with. */
export const E2E_USER = {
  email: 'bigcapital@bigcapital.com',
  password: '123123123',
  firstName: 'E2E',
  lastName: 'Runner',
  organizationName: 'E2E Org',
};

export const APP_PORT = parseInt(process.env.E2E_APP_PORT || '3000', 10);
export const APP_BASE = `http://127.0.0.1:${APP_PORT}/api`;
