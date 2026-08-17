import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { transformLedgerEntryToTransaction } from './utils';
import { ILedgerEntry } from './types/Ledger.types';
import { ILedger } from './types/Ledger.types';
import { AccountTransaction } from '../Accounts/models/AccountTransaction.model';
import { TenantModelProxy } from '../System/models/TenantBaseModel';

// Filter the blank entries.
const filterBlankEntry = (entry: ILedgerEntry) =>
  Boolean(entry.credit || entry.debit);

@Injectable()
export class LedgerEntriesStorageService {
  /**
   * @param {TenantModelProxy<typeof AccountTransaction>} accountTransactionModel - Account transaction model.
   */
  constructor(
    @Inject(AccountTransaction.name)
    private readonly accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,
  ) {}

  /**
   * Saves entries of the given ledger.
   * @param {ILedger} ledger - Ledger.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public saveEntries = async (ledger: ILedger, trx?: Knex.Transaction) => {
    const entries = ledger.filter(filterBlankEntry).getEntries();

    // Sequential and awaited on purpose.
    //
    // This previously used `async.queue(..., 10)` drained with `queue.drain()`.
    // `drain()` resolves when the queue empties regardless of whether a worker
    // threw, and no `queue.error` handler was registered, so an insert failure
    // was swallowed: the caller saw success, the enclosing transaction was
    // committed, and a partially-written ledger was persisted.
    //
    // The concurrency was illusory anyway - every entry is written on the same
    // Knex transaction/connection, and the driver serialises statements on it.
    // A plain loop keeps the ordering, and the first failure now propagates to
    // LedgerStorageService and rolls the transaction back.
    for (const entry of entries) {
      await this.saveEntry(entry, trx);
    }
  };

  /**
   * Deletes the ledger entries.
   * @param {ILedger} ledger - Ledger.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public deleteEntries = async (ledger: ILedger, trx?: Knex.Transaction) => {
    const entriesIds = ledger
      .getEntries()
      .filter((e) => e.entryId)
      .map((e) => e.entryId);

    await this.accountTransactionModel()
      .query(trx)
      .whereIn('id', entriesIds)
      .delete();
  };

  /**
   * Saves the ledger entry to the account transactions repository.
   * @param {ILedgerEntry} entry - Ledger entry.
   * @param {Knex.Transaction} trx
   * @returns {Promise<void>}
   */
  private saveEntry = async (
    entry: ILedgerEntry,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const transaction = transformLedgerEntryToTransaction(entry);

    await this.accountTransactionModel().query(trx).insert(transaction);
  };
}
