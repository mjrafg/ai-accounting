import { Knex } from 'knex';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ILedger } from './types/Ledger.types';
import { LedgerContactsBalanceStorage } from './LedgerContactStorage.service';
import { LedegrAccountsStorage } from './LedgetAccountStorage.service';
import { LedgerEntriesStorageService } from './LedgerEntriesStorage.service';
import { AccountTransaction } from '../Accounts/models/AccountTransaction.model';
import { Ledger } from './Ledger';
import { TenantModelProxy } from '../System/models/TenantBaseModel';

@Injectable()
export class LedgerStorageService {
  private readonly logger = new Logger(LedgerStorageService.name);

  /**
   * @param {LedgerContactsBalanceStorage} ledgerContactsBalance - Ledger contacts balance storage.
   * @param {LedegrAccountsStorage} ledgerAccountsBalance - Ledger accounts balance storage.
   * @param {LedgerEntriesStorageService} ledgerEntriesService - Ledger entries storage service.
   */
  constructor(
    private ledgerContactsBalance: LedgerContactsBalanceStorage,
    private ledgerAccountsBalance: LedegrAccountsStorage,
    private ledgerEntriesService: LedgerEntriesStorageService,

    @Inject(AccountTransaction.name)
    private accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,
  ) {}

  /**
   * Commit the ledger to the storage layer as one unit-of-work.
   * @param {ILedger} ledger
   * @returns {Promise<void>}
   */
  public commit = async (
    ledger: ILedger,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Sequential and awaited, not Promise.all: all three storages write on the
    // same Knex transaction, and a rejection in one of a Promise.all set leaves
    // the others running. If a later storage fails, the enclosing UnitOfWork
    // transaction now rolls back the earlier writes as well.
    try {
      // 1. Saves the ledger entries.
      await this.ledgerEntriesService.saveEntries(ledger, trx);

      // 2. Mutates the associated accounts balances.
      await this.ledgerAccountsBalance.saveAccountsBalance(ledger, trx);

      // 3. Mutates the associated contacts balances.
      await this.ledgerContactsBalance.saveContactsBalance(ledger, trx);
    } catch (error) {
      this.logger.error(
        `LEDGER_WRITE_FAILED operation=commit entries=${ledger.getEntries().length}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  };

  /**
   * Deletes the given ledger and revert balances.
   * @param {number} tenantId
   * @param {ILedger} ledger
   * @param {Knex.Transaction} trx
   * @returns {Promise<void>}
   */
  public delete = async (ledger: ILedger, trx?: Knex.Transaction) => {
    // Sequential and awaited, for the same reason as `commit` above.
    try {
      // 1. Deletes the ledger entries.
      await this.ledgerEntriesService.deleteEntries(ledger, trx);

      // 2. Mutates the associated accounts balances.
      await this.ledgerAccountsBalance.saveAccountsBalance(ledger, trx);

      // 3. Mutates the associated contacts balances.
      await this.ledgerContactsBalance.saveContactsBalance(ledger, trx);
    } catch (error) {
      this.logger.error(
        `LEDGER_WRITE_FAILED operation=delete entries=${ledger.getEntries().length}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  };

  /**
   * Deletes the ledger entries by the given reference.
   * @param {number | number[]} referenceId - The reference ID.
   * @param {string | string[]} referenceType - The reference type.
   * @param {Knex.Transaction} trx - The knex transaction.
   */
  public deleteByReference = async (
    referenceId: number | number[],
    referenceType: string | string[],
    trx?: Knex.Transaction,
  ) => {
    // Retrieves the transactions of the given reference.
    const transactions = await this.accountTransactionModel()
      .query(trx)
      .modify('filterByReference', referenceId, referenceType)
      .withGraphFetched('account');

    // Creates a new ledger from transaction and reverse the entries.
    const reversedLedger = Ledger.fromTransactions(transactions).reverse();

    // Deletes and reverts the balances.
    await this.delete(reversedLedger, trx);
  };
}
