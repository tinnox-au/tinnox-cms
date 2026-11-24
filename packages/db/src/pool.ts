import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResult<R extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<R>;
export type QueryResultRow = pg.QueryResultRow;

const RUNTIME_ROLE = 'tinnox_app';

/**
 * The database session or its role is not the runtime role as infra/postgres/init/01-roles.sh
 * makes it. Each problem names roles and objects only, never a connection string or password,
 * so an entry point can print them as they are.
 */
export class RuntimeRoleError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'RuntimeRoleError';
    this.problems = problems;
  }
}

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
 * Not in the runtime entry (./index.ts; adoption plan step 21): the API and the alert job hold
 * the pool behind the handle of createDatabase (./database.ts), and tests take it from
 * '@tinnox/db/testing'.
 * int8 values (bigint ids, seq, bytes) are returned as strings by pg; convert deliberately.
 *
 * Every connection is checked before the pool hands it out (poteto adoption plan, AG-1.2):
 * pg-pool awaits onConnect for each connection it opens, the first ones and every replacement
 * of one that dropped or idled out, and on a refusal closes that connection and fails the
 * query or checkout that asked for it. A pool opens connections lazily, so a check made once
 * at creation would not cover the later ones. The cost is one round trip per new connection,
 * not per checkout. As in connectMigrator, current_user and session_user must both be
 * tinnox_app, so the superuser or the migrator acting as tinnox_app (a role default set with
 * ALTER ROLE ... SET role) is refused.
 *
 * The timeouts and row security are sent as connection startup parameters, which take
 * precedence over role and database defaults. tinnox_app can change its own role
 * defaults (ALTER ROLE ... SET; PostgreSQL always allows that), so the API does not rely
 * on the defaults set in infra/postgres/init/01-roles.sh (review round 3, SCU-02).
 * A connection string whose query would replace one of them is refused (startupSettingsProblem).
 */
export function createPool(options: CreatePoolOptions): Pool {
  if (typeof options.connectionString !== 'string' || options.connectionString === '') {
    throw new Error('database connection string is not configured');
  }
  const replaced = startupSettingsProblem(options.connectionString);
  if (replaced !== null) throw new Error(replaced);
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

// The connection parameters createPool sends itself. `options` carries `-c name=value` for any
// setting, search_path and row_security included.
const STARTUP_SETTINGS = [
  'options',
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
];

/**
 * pg-connection-string runs encodeURI over a string that matches this before it parses it, so it
 * reads a query from a string that new URL refuses as it is, such as one with a space in its host.
 */
const PG_REWRITES = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i;

/**
 * The query of a connection string as pg-connection-string reads it (empty when the form has
 * none), or null when this cannot read it exactly as pg does.
 */
function queryOf(connectionString: string): URLSearchParams | null {
  // A socket path and a database name: pg reads no query from this form.
  if (connectionString.startsWith('/')) return new URLSearchParams();
  // pg would read a rewritten string, not this one: fail closed rather than judge other text.
  if (PG_REWRITES.test(connectionString)) return null;
  for (const text of [connectionString, connectionString.replace('@/', '@___DUMMY___/')]) {
    try {
      return new URL(text, 'postgres://base').searchParams;
    } catch {
      // pg tries the second form too (no host).
    }
  }
  return null;
}

/**
 * Why `connectionString` cannot be a runtime connection string, or null. pg copies every query
 * parameter of a connection string over the options a pool is created with, so
 * `?options=-c row_security=off` would silently replace createPool's `-c row_security=on` (and
 * may set any other setting), and `?statement_timeout=0` its timeout
 * (packages/db/test/rls.integration.test.ts shows pg doing it). A string whose query cannot be
 * read exactly as pg reads it is refused too (review finding SEC-1). The text names the
 * parameters and `what` only, never the connection string or a value.
 */
export function startupSettingsProblem(
  connectionString: string,
  what = 'the database connection string',
): string | null {
  const query = queryOf(connectionString);
  if (query === null) {
    return (
      `${what} cannot be read the way pg reads it: it is not a URL, or it has a space or a ` +
      'malformed percent sequence, which pg rewrites before it reads the query. Write the ' +
      'connection string as a plain URL, postgres://user:password@host:port/database, with ' +
      'every special character of the user name and password percent-encoded (%20 for a ' +
      'space, %25 for a percent sign)'
    );
  }
  const found = STARTUP_SETTINGS.filter((name) => query.has(name));
  if (found.length === 0) return null;
  return (
    `${what} sets ${found.join(', ')} in its query, which would replace what createPool ` +
    '(@tinnox/db) sends at connection start-up (row security on, and the statement, lock and ' +
    `idle-in-transaction timeouts): remove ${found.length === 1 ? 'that parameter' : 'those parameters'} ` +
    "from the connection string; the statement timeout of a pool is createPool's statementTimeoutMs"
  );
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
    throw new RuntimeRoleError([
      `createPool serves role ${RUNTIME_ROLE} only, but the connection logs in as ` +
        `${who?.session_user ?? 'unknown'} and acts as ${who?.current_user ?? 'unknown'}; ` +
        `use the ${RUNTIME_ROLE} connection string (DATABASE_URL) without a role setting, ` +
        'and connectMigrator (@tinnox/db/migrate) for an offline tool that needs tinnox_migrator',
    ]);
  }
}

/** What the catalogue says about a session and the role it acts as (readRuntimeRole). */
export interface RuntimeRoleFacts {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** REPLICATION: a replication connection streams the whole cluster, past every policy. */
  readonly replication: boolean;
  readonly createRole: boolean;
  readonly createDb: boolean;
  /** The roles it is directly a member of. */
  readonly memberOf: readonly string[];
  /** What it owns in this database, and shared objects (databases, tablespaces). */
  readonly owns: readonly string[];
}

/**
 * One problem per way the facts differ from the runtime role tinnox_app as
 * infra/postgres/init/01-roles.sh makes it (AG-1.2, AG-1.3, AG-1.4, AG-1.5).
 */
export function runtimeRoleProblems(facts: RuntimeRoleFacts): string[] {
  const problems: string[] = [];
  const role = facts.currentUser;
  if (facts.currentUser !== RUNTIME_ROLE || facts.sessionUser !== RUNTIME_ROLE) {
    problems.push(
      `the database session logs in as ${facts.sessionUser} and acts as ${facts.currentUser}, ` +
        `not ${RUNTIME_ROLE}: set DATABASE_URL to the ${RUNTIME_ROLE} connection string, with ` +
        'no user, password or role setting in its query',
    );
  }
  if (facts.superuser) {
    problems.push(
      `role ${role} is a superuser, which bypasses row-level security: the database ` +
        `administrator runs ALTER ROLE ${role} NOSUPERUSER (infra/postgres/init/01-roles.sh)`,
    );
  }
  if (facts.bypassRls) {
    problems.push(
      `role ${role} has BYPASSRLS, so no tenant policy applies to it: the database ` +
        `administrator runs ALTER ROLE ${role} NOBYPASSRLS (infra/postgres/init/01-roles.sh)`,
    );
  }
  if (facts.replication) {
    problems.push(
      `role ${role} has REPLICATION, so a replication connection with its credentials streams ` +
        `every database's rows past row-level security: the database administrator runs ` +
        `ALTER ROLE ${role} NOREPLICATION (infra/postgres/init/01-roles.sh)`,
    );
  }
  if (facts.createRole) {
    problems.push(
      `role ${role} has CREATEROLE and can create and administer other roles: the database ` +
        `administrator runs ALTER ROLE ${role} NOCREATEROLE (infra/postgres/init/01-roles.sh)`,
    );
  }
  if (facts.createDb) {
    problems.push(
      `role ${role} has CREATEDB and can create databases that it owns: the database ` +
        `administrator runs ALTER ROLE ${role} NOCREATEDB (infra/postgres/init/01-roles.sh)`,
    );
  }
  if (facts.memberOf.length > 0) {
    problems.push(
      `role ${role} is a member of ${facts.memberOf.join(', ')} and so may hold its rights: ` +
        `the database administrator runs REVOKE <role> FROM ${role}; the runtime role is a ` +
        'member of no role (infra/postgres/init/01-roles.sh)',
    );
  }
  if (facts.owns.length > 0) {
    const shown = facts.owns.slice(0, 5).join(', ');
    const more = facts.owns.length > 5 ? ` and ${facts.owns.length - 5} more` : '';
    problems.push(
      `role ${role} owns ${shown}${more}, and an owner can alter an object and turn its ` +
        'row-level security off: make tinnox_migrator the owner (ALTER ... OWNER TO ' +
        'tinnox_migrator, in a new migration under db/migrations for a schema object); ' +
        'the runtime role owns nothing',
    );
  }
  return problems;
}

interface RuntimeRoleRow {
  current_role_name: string;
  session_role_name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolreplication: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  member_of: string[];
  owns: string[];
}

/**
 * Reads the facts of runtimeRoleProblems for the session of `client` from the catalogue.
 * pg_shdepend records the owner of every kind of object (tables, functions, schemas, types,
 * the database itself), as packages/db/test/catalogue.integration.test.ts reads it.
 */
export async function readRuntimeRole(client: pg.ClientBase): Promise<RuntimeRoleFacts> {
  const { rows } = await client.query<RuntimeRoleRow>(
    `SELECT current_user::text AS current_role_name, session_user::text AS session_role_name,
            r.rolsuper, r.rolbypassrls, r.rolreplication, r.rolcreaterole, r.rolcreatedb,
            ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid ORDER BY 1) AS member_of,
            ARRAY(SELECT pg_describe_object(d.classid, d.objid, d.objsubid) FROM pg_shdepend d
                  WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
                    AND d.deptype = 'o'
                    AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                  ORDER BY 1) AS owns
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the current role is missing from pg_roles');
  return {
    currentUser: row.current_role_name,
    sessionUser: row.session_role_name,
    superuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    replication: row.rolreplication,
    createRole: row.rolcreaterole,
    createDb: row.rolcreatedb,
    memberOf: row.member_of,
    owns: row.owns,
  };
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
