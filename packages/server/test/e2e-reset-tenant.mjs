/**
 * Stage -1 DATABASE LIFECYCLE: fresh tenant per complete run.
 *
 * Policy (chosen deliberately, see Stage -1 design):
 *   fresh tenant per RUN  +  shared across specs within that run  +  fixed sorted order
 *
 * The tenant is NOT reset between individual specs. Existing specs contain
 * within-file id chaining (27 of 55 capture `.body.id`) and a handful depend on
 * records with fixed ids (`/bills/1`, `/credit-notes/1`, `/vendor-credits/1`,
 * `/banking/uncategorized/accounts/1`). Resetting per spec would silently change
 * those tests' semantics. Resetting per run instead makes the starting state
 * defined without touching a single assertion.
 *
 * Provisioning deliberately goes through the application's own signup +
 * organization-build path so the tenant is migrated and seeded exactly the way
 * production does it. That requires a BullMQ worker, so this module starts the
 * built server, provisions, and then shuts it down again. The runner verifies
 * afterwards that no worker remains attached to Redis.
 *
 * Test-tree only. Never imported by the application.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  SERVER_DIR,
  dbConfig,
  E2E_USER,
  APP_BASE,
  APP_PORT,
} from './e2e-env.mjs';

const require = createRequire(import.meta.url);
const knex = require('knex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tables in the system DB that reference TENANTS / USERS and block deletion. */
const TENANT_CHILD_TABLES = [
  'API_KEYS',
  'PAYMENT_LINKS',
  'PLAID_ITEMS',
  'IMPORTS',
  'STRIPE_ACCOUNTS',
  'ONECLICK_DEMOS',
  'USER_INVITES',
  'SUBSCRIPTION_PLAN_SUBSCRIPTIONS',
  'TENANTS_METADATA',
];
const USER_CHILD_TABLES = ['API_KEYS', 'USER_INVITES', 'PASSWORD_RESETS'];

function systemKnex() {
  const cfg = dbConfig();
  return knex({
    client: 'mysql',
    connection: {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.systemDb,
      charset: 'utf8',
    },
    pool: { min: 0, max: 3 },
  });
}

/** Drop the fixed E2E user, its tenants and their tenant databases. */
export async function resetTenant(log = console.log) {
  const cfg = dbConfig();
  const db = systemKnex();
  try {
    const [users] = await db.raw('SELECT ID FROM USERS WHERE EMAIL = ?', [
      E2E_USER.email,
    ]);
    if (!users.length) {
      log('  reset: no existing E2E user (already clean)');
      return;
    }
    const userId = users[0].ID;
    const [rows] = await db.raw(
      'SELECT TENANT_ID FROM USER_TENANTS WHERE USER_ID = ?',
      [userId],
    );
    const tenantIds = [...new Set(rows.map((r) => r.TENANT_ID))];

    for (const tenantId of tenantIds) {
      const [t] = await db.raw(
        'SELECT ORGANIZATION_ID FROM TENANTS WHERE ID = ?',
        [tenantId],
      );
      if (t.length) {
        await db.raw(
          `DROP DATABASE IF EXISTS \`${cfg.tenantPrefix}${t[0].ORGANIZATION_ID}\``,
        );
      }
    }
    // Deletion order matters: USERS.TENANT_ID references TENANTS, and
    // USER_TENANTS references USERS, so users must go before tenants.
    const list = tenantIds.length ? tenantIds.join(',') : null;

    if (list)
      await db.raw(`DELETE FROM USER_TENANTS WHERE TENANT_ID IN (${list})`);
    await db.raw('DELETE FROM USER_TENANTS WHERE USER_ID = ?', [userId]);

    // Any user rooted in these tenants (e.g. accepted invitees) also blocks the
    // tenant delete, so clear their dependants and then the users themselves.
    const [tenantUsers] = list
      ? await db.raw(`SELECT ID FROM USERS WHERE TENANT_ID IN (${list})`)
      : [[]];
    const userIds = [...new Set([userId, ...tenantUsers.map((r) => r.ID)])];
    const userList = userIds.join(',');
    for (const table of USER_CHILD_TABLES) {
      try {
        await db.raw(`DELETE FROM ${table} WHERE USER_ID IN (${userList})`);
      } catch {
        /* column absent */
      }
    }
    await db.raw(`DELETE FROM USER_TENANTS WHERE USER_ID IN (${userList})`);
    await db.raw(`DELETE FROM USERS WHERE ID IN (${userList})`);

    if (list) {
      for (const table of TENANT_CHILD_TABLES) {
        try {
          await db.raw(`DELETE FROM ${table} WHERE TENANT_ID IN (${list})`);
        } catch {
          /* column absent */
        }
      }
      await db.raw(`DELETE FROM TENANTS WHERE ID IN (${list})`);
    }
    log(
      `  reset: dropped ${tenantIds.length} tenant database(s) and the E2E user`,
    );
  } finally {
    await db.destroy();
  }
}

async function httpJson(method, urlPath, body, token, orgId) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers['organization-id'] = orgId;
  const res = await fetch(APP_BASE + urlPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Start the built server, wait until it answers, return the child process. */
async function startServer(log) {
  const child = spawn('node', ['dist/main.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_BASE}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'probe@invalid', password: 'x' }),
      });
      if (res.status > 0) {
        log('  provisioning server is up');
        return child;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(2000);
  }
  child.kill('SIGKILL');
  throw new Error('provisioning server did not become ready within 180s');
}

async function stopServer(child, log) {
  if (!child) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 30000;
  while (
    Date.now() < deadline &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    await sleep(500);
  }
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
  await sleep(2000);
  log('  provisioning server stopped');
}

/**
 * Create the fixed E2E user + organization and wait for the tenant database to
 * be migrated and seeded. Returns the organizationId.
 */
export async function provisionTenant(log = console.log) {
  const cfg = dbConfig();
  let child = null;
  try {
    child = await startServer(log);

    const signup = await httpJson('POST', '/auth/signup', {
      email: E2E_USER.email,
      password: E2E_USER.password,
      firstName: E2E_USER.firstName,
      lastName: E2E_USER.lastName,
      organizationName: E2E_USER.organizationName,
    });
    if (signup.status >= 400) {
      throw new Error(
        `signup failed: ${signup.status} ${JSON.stringify(signup.body).slice(0, 200)}`,
      );
    }
    const signin = await httpJson('POST', '/auth/signin', {
      email: E2E_USER.email,
      password: E2E_USER.password,
    });
    if (signin.status >= 400)
      throw new Error(`signin failed: ${signin.status}`);
    const organizationId = signin.body.organization_id;
    const token = signin.body.access_token;

    const build = await httpJson(
      'POST',
      '/organization/build',
      {
        name: E2E_USER.organizationName,
        industry: 'services',
        location: 'US',
        baseCurrency: 'USD',
        timezone: 'UTC',
        fiscalYear: 'january',
        language: 'en',
        dateFormat: 'DD/MM/yyyy',
      },
      token,
      organizationId,
    );
    if (build.status >= 400) {
      throw new Error(
        `organization build failed: ${build.status} ${JSON.stringify(build.body).slice(0, 200)}`,
      );
    }

    // Wait for tenant migrations + seeds to finish.
    const db = systemKnex();
    const tenantDb = `${cfg.tenantPrefix}${organizationId}`;
    try {
      const deadline = Date.now() + 300000;
      for (;;) {
        try {
          const [r] = await db.raw(
            `SELECT COUNT(*) AS c FROM \`${tenantDb}\`.ACCOUNTS`,
          );
          if (Number(r[0].c) > 0) {
            log(`  provisioned ${tenantDb} (${r[0].c} seeded accounts)`);
            break;
          }
        } catch {
          /* database/table not created yet */
        }
        if (Date.now() > deadline)
          throw new Error(`tenant ${tenantDb} was not seeded within 300s`);
        await sleep(3000);
      }
    } finally {
      await db.destroy();
    }
    return organizationId;
  } finally {
    await stopServer(child, log);
  }
}

export async function resetAndProvision(log = console.log) {
  await resetTenant(log);
  return provisionTenant(log);
}

// CLI entry point: `node test/e2e-reset-tenant.mjs`
if (process.argv[1] && process.argv[1].endsWith('e2e-reset-tenant.mjs')) {
  const { loadEnv } = await import('./e2e-env.mjs');
  loadEnv();
  resetAndProvision()
    .then((org) => {
      console.log(`organizationId=${org}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`RESET/PROVISION FAILED: ${e.message}`);
      process.exit(2);
    });
}
