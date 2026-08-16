/**
 * Enumeration that represents transaction isolation levels for use with the {@link Transactional} annotation
 */
export enum IsolationLevel {
  /**
   * A constant indicating that dirty reads, non-repeatable reads and phantom reads can occur.
   */
  READ_UNCOMMITTED = 'read uncommitted',
  /**
   * A constant indicating that dirty reads are prevented; non-repeatable reads and phantom reads can occur.
   */
  READ_COMMITTED = 'read committed',
  /**
   * A constant indicating that dirty reads and non-repeatable reads are prevented; phantom reads can occur.
   */
  REPEATABLE_READ = 'repeatable read',
  /**
   * A constant indicating that dirty reads, non-repeatable reads and phantom reads are prevented.
   */
  SERIALIZABLE = 'serializable',
}

/**
 * @param {any} maybeTrx
 * @returns {maybeTrx is import('objection').TransactionOrKnex & { executionPromise: Promise<any> }}
 */
function checkIsTransaction(maybeTrx) {
  return Boolean(maybeTrx && maybeTrx.executionPromise);
}

/**
 * Wait for a transaction to be complete.
 * @param {import('objection').TransactionOrKnex} [trx]
 */
export async function waitForTransaction(trx) {
  return Promise.resolve(checkIsTransaction(trx) ? trx.executionPromise : null);
}

/**
 * Run a callback once the transaction has completed SUCCESSFULLY.
 *
 * The rejection arm below is load-bearing - do not delete it as dead code.
 *
 * It keys off `trx.executionPromise`, whose settlement is what distinguishes a
 * committed transaction from a rolled-back one:
 *
 *   executionPromise RESOLVES -> the transaction committed -> callback may run
 *   executionPromise REJECTS  -> rolled back / failed      -> callback MUST NOT run
 *
 * This only holds because `UnitOfWork` uses Knex's managed transaction form. A
 * bare `trx.rollback()` (no argument) RESOLVES `executionPromise` on knex 3.1.0,
 * which is indistinguishable from a successful commit - measured behaviour, and
 * the reason post-transaction side effects previously fired even when the
 * business transaction had been rolled back. Under the managed form the promise
 * rejects on rollback, so this arm is what actually suppresses those side
 * effects. See UnitOfWork.withTransaction.
 *
 * @param {import('objection').TransactionOrKnex | undefined} trx
 * @param {Function} callback
 */
export function runAfterTransaction(trx, callback) {
  waitForTransaction(trx).then(
    () => {
      // Transaction committed: run the after-transaction action.
      return Promise.resolve(callback()).catch((error) => {
        setTimeout(() => {
          throw error;
        });
      });
    },
    () => {
      // Transaction rolled back or failed: the callback must NOT run.
    },
  );
}
