// The statements of each transaction handle, by handle. A PreOrgTx has no `query` (./tx.ts), so
// request code cannot send a statement of its own where no organisation is set (AG-2.2). run()
// in ./tx.ts keeps the statements here, and three modules of this package take them out again:
// ./sec.ts for its typed sec.* wrappers, ./definer.ts for asDefiner, and ./testing.ts for tests
// of row-level security itself. In a file of its own because everything ./tx.ts exports is part
// of the runtime entry (./index.ts), and this is not: no entry of the package exports this
// module (./entries.test.ts).
import type { Autocommit, Tx } from './tx.ts';

// Keyed by any object, as ./tx-pool.ts is: a lookup with the handle of poolAsTx finds nothing.
const kept = new WeakMap<object, Autocommit>();

/** Called by run() for every handle it makes; the handles of one transaction share `statements`. */
export function keepStatements(tx: Tx, statements: Autocommit): void {
  kept.set(tx, statements);
}

/**
 * What sends a statement on `handle`. For a handle of run() that is the transaction's one
 * statements object, whichever handle of the transaction was given; for the handle of poolAsTx
 * it is the handle itself.
 */
export function statementsOf(handle: Autocommit | Tx): Autocommit {
  const statements = kept.get(handle);
  if (statements !== undefined) return statements;
  if ('query' in handle) return handle;
  throw new Error(
    'this is not a transaction handle of @tinnox/db: use the tx that the callback of withoutOrg or withResolvedOrg receives',
  );
}
