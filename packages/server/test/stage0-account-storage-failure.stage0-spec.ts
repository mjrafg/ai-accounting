/**
 * Stage 0 — LedgetAccountStorage failure propagation.
 *
 * This lives in its OWN spec file on purpose.
 *
 * `LedegrAccountsStorage` is request-scoped (it injects the request-scoped
 * `AccountRepository`), so `app.get()` cannot return the instance a request
 * actually uses and `jest.spyOn` has nothing to attach to. The fault must
 * therefore be injected with `overrideProvider`, which means building a second
 * Nest application.
 *
 * A second application in the same process is not safe to mix with other tests:
 * `EventEmitterModule.forRoot()` registers its EventEmitter2 with `useValue`,
 * so the instance is created once per module *definition* and is SHARED by
 * every app built from the same required AppModule. An always-failing override
 * registered by a second app stays attached to that shared emitter and breaks
 * unrelated tests that run afterwards. Isolating this case in its own file gives
 * it a fresh module registry, and therefore a fresh emitter.
 *
 * Run via: pnpm test:stage0
 */
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { Knex } from 'knex';
import * as knexFactory from 'knex';
import { AppModule } from '../src/modules/App/App.module';
import { LedegrAccountsStorage } from '../src/modules/Ledger/LedgetAccountStorage.service';

jest.setTimeout(300000);

const EMAIL = 'bigcapital@bigcapital.com';
const PASSWORD = '123123123';

const makeJournal = (journalNumber: string) => ({
  date: '2022-06-01',
  reference: journalNumber,
  journalNumber,
  publish: false,
  entries: [
    { index: 1, credit: 500, debit: 0, accountId: 1003 },
    { index: 2, credit: 0, debit: 500, accountId: 1004 },
  ],
});

it('2. LedgetAccountStorage failure -> rolls back entries written earlier in the same transaction', async () => {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LedegrAccountsStorage)
    .useValue({
      saveAccountsBalance: jest
        .fn()
        .mockRejectedValue(new Error('STAGE0_INJECTED_ACCOUNTS_FAILURE')),
    })
    .compile();
  const app = moduleFixture.createNestApplication();
  await app.init();

  let db: Knex | undefined;
  try {
    const signin = await request(app.getHttpServer())
      .post('/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    const hdr = `Bearer ${signin.body.access_token}`;
    const org = signin.body.organization_id;

    db = (knexFactory as any)({
      client: 'mysql',
      connection: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'bigcapital',
        password: process.env.DB_PASSWORD || 'bigcapital',
        database: `${process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_'}${org}`,
        charset: 'utf8',
      },
      pool: { min: 0, max: 4 },
    });

    const created = await request(app.getHttpServer())
      .post('/manual-journals')
      .set('organization-id', org)
      .set('Authorization', hdr)
      .send(makeJournal(`STAGE0-accounts-${Date.now()}`));
    expect(created.status).toBe(201);
    const journalId = created.body.id;

    const accountsBefore = await db!('ACCOUNTS')
      .whereIn('ID', [1003, 1004])
      .select('ID', 'AMOUNT');

    const res = await request(app.getHttpServer())
      .patch(`/manual-journals/${journalId}/publish`)
      .set('organization-id', org)
      .set('Authorization', hdr)
      .send();
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Ledger entries are written BEFORE the account balances inside
    // LedgerStorage.commit(), so this proves the earlier writes were rolled back.
    const rows = await db!('ACCOUNTS_TRANSACTIONS')
      .where({ REFERENCE_TYPE: 'Journal', REFERENCE_ID: journalId })
      .select('ID');
    expect(rows.length).toBe(0);

    const accountsAfter = await db!('ACCOUNTS')
      .whereIn('ID', [1003, 1004])
      .select('ID', 'AMOUNT');
    expect(accountsAfter).toEqual(accountsBefore);

    const journal = await db!('MANUAL_JOURNALS')
      .where('ID', journalId)
      .select('PUBLISHED_AT');
    expect(journal[0].PUBLISHED_AT).toBeNull();
  } finally {
    if (db) await db.destroy();
    await app.close();
  }
});
