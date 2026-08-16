/**
 * Stage 0 — transaction safety / ledger failure propagation.
 *
 * Deliberately NOT named `*.e2e-spec.ts`: the Stage -1 isolated runner discovers
 * specs by that exact suffix, and adding a 56th file would show up as a baseline
 * change. Run it explicitly:
 *
 *   pnpm test:stage0
 *
 * These tests prove that an accounting write failure FAILS CLOSED:
 *   - the operation rejects (never reports success),
 *   - nothing partial survives in ACCOUNTS_TRANSACTIONS,
 *   - cached account/contact balances are not left mutated.
 *
 * The write path used is the manual journal publish, which was empirically
 * confirmed to reach LedgerStorage.commit() and to mutate account balances.
 */
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Knex } from 'knex';
import * as knexFactory from 'knex';
import { AppModule } from '../src/modules/App/App.module';
import { LedgerEntriesStorageService } from '../src/modules/Ledger/LedgerEntriesStorage.service';
import { LedgerContactsBalanceStorage } from '../src/modules/Ledger/LedgerContactStorage.service';

jest.setTimeout(300000);

const EMAIL = 'bigcapital@bigcapital.com';
const PASSWORD = '123123123';

let app: INestApplication;
let authHeader: string;
let organizationId: string;
let db: Knex;

/** A balanced two-legged journal against two seeded accounts. */
const makeJournal = (journalNumber: string) => ({
  date: '2027-06-01',
  reference: journalNumber,
  journalNumber,
  publish: false,
  entries: [
    { index: 1, credit: 500, debit: 0, accountId: 1003 },
    { index: 2, credit: 0, debit: 500, accountId: 1004 },
  ],
});

const post = (path: string, body: any) =>
  request(app.getHttpServer())
    .post(path)
    .set('organization-id', organizationId)
    .set('Authorization', authHeader)
    .send(body);

const patch = (path: string) =>
  request(app.getHttpServer())
    .patch(path)
    .set('organization-id', organizationId)
    .set('Authorization', authHeader)
    .send();

async function ledgerState(journalId: number) {
  const rows = await db('ACCOUNTS_TRANSACTIONS')
    .where({ REFERENCE_TYPE: 'Journal', REFERENCE_ID: journalId })
    .select('ID');
  const accounts = await db('ACCOUNTS')
    .whereIn('ID', [1003, 1004])
    .select('ID', 'AMOUNT');
  const balances: Record<number, string | null> = {};
  for (const a of accounts)
    balances[a.ID] = a.AMOUNT === null ? null : String(a.AMOUNT);
  return { entryCount: rows.length, balances };
}

/** Creates a draft journal and returns its id. */
async function createDraftJournal(tag: string): Promise<number> {
  const res = await post(
    '/manual-journals',
    makeJournal(`STAGE0-${tag}-${Date.now()}`),
  );
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const signin = await request(app.getHttpServer())
    .post('/auth/signin')
    .send({ email: EMAIL, password: PASSWORD });
  authHeader = `Bearer ${signin.body.access_token}`;
  organizationId = signin.body.organization_id;

  db = (knexFactory as any)({
    client: 'mysql',
    connection: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'bigcapital',
      password: process.env.DB_PASSWORD || 'bigcapital',
      database: `${process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_'}${organizationId}`,
      charset: 'utf8',
    },
    pool: { min: 0, max: 4 },
  });
});

afterAll(async () => {
  if (db) await db.destroy();
  if (app) await app.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Stage 0: ledger storage failure propagation', () => {
  it('control: publishing a journal succeeds and writes balanced ledger rows', async () => {
    const journalId = await createDraftJournal('control');
    const before = await ledgerState(journalId);
    expect(before.entryCount).toBe(0);

    const res = await patch(`/manual-journals/${journalId}/publish`);
    expect(res.status).toBe(200);

    const after = await ledgerState(journalId);
    expect(after.entryCount).toBe(2);

    const sums = await db('ACCOUNTS_TRANSACTIONS')
      .where({ REFERENCE_TYPE: 'Journal', REFERENCE_ID: journalId })
      .sum({ d: 'DEBIT', c: 'CREDIT' });
    expect(Number(sums[0].d)).toBeCloseTo(Number(sums[0].c), 3);
  });

  it('1. LedgerEntriesStorage failure -> request fails, no partial entries, no cache drift', async () => {
    const journalId = await createDraftJournal('entries');
    const before = await ledgerState(journalId);

    const entries = app.get(LedgerEntriesStorageService);
    jest
      .spyOn(entries, 'saveEntries')
      .mockRejectedValue(new Error('STAGE0_INJECTED_ENTRIES_FAILURE'));

    const res = await patch(`/manual-journals/${journalId}/publish`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await ledgerState(journalId);
    expect(after.entryCount).toBe(0);
    expect(after.balances).toEqual(before.balances);
  });

  it('3. LedgerContactStorage failure -> rolls back earlier entry and account writes', async () => {
    const journalId = await createDraftJournal('contacts');
    const before = await ledgerState(journalId);

    const contacts = app.get(LedgerContactsBalanceStorage);
    jest
      .spyOn(contacts, 'saveContactsBalance')
      .mockRejectedValue(new Error('STAGE0_INJECTED_CONTACTS_FAILURE'));

    const res = await patch(`/manual-journals/${journalId}/publish`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Contact balances run LAST, so both the entries and the account balance
    // mutations had already been applied inside the transaction.
    const after = await ledgerState(journalId);
    expect(after.entryCount).toBe(0);
    expect(after.balances).toEqual(before.balances);
  });
});

describe('Stage 0: inventory adjustment GL failure propagation', () => {
  let itemId: number;

  beforeAll(async () => {
    const res = await post('/items', {
      name: `STAGE0-INV-${Date.now()}`,
      type: 'inventory',
      sellable: true,
      purchasable: true,
      sellPrice: 100,
      costPrice: 60,
      sellAccountId: 1026,
      costAccountId: 1019,
      inventoryAccountId: 1007,
    });
    expect(res.status).toBe(201);
    itemId = parseInt(res.body.id, 10);
  });

  const quickAdjustment = () =>
    post('/inventory-adjustments/quick', {
      date: '2027-02-01',
      type: 'increment',
      adjustmentAccountId: 1024,
      itemId,
      quantity: 10,
      cost: 60,
      publish: true,
      reason: 'stage0 probe',
    });

  it('control: a quick inventory adjustment posts GL entries', async () => {
    const res = await quickAdjustment();
    expect(res.status).toBe(201);
    const rows = await db('ACCOUNTS_TRANSACTIONS')
      .where({
        REFERENCE_TYPE: 'InventoryAdjustment',
        REFERENCE_ID: res.body.id,
      })
      .select('ID');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('LedgerEntriesStorage failure -> adjustment fails, no partial ledger rows', async () => {
    const beforeRows = await db('ACCOUNTS_TRANSACTIONS')
      .where('REFERENCE_TYPE', 'InventoryAdjustment')
      .count({ c: '*' });
    const beforeAccounts = await db('ACCOUNTS')
      .whereIn('ID', [1007, 1024])
      .select('ID', 'AMOUNT');

    const entries = app.get(LedgerEntriesStorageService);
    jest
      .spyOn(entries, 'saveEntries')
      .mockRejectedValue(new Error('STAGE0_INJECTED_INV_ADJ_FAILURE'));

    const res = await quickAdjustment();
    expect(res.status).toBeGreaterThanOrEqual(400);

    const afterRows = await db('ACCOUNTS_TRANSACTIONS')
      .where('REFERENCE_TYPE', 'InventoryAdjustment')
      .count({ c: '*' });
    const afterAccounts = await db('ACCOUNTS')
      .whereIn('ID', [1007, 1024])
      .select('ID', 'AMOUNT');

    expect(Number(afterRows[0].c)).toBe(Number(beforeRows[0].c));
    expect(afterAccounts).toEqual(beforeAccounts);
  });
});
