// U-3: which transaction is open on this asynchronous path, and the refusal of a second
// connection while it is. Its own module, not exported by any entry, so that a helper of this
// package that checks out a connection of its own (withSessionLock in ./session-lock.ts) refuses
// the same way as the openers of ./tx.ts (CHK-3).
import { AsyncLocalStorage } from 'node:async_hooks';

/** The functions that open a transaction and give their callback its handle, for the messages. */
export const OPENERS = 'withOrg, withoutOrg, withResolvedOrg, readOrg, changeOrg or changePreOrg';

/** One transaction of run(): `open` from BEGIN until its callback returns or throws. */
export interface Transaction {
  open: boolean;
}

/**
 * The transaction whose callback is running on this asynchronous path, if any (U-3). The store
 * is entered around the callback only, and work the callback started keeps it after the
 * callback has ended, so `open` is what says whether the transaction is still there.
 */
export const current = new AsyncLocalStorage<Transaction>();

/**
 * U-3: a second transaction takes another pooled connection, so it commits or rolls back on its
 * own (an audit row could commit while its change rolls back), it does not see the outer
 * transaction's rows, and the outer holds a connection while it waits for the inner. Checked
 * before a connection is taken. tinnox/no-nested-transaction reports the cases lint can read
 * (scripts/eslint-rules/no-nested-transaction.ts). `harm` says what the call would do; a helper
 * that opens no transaction (withSessionLock) says its own.
 */
export function refuseNested(
  opener: string,
  instead = 'Pass the outer tx to the helper.',
  harm = 'This opens a second transaction on another connection that commits independently.',
): void {
  if (current.getStore()?.open === true) {
    throw new Error(
      `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of ${OPENERS}, or in a helper it called). ${harm} ${instead}`,
    );
  }
}
