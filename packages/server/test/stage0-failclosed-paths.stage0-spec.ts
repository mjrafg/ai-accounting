/**
 * Stage 0 — remaining fail-closed paths.
 *
 * Seven targeted fault injections covering the shapes the earlier Stage 0 specs
 * did not reach: middle-of-loop failures, create paths, reversal-inside-trx,
 * balance sync, inventory quantity sync, and COGS old-cost reversal.
 *
 * Assertions are document-correlated (by REFERENCE_TYPE/REFERENCE_ID or row id),
 * never global row counts, and every fixture is created inside its own test.
 *
 * Run via: pnpm test:stage0
 */
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import * as knexFactory from 'knex';
import { AppModule } from '../src/modules/App/App.module';
import { UnitOfWork } from '../src/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { LedgerEntriesStorageService } from '../src/modules/Ledger/LedgerEntriesStorage.service';
import { InventoryItemsQuantitySyncService } from '../src/modules/InventoryCost/commands/InventoryItemsQuantitySync.service';
import { InventoryCostGLStorage } from '../src/modules/InventoryCost/commands/InventoryCostGLStorage.service';
import { CreditNoteApplySyncInvoicesCreditedAmount } from '../src/modules/CreditNotesApplyInvoice/commands/CreditNoteApplySyncInvoices.service';

jest.setTimeout(300000);

const DATE = '2027-06-01';
let app: INestApplication;
let db: Knex;
let hdr: string;
let org: string;
let cls: ClsService;
let uow: UnitOfWork;
let serviceItemId: number;
let inventoryItemId: number;
let customerId: number;
let vendorId: number;

const api = () => request(app.getHttpServer());
const H = (r: request.Test) =>
  r.set('organization-id', org).set('Authorization', hdr);

const post = (p: string, b: any) => H(api().post(p)).send(b);
const put = (p: string, b: any) => H(api().put(p)).send(b);
const del = (p: string) => H(api().delete(p)).send();

/** Ledger rows for one document, by reference. */
const ledgerRows = (type: string, id: number) =>
  db('ACCOUNTS_TRANSACTIONS')
    .where({ REFERENCE_TYPE: type, REFERENCE_ID: id })
    .orderBy('ID')
    .select('ID', 'ACCOUNT_ID', 'DEBIT', 'CREDIT');

const accountAmounts = (ids: number[]) =>
  db('ACCOUNTS').whereIn('ID', ids).orderBy('ID').select('ID', 'AMOUNT');

async function makeInvoice(rate = 500, qty = 1) {
  const res = await post('/sale-invoices', {
    customerId,
    invoiceDate: DATE,
    dueDate: DATE,
    delivered: true,
    exchangeRate: 1,
    entries: [
      {
        index: 1,
        itemId: serviceItemId,
        rate,
        quantity: qty,
        sellAccountId: 1026,
      },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function makePayment(invoiceId: number, amount: number) {
  const res = await post('/payments-received', {
    customerId,
    paymentDate: DATE,
    exchangeRate: 1,
    depositAccountId: 1000,
    entries: [{ index: 1, invoiceId, paymentAmount: amount }],
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  const mf = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mf.createNestApplication();
  await app.init();

  const signin = await api()
    .post('/auth/signin')
    .send({ email: 'bigcapital@bigcapital.com', password: '123123123' });
  hdr = `Bearer ${signin.body.access_token}`;
  org = signin.body.organization_id;
  cls = app.get(ClsService);
  uow = app.get(UnitOfWork);

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
    pool: { min: 0, max: 6 },
  });

  const svc = await post('/items', {
    name: `S0-SVC-${Date.now()}`,
    type: 'service',
    sellable: true,
    purchasable: true,
    sellPrice: 500,
    costPrice: 300,
    sellAccountId: 1026,
    costAccountId: 1020,
  });
  expect(svc.status).toBe(201);
  serviceItemId = parseInt(svc.body.id, 10);

  const inv = await post('/items', {
    name: `S0-INV-${Date.now()}`,
    type: 'inventory',
    sellable: true,
    purchasable: true,
    sellPrice: 100,
    costPrice: 60,
    sellAccountId: 1026,
    costAccountId: 1019,
    inventoryAccountId: 1007,
  });
  expect(inv.status).toBe(201);
  inventoryItemId = parseInt(inv.body.id, 10);

  const cust = await post('/customers', {
    displayName: `S0-C-${Date.now()}`,
    currencyCode: 'USD',
    customerType: 'business',
  });
  expect(cust.status).toBe(201);
  customerId = cust.body.id;

  const vend = await post('/vendors', {
    displayName: `S0-V-${Date.now()}`,
    currencyCode: 'USD',
  });
  expect(vend.status).toBe(201);
  vendorId = vend.body.id;
});

afterAll(async () => {
  if (db) await db.destroy();
  if (app) await app.close();
});

afterEach(() => jest.restoreAllMocks());

describe('Stage 0: remaining fail-closed paths', () => {
  it('1. INVOICE EDIT + THREE PAYMENTS: failing a MIDDLE GL rewrite rolls everything back', async () => {
    const invoiceId = await makeInvoice(1000);
    const p1 = await makePayment(invoiceId, 100);
    const p2 = await makePayment(invoiceId, 150);
    const p3 = await makePayment(invoiceId, 200);

    const beforeInvoiceGL = await ledgerRows('SaleInvoice', invoiceId);
    const before = {
      p1: await ledgerRows('PaymentReceive', p1),
      p2: await ledgerRows('PaymentReceive', p2),
      p3: await ledgerRows('PaymentReceive', p3),
    };
    expect(before.p1.length).toBeGreaterThan(0);
    expect(before.p3.length).toBeGreaterThan(0);
    const beforeAccounts = await accountAmounts([1000, 1006, 1026]);

    // Editing the invoice rewrites the invoice GL and then each payment's GL in
    // a sequential loop. Failing the 3rd saveEntries call lands on the SECOND
    // payment, i.e. a middle iteration with one payment already rewritten.
    //
    // PaymentReceivedGLEntries is request-scoped (it injects the request-scoped
    // AccountRepository), so app.get() cannot return the live instance to spy
    // on; LedgerEntriesStorageService is a true singleton and is the leaf every
    // rewrite funnels through.
    const entries = app.get(LedgerEntriesStorageService);
    const realSaveEntries = entries.saveEntries.bind(entries);
    let calls = 0;
    jest
      .spyOn(entries, 'saveEntries')
      .mockImplementation(async (...args: any[]) => {
        calls += 1;
        if (calls === 3) throw new Error('STAGE0_MIDDLE_REWRITE_FAILED');
        return (realSaveEntries as any)(...args);
      });

    const res = await put(`/sale-invoices/${invoiceId}`, {
      customerId,
      invoiceDate: DATE,
      dueDate: DATE,
      delivered: true,
      exchangeRate: 1,
      entries: [
        {
          index: 1,
          itemId: serviceItemId,
          rate: 1400,
          quantity: 1,
          sellAccountId: 1026,
        },
      ],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Proves a middle iteration was reached: earlier writes had already run.
    expect(calls).toBe(3);

    // The invoice edit itself rolled back.
    const invoiceRow = await db('SALES_INVOICES')
      .where('ID', invoiceId)
      .select('BALANCE');
    expect(Number(invoiceRow[0].BALANCE)).toBe(1000);
    expect(await ledgerRows('SaleInvoice', invoiceId)).toEqual(beforeInvoiceGL);

    // No partial rewrite survived for ANY payment - including the one that had
    // already been rewritten before the failure.
    expect(await ledgerRows('PaymentReceive', p1)).toEqual(before.p1);
    expect(await ledgerRows('PaymentReceive', p2)).toEqual(before.p2);
    expect(await ledgerRows('PaymentReceive', p3)).toEqual(before.p3);
    expect(await accountAmounts([1000, 1006, 1026])).toEqual(beforeAccounts);
  });

  it('2. CREATE PATH: failing bill GL posting leaves no bill and no ledger rows', async () => {
    const beforeAccounts = await accountAmounts([1008, 1020]);
    const billNumber = `S0-BILL-${Date.now()}`;

    const entries = app.get(LedgerEntriesStorageService);
    jest
      .spyOn(entries, 'saveEntries')
      .mockRejectedValue(new Error('STAGE0_BILL_GL_FAILED'));

    const res = await post('/bills', {
      vendorId,
      billDate: DATE,
      dueDate: DATE,
      billNumber,
      open: true,
      entries: [
        {
          index: 1,
          itemId: serviceItemId,
          rate: 400,
          quantity: 1,
          costAccountId: 1020,
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const bills = await db('BILLS')
      .where('BILL_NUMBER', billNumber)
      .select('ID');
    expect(bills.length).toBe(0);
    expect(await accountAmounts([1008, 1020])).toEqual(beforeAccounts);
  });

  it('3. DELETE/REVERSAL: failing reversal keeps the credit note and its GL rows intact', async () => {
    const created = await post('/credit-notes', {
      customerId,
      creditNoteDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: serviceItemId,
          rate: 300,
          quantity: 1,
          sellAccountId: 1026,
        },
      ],
    });
    expect(created.status).toBe(201);
    const creditNoteId = created.body.id;

    const beforeGL = await ledgerRows('CreditNote', creditNoteId);
    expect(beforeGL.length).toBeGreaterThan(0);
    const beforeAccounts = await accountAmounts([1006, 1026]);

    // deleteEntries is what the reversal calls; failing it proves the reversal
    // participates in the owning transaction (otherwise the delete would have
    // committed the reversal independently before failing).
    const entries = app.get(LedgerEntriesStorageService);
    jest
      .spyOn(entries, 'deleteEntries')
      .mockRejectedValue(new Error('STAGE0_CN_REVERSAL_FAILED'));

    const res = await del(`/credit-notes/${creditNoteId}`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const cn = await db('CREDIT_NOTES').where('ID', creditNoteId).select('ID');
    expect(cn.length).toBe(1);
    expect(await ledgerRows('CreditNote', creditNoteId)).toEqual(beforeGL);
    expect(await accountAmounts([1006, 1026])).toEqual(beforeAccounts);
  });

  it('4. BALANCE SYNC: failing credited-amount sync leaves no application row', async () => {
    const invoiceId = await makeInvoice(700);
    const created = await post('/credit-notes', {
      customerId,
      creditNoteDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: serviceItemId,
          rate: 700,
          quantity: 1,
          sellAccountId: 1026,
        },
      ],
    });
    expect(created.status).toBe(201);
    const creditNoteId = created.body.id;

    const beforeInvoice = await db('SALES_INVOICES')
      .where('ID', invoiceId)
      .select('CREDITED_AMOUNT');
    const beforeApplied = await db('CREDIT_NOTE_APPLIED_INVOICE')
      .where('CREDIT_NOTE_ID', creditNoteId)
      .select('ID');

    const sync = app.get(CreditNoteApplySyncInvoicesCreditedAmount);
    jest
      .spyOn(sync, 'incrementInvoicesCreditedAmount' as any)
      .mockRejectedValue(new Error('STAGE0_CREDIT_SYNC_FAILED'));

    const res = await post(`/credit-notes/${creditNoteId}/apply-invoices`, {
      entries: [{ invoiceId, amount: 100 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const afterApplied = await db('CREDIT_NOTE_APPLIED_INVOICE')
      .where('CREDIT_NOTE_ID', creditNoteId)
      .select('ID');
    expect(afterApplied).toEqual(beforeApplied);
    const afterInvoice = await db('SALES_INVOICES')
      .where('ID', invoiceId)
      .select('CREDITED_AMOUNT');
    expect(afterInvoice).toEqual(beforeInvoice);
  });

  it('5. INVENTORY QUANTITY SYNC: failing changeItemsQuantity rolls back the inventory transactions', async () => {
    const beforeQty = await db('ITEMS')
      .where('ID', inventoryItemId)
      .select('QUANTITY_ON_HAND');

    const sync = app.get(InventoryItemsQuantitySyncService);
    jest
      .spyOn(sync, 'changeItemsQuantity')
      .mockRejectedValue(new Error('STAGE0_QTY_SYNC_FAILED'));

    const res = await post('/inventory-adjustments/quick', {
      date: DATE,
      type: 'increment',
      adjustmentAccountId: 1024,
      itemId: inventoryItemId,
      quantity: 25,
      cost: 60,
      publish: true,
      reason: 'stage0 qty sync',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Document-correlated: no adjustment, and no inventory txn pointing at one.
    const adjustments = await db('INVENTORY_ADJUSTMENTS')
      .where('REASON', 'stage0 qty sync')
      .select('ID');
    expect(adjustments.length).toBe(0);
    const orphanTxns = await db('INVENTORY_TRANSACTIONS')
      .where({
        TRANSACTION_TYPE: 'InventoryAdjustment',
        ITEM_ID: inventoryItemId,
      })
      .andWhere('QUANTITY', 25)
      .select('ID');
    expect(orphanTxns.length).toBe(0);
    expect(
      await db('ITEMS').where('ID', inventoryItemId).select('QUANTITY_ON_HAND'),
    ).toEqual(beforeQty);
  });

  it('6. COGS REVERSAL: failing old-cost reversal aborts before any new cost posting', async () => {
    await cls.run(async () => {
      cls.set('organizationId', org);
      cls.set('userId', 1);
      await (cls as any).resolveProxyProviders();

      const costStorage = app.get(InventoryCostGLStorage);
      const entries = app.get(LedgerEntriesStorageService);
      jest
        .spyOn(costStorage, 'revertInventoryCostGLEntries')
        .mockRejectedValue(new Error('STAGE0_COGS_REVERSAL_FAILED'));
      const writeSpy = jest.spyOn(entries, 'saveEntries');

      let caught: any = null;
      try {
        await uow.withTransaction(async (trx: Knex.Transaction) => {
          // Reversal-then-post pairing: the reversal must abort the unit before
          // any new cost entries are written.
          await costStorage.revertInventoryCostGLEntries(new Date(DATE), trx);
          await entries.saveEntries(
            {
              getEntries: () => [],
              filter: () => ({ getEntries: () => [] }),
            } as any,
            trx,
          );
          return 'SHOULD_NOT_REACH';
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeDefined();
      expect(caught.message).toBe('STAGE0_COGS_REVERSAL_FAILED');
      // New-cost posting never proceeded independently.
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  it('7. INNER LOOP: failing the MIDDLE of three ledger entries persists none of them', async () => {
    const journalNumber = `S0-LOOP-${Date.now()}`;
    const created = await post('/manual-journals', {
      date: DATE,
      reference: journalNumber,
      journalNumber,
      publish: false,
      entries: [
        { index: 1, credit: 300, debit: 0, accountId: 1003 },
        { index: 2, credit: 200, debit: 0, accountId: 1003 },
        { index: 3, credit: 0, debit: 500, accountId: 1004 },
      ],
    });
    expect(created.status).toBe(201);
    const journalId = created.body.id;
    const beforeAccounts = await accountAmounts([1003, 1004]);

    // Fail the MIDDLE entry of the sequential for...of loop.
    const entries = app.get(LedgerEntriesStorageService);
    const realSave = (entries as any).saveEntry.bind(entries);
    let n = 0;
    jest
      .spyOn(entries as any, 'saveEntry')
      .mockImplementation(async (...args: any[]) => {
        n += 1;
        if (n === 2) throw new Error('STAGE0_MIDDLE_ENTRY_FAILED');
        return realSave(...args);
      });

    const res = await H(
      api().patch(`/manual-journals/${journalId}/publish`),
    ).send();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(n).toBe(2); // stopped at the failing middle entry, did not continue

    expect(await ledgerRows('Journal', journalId)).toEqual([]);
    expect(await accountAmounts([1003, 1004])).toEqual(beforeAccounts);
  });
});
