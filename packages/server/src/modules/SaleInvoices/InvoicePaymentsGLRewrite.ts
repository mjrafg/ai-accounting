import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { PaymentReceivedGLEntries } from '../PaymentReceived/commands/PaymentReceivedGLEntries';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { PaymentReceivedEntry } from '../PaymentReceived/models/PaymentReceivedEntry';

@Injectable()
export class InvoicePaymentsGLEntriesRewrite {
  constructor(
    private readonly paymentGLEntries: PaymentReceivedGLEntries,

    @Inject(PaymentReceivedEntry.name)
    private readonly paymentReceivedEntryModel: TenantModelProxy<
      typeof PaymentReceivedEntry
    >,
  ) {}

  /**
   * Rewrites the payment GL entries task.
   * @param   {{ tenantId: number, paymentId: number, trx: Knex?.Transaction }}
   * @returns {Promise<void>}
   */
  public rewritePaymentsGLEntriesTask = async ({ paymentId, trx }) => {
    await this.paymentGLEntries.rewritePaymentGLEntries(paymentId, trx);
  };

  /**
   * Rewrites the payment GL entries of the given payments ids.
   * @param {number[]} paymentsIds
   * @param {Knex.Transaction} trx
   */
  public rewritePaymentsGLEntriesQueue = async (
    paymentsIds: number[],
    trx?: Knex.Transaction,
  ) => {
    // Sequential and awaited on purpose. The previous `async.queue(..., 10)`
    // drained with `queue.drain()`, which resolves even when a worker threw and
    // had no `queue.error` handler, so a failed payment GL rewrite was silently
    // swallowed and the invoice edit still reported success. All rewrites run
    // on the same Knex transaction, so there was no real concurrency to lose.
    for (const paymentId of paymentsIds) {
      await this.rewritePaymentsGLEntriesTask({ paymentId, trx });
    }
  };

  /**
   * Rewrites the payments GL entries that associated to the given invoice.
   * @param {number} invoiceId
   * @param {Knex.Transaction} trx
   * @ {Promise<void>}
   */
  public invoicePaymentsGLEntriesRewrite = async (
    invoiceId: number,
    trx?: Knex.Transaction,
  ) => {
    const invoicePaymentEntries = await this.paymentReceivedEntryModel()
      .query()
      .where('invoiceId', invoiceId);

    const paymentsIds = invoicePaymentEntries.map((e) => e.paymentReceiveId);

    await this.rewritePaymentsGLEntriesQueue(paymentsIds, trx);
  };
}
