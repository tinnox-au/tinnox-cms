// The '@tinnox/db/testing' entry: what only tests may use. Lint refuses the entry in every file
// that is not a test (the db entries of eslint.config.js), so nothing here can reach the API, the
// alert job or an offline tool.
import { registerOwnHandle } from './database.ts';
import type { MigratorPool } from './migrate.ts';
import { mintOrgId } from './org-id.ts';
import type { Pool, PoolClient } from './pool.ts';
import { statementsOf } from './pre-org.ts';
import { withoutOrg, type Autocommit, type OrgId, type PreOrgTx } from './tx.ts';

// The audit-debt guard of the integration test database (adoption plan section 2.1 C, D3).
export {
  AUDIT_DEBT_SQLSTATE,
  ensureAuditDebtGuard,
  installAuditDebtGuard,
  removeAuditDebtGuard,
  unjudgedSql,
  watchAuditDebt,
  whileUnauditedAllowed,
  type AuditDebtWatch,
} from './audit-debt-guard.ts';

// The audit fault: makes the audit rows of one action fail, to show that the change they
// record rolls back with them (adoption plan step 17, D3).
export { removeAuditFault, whileAuditFails, type AuditFaultOutcome } from './audit-fault.ts';

// The audit rows of every organisation, for the scan after each integration test file (AG-3.4).
export { auditRowsSince, auditScanMark, type StoredAuditRow } from './audit-rows.ts';

// The pool behind the database (adoption plan step 21). The runtime entry hands out only the
// handle of createDatabase, which has no query and no connect; a test that sends statements of
// its own, or wraps the pool to inject a fault, makes the pool here and gives the code under
// test the handle `databaseOn(pool)`.
export { databaseOn } from './database.ts';
export { createPool, type Pool, type PoolClient } from './pool.ts';

/**
 * Makes a wrapper of the pool connectMigrator returned (a Proxy that holds or fails a statement)
 * its own Database, as connectMigrator makes the pool it returns: an offline tool passes the pool
 * it holds to changePreOrg, and asDefiner compares it with the pool of its transaction, so the
 * wrapper has to be both.
 */
export function wrappedMigratorPool<P extends MigratorPool>(wrapped: P): P {
  registerOwnHandle(wrapped);
  return wrapped;
}

// What the change API of ./change.ts is built on, which the runtime entry does not export
// (adoption plan step 20, SCR-34): tests arrange their data in a transaction of their own,
// with no permit and no route statement, and the tests of the audit writers call them by hand.
export { auditScoped, auditUnscoped } from './sec.ts';
export { withOrg, withoutOrg, withResolvedOrg } from './tx.ts';

/**
 * Runs `fn` in a transaction of its own with no organisation, as a route does before the
 * organisation is known. For the sec.* wrappers that change data there and the unscoped audit
 * writer: they take a `PreOrgTx`, and the handle `poolAsTx` gives is not one (D2).
 */
export function inTx<T>(pool: Pool, fn: (tx: PreOrgTx) => Promise<T>): Promise<T> {
  return withoutOrg(pool, fn);
}

/**
 * The id of an organisation a test made, or made up: tests insert their own organisations and
 * then run as them with `withOrg`. The one way a test gets an `OrgId` from a string; lint
 * refuses a cast in tests too.
 */
export function testOrgId(id: string): OrgId {
  return mintOrgId(id);
}

/**
 * Sends statements of the test's own on a transaction with no organisation, which a `PreOrgTx`
 * does not allow by itself. For the tests of row-level security: that a tenant table shows no
 * row and takes no write there.
 */
export function withNoOrgSet(tx: PreOrgTx): Autocommit {
  return statementsOf(tx);
}

/**
 * Resolves to true when `promise` is still pending after `ms`: for a two-connection test, that
 * one side waits on a lock the other holds. A side that is not blocked has settled long before.
 * Shared so the race tests of packages/db, apps/api and tests/integration wait the same way
 * (SCX-05).
 */
export async function stillWaiting(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  promise.then(mark, mark);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !settled;
}

/**
 * Two tinnox_app connections of `pool`, each in an open transaction for `orgId`, rolled back
 * when `work` ends: the two sides of a race test, which send their own statements so the test
 * can stop one between them. Shared with stillWaiting for the same reason (SCX-05).
 */
export async function twoTransactions(
  pool: Pool,
  orgId: OrgId,
  work: (first: PoolClient, second: PoolClient) => Promise<void>,
): Promise<void> {
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    for (const client of [first, second]) {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    }
    await work(first, second);
  } finally {
    for (const client of [first, second]) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
}
