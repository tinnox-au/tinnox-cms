// The '@tinnox/db/testing' entry: what only tests may use. Lint refuses the entry in every file
// that is not a test (the db entries of eslint.config.js), so nothing here can reach the API, the
// alert job or an offline tool.
import { registerOwnHandle } from './database.ts';
import type { MigratorPool } from './migrate.ts';
import { mintOrgId } from './org-id.ts';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from './pool.ts';
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
 * The pid of the backend behind a connected client: node-postgres keeps it from the connection
 * handshake. What waitForLockWaiters takes as the holder, and killBackend as the backend to end.
 */
export function backendPid(client: object): number {
  const pid: unknown = Reflect.get(client, 'processID');
  if (typeof pid !== 'number') throw new Error('the connection has no backend pid: connect it');
  return pid;
}

/** A connection or pool that can read pg_stat_activity and pg_locks (any role can). */
export interface LockReader {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * Waits until `count` backends of this database wait for a lock that backend `holder` holds,
 * directly or queued behind another such waiter (pg_blocking_pids), and returns their pids.
 * Only waits that lead back to the test's own holder count, so a lock wait elsewhere on the
 * shared server (another database, another checkout's run) can neither satisfy nor overshoot
 * it, as a count over all of pg_locks could (TST-3). With `locktype`, only a wait for that kind
 * of lock counts ('advisory' for withCountedLimit), so a wait for some other row does not pass
 * for the lock under test. The answer is read from the server, so it does not rest on a guess
 * at how long an unblocked side takes, as a wait of some milliseconds would (TST-5). With
 * `waiter`, the promise of a side that has to wait, it fails as soon as that side ends without
 * having been seen waiting, instead of at the deadline. It gives up after `timeoutMs` (ten
 * seconds, for a loaded runner) with `what` in the message; a passing run returns as soon as
 * the waiters are there.
 */
export async function waitForLockWaiters(
  reader: LockReader,
  holder: number,
  count: number,
  what: string,
  options: {
    readonly locktype?: string;
    readonly timeoutMs?: number;
    readonly waiter?: Promise<unknown>;
  } = {},
): Promise<readonly number[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let ended = false;
  const mark = (): void => {
    ended = true;
  };
  options.waiter?.then(mark, mark);
  for (;;) {
    // Read before the server is asked: a waiter seen waiting may well have ended by the time
    // the answer is back, once its holder lets go.
    const endedBefore = ended;
    const { rows } = await reader.query<{ pid: number; blockers: number[]; of_type: boolean }>(
      `SELECT a.pid, pg_blocking_pids(a.pid) AS blockers,
              EXISTS (SELECT 1 FROM pg_locks l
                       WHERE l.pid = a.pid AND NOT l.granted
                         AND ($1::text IS NULL OR l.locktype = $1::text)) AS of_type
         FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted)`,
      [options.locktype ?? null],
    );
    // Every backend whose wait leads back to the holder, through any number of waiters.
    const behind = new Set<number>();
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (!behind.has(row.pid) && row.blockers.some((b) => b === holder || behind.has(b))) {
          behind.add(row.pid);
          grew = true;
        }
      }
    }
    const waiting = rows.filter((row) => behind.has(row.pid) && row.of_type).map((r) => r.pid);
    if (waiting.length >= count) return waiting;
    if (endedBefore) {
      throw new Error(`${what}: the side that had to wait ended without waiting for a lock`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: ${String(waiting.length)} of ${String(count)} backends waited for a lock of backend ${String(holder)} within ${String(timeoutMs / 1000)} s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Two tinnox_app connections of `pool`, each in an open transaction for `orgId`, rolled back
 * when `work` ends: the two sides of a race test, which send their own statements so the test
 * can stop one between them. Shared so the race tests of packages/db, apps/api and
 * tests/integration open their two sides the same way (SCX-05).
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

/** What killBackend saw: the backend it ended, gone from the server. */
export interface KilledBackend {
  readonly pid: number;
  /** pg_terminate_backend answered true and pg_stat_activity then had no row for the pid. */
  readonly gone: true;
}

/**
 * Ends backend `pid` (pg_terminate_backend) and returns once the server no longer lists it:
 * what a failover or an administrator does to a connection in use. Its open transaction is
 * rolled back and its session locks are freed. `killer` is another connection of the same role
 * (tinnox_app may end a backend of its own role) or of the superuser. The client side learns
 * of it by itself, as an 'error' on the connection or a failed statement; the fault harness of
 * apps/api/test/support/faults.ts also waits for that.
 */
export async function killBackend(killer: LockReader, pid: number): Promise<KilledBackend> {
  const sent = await killer.query<{ sent: boolean }>('SELECT pg_terminate_backend($1) AS sent', [
    pid,
  ]);
  if (sent.rows[0]?.sent !== true) throw new Error(`backend ${String(pid)} was not there to end`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const left = await killer.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (left.rowCount === 0) return { pid, gone: true };
    if (Date.now() > deadline) throw new Error(`backend ${String(pid)} was still there after 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
