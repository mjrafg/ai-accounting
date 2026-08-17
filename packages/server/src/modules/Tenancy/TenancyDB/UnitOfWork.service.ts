import { Transaction } from 'objection';
import { Knex } from 'knex';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IsolationLevel } from './TransactionsHooks';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';

@Injectable()
export class UnitOfWork {
  private readonly logger = new Logger(UnitOfWork.name);

  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKex: () => Knex,
  ) {}

  /**
   * Runs the given work inside a database transaction, using Knex's MANAGED
   * transaction form. Success is returned to the caller only after the
   * transaction has actually committed.
   *
   * Why managed rather than manual commit/rollback
   * ----------------------------------------------
   * The previous implementation created the transaction by hand and called
   * `commit()` / `rollback()` without awaiting them, so `withTransaction` could
   * resolve before the transaction completed, and a COMMIT that failed
   * afterwards was never surfaced.
   *
   * Awaiting `commit()` is not sufficient either. Measured on knex 3.1.0 /
   * mysql 2.18.1, over 10 runs, when the transaction's connection dies before
   * COMMIT is dispatched:
   *
   *   await trx.commit()      -> RESOLVED(undefined)   (no COMMIT in the general log)
   *   trx.executionPromise    -> REJECTED
   *   rows persisted          -> 0
   *
   * i.e. `commit()` reports success for a transaction that never committed. The
   * managed form waits on the transaction's own completion promise, so that
   * failure reaches the caller. A four-pattern comparison (manual commit;
   * commit + executionPromise; awaited commit + executionPromise; managed) found
   * the managed form to be the only one correct in all of: normal commit,
   * connection death, and work failure.
   *
   * Deliberately NOT used as a durability check: `isCompleted()`, connection
   * pings or liveness probes. None of those prove a commit was durable.
   *
   * Ordinary database failures (deadlock 1213, lock wait timeout 1205, FK
   * violations) surface as statement errors inside `work` and are propagated by
   * the same path; InnoDB has no deferred constraints, so there is no separate
   * "constraint fails at COMMIT" case to handle.
   *
   * Behavioural guarantees:
   *   success        -> commits, caller resolves, after-transaction hooks run
   *   work failure   -> rolls back, ORIGINAL error reaches the caller, hooks do NOT run
   *   commit failure -> rejects, caller never sees success, hooks do NOT run
   *
   * The hook behaviour matters: `runAfterTransaction` keys off
   * `trx.executionPromise`, and under the managed form that promise rejects on
   * rollback instead of resolving. See ./TransactionsHooks.
   *
   * Isolation level, CLS `organizationId`, tenant routing, nested-transaction
   * semantics and return-value semantics are all unchanged.
   *
   * @param {function} work - The work to be done in the transaction.
   * @param {Transaction} trx - Existing transaction to join, if any.
   * @param {IsolationLevel} isolationLevel
   */
  public withTransaction = async <T>(
    work: (knex: Knex.Transaction) => Promise<T> | T,
    trx?: Transaction,
    isolationLevel: IsolationLevel = IsolationLevel.READ_UNCOMMITTED,
  ): Promise<T> => {
    // Joining an outer transaction: the outermost caller owns commit/rollback.
    if (trx) {
      return (await work(trx)) as T;
    }
    const knex = this.tenantKex();

    try {
      return (await knex.transaction<T>(
        async (managedTrx: Knex.Transaction) => (await work(managedTrx)) as T,
        { isolationLevel },
      )) as T;
    } catch (error) {
      // Knex has already rolled back at this point. The error is re-thrown
      // unchanged so callers keep the original error identity; this catch exists
      // only to record the boundary failure.
      this.logger.error(
        `UOW_TRANSACTION_FAILED reason=${this.describe(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  };

  /** Short, non-sensitive description of an error for boundary logging. */
  private describe(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}${(error as any).code ? `:${(error as any).code}` : ''}`;
    }
    return typeof error;
  }
}
