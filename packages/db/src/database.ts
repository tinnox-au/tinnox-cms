/**
 * The database as the API and the alert job hold it (adoption plan section 2.4, step 21): an
 * opaque handle that createDatabase makes, reached as `AppContext.db`. It has no `query` and no
 * `connect`, and nothing outside this package can get the pool behind it, so product code sends
 * a statement only inside a transaction the package opened (readOrg, changeOrg, changePreOrg),
 * through a typed sec.* wrapper, or through one of the named functions here. Those functions,
 * and the openers, take a `Database`; a `pg` Pool is not one, so it does not type-check where a
 * `Database` is wanted (./database.test.ts).
 *
 * The pool is kept here, keyed by the handle, where only this package finds it
 * (`poolOfDatabase`). No entry of the package exports that function or `databaseOn`: tests get a
 * handle for a pool of their own from '@tinnox/db/testing', and the offline tools pass the
 * `MigratorPool` connectMigrator returned, which is a `Database` too (./migrate.ts).
 */
import { createPool, readRuntimeRole, runtimeRoleProblems, RuntimeRoleError } from './pool.ts';
import type { CreatePoolOptions, Pool, PoolClient, RuntimeRoleFacts } from './pool.ts';

declare const database: unique symbol;

/**
 * The database of a process: what createDatabase returns, and what readOrg, changeOrg,
 * changePreOrg, auditStandalone, sessionRevokeUnaudited, poolAsTx, ping and assertRuntimeRole
 * take. It carries no way to send a statement of its own.
 */
export interface Database {
  readonly [database]: true;
  /** Closes every connection, waiting for the ones in use: the shutdown of an entry point. */
  end(): Promise<void>;
}

const pools = new WeakMap<object, Pool>();

/**
 * The handle for `pool`. For createDatabase, connectMigrator (./migrate.ts), whose pool is its
 * own handle, and `databaseOn` of '@tinnox/db/testing'.
 */
export function databaseOn(pool: Pool): Database {
  const db: Omit<Database, typeof database> = Object.freeze({ end: () => pool.end() });
  pools.set(db, pool);
  // The brand is a type only: what makes this a database is its entry in `pools`.
  return db as Database;
}

/** Makes `pool` its own handle: the MigratorPool of connectMigrator (./migrate.ts). */
export function registerOwnHandle(pool: Pool): void {
  pools.set(pool, pool);
}

/** The pool behind `db`. Throws for a value that no function of this module made a handle. */
export function poolOfDatabase(db: Database): Pool {
  const pool = pools.get(db);
  if (pool === undefined) {
    throw new Error(
      'this is not a database of @tinnox/db: pass the Database that createDatabase(options) returned (AppContext.db in the API). A test wraps a pool of its own with databaseOn(pool) from @tinnox/db/testing; an offline tool passes the pool that connectMigrator returned (@tinnox/db/migrate)',
    );
  }
  return pool;
}

/**
 * Creates the database of a process that connects as the runtime role tinnox_app (DATABASE_URL):
 * the pool of createPool (./pool.ts), with its role check on every new connection and its
 * start-up settings, behind the handle. The two entry points (apps/api/src/main.ts,
 * apps/api/src/alerts-once.ts) call it once, and the API hands it to its routes as
 * `AppContext.db`.
 */
export function createDatabase(options: CreatePoolOptions): Database {
  return databaseOn(createPool(options));
}

/**
 * A liveness probe (the API's /readyz): resolves when a pooled connection answers one statement
 * that reads no table, and rejects when no connection can be had or the server does not answer.
 * The one statement the API sends outside a transaction or a typed sec.* wrapper
 * (tinnox/no-query-off-transaction holds the rest).
 */
export async function ping(db: Database): Promise<void> {
  await poolOfDatabase(db).query('SELECT 1');
}

/**
 * A connection of its own, with no transaction open, for the alert check's session advisory
 * lock (apps/api/src/alerts.ts): the lock must outlive the transactions the run opens, and a
 * lost connection must release it. tinnox/no-query-off-transaction refuses every statement on
 * it except the lock and the unlock that QUERY_OFF_TRANSACTION (eslint.config.js) lists for that
 * file. Replaced by withSessionLock in adoption plan step 22 (EAX-06). The caller releases it.
 */
export function sessionLockConnection(db: Database): Promise<PoolClient> {
  return poolOfDatabase(db).connect();
}

/**
 * Start-up check of both entry points (apps/api/src/main.ts, apps/api/src/alerts-once.ts;
 * poteto adoption plan AG-1.3): resolves when the database's session is tinnox_app as
 * infra/postgres/init/01-roles.sh makes it, not superuser, no BYPASSRLS, REPLICATION,
 * CREATEROLE or CREATEDB, a member of no role and owning nothing, read from the catalogue;
 * otherwise rejects with a RuntimeRoleError that lists every problem, and the caller exits before
 * it listens or runs.
 *
 * It and createPool's per-connection check differ on purpose. createPool's compares the
 * session's names on every new connection: one cheap query, so no connection is ever served as
 * another login. It cannot see the role's attributes: a role still named tinnox_app that an
 * administrator made superuser, gave BYPASSRLS or REPLICATION, granted another role or made an
 * owner would pass it, and with it every row-level policy would be skipped or could be turned
 * off. Those attributes change only by an administrator's hand, so reading them once at start-up,
 * where a refusal is seen at once, is enough, and costs one catalogue query that no connection
 * pays. The integration tests read the same attributes of the test database
 * (packages/db/test/catalogue.integration.test.ts); this reads the database the process uses.
 */
export async function assertRuntimeRole(db: Database): Promise<void> {
  // The checkout runs createPool's session check first, when the connection is new.
  const client = await poolOfDatabase(db).connect();
  let facts: RuntimeRoleFacts;
  try {
    facts = await readRuntimeRole(client);
  } finally {
    client.release();
  }
  const problems = runtimeRoleProblems(facts);
  if (problems.length > 0) throw new RuntimeRoleError(problems);
}
