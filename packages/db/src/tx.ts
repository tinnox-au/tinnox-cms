import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from './pool.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The only handle request code gets on the database inside a transaction.
 * Always pass values as parameters; never build SQL from input.
 */
export interface Tx {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** One transaction of run(): `open` from BEGIN until its callback returns or throws. */
interface Transaction {
  open: boolean;
}

/**
 * The transaction whose callback is running on this asynchronous path, if any (U-3). The store
 * is entered around the callback only, and work the callback started keeps it after the
 * callback has ended, so `open` is what says whether the transaction is still there.
 */
const current = new AsyncLocalStorage<Transaction>();

/**
 * U-3: a second transaction takes another pooled connection, so it commits or rolls back on its
 * own (an audit row could commit while its change rolls back), it does not see the outer
 * transaction's rows, and the outer holds a connection while it waits for the inner. Checked
 * before a connection is taken. tinnox/no-nested-transaction reports the cases lint can read
 * (scripts/eslint-rules/no-nested-transaction.ts).
 */
function refuseNested(opener: string): void {
  if (current.getStore()?.open === true) {
    throw new Error(
      `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of withOrg, withoutOrg or withResolvedOrg, or in a helper it called). This opens a second transaction on another connection that commits independently. Pass the outer tx to the helper.`,
    );
  }
}

function wrap(client: PoolClient, transaction: Transaction): Tx {
  return {
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) => {
      // U-2: the connection of an ended transaction is on its way back to the pool, or already
      // serves another request. A statement sent now would run with no transaction and no
      // organisation, or inside whatever transaction the next user of the connection opened.
      if (!transaction.open) {
        return Promise.reject<QueryResult<R>>(
          new Error(
            'a transaction handle was used after its transaction ended: the callback given to withOrg, withoutOrg or withResolvedOrg had already returned or thrown, so the statement was not sent. Await every query inside the callback, and do not keep tx, or pass it to work that outlives the callback.',
          ),
        );
      }
      return client.query<R>(text, values === undefined ? undefined : [...values]);
    },
  };
}

/**
 * COMMIT was sent but did not confirm, so the transaction may have committed. Callers
 * must not undo work outside the database (delete files or stored objects) on this
 * error: the rows that own that work may exist (review round 3, SCX-03). `cause` holds
 * what COMMIT failed with.
 */
export class CommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('the outcome of the transaction is unknown: COMMIT did not confirm', { cause });
    this.name = 'CommitOutcomeUnknownError';
  }
}

/** SQLSTATE 40003, statement_completion_unknown: class 40, yet it confirms nothing. */
const STATEMENT_COMPLETION_UNKNOWN = '40003';

/**
 * True when the server answered COMMIT with an error that it raises only while rolling
 * the transaction back: a deferred constraint (class 23) or a serialization failure
 * (class 40, except 40003, which says the server itself does not know). Anything else (a
 * lost connection, a timeout, a server shutting down) may have come after the commit was
 * durable.
 */
function commitRefused(error: unknown): boolean {
  return (
    error instanceof pg.DatabaseError &&
    typeof error.code === 'string' &&
    error.code !== STATEMENT_COMPLETION_UNKNOWN &&
    (error.code.startsWith('23') || error.code.startsWith('40'))
  );
}

async function run<T>(
  opener: string,
  pool: Pool,
  begin: (client: PoolClient) => Promise<void>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  refuseNested(opener);
  const client = await pool.connect();
  const transaction: Transaction = { open: true };
  let broken: Error | undefined;
  // A connection that is lost while checked out emits 'error'; the pool listens only while a
  // connection is idle, and an 'error' nobody listens to would end the process. The queries
  // of the transaction reject by themselves; the connection is destroyed on release.
  const onLost = (error: Error): void => {
    broken = error;
  };
  client.on('error', onLost);
  try {
    await client.query('BEGIN');
    await begin(client);
    let result: T;
    try {
      result = await current.run(transaction, () => fn(wrap(client, transaction)));
    } finally {
      // The handle closes before COMMIT or ROLLBACK is sent (U-2), and work the callback left
      // running no longer counts as inside this transaction (U-3).
      transaction.open = false;
    }
    try {
      await client.query('COMMIT');
    } catch (error) {
      throw commitRefused(error) ? error : new CommitOutcomeUnknownError(error);
    }
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The connection is in an unknown state; destroy it rather than return it to the pool.
      broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    throw error;
  } finally {
    client.removeListener('error', onLost);
    client.release(broken);
  }
}

/**
 * Runs `fn` in one transaction, on one pooled connection, with the tenant
 * context set for that transaction only (prototype-m0.md D4):
 *
 *   BEGIN; SELECT set_config('app.org_id', $1, true); ...fn...; COMMIT
 *
 * Row-level security then limits every statement in `fn` to `orgId`.
 * `orgId` must come from a verified session or device credential, never from
 * request input. The setting is transaction-local, so it cannot leak to the
 * next user of the pooled connection. Rolls back when `fn` throws.
 */
export async function withOrg<T>(
  pool: Pool,
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) {
    throw new Error('withOrg requires a lower-case UUID organisation id');
  }
  return run(
    'withOrg',
    pool,
    async (client) => {
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    },
    fn,
  );
}

/**
 * Runs `fn` in one transaction with NO tenant context. Tenant tables show no
 * rows here. Use only for sec.* calls that happen before the organisation is known.
 */
export async function withoutOrg<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return run('withoutOrg', pool, async () => undefined, fn);
}

/**
 * Runs `fn` in one transaction whose organisation is not known when it starts:
 * pairing completion, sign-in and sign-out, where a sec.* call resolves a
 * credential to its organisation. `fn` calls `enterOrg` with that organisation
 * to set the tenant context for the rest of the transaction, so the credential
 * change and its audit event commit or roll back together. The same rule as
 * `withOrg` applies: the id must come from a verified credential, never from
 * request input.
 */
export async function withResolvedOrg<T>(
  pool: Pool,
  fn: (tx: Tx, enterOrg: (orgId: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  return run(
    'withResolvedOrg',
    pool,
    async () => undefined,
    (tx) =>
      fn(tx, async (orgId) => {
        if (typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) {
          throw new Error('enterOrg requires a lower-case UUID organisation id');
        }
        await tx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      }),
  );
}

/** Minimal query interface satisfied by Pool, PoolClient and Tx. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Adapts a pool for single-statement sec.* calls (each statement is its own transaction). So a
 * statement sent while a transaction is open on the same asynchronous path is refused, like
 * any other second transaction (U-3).
 */
export function poolAsTx(pool: Pool): Tx {
  return {
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) => {
      refuseNested('poolAsTx(pool).query');
      return pool.query<R>(text, values === undefined ? undefined : [...values]);
    },
  };
}
