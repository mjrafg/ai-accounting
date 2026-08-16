/**
 * TEST-ONLY compatibility shim for `process.emitWarning` under Jest.
 *
 * WHY THIS EXISTS
 * ---------------
 * `eventemitter2@6.4.9` (pinned transitively by `@nestjs/event-emitter@2.1.1`)
 * reports a listener-count overflow like this:
 *
 *     var e = new Error(errorMsg);
 *     e.name = 'MaxListenersExceededWarning';
 *     process.emitWarning(e);
 *
 * That is a legal Node call. But under `jest-environment-node` the test code
 * runs inside a V8 VM context, so the `Error` is constructed in a *different
 * realm* than the one Node's internals validate against. Node's argument check
 * fails and throws:
 *
 *     TypeError [ERR_INVALID_ARG_TYPE]: The "warning" argument must be of type
 *     string or an instance of Error. Received an instance of Error
 *
 * The throw escapes `EventEmitter.on()`, which aborts
 * `EventSubscribersLoader.loadEventListeners()` part-way through. The Nest
 * application is then left with only a fraction of its `@OnEvent` subscribers
 * registered. Measured on this repository:
 *
 *     normal boot : 221 unique events / 500 listeners / onSaleInvoiceCreated = 8
 *     under Jest  :  36 unique events /  63 listeners / onSaleInvoiceCreated = 0
 *
 * With zero listeners on `onSaleInvoiceCreated`, creating an invoice in an E2E
 * test writes NO ledger entries at all, so every accounting assertion in the
 * suite is meaningless.
 *
 * WHAT THIS SHIM DOES
 * -------------------
 * It makes the warning NON-FATAL. It does not suppress it, and it does not
 * change any listener limit.
 *
 *   1. Always try the original `process.emitWarning` first.
 *   2. Only if that throws the specific `ERR_INVALID_ARG_TYPE` cross-realm
 *      failure, re-emit using the stable `(message, name)` string overload,
 *      which carries no realm-bound object.
 *   3. Anything else is rethrown untouched.
 *
 * Deliberate non-goals:
 *   - Not raising `maxListeners` (that would hide genuine listener leaks and
 *     would have to change production configuration).
 *   - Not using `instanceof Error` to detect the cross-realm object: that check
 *     is exactly what is unreliable across realms. Duck-typing on a string
 *     `message` is used instead.
 *   - Not touching any application/production code.
 *
 * A real MaxListenersExceededWarning therefore remains observable on stderr,
 * which is the same behaviour a normal (non-Jest) server boot has.
 */

'use strict';

const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function patchedEmitWarning(warning, ...rest) {
  try {
    return originalEmitWarning(warning, ...rest);
  } catch (err) {
    // Only rescue the one specific failure mode described above.
    const isCrossRealmWarningObject =
      err &&
      err.code === 'ERR_INVALID_ARG_TYPE' &&
      warning !== null &&
      typeof warning === 'object' &&
      typeof warning.message === 'string';

    if (!isCrossRealmWarningObject) {
      throw err;
    }

    // Re-emit with primitives only, so the warning stays visible.
    const name =
      typeof warning.name === 'string' && warning.name.length > 0
        ? warning.name
        : 'Warning';

    return originalEmitWarning(warning.message, name);
  }
};
