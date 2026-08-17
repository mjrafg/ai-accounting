/**
 * Stage 0 - MariaDB thread proof for the payment-received A/R fix.
 *
 * Proves at the connection level that when a Payment Received has to create the
 * A/R account for its currency, that INSERT happens on the same MariaDB thread,
 * inside the same transaction, as the payment itself - so a later failure rolls
 * the account back instead of leaving an orphan behind.
 */
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Knex } from 'knex';
import * as knexFactory from 'knex';
import { AppModule } from '../src/modules/App/App.module';
import { LedgerEntriesStorageService } from '../src/modules/Ledger/LedgerEntriesStorage.service';

jest.setTimeout(300000);
const DATE = '2027-06-01';
const CURRENCY = 'CAD';
let app: INestApplication;
let db: Knex;
let meta: Knex;
let org: string;
let hdr: string;
const H = (r: any) => r.set('organization-id', org).set('Authorization', hdr);
const R = () => request(app.getHttpServer());

beforeAll(async () => {
  const mf = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mf.createNestApplication();
  await app.init();
  const s = await R()
    .post('/auth/signin')
    .send({ email: 'bigcapital@bigcapital.com', password: '123123123' });
  org = s.body.organization_id;
  hdr = `Bearer ${s.body.access_token}`;
  const conn = (d: string) => ({
    client: 'mysql',
    connection: {
      host: 'mariadb',
      port: 3306,
      user: 'root',
      password: 'root',
      database: d,
      charset: 'utf8',
    },
    pool: { min: 0, max: 4 },
  });
  db = (knexFactory as any)(conn(`bigcapital_tenant_${org}`));
  meta = (knexFactory as any)(conn('mysql'));
});
afterAll(async () => {
  try {
    await meta.raw('SET GLOBAL general_log=OFF');
  } catch {}
  await meta.destroy();
  await db.destroy();
  await app.close();
});

it('C. real Payment Received HTTP flow: AR INSERT and ROLLBACK on one thread', async () => {
  await meta.raw("SET GLOBAL log_output='TABLE'");
  await meta.raw('SET GLOBAL general_log=ON');
  const [gl] = await meta.raw("SHOW VARIABLES LIKE 'general_log'");
  const [lo] = await meta.raw("SHOW VARIABLES LIKE 'log_output'");
  console.log(`  general_log=${gl[0].Value} log_output=${lo[0].Value}`);

  // Unique, log-greppable marker carried by the payment.
  const MARKER = `STAGE0PAY${String(Date.now()).slice(-8)}`;

  const item = await H(R().post('/items')).send({
    name: `PAY-${MARKER}`,
    type: 'service',
    sellable: true,
    purchasable: true,
    sellPrice: 500,
    costPrice: 100,
    sellAccountId: 1026,
    costAccountId: 1020,
  });
  const itemId = parseInt(item.body.id, 10);
  const cust = await H(R().post('/customers')).send({
    displayName: `PAYC-${MARKER}`,
    currencyCode: CURRENCY,
    customerType: 'business',
  });
  const customerId = cust.body.id;

  // Delivering the invoice creates the CAD A/R account and commits it, so the
  // payment alone would never have to create one. Remove it to restore the
  // real-world precondition: a payment for a currency with no A/R account yet.
  const inv = await H(R().post('/sale-invoices')).send({
    customerId,
    invoiceDate: DATE,
    dueDate: DATE,
    delivered: true,
    exchangeRate: 1,
    entries: [
      { index: 1, itemId, rate: 500, quantity: 1, sellAccountId: 1026 },
    ],
  });
  const invoiceId = inv.body.id;
  console.log(`  invoice create -> HTTP ${inv.status} id=${invoiceId}`);

  const arRows = await db('ACCOUNTS')
    .where({ ACCOUNT_TYPE: 'accounts-receivable', CURRENCY_CODE: CURRENCY })
    .select('ID', 'SLUG');
  console.log(
    `  ${CURRENCY} A/R accounts created by the invoice: ${JSON.stringify(arRows)}`,
  );
  await db('ACCOUNTS_TRANSACTIONS')
    .whereIn(
      'ACCOUNT_ID',
      arRows.map((r: any) => r.ID),
    )
    .delete();
  await db('ACCOUNTS')
    .whereIn(
      'ID',
      arRows.map((r: any) => r.ID),
    )
    .delete();
  const preCount = await db('ACCOUNTS')
    .where({ ACCOUNT_TYPE: 'accounts-receivable', CURRENCY_CODE: CURRENCY })
    .count({ c: 'ID' });
  console.log(
    `  precondition: ${CURRENCY} A/R accounts now = ${preCount[0].c}`,
  );

  // Force the ledger persistence step of the payment to fail.
  const entries = app.get(LedgerEntriesStorageService);
  jest
    .spyOn(entries, 'saveEntries')
    .mockRejectedValue(new Error('STAGE0_PAY_LEDGER_FAILED'));

  await meta.raw('TRUNCATE mysql.general_log');
  const pay = await H(R().post('/payments-received')).send({
    customerId,
    paymentDate: DATE,
    exchangeRate: 1,
    depositAccountId: 1000,
    paymentReceiveNo: MARKER,
    referenceNo: MARKER,
    entries: [{ index: 1, invoiceId, paymentAmount: 100 }],
  });
  console.log(`  payment POST -> HTTP ${pay.status}`);
  expect(pay.status).toBeGreaterThanOrEqual(400);

  // ---- general_log: locate the thread that INSERTed the A/R account ----
  const [threads] = await meta.raw(
    `SELECT DISTINCT thread_id FROM mysql.general_log
     WHERE command_type='Query'
       AND CONVERT(argument USING utf8) LIKE '%insert into \`ACCOUNTS\`%'
       AND CONVERT(argument USING utf8) LIKE '%accounts-receivable%'
       AND CONVERT(argument USING utf8) NOT LIKE '%mysql.general_log%'`,
  );
  console.log(
    `  threads that INSERTed an A/R account: ${threads.map((t: any) => t.thread_id).join(', ') || '(none)'}`,
  );

  const traces: Array<{ thread: number; ops: string[] }> = [];
  for (const t of threads) {
    const [seq] = await meta.raw(
      `SELECT CONVERT(argument USING utf8) a, event_time FROM mysql.general_log
       WHERE command_type='Query' AND thread_id=? ORDER BY event_time, thread_id`,
      [t.thread_id],
    );
    const ops: string[] = [];
    for (const row of seq) {
      const a = String(row.a);
      if (/^BEGIN/i.test(a)) ops.push('BEGIN');
      else if (/^COMMIT/i.test(a)) ops.push('COMMIT');
      else if (/^ROLLBACK/i.test(a)) ops.push('ROLLBACK');
      else if (
        /insert into `ACCOUNTS`/i.test(a) &&
        /accounts-receivable/.test(a)
      )
        ops.push('AR_ACCOUNT_INSERT');
      else if (/from `ACCOUNTS`/i.test(a) && /accounts-receivable/.test(a))
        ops.push('AR_ACCOUNT_LOOKUP');
      else if (
        new RegExp(MARKER).test(a) &&
        /insert into `PAYMENT_RECEIVES`/i.test(a)
      )
        ops.push('PAYMENT_INSERT');
      else if (/insert into `PAYMENT_RECEIVES_ENTRIES`/i.test(a))
        ops.push('PAYMENT_ENTRIES_INSERT');
      else if (/update `SALE_INVOICES`/i.test(a)) ops.push('INVOICE_UPDATE');
    }
    // collapse consecutive duplicates for readability
    const collapsed = ops.filter((o, i) => o !== ops[i - 1]);
    console.log(`  thread ${t.thread_id}: ${collapsed.join(' -> ')}`);
    traces.push({ thread: t.thread_id, ops: collapsed });
  }

  // Exactly one real connection created the A/R account, and it did so between
  // its own BEGIN and ROLLBACK - never on a separate pooled connection.
  expect(traces.length).toBe(1);
  const trace = traces[0].ops;
  console.log(`  PROOF thread ${traces[0].thread}: ${trace.join(' -> ')}`);
  expect(trace[0]).toBe('BEGIN');
  expect(trace[trace.length - 1]).toBe('ROLLBACK');
  expect(trace).toContain('AR_ACCOUNT_INSERT');
  expect(trace).toContain('PAYMENT_INSERT');
  expect(trace.indexOf('AR_ACCOUNT_INSERT')).toBeGreaterThan(
    trace.indexOf('BEGIN'),
  );
  expect(trace.indexOf('AR_ACCOUNT_INSERT')).toBeLessThan(
    trace.indexOf('ROLLBACK'),
  );
  expect(trace).not.toContain('COMMIT');

  // ---- direct post-rollback DB state ----
  const payRows = await db('PAYMENT_RECEIVES').where({
    PAYMENT_RECEIVE_NO: MARKER,
  });
  const arAfter = await db('ACCOUNTS').where({
    ACCOUNT_TYPE: 'accounts-receivable',
    CURRENCY_CODE: CURRENCY,
  });
  const ledgerAfter = await db('ACCOUNTS_TRANSACTIONS')
    .where({ REFERENCE_TYPE: 'PaymentReceive' })
    .andWhere('REFERENCE_ID', '>', 0)
    .andWhere('CURRENCY_CODE', CURRENCY);
  const invAfter = await db('SALES_INVOICES').where({ ID: invoiceId }).first();
  console.log(
    `  post-rollback: payments=${payRows.length} arAccounts=${JSON.stringify(arAfter.map((r: any) => r.ID))} ledgerRows=${ledgerAfter.length} invoiceRow=${invAfter ? `paymentAmount=${invAfter.PAYMENT_AMOUNT}` : 'MISSING'}`,
  );

  expect(payRows.length).toBe(0);
  expect(arAfter.length).toBe(0);
  expect(ledgerAfter.length).toBe(0);
  expect(Number(invAfter.PAYMENT_AMOUNT)).toBe(0);
});
