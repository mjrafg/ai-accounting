/**
 * Stage 0 — UnitOfWork transaction lifecycle.
 *
 * Proves the guarantees of the managed Knex transaction form:
 *
 *   success                  -> commits, caller resolves, after-transaction hook RUNS
 *   work failure             -> rolls back, ORIGINAL error reaches caller, hook does NOT run
 *   detectable commit failure-> rejects, caller never sees success, 0 rows, hook does NOT run
 *
 * The commit-failure case is the one the previous manual implementation missed:
 * measured over 10 runs on knex 3.1.0 / mysql 2.18.1, when the transaction's
 * connection dies before COMMIT is dispatched, `await trx.commit()` RESOLVES,
 * no COMMIT appears in the MariaDB general log, and 0 rows persist.
 *
 * `UnitOfWork` depends on the CLS proxy provider TENANCY_DB_CONNECTION, so these
 * tests run inside an explicit `cls.run()` with the proxy providers resolved -
 * outside an HTTP request there is no ambient CLS context.
 *
 * Run via: pnpm test:stage0
 */
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import { AppModule } from '../src/modules/App/App.module';
import { UnitOfWork } from '../src/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { runAfterTransaction } from '../src/modules/Tenancy/TenancyDB/TransactionsHooks';
import { CreateCustomer as CreateCustomerService } from '../src/modules/Customers/commands/CreateCustomer.service';

jest.setTimeout(300000);

const PROBE = 'STAGE0_UOW';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: INestApplication;
let cls: ClsService;
let uow: UnitOfWork;
let organizationId: string;

/** Runs a body inside a CLS context with tenant routing resolved. */
async function inTenantContext<T>(fn: (knex: Knex) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('organizationId', organizationId);
    cls.set('userId', 1);
    await (cls as any).resolveProxyProviders();
    const knex = (uow as any).tenantKex() as Knex;
    return fn(knex);
  });
}

const insertProbeRow = (trx: Knex.Transaction, refId: number) =>
  trx.raw(
    'INSERT INTO ACCOUNTS_TRANSACTIONS (CREDIT,DEBIT,CURRENCY_CODE,EXCHANGE_RATE,REFERENCE_TYPE,REFERENCE_ID,ACCOUNT_ID,`DATE`,CREATED_AT) ' +
      'VALUES (1,0,?,1,?,?,1003,?,NOW())',
    ['USD', PROBE, refId, '2027-12-01'],
  );

const countProbeRows = async (knex: Knex, refId: number) => {
  const [r] = await knex.raw(
    'SELECT COUNT(*) c FROM ACCOUNTS_TRANSACTIONS WHERE REFERENCE_TYPE=? AND REFERENCE_ID=?',
    [PROBE, refId],
  );
  return Number(r[0].c);
};

beforeAll(async () => {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const signin = await request(app.getHttpServer())
    .post('/auth/signin')
    .send({ email: 'bigcapital@bigcapital.com', password: '123123123' });
  organizationId = signin.body.organization_id;

  cls = app.get(ClsService);
  uow = app.get(UnitOfWork);
});

afterAll(async () => {
  await inTenantContext(async (knex) => {
    await knex.raw('DELETE FROM ACCOUNTS_TRANSACTIONS WHERE REFERENCE_TYPE=?', [
      PROBE,
    ]);
  }).catch(() => undefined);
  if (app) await app.close();
});

describe('Stage 0: managed UnitOfWork lifecycle', () => {
  it('SUCCESS: commits, resolves with the work result, after-transaction hook runs', async () => {
    await inTenantContext(async (knex) => {
      let hookRan = false;
      const result = await uow.withTransaction(
        async (trx: Knex.Transaction) => {
          runAfterTransaction(trx, () => {
            hookRan = true;
          });
          await insertProbeRow(trx, 940001);
          return 'WORK_DONE';
        },
      );
      await sleep(300);

      expect(result).toBe('WORK_DONE');
      expect(await countProbeRows(knex, 940001)).toBe(1);
      expect(hookRan).toBe(true);
    });
  });

  it('WORK FAILURE: rolls back, preserves the original error, hook does NOT run', async () => {
    await inTenantContext(async (knex) => {
      const original = new Error('STAGE0_BUSINESS_RULE_FAILED');
      let hookRan = false;
      let caught: any = null;

      try {
        await uow.withTransaction(async (trx: Knex.Transaction) => {
          runAfterTransaction(trx, () => {
            hookRan = true;
          });
          await insertProbeRow(trx, 940002);
          throw original;
        });
      } catch (e) {
        caught = e;
      }
      await sleep(300);

      // Same error object, not a wrapper.
      expect(caught).toBe(original);
      expect(caught.message).toBe('STAGE0_BUSINESS_RULE_FAILED');
      expect(await countProbeRows(knex, 940002)).toBe(0);
      expect(hookRan).toBe(false);
    });
  });

  it('COMMIT FAILURE: connection dies before COMMIT -> rejects, 0 rows, hook does NOT run', async () => {
    await inTenantContext(async (knex) => {
      let hookRan = false;
      let sawSuccess = false;
      let caught: any = null;

      try {
        await uow.withTransaction(async (trx: Knex.Transaction) => {
          runAfterTransaction(trx, () => {
            hookRan = true;
          });
          const [rows] = await trx.raw('SELECT CONNECTION_ID() AS c');
          await insertProbeRow(trx, 940003);
          // Kill the transaction's own server-side thread from another connection.
          await knex.raw(`KILL CONNECTION ${rows[0].c}`);
          await sleep(250);
          return 'WORK_DONE';
        });
        sawSuccess = true;
      } catch (e) {
        caught = e;
      }
      await sleep(400);

      expect(sawSuccess).toBe(false);
      expect(caught).toBeDefined();
      expect(await countProbeRows(knex, 940003)).toBe(0);
      expect(hookRan).toBe(false);
    });
  });

  it('NESTED (real command): CreateCustomer joins the caller transaction and rolls back with it', async () => {
    // CreateCustomer.createCustomer(dto, trx) is the production nesting pattern:
    // the command accepts an optional trx and passes it as withTransaction's
    // second argument. This exercises that real path rather than a synthetic one.
    const createCustomer = app.get(CreateCustomerService);
    const displayName = `STAGE0-NESTED-${Date.now()}`;
    const boom = new Error('STAGE0_OUTER_FAILED');

    await inTenantContext(async (knex) => {
      let caught: any = null;
      let innerCustomerId: number | undefined;
      try {
        await uow.withTransaction(async (outerTrx: Knex.Transaction) => {
          const customer = await createCustomer.createCustomer(
            {
              displayName,
              currencyCode: 'USD',
              customerType: 'business',
            } as any,
            outerTrx,
          );
          innerCustomerId = customer.id;
          // Visible inside the still-open outer transaction.
          const [seen] = await outerTrx.raw(
            'SELECT COUNT(*) c FROM CONTACTS WHERE ID = ?',
            [customer.id],
          );
          expect(Number(seen[0].c)).toBe(1);
          throw boom;
        });
      } catch (e) {
        caught = e;
      }
      await sleep(300);

      expect(caught).toBe(boom);
      expect(innerCustomerId).toBeDefined();
      // The nested command must NOT have committed independently.
      const [after] = await knex.raw(
        'SELECT COUNT(*) c FROM CONTACTS WHERE ID = ?',
        [innerCustomerId],
      );
      expect(Number(after[0].c)).toBe(0);
    });
  });

  it('NESTED: an existing trx is joined, not re-committed', async () => {
    await inTenantContext(async (knex) => {
      const outerResult = await uow.withTransaction(
        async (outerTrx: Knex.Transaction) => {
          // Passing the existing trx must reuse it rather than open a new one.
          const inner = await uow.withTransaction(async (innerTrx) => {
            expect(innerTrx).toBe(outerTrx);
            await insertProbeRow(innerTrx, 940004);
            return 'INNER_DONE';
          }, outerTrx);
          expect(inner).toBe('INNER_DONE');
          return 'OUTER_DONE';
        },
      );
      await sleep(200);

      expect(outerResult).toBe('OUTER_DONE');
      // The outer transaction owns the commit, so the inner write is persisted.
      expect(await countProbeRows(knex, 940004)).toBe(1);
    });
  });
});
