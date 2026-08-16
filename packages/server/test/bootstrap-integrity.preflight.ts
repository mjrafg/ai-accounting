/**
 * Stage -1 BOOTSTRAP INTEGRITY PREFLIGHT.
 *
 * Deliberately NOT named `*.e2e-spec.ts` so that it is never picked up by the
 * suite's own discovery. The isolated runner invokes it explicitly, once, before
 * any spec runs, and aborts the whole run (harness exit code 2) if it fails.
 *
 * It must run *inside Jest*, because the subscriber-truncation defect it guards
 * against only reproduces inside the Jest VM realm.
 *
 * WHAT IT GUARANTEES (and what it deliberately does not)
 * -----------------------------------------------------
 * It is NOT a "221 events / 500 listeners forever" invariant. Subscriber counts
 * legitimately change whenever a feature is added, and pinning them here would
 * turn ordinary development into a harness failure.
 *
 * It asserts only the properties that make E2E results *trustworthy*:
 *   1. the application bootstrapped without throwing;
 *   2. registration was not obviously truncated (floors, not exact equality);
 *   3. every critical accounting event actually has at least one listener --
 *      this is the check that would have caught the original defect, where
 *      `onSaleInvoiceCreated` had 0 listeners and invoices posted no ledger.
 *
 * The *exact* listener signature is emitted as JSON for the runner to record in
 * the Stage -1 baseline. Drift in that signature is reported as REVIEW_REQUIRED
 * by the comparison step, not as a hard failure here.
 */

import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/modules/App/App.module';

/**
 * Events whose absence silently invalidates accounting results. Each of these
 * is a post-commit hook that writes ledger entries, inventory transactions or
 * balance mutations. If any has zero listeners, the suite is measuring an
 * application that does not do accounting.
 */
const CRITICAL_ACCOUNTING_EVENTS = [
  'onSaleInvoiceCreated',
  'onSaleInvoiceEdited',
  'onSaleInvoiceDeleted',
  'onBillCreated',
  'onBillEdited',
  'onPaymentReceiveCreated',
  'onBillPaymentCreated',
  'onCreditNoteCreated',
  'onVendorCreditCreated',
  'onManualJournalCreated',
  'onExpenseCreated',
  'onSaleReceiptsCreated',
  'onInventoryTransactionsCreated',
];

/**
 * Truncation floors. Measured healthy boot is 221 unique events / 500 listeners;
 * the broken boot was 36 / 63. These floors sit far below healthy and far above
 * broken, so they detect truncation without breaking on normal feature growth.
 */
const MIN_UNIQUE_EVENT_NAMES = 150;
const MIN_TOTAL_LISTENERS = 350;

jest.setTimeout(300000);

describe('Stage -1 bootstrap integrity preflight', () => {
  let app: INestApplication;
  let bootstrapError: string | null = null;

  beforeAll(async () => {
    try {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    } catch (error: any) {
      bootstrapError = `${error?.constructor?.name}: ${error?.message}`;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('bootstraps the application without throwing', () => {
    expect(bootstrapError).toBeNull();
    expect(app).toBeDefined();
  });

  it('registers subscribers without obvious truncation', () => {
    const emitter = app.get(EventEmitter2);
    const names = emitter.eventNames();
    let totalListeners = 0;
    for (const name of names) {
      totalListeners += emitter.listeners(name as any).length;
    }
    expect(names.length).toBeGreaterThanOrEqual(MIN_UNIQUE_EVENT_NAMES);
    expect(totalListeners).toBeGreaterThanOrEqual(MIN_TOTAL_LISTENERS);
  });

  it('registers at least one listener for every critical accounting event', () => {
    const emitter = app.get(EventEmitter2);
    const missing = CRITICAL_ACCOUNTING_EVENTS.filter(
      (event) => emitter.listeners(event as any).length === 0,
    );
    expect(missing).toEqual([]);
  });

  it('emits the listener signature for the baseline', () => {
    const emitter = app.get(EventEmitter2);
    const perEvent: Record<string, number> = {};
    let totalListeners = 0;
    for (const name of emitter.eventNames()) {
      const key = Array.isArray(name) ? name.join('.') : String(name);
      const count = emitter.listeners(name as any).length;
      perEvent[key] = count;
      totalListeners += count;
    }
    const sorted: Record<string, number> = {};
    for (const key of Object.keys(perEvent).sort()) sorted[key] = perEvent[key];

    const signature = {
      uniqueEventNames: Object.keys(sorted).length,
      totalListenerRegistrations: totalListeners,
      maxListeners: emitter.getMaxListeners(),
      criticalAccountingEvents: Object.fromEntries(
        CRITICAL_ACCOUNTING_EVENTS.map((e) => [
          e,
          emitter.listeners(e as any).length,
        ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
      perEvent: sorted,
    };

    // Delimited so the runner can extract it from stdout deterministically.
    console.log(
      `__LISTENER_SIGNATURE_BEGIN__${JSON.stringify(
        signature,
      )}__LISTENER_SIGNATURE_END__`,
    );
    expect(signature.totalListenerRegistrations).toBeGreaterThan(0);
  });
});
