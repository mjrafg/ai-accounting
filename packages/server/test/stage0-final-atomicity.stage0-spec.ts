/**
 * Stage 0 — final atomicity coverage.
 *
 * Proves the four remaining transaction-boundary blockers, plus two strengthened
 * proofs where an earlier test did not independently demonstrate the production
 * property it claimed.
 *
 * Run via: pnpm test:stage0
 */
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Knex } from 'knex';
import * as knexFactory from 'knex';
import { AppModule } from '../src/modules/App/App.module';
import { UnitOfWork } from '../src/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { LedgerEntriesStorageService } from '../src/modules/Ledger/LedgerEntriesStorage.service';
import { LedgerContactsBalanceStorage } from '../src/modules/Ledger/LedgerContactStorage.service';
import { InventoryTransactionsService } from '../src/modules/InventoryCost/commands/InventoryTransactions.service';
import { PaymentReceivedGLEntries } from '../src/modules/PaymentReceived/commands/PaymentReceivedGLEntries';
import { LandedCostGLEntriesSubscriber } from '../src/modules/BillLandedCosts/commands/LandedCostGLEntries.subscriber';
import { LandedCostInventoryTransactionsSubscriber } from '../src/modules/BillLandedCosts/commands/LandedCostInventoryTransactions.subscriber';
import { LandedCostSyncCostTransactions } from '../src/modules/BillLandedCosts/commands/LandedCostSyncCostTransactions.service';
import { CreditNoteInventoryTransactionsSubscriber } from '../src/modules/CreditNotes/subscribers/CreditNoteInventoryTransactionsSubscriber';
import { CreditNoteInventoryTransactions } from '../src/modules/CreditNotes/commands/CreditNotesInventoryTransactions';
import { VendorCreditInventoryTransactions } from '../src/modules/VendorCredit/commands/VendorCreditInventoryTransactions';
import { events } from '../src/common/events/events';

jest.setTimeout(300000);

const DATE = '2027-06-01';
let app: INestApplication;
let db: Knex;
let hdr: string;
let org: string;
let cls: ClsService;
let uow: UnitOfWork;
let svcItem: number;
let invItem: number;
let customerId: number;
let vendorId: number;

const api = () => request(app.getHttpServer());
const H = (r: request.Test) =>
  r.set('organization-id', org).set('Authorization', hdr);
const post = (p: string, b: any) => H(api().post(p)).send(b);
const put = (p: string, b: any) => H(api().put(p)).send(b);
const del = (p: string) => H(api().delete(p)).send();

const ledgerRows = (type: string, id: number) =>
  db('ACCOUNTS_TRANSACTIONS')
    .where({ REFERENCE_TYPE: type, REFERENCE_ID: id })
    .orderBy('ID')
    .select('ID', 'ACCOUNT_ID', 'DEBIT', 'CREDIT');

const invTxns = (type: string, id: number) =>
  db('INVENTORY_TRANSACTIONS')
    .where({ TRANSACTION_TYPE: type, TRANSACTION_ID: id })
    .orderBy('ID')
    .select('ID', 'ITEM_ID', 'QUANTITY', 'DIRECTION');

async function inTenantContext<T>(fn: (knex: Knex) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('organizationId', org);
    cls.set('userId', 1);
    await (cls as any).resolveProxyProviders();
    return fn((uow as any).tenantKex() as Knex);
  });
}

beforeAll(async () => {
  const mf = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mf.createNestApplication();
  await app.init();
  const s = await api()
    .post('/auth/signin')
    .send({ email: 'bigcapital@bigcapital.com', password: '123123123' });
  hdr = `Bearer ${s.body.access_token}`;
  org = s.body.organization_id;
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

  const a = await post('/items', {
    name: `F-SVC-${Date.now()}`,
    type: 'service',
    sellable: true,
    purchasable: true,
    sellPrice: 300,
    costPrice: 200,
    sellAccountId: 1026,
    costAccountId: 1020,
  });
  svcItem = parseInt(a.body.id, 10);
  const b = await post('/items', {
    name: `F-INV-${Date.now()}`,
    type: 'inventory',
    sellable: true,
    purchasable: true,
    sellPrice: 100,
    costPrice: 60,
    sellAccountId: 1026,
    costAccountId: 1019,
    inventoryAccountId: 1007,
  });
  invItem = parseInt(b.body.id, 10);
  const c = await post('/customers', {
    displayName: `F-C-${Date.now()}`,
    currencyCode: 'USD',
    customerType: 'business',
  });
  customerId = c.body.id;
  const v = await post('/vendors', {
    displayName: `F-V-${Date.now()}`,
    currencyCode: 'USD',
  });
  vendorId = v.body.id;
});

afterAll(async () => {
  if (db) await db.destroy();
  if (app) await app.close();
});
afterEach(() => jest.restoreAllMocks());

describe('Stage 0 final: inventory propagation on credit note / vendor credit', () => {
  it('1a. CREDIT NOTE CREATE: inventory write failure rolls the credit note back', async () => {
    const inventory = app.get(InventoryTransactionsService);
    jest
      .spyOn(inventory, 'recordInventoryTransactions')
      .mockRejectedValue(new Error('STAGE0_CN_INV_CREATE_FAILED'));

    const ref = `F-CN-${Date.now()}`;
    const res = await post('/credit-notes', {
      customerId,
      creditNoteDate: DATE,
      exchangeRate: 1,
      open: true,
      referenceNo: ref,
      entries: [
        {
          index: 1,
          itemId: invItem,
          rate: 100,
          quantity: 2,
          sellAccountId: 1026,
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await db('CREDIT_NOTES')
      .where('REFERENCE_NO', ref)
      .select('ID');
    expect(rows.length).toBe(0);
  });

  // The credit-note onEdited inventory handler is annotated, but it can never
  // do any work: it guards on `if (!creditNote.isOpen) return;`, and the object
  // the edit command emits can never satisfy that guard.
  //
  //   isOpen = !!openedAt && creditsRemaining > 0
  //   creditsRemaining = max(amount - refundedAmount - invoicesAmount, 0)
  //
  // CommandCreditNoteDTOTransform builds the model that upsertGraph returns:
  //   * `openedAt` is added only when `!oldCreditNote?.openedAt`, so editing an
  //     already-open note omits it entirely -> `!!undefined` -> isOpen false.
  //   * `refundedAmount` / `invoicesAmount` are seeded only when `!oldCreditNote`
  //     (upstream commit 76fc32078), so on any edit they are undefined ->
  //     creditsRemaining is NaN -> `NaN > 0` is false -> isOpen false.
  //
  // Both edit branches were driven through the real API and observed; this test
  // pins that observation so the dead guard cannot regress unnoticed. Fixing it
  // changes credit-note edit semantics and is out of Stage 0 scope.
  it('1b. CREDIT NOTE EDIT: inventory handler is invoked but always short-circuits', async () => {
    const created = await post('/credit-notes', {
      customerId,
      creditNoteDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: invItem,
          rate: 100,
          quantity: 2,
          sellAccountId: 1026,
        },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const sub = app.get(CreditNoteInventoryTransactionsSubscriber);
    const inner = app.get(CreditNoteInventoryTransactions);
    let seen: any = null;
    const orig = sub.rewriteInventoryTransactionsOnceEdited.bind(sub);
    jest
      .spyOn(sub, 'rewriteInventoryTransactionsOnceEdited')
      .mockImplementation(async (payload: any) => {
        const cn = payload.creditNote;
        seen = {
          openedAt: cn?.openedAt ?? null,
          isOpen: cn?.isOpen,
          creditsRemainingIsNaN: Number.isNaN(cn?.creditsRemaining),
        };
        return orig(payload);
      });
    // Would reject if it were ever reached, so a passing edit also proves the
    // rewrite never runs.
    const innerSpy = jest
      .spyOn(inner, 'editInventoryTransactions')
      .mockRejectedValue(new Error('STAGE0_CN_INV_EDIT_UNREACHABLE'));

    const res = await put(`/credit-notes/${id}`, {
      customerId,
      creditNoteDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: invItem,
          rate: 400,
          quantity: 5,
          sellAccountId: 1026,
        },
      ],
    });

    // The subscriber ran, saw a payload that cannot be open, and returned early.
    expect(res.status).toBe(200);
    expect(seen).not.toBeNull();
    expect(seen.openedAt).toBeNull();
    expect(seen.isOpen).toBe(false);
    expect(innerSpy).not.toHaveBeenCalled();
  });

  it('1c. VENDOR CREDIT EDIT: inventory rewrite failure preserves the original state', async () => {
    const created = await post('/vendor-credits', {
      vendorId,
      vendorCreditDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: invItem,
          rate: 100,
          quantity: 2,
          costAccountId: 1019,
        },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const beforeInv = await invTxns('VendorCredit', id);
    const beforeGL = await ledgerRows('VendorCredit', id);
    const beforeAmount = await db('VENDOR_CREDITS')
      .where('ID', id)
      .select('AMOUNT');
    // Control: the create path really did write inventory, so the edit below is
    // rewriting something rather than asserting over an empty set.
    expect(beforeInv.length).toBeGreaterThan(0);

    const inner = app.get(VendorCreditInventoryTransactions);
    jest
      .spyOn(inner, 'editInventoryTransactions')
      .mockRejectedValue(new Error('STAGE0_VC_INV_EDIT_FAILED'));

    const res = await put(`/vendor-credits/${id}`, {
      vendorId,
      vendorCreditDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: invItem,
          rate: 999,
          quantity: 7,
          costAccountId: 1019,
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(await invTxns('VendorCredit', id)).toEqual(beforeInv);
    expect(await ledgerRows('VendorCredit', id)).toEqual(beforeGL);
    expect(await db('VENDOR_CREDITS').where('ID', id).select('AMOUNT')).toEqual(
      beforeAmount,
    );
  });

  it('2. VENDOR CREDIT CREATE: inventory write failure rolls the vendor credit back', async () => {
    const inventory = app.get(InventoryTransactionsService);
    jest
      .spyOn(inventory, 'recordInventoryTransactions')
      .mockRejectedValue(new Error('STAGE0_VC_INV_FAILED'));

    const ref = `F-VC-${Date.now()}`;
    const res = await post('/vendor-credits', {
      vendorId,
      vendorCreditDate: DATE,
      exchangeRate: 1,
      open: true,
      referenceNo: ref,
      entries: [
        {
          index: 1,
          itemId: invItem,
          rate: 100,
          quantity: 3,
          costAccountId: 1019,
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await db('VENDOR_CREDITS')
      .where('REFERENCE_NO', ref)
      .select('ID');
    expect(rows.length).toBe(0);
    // and no inventory rows for any vendor credit created in this test
    const orphan = await db('INVENTORY_TRANSACTIONS')
      .where({ TRANSACTION_TYPE: 'VendorCredit', ITEM_ID: invItem })
      .andWhere('QUANTITY', 3)
      .select('ID');
    expect(orphan.length).toBe(0);
  });
});

describe('Stage 0 final: strengthened reversal proof', () => {
  it('3. LANDED COST CREATE: cost-sync failure aborts the owning transaction and rolls it back', async () => {
    await inTenantContext(async () => {
      // Blocker 3: events.billLandedCost.onCreated was unannotated, so a failed
      // cost-transaction increment was swallowed and the allocation reported
      // success with the source cost transaction left un-incremented.
      // Two sibling subscribers listen to the same event and need a fuller
      // fixture than this probe builds; neutralize them so the propagated error
      // is unambiguously the one raised by the handler under test.
      jest
        .spyOn(
          app.get(LandedCostGLEntriesSubscriber),
          'writeGLEntriesOnceLandedCostCreated',
        )
        .mockResolvedValue(undefined);
      jest
        .spyOn(
          app.get(LandedCostInventoryTransactionsSubscriber),
          'writeInventoryTransactionsOnceCreated',
        )
        .mockResolvedValue(undefined);

      const sync = app.get(LandedCostSyncCostTransactions);
      jest
        .spyOn(sync, 'incrementLandedCostAmount')
        .mockRejectedValue(new Error('STAGE0_LANDED_COST_SYNC_FAILED'));

      const marker = `STAGE0-LC-${Date.now()}`;
      const emitter = app.get(EventEmitter2);
      let caught: any = null;
      try {
        await uow.withTransaction(async (trx: Knex.Transaction) => {
          // A real write on the owning transaction, so the rollback is
          // observable in the database rather than only inferred.
          await trx.raw(
            'UPDATE `ACCOUNTS` SET `DESCRIPTION` = ? WHERE `ID` = 1000',
            [marker],
          );
          const [before] = await trx.raw(
            'SELECT `DESCRIPTION` d FROM `ACCOUNTS` WHERE `ID` = 1000',
          );
          expect(before[0].d).toBe(marker);

          // Real event, real registered subscriber, real annotation.
          await emitter.emitAsync(events.billLandedCost.onCreated, {
            billLandedCost: {
              fromTransactionType: 'Bill',
              fromTransactionId: 1,
              fromTransactionEntryId: 1,
              amount: 100,
            },
            trx,
          });
          return 'SHOULD_NOT_REACH';
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeDefined();
      expect(String(caught.message)).toContain(
        'STAGE0_LANDED_COST_SYNC_FAILED',
      );

      // The owning transaction rolled back: the in-transaction write is gone.
      const [after] = await db.raw(
        'SELECT `DESCRIPTION` d FROM `ACCOUNTS` WHERE `ID` = 1000',
      );
      expect(after[0].d).not.toBe(marker);
    });
  });

  it('5A. CREDIT NOTE REVERSAL runs INSIDE the owning transaction (rollback restores deleted rows)', async () => {
    const created = await post('/credit-notes', {
      customerId,
      creditNoteDate: DATE,
      exchangeRate: 1,
      open: true,
      entries: [
        {
          index: 1,
          itemId: svcItem,
          rate: 300,
          quantity: 1,
          sellAccountId: 1026,
        },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const beforeGL = await ledgerRows('CreditNote', id);
    expect(beforeGL.length).toBeGreaterThan(0);

    // Let deleteEntries actually DELETE, then fail the step that runs after it
    // inside LedgerStorage.delete (entries -> account balances -> contact
    // balances). If the reversal were running outside the owning transaction,
    // the deletion would already be committed and the rows could not come back.
    const contacts = app.get(LedgerContactsBalanceStorage);
    jest
      .spyOn(contacts, 'saveContactsBalance')
      .mockRejectedValue(new Error('STAGE0_AFTER_REVERSAL_FAILED'));

    const res = await del(`/credit-notes/${id}`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The deleted GL rows were restored by the rollback -> the DELETE SQL was
    // part of the owning transaction.
    expect(await ledgerRows('CreditNote', id)).toEqual(beforeGL);
    expect((await db('CREDIT_NOTES').where('ID', id).select('ID')).length).toBe(
      1,
    );
  });
});

describe('Stage 0 final: payment received keeps AR account creation in-transaction', () => {
  it('4. a rolled-back payment leaves no newly created A/R account behind', async () => {
    // NOTE ON REACHABILITY: this cannot be driven from the HTTP payment endpoint.
    // A payment requires a delivered invoice, and delivering an invoice already
    // calls findOrCreateAccountReceivable for that currency - so by the time a
    // payment runs, the A/R account always exists. The defect is therefore
    // exercised against the real service inside a real UnitOfWork transaction,
    // using a currency that has no receivable account yet.
    const CURRENCY = 'CAD';

    await inTenantContext(async () => {
      const existing = await db('ACCOUNTS')
        .where({ ACCOUNT_TYPE: 'accounts-receivable', CURRENCY_CODE: CURRENCY })
        .select('ID');
      expect(existing.length).toBe(0); // precondition: no CAD receivable yet

      const glEntries = app.get(PaymentReceivedGLEntries);
      const entries = app.get(LedgerEntriesStorageService);
      jest
        .spyOn(entries, 'saveEntries')
        .mockRejectedValue(new Error('STAGE0_AR_LEDGER_FAILED'));

      let caught: any = null;
      try {
        await uow.withTransaction(async (trx: Knex.Transaction) => {
          // Real production path: builds the ledger, creating the A/R account
          // for this currency, then persists it (which we force to fail).
          const ledger = await glEntries.getPaymentReceiveGLedger(
            {
              id: 999001,
              currencyCode: CURRENCY,
              exchangeRate: 1,
              entries: [],
              customerId,
            } as any,
            'USD',
            trx,
          );
          await entries.saveEntries(ledger, trx);
          return 'SHOULD_NOT_REACH';
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeDefined();
      // The A/R account insert was rolled back with the owning transaction.
      const after = await db('ACCOUNTS')
        .where({ ACCOUNT_TYPE: 'accounts-receivable', CURRENCY_CODE: CURRENCY })
        .select('ID');
      expect(after.length).toBe(0);
      const orphanLedger = await db('ACCOUNTS_TRANSACTIONS')
        .where({ REFERENCE_TYPE: 'PaymentReceive', REFERENCE_ID: 999001 })
        .select('ID');
      expect(orphanLedger.length).toBe(0);
    });
  });
});

describe('Stage 0 final: COGS old-cost reversal via the real subscriber', () => {
  it('5B. real event -> subscriber -> reversal failure aborts the owning flow', async () => {
    await inTenantContext(async () => {
      // InventoryCostGLStorage is not reliably reachable via app.get() for
      // spying (the subscriber holds its own injected reference), so the fault
      // is injected at the leaf the reversal funnels through:
      // revertInventoryCostGLEntries -> ledgerStorage.delete -> deleteEntries.
      const entries = app.get(LedgerEntriesStorageService);
      jest
        .spyOn(entries, 'deleteEntries')
        .mockRejectedValue(new Error('STAGE0_COGS_REVERSAL_FAILED'));
      const writeSpy = jest.spyOn(entries, 'saveEntries');

      const emitter = app.get(EventEmitter2);
      let caught: any = null;
      try {
        await uow.withTransaction(async (trx: Knex.Transaction) => {
          // Real event, real registered subscriber
          // (InventoryCostGLBeforeWriteSubscriber), real annotation.
          await emitter.emitAsync(
            events.inventory.onCostLotsGLEntriesBeforeWrite,
            {
              startingDate: new Date(DATE),
              trx,
            },
          );
          return 'SHOULD_NOT_REACH';
        });
      } catch (e) {
        caught = e;
      }

      // The subscriber propagated instead of swallowing, so the owning flow
      // aborted and the new-cost posting never ran.
      expect(caught).toBeDefined();
      expect(String(caught.message)).toContain('STAGE0_COGS_REVERSAL_FAILED');
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });
});
