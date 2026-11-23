import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from './pool.ts';
import { keepStatements } from './pre-org.ts';
import { rememberPool } from './tx-pool.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

declare const organisation: unique symbol;
/**
 * The id of an organisation that the database named: the verified session's member, the device
 * credential, or one of the other lookups of ./sec.ts. `withOrg` and `enterOrg` take nothing
 * else, so a string from a path, a query, a body or a header does not type-check as the
 * organisation a query runs for (AG-2.3). Only ./org-id.ts makes one, and lint refuses a cast
 * to it everywhere else (NO_ORG_ID_FORGERY in eslint.config.js). The offline tools have two
 * more sources, both in the '@tinnox/db/migrate' entry: `newOrgId` for an organisation that is
 * being created, and what `asDefiner` reads (D25). Tests make one with `testOrgId` from
 * '@tinnox/db/testing'.
 */
export type OrgId = string & { readonly [organisation]: true };

/**
 * A handle that runs one statement at a time, each committing on its own: what `poolAsTx`
 * returns. A function that only reads before the organisation is known, or whose one statement
 * is complete by itself (the login state, the purges), takes this, and so also accepts an
 * `OrgTx`. Always pass values as parameters; never build SQL from input.
 */
export interface Autocommit {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Marks a handle made by run(), with what it knows of the organisation. Not exported, so no
 * other module can build a transaction handle.
 */
const inTransaction: unique symbol = Symbol('inTransaction');

/**
 * A transaction with the organisation set: the callback of `withOrg` receives it, and so does
 * the caller of `enterOrg`. Row-level security limits every statement on it to that
 * organisation. This is the only handle request code can send a statement of its own on, so a
 * tenant query cannot run where no organisation is set (AG-2.1). The scoped audit writer and
 * the sec.* wrappers that need the organisation take it.
 */
export interface OrgTx extends Autocommit {
  readonly [inTransaction]: 'org';
}

/**
 * A transaction before the organisation is known: the callback of `withoutOrg` and of
 * `withResolvedOrg` receives it. It has no `query`: tenant tables show no rows here, so the
 * only thing to do with it is to hand it to a sec.* wrapper of ./sec.ts that takes one (they
 * resolve a credential to its organisation, or record what has none), and then to `enterOrg`
 * (AG-2.2).
 */
export interface PreOrgTx {
  readonly [inTransaction]: 'pre';
}

/**
 * Any handle inside a transaction, whichever of the two it is. A pool, and the handle
 * `poolAsTx` returns, are neither. So a function that takes an `OrgTx` or a `PreOrgTx` (the
 * audit writers, and every sec.* wrapper that changes data) cannot be given a handle that
 * commits each statement on its own, and the audit row commits or rolls back with the change
 * it records (CX-01, D2). Code that sends a statement names the one it needs: `tx: OrgTx`.
 */
export type Tx = OrgTx | PreOrgTx;

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
function refuseNested(opener: string, instead = 'Pass the outer tx to the helper.'): void {
  if (current.getStore()?.open === true) {
    throw new Error(
      `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of withOrg, withoutOrg or withResolvedOrg, or in a helper it called). This opens a second transaction on another connection that commits independently. ${instead}`,
    );
  }
}

/** The statements of one transaction: what a handle of run() sends, until the transaction ends. */
function statementsOn(client: PoolClient, transaction: Transaction): Autocommit {
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

/** The handle of a transaction whose organisation is set. `pool` is for asDefiner (./definer.ts). */
function orgHandle(statements: Autocommit, pool: Pool): OrgTx {
  const tx: OrgTx = {
    [inTransaction]: 'org',
    query: <R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) =>
      statements.query<R>(text, values),
  };
  keepStatements(tx, statements);
  rememberPool(tx, pool);
  return tx;
}

/**
 * The handle of a transaction with no organisation yet. Its statements are kept where only this
 * package finds them (./pre-org.ts), so the object itself has no `query` to call.
 */
function preOrgHandle(statements: Autocommit, pool: Pool): PreOrgTx {
  const tx: PreOrgTx = { [inTransaction]: 'pre' };
  keepStatements(tx, statements);
  rememberPool(tx, pool);
  return tx;
}

function requireOrgId(caller: string, orgId: OrgId): void {
  if (typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) {
    throw new Error(`${caller} requires a lower-case UUID organisation id`);
  }
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
  fn: (statements: Autocommit) => Promise<T>,
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
      const statements = statementsOn(client, transaction);
      result = await current.run(transaction, () => fn(statements));
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
 * `orgId` is an `OrgId`: it comes from a verified session or device credential, never from
 * request input. The setting is transaction-local, so it cannot leak to the
 * next user of the pooled connection. Rolls back when `fn` throws.
 */
export async function withOrg<T>(
  pool: Pool,
  orgId: OrgId,
  fn: (tx: OrgTx) => Promise<T>,
): Promise<T> {
  requireOrgId('withOrg', orgId);
  return run(
    'withOrg',
    pool,
    async (client) => {
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    },
    (statements) => fn(orgHandle(statements, pool)),
  );
}

/**
 * Runs `fn` in one transaction with NO tenant context. Tenant tables show no
 * rows here, and the handle takes no statement of the caller's own. Use only for sec.* calls
 * that happen before the organisation is known.
 */
export async function withoutOrg<T>(pool: Pool, fn: (tx: PreOrgTx) => Promise<T>): Promise<T> {
  return run(
    'withoutOrg',
    pool,
    async () => undefined,
    (statements) => fn(preOrgHandle(statements, pool)),
  );
}

/**
 * Runs `fn` in one transaction whose organisation is not known when it starts:
 * pairing completion, sign-in and sign-out, where a sec.* call resolves a
 * credential to its organisation. `fn` calls `enterOrg` with that organisation
 * to set the tenant context for the rest of the transaction, and runs its tenant
 * statements on the `OrgTx` that `enterOrg` returns, so the credential change and
 * its audit event commit or roll back together. The same rule as `withOrg`
 * applies: the id is an `OrgId`, from a verified credential, never from request
 * input. Call `enterOrg` once: nothing stops a second call, which would move the
 * transaction, and the handle the first call returned with it, to another
 * organisation.
 */
export async function withResolvedOrg<T>(
  pool: Pool,
  fn: (tx: PreOrgTx, enterOrg: (orgId: OrgId) => Promise<OrgTx>) => Promise<T>,
): Promise<T> {
  return run(
    'withResolvedOrg',
    pool,
    async () => undefined,
    (statements) =>
      fn(preOrgHandle(statements, pool), async (orgId) => {
        requireOrgId('enterOrg', orgId);
        await statements.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        return orgHandle(statements, pool);
      }),
  );
}

/** Minimal query interface satisfied by Pool, PoolClient and OrgTx. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * A function that writes on the pool under a name of its own (`auditStandalone`,
 * `sessionRevokeUnaudited`): the name the refusal of U-3 gives, and what to call on the outer
 * `tx` instead, since "pass the outer tx" does not fit a function that takes none.
 */
export interface StandaloneCaller {
  readonly opener: string;
  readonly instead: string;
}

/**
 * Adapts a pool for single-statement sec.* calls (each statement is its own transaction). So a
 * statement sent while a transaction is open on the same asynchronous path is refused, like
 * any other second transaction (U-3). The handle is an `Autocommit`, never a `Tx`: an audit
 * writer or a wrapper that changes data does not accept it.
 */
export function poolAsTx(pool: Pool, caller?: StandaloneCaller): Autocommit {
  return {
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) => {
      if (caller === undefined) refuseNested('poolAsTx(pool).query');
      else refuseNested(caller.opener, caller.instead);
      return pool.query<R>(text, values === undefined ? undefined : [...values]);
    },
  };
}
