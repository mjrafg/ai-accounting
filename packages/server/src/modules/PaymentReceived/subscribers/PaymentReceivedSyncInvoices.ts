import {
  IPaymentReceivedCreatedPayload,
  IPaymentReceivedDeletedPayload,
  IPaymentReceivedEditedPayload,
} from '../types/PaymentReceived.types';
import { PaymentReceivedInvoiceSync } from '../commands/PaymentReceivedInvoiceSync.service';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';

@Injectable()
export class PaymentReceivedSyncInvoicesSubscriber {
  /**
   * @param {PaymentReceivedInvoiceSync} paymentSyncInvoice -
   */
  constructor(
    private readonly paymentSyncInvoice: PaymentReceivedInvoiceSync,
  ) {}

  /**
   * Handle sale invoice increment/decrement payment amount
   * once created, edited or deleted.
   */
  @OnEvent(events.paymentReceive.onCreated, { suppressErrors: false })
  private async handleInvoiceIncrementPaymentOnceCreated({
    paymentReceive,
    trx,
  }: IPaymentReceivedCreatedPayload) {
    await this.paymentSyncInvoice.saveChangeInvoicePaymentAmount(
      paymentReceive.entries,
      null,
      trx,
    );
  }

  /**
   * Handle sale invoice increment/decrement payment amount once edited.
   */
  @OnEvent(events.paymentReceive.onEdited, { suppressErrors: false })
  private async handleInvoiceIncrementPaymentOnceEdited({
    paymentReceive,
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedEditedPayload) {
    await this.paymentSyncInvoice.saveChangeInvoicePaymentAmount(
      paymentReceive.entries,
      oldPaymentReceive?.entries || null,
      trx,
    );
  }

  /**
   * Handle revert invoices payment amount once payment receive deleted.
   */
  @OnEvent(events.paymentReceive.onDeleted, { suppressErrors: false })
  private async handleInvoiceDecrementPaymentAmount({
    paymentReceiveId,
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedDeletedPayload) {
    await this.paymentSyncInvoice.saveChangeInvoicePaymentAmount(
      oldPaymentReceive.entries.map((entry) => ({
        ...entry,
        paymentAmount: 0,
      })),
      oldPaymentReceive.entries,
      trx,
    );
  }
}
