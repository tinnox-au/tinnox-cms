import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResult<R extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<R>;
export type QueryResultRow = pg.QueryResultRow;

const RUNTIME_ROLE = 'tinnox_app';

export interface CreatePoolOptions {
  readonly connectionString: string;
  /** Shown in pg_stat_activity. */
  readonly applicationName?: string;
  /** Maximum pooled connections. Default 10. */
  readonly max?: number;
  /** Server-side statement timeout in milliseconds. Default 15000. */
  readonly statementTimeoutMs?: number;
}

/**
 * Creates a connection pool for the runtime role tinnox_app (DATABASE_URL), and for nothing
 * else. The offline tools (migration runner and test reset, seed, provisioning) connect as
 * tinnox_migrator through connectMigrator (migrate.ts), never through this.
 * int8 values (bigint ids, seq, bytes) are returned as strings by pg; convert deliberately.
 *
 * Every connection is checked before the pool hands it out (poteto adoption plan, AG-1.2):
 * pg-pool awaits onConnect for each connection it opens, the first ones and every replacement
 * of one that dropped or idled out, and on a refusal closes that connection and fails the
 * query or checkout that asked for it. A pool opens connections lazily, so a check made once
 * at creation would not cover the later ones. The cost is one round trip per new connection,
 * not per checkout. As in connectMigrator, current_user and session_user must both be
 * tinnox_app, so the superuser or the migrator acting as tinnox_app (-c role=) is refused.
 *
 * The timeouts and row security are sent as connection startup parameters, which take
 * precedence over role and database defaults. tinnox_app can change its own role
 * defaults (ALTER ROLE ... SET; PostgreSQL always allows that), so the API does not rely
 * on the defaults set in infra/postgres/init/01-roles.sh (review round 3, SCU-02).
 */
export function createPool(options: CreatePoolOptions): Pool {
  if (typeof options.connectionString !== 'string' || options.connectionString === '') {
    throw new Error('database connection string is not configured');
  }
  const config: RuntimePoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'tinnox',
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
    options: '-c row_security=on',
    onConnect: assertRuntimeSession,
  };
  const pool = new pg.Pool(config);
  // An idle client that errors (server restart, network drop) must not crash the process;
  // pg removes it from the pool and the next query gets a fresh connection.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * pg-pool (3.14, the version pg 8.23 requires) awaits a promise returned by onConnect and fails
 * the checkout when it rejects (newClient in pg-pool's index.js); @types/pg still types the hook
 * as returning void. This type states what the pool really does. The refusal tests in
 * packages/db/test/rls.integration.test.ts fail if the pool ever stops awaiting it.
 */
type RuntimePoolConfig = Omit<pg.PoolConfig, 'onConnect'> & {
  readonly onConnect: (client: pg.ClientBase) => Promise<void>;
};

async function assertRuntimeSession(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ current_user: string; session_user: string }>(
    'SELECT current_user, session_user',
  );
  const who = rows[0];
  if (who?.current_user !== RUNTIME_ROLE || who.session_user !== RUNTIME_ROLE) {
    throw new Error(
      `createPool serves role ${RUNTIME_ROLE} only, but the connection logs in as ` +
        `${who?.session_user ?? 'unknown'} and acts as ${who?.current_user ?? 'unknown'}; ` +
        `use the ${RUNTIME_ROLE} connection string (DATABASE_URL) without a role setting, ` +
        'and connectMigrator (@tinnox/db) for an offline tool that needs tinnox_migrator',
    );
  }
}

/** Throws unless the connection string's user is exactly `expectedRole`. Guards against running the API as the migrator. */
export function assertConnectionRole(connectionString: string, expectedRole: string): void {
  let user: string;
  try {
    user = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('database connection string is not a valid URL');
  }
  if (user !== expectedRole) {
    throw new Error(`database connection must use role ${expectedRole}`);
  }
}
