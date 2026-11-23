/**
 * The audit-debt guard (poteto adoption plan section 2.1 C, step 16; decision D3). TEST DATABASES
 * ONLY: the integration set-up installs it after the migrations; no migration creates it and no
 * other database gets it (every function below refuses one).
 *
 * What it holds: a transaction of the runtime role that changes a table whose changes must be
 * audited, and commits no audit_event row, fails at COMMIT. Types cannot see that mistake (a
 * handler that forgets the audit call compiles), so every route an integration test touches is
 * checked here, whatever its TypeScript says.
 *
 * How, with no table of its own and no privilege for anybody:
 *  - audit_debt_note, a row trigger on every audited table, writes the table into the
 *    transaction-local setting audit_debt.owed, unless the write is one D3 exempts;
 *  - audit_debt_paid, a row trigger on audit_event, sets audit_debt.paid;
 *  - audit_debt_settle, a deferred constraint trigger on every audited table, runs at COMMIT and
 *    raises when something is owed and nothing was paid.
 * Both settings are transaction-local, so a ROLLBACK, or a ROLLBACK TO SAVEPOINT, takes back the
 * debt or the payment with the rows.
 *
 * Who is judged: sessions that log in as tinnox_app, the API's own pool in the test harness
 * among them. Not judged: tinnox_migrator and the superuser (test helpers that arrange data, the
 * offline tools, the incident scripts), told apart by session_user; and a tinnox_app connection
 * whose application_name is TEST_SQL_APPLICATION_NAME, which is how a test says "this SQL is the
 * test's own, not product code" when it has to act as the runtime role (the tests of row-level
 * security, grants and the sec.* functions). Tests get that name only from unjudgedSql(why), so
 * every such connection says why it is not product code, and a search for unjudgedSql, appPool,
 * appClient and testSql finds them all.
 *
 * The catalogue test (packages/db/test/catalogue.integration.test.ts) describes the schema the
 * migrations produce, so it removes the guard before it reads; the set-up of the next test file
 * puts it back (scripts/vitest-integration-file-setup.ts).
 *
 * Every statement here is fixed text (tinnox/sql-fragments): the lists travel as parameters into
 * transaction-local settings, and the database quotes each table name itself (format %I).
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { errorField } from './error-field.ts';
import { connectMigrator } from './migrate.ts';

/**
 * The application_name of a tinnox_app connection that carries SQL a test wrote itself. The
 * guard does not judge it. Tests take it from unjudgedSql, never from here.
 */
export const TEST_SQL_APPLICATION_NAME = 'tinnox-test-sql';

/** A reason shorter than this says nothing a reviewer can check. */
const MIN_REASON = 20;

function requireReason(why: string, what: string): void {
  if (why.trim().length < MIN_REASON) {
    throw new Error(
      `${what} needs a reason of at least ${String(MIN_REASON)} characters: say why this SQL is not product code, or name the decision that leaves the path unaudited`,
    );
  }
}

/**
 * The application_name for a tinnox_app connection whose SQL the test writes itself (arranging
 * rows no route makes, trying what the role may do), which the guard does not judge. `why` says
 * what that SQL is. A product call (a route's handler, a publishing helper, a sec.* wrapper a
 * route pairs with an audit row) never runs on such a connection to get past the guard.
 */
export function unjudgedSql(why: string): string {
  requireReason(why, 'unjudgedSql');
  return TEST_SQL_APPLICATION_NAME;
}

/**
 * SQLSTATE of the guard's refusal. Class 23 (integrity constraint violation), which is what a
 * deferred trigger that fails a COMMIT is: run() in ./tx.ts then knows the transaction rolled
 * back, as it does for a deferred foreign key. A private subclass, so no route's handling of
 * 23503, 23505 or 23001 can take the refusal for a conflict and answer 409.
 */
export const AUDIT_DEBT_SQLSTATE = '23U01';

/** Tables the guard never looks at. */
export const UNWATCHED_TABLES = [
  // The runner's own history; only tinnox_migrator writes it.
  'schema_migrations',
  // The audit trail itself: a row here is the payment, not a debt.
  'audit_event',
] as const;

/** D3 and plan section 2.1 C: tables whose changes need no audit row, each with D3's reason. */
export const EXEMPT_TABLES: Readonly<Record<string, string>> = {
  heartbeat_log:
    'D3: heartbeats are telemetry, and the heartbeat log is where they are kept; the hourly purge only removes rows past their retention',
  display_delivery:
    'plan section 2.1 C and D3: the delivery state a heartbeat reports is telemetry; the desired publication is written by a publish, whose publication row is audited',
  login_state:
    'D3: pre-sign-in login state grants nothing, and the outcome of the sign-in it belongs to is audited at the callback',
};

/**
 * D3: columns whose change needs no audit row. An UPDATE that changes nothing but these owes
 * nothing; one that also changes another column does.
 */
export const EXEMPT_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  session: {
    last_seen_at:
      'D3: session activity; sec.session_by_id_hash stamps it on every authenticated request',
  },
  pairing_session: {
    failed_attempts:
      'D3: the wrong-attempt counter of pairing polls, a counter under its threshold; the attempt that locks the session also changes status, and that is audited as pairing.lock',
  },
};

/**
 * D3: the purges. A write made inside one of these functions owes nothing: they only remove
 * data whose retention period has run out. Told apart by the call stack, so the same DELETE
 * sent by a route is judged.
 */
export const EXEMPT_FUNCTIONS: Readonly<Record<string, string>> = {
  'sec.session_purge_expired':
    'D3: purge; drops the id token of ended sessions and deletes sessions ended over a day ago',
  'sec.pairing_purge': 'D3: purge; deletes pairing sessions past their retention',
  'sec.heartbeat_log_purge': 'D3: purge; deletes heartbeat history past its retention',
};

/** The triggers of the guard, which carry the names of its three functions. */
const GUARD_TRIGGERS = ['audit_debt_note', 'audit_debt_settle', 'audit_debt_paid'] as const;

/** True for the sessions the guard judges; evaluated when the row changes. */
const JUDGED = `session_user = 'tinnox_app' AND current_setting('application_name') <> '${TEST_SQL_APPLICATION_NAME}'`;

/**
 * Notes the debt. TG_ARGV[0]: the exempt columns of the table, comma-separated, or empty.
 * TG_ARGV[1]: a pattern that matches the call stack inside a purge function.
 */
export const NOTE_FUNCTION = `
  CREATE FUNCTION public.audit_debt_note() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp AS $guard$
  DECLARE
    o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
    n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
    exempt_columns text[] := string_to_array(TG_ARGV[0], ',');
    stack text;
    entry text := 'public.' || TG_TABLE_NAME || ' (' || TG_OP || ')';
    owed text := coalesce(current_setting('audit_debt.owed', true), '');
  BEGIN
    -- EXEMPT_COLUMNS: an UPDATE that changed nothing else.
    IF TG_OP = 'UPDATE' AND TG_ARGV[0] <> '' AND (n - exempt_columns) = (o - exempt_columns) THEN
      RETURN NULL;
    END IF;
    -- EXEMPT_FUNCTIONS: with the search_path above, the stack names each function with its schema.
    GET DIAGNOSTICS stack = PG_CONTEXT;
    IF stack ~ TG_ARGV[1] THEN RETURN NULL; END IF;
    IF position(entry in owed) = 0 THEN
      PERFORM set_config('audit_debt.owed', owed || CASE WHEN owed = '' THEN '' ELSE ', ' END || entry, true);
    END IF;
    RETURN NULL;
  END $guard$`;

/** Notes the payment: an audit row of this transaction. */
export const PAID_FUNCTION = `
  CREATE FUNCTION public.audit_debt_paid() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp AS $guard$
  BEGIN
    PERFORM set_config('audit_debt.paid', 'yes', true);
    RETURN NULL;
  END $guard$`;

/** Judges at COMMIT. The message says what to do instead (adoption plan section 3.4). */
export const SETTLE_FUNCTION = `
  CREATE FUNCTION public.audit_debt_settle() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp AS $guard$
  DECLARE
    owed text := coalesce(current_setting('audit_debt.owed', true), '');
  BEGIN
    IF owed <> '' AND coalesce(current_setting('audit_debt.paid', true), '') = '' THEN
      RAISE EXCEPTION 'audit debt: this transaction changed % as tinnox_app and commits no audit_event row. Write the audit row on the same Tx as the change, with auditScoped(tx, event) or auditUnscoped(tx, event) from @tinnox/db, so both commit or neither does (AGENTS.md section 3). Only a write that decision D3 exempts goes in the lists of packages/db/src/audit-debt-guard.ts, with D3''s reason; product code never moves to a connection the guard does not judge.', owed
        USING ERRCODE = '${AUDIT_DEBT_SQLSTATE}', CONSTRAINT = 'audit_debt';
    END IF;
    RETURN NULL;
  END $guard$`;

/**
 * A trigger function is not called through EXECUTE, so nobody needs the right; without this
 * PUBLIC would hold it, as on every new function.
 */
export const REVOKE_FUNCTIONS =
  'REVOKE ALL ON FUNCTION public.audit_debt_note(), public.audit_debt_settle(), public.audit_debt_paid() FROM PUBLIC';

/**
 * Creates the triggers: one on audit_event, two on every table of schema public that
 * audit_debt.skipped_tables does not name. Reads the three settings guardSettings() makes.
 */
export const CREATE_TRIGGERS = `
  DO $install$
  DECLARE
    skipped text[] := string_to_array(current_setting('audit_debt.skipped_tables'), ',');
    exempt_columns jsonb := current_setting('audit_debt.exempt_columns')::jsonb;
    purges text := current_setting('audit_debt.purge_stack');
    audited text;
  BEGIN
    CREATE TRIGGER audit_debt_paid AFTER INSERT ON public.audit_event
      FOR EACH ROW WHEN (${JUDGED}) EXECUTE FUNCTION public.audit_debt_paid();
    FOR audited IN
      SELECT c.relname::text FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname::text <> ALL (skipped)
      ORDER BY 1
    LOOP
      EXECUTE format(
        $trigger$CREATE TRIGGER audit_debt_note AFTER INSERT OR UPDATE OR DELETE ON public.%I
          FOR EACH ROW WHEN (${JUDGED}) EXECUTE FUNCTION public.audit_debt_note(%L, %L)$trigger$,
        audited, coalesce(exempt_columns->>audited, ''), purges);
      EXECUTE format(
        $trigger$CREATE CONSTRAINT TRIGGER audit_debt_settle AFTER INSERT OR UPDATE OR DELETE ON public.%I
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (${JUDGED}) EXECUTE FUNCTION public.audit_debt_settle()$trigger$,
        audited);
    END LOOP;
  END $install$`;

/** Drops every trigger of the guard, wherever it is, and its functions. */
const DROP_GUARD = `
  DO $remove$
  DECLARE
    found record;
  BEGIN
    FOR found IN
      SELECT t.tgname::text AS trigger_name, c.relname::text AS table_name
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND t.tgname IN ('audit_debt_note', 'audit_debt_settle', 'audit_debt_paid')
    LOOP
      EXECUTE format('DROP TRIGGER %I ON public.%I', found.trigger_name, found.table_name);
    END LOOP;
    DROP FUNCTION IF EXISTS public.audit_debt_note(), public.audit_debt_settle(), public.audit_debt_paid();
  END $remove$`;

/** Stores what ensureAuditDebtGuard compares: the setting audit_debt.fingerprint. */
const STAMP_GUARD = `
  DO $stamp$
  BEGIN
    EXECUTE format('COMMENT ON FUNCTION public.audit_debt_settle() IS %L', current_setting('audit_debt.fingerprint'));
  END $stamp$`;

/** Stops, and starts again, the noting of debts on the table audit_debt.allowed_table names. */
const STOP_NOTING = `
  DO $allow$
  BEGIN
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER audit_debt_note', current_setting('audit_debt.allowed_table'));
  END $allow$`;
const START_NOTING = `
  DO $allow$
  BEGIN
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER audit_debt_note', current_setting('audit_debt.allowed_table'));
  END $allow$`;

/** The tables that get the guard's triggers, of `tables` (the tables of schema public). */
export function auditedTables(tables: readonly string[]): string[] {
  const unwatched: readonly string[] = UNWATCHED_TABLES;
  return tables
    .filter((name) => !unwatched.includes(name) && !Object.hasOwn(EXEMPT_TABLES, name))
    .sort();
}

/**
 * A name in one of the lists above that is not a table of the schema: the list is stale, and an
 * exemption nobody can match would hide that. One sentence each, saying what to do.
 */
export function staleListProblems(tables: readonly string[]): string[] {
  const named = [
    ...Object.keys(EXEMPT_TABLES).map((table) => ({ table, list: 'EXEMPT_TABLES' })),
    ...Object.keys(EXEMPT_COLUMNS).map((table) => ({ table, list: 'EXEMPT_COLUMNS' })),
  ];
  return named
    .filter(({ table }) => !tables.includes(table))
    .map(
      ({ table, list }) =>
        `${list} of packages/db/src/audit-debt-guard.ts names table ${table}, which is not in schema public: remove the entry, or rename it with the table.`,
    );
}

/** The lists above as the settings CREATE_TRIGGERS reads; each value travels as a parameter. */
export function guardSettings(): {
  readonly skippedTables: string;
  readonly exemptColumns: string;
  readonly purgeStack: string;
} {
  const purges = Object.keys(EXEMPT_FUNCTIONS).map((name) => name.replaceAll('.', '\\.'));
  return {
    skippedTables: [...UNWATCHED_TABLES, ...Object.keys(EXEMPT_TABLES)].join(','),
    exemptColumns: JSON.stringify(
      Object.fromEntries(
        Object.entries(EXEMPT_COLUMNS).map(([table, columns]) => [
          table,
          Object.keys(columns).join(','),
        ]),
      ),
    ),
    // As PG_CONTEXT prints a frame: "PL/pgSQL function sec.pairing_purge(integer) line 9 ...".
    purgeStack: `function (${purges.join('|')})\\(`,
  };
}

/** Changes when the guard's SQL, its lists or the audited tables change. */
function fingerprint(tables: readonly string[]): string {
  const parts = [
    NOTE_FUNCTION,
    PAID_FUNCTION,
    SETTLE_FUNCTION,
    REVOKE_FUNCTIONS,
    CREATE_TRIGGERS,
    JSON.stringify(guardSettings()),
    auditedTables(tables).join(','),
  ];
  return `audit-debt guard ${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

/** The triggers the guard has when it is whole: `table.trigger`, sorted. */
function expectedTriggers(tables: readonly string[]): string[] {
  return [
    'audit_event.audit_debt_paid',
    ...auditedTables(tables).flatMap((table) => [
      `${table}.audit_debt_note`,
      `${table}.audit_debt_settle`,
    ]),
  ].sort();
}

interface GuardState {
  readonly tables: readonly string[];
  /** `table.trigger`, sorted; one that is not in its ordinary enabled state ends in ` [X]`. */
  readonly triggers: readonly string[];
  readonly comment: string | null;
}

async function readState(client: pg.ClientBase): Promise<GuardState> {
  const tables = await client.query<{ name: string }>(
    `SELECT c.relname::text AS name FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  const triggers = await client.query<{ name: string }>(
    `SELECT c.relname::text || '.' || t.tgname::text
              || CASE t.tgenabled WHEN 'O' THEN '' ELSE ' [' || t.tgenabled::text || ']' END AS name
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname::text = ANY($1) ORDER BY 1`,
    [[...GUARD_TRIGGERS]],
  );
  const comment = await client.query<{ comment: string | null }>(
    `SELECT pg_catalog.obj_description(p.oid, 'pg_proc') AS comment FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'audit_debt_settle'`,
  );
  return {
    tables: tables.rows.map((row) => row.name),
    triggers: triggers.rows.map((row) => row.name),
    comment: comment.rows[0]?.comment ?? null,
  };
}

const isWhole = (state: GuardState): boolean =>
  state.comment === fingerprint(state.tables) &&
  state.triggers.join('\n') === expectedTriggers(state.tables).join('\n');

/** Only a database whose name ends in `_test`, as resetTestDatabase. */
async function refuseOtherDatabases(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows[0]?.name ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `refusing to touch the audit-debt guard in database "${name}": it is a test-only guard, for *_test databases. No other database gets it; what production must hold is a migration (db/migrations)`,
    );
  }
}

/** Runs `work` in one transaction as tinnox_migrator, on a test database. */
async function asMigrator<T>(
  migratorUrl: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await connectMigrator(migratorUrl, { applicationName: 'tinnox-audit-debt-guard' });
  try {
    const client = await pool.connect();
    try {
      await refuseOtherDatabases(client);
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function install(client: pg.ClientBase, state: GuardState): Promise<void> {
  if (!state.tables.includes('audit_event')) {
    throw new Error(
      'the audit-debt guard needs the migrated schema and found no table public.audit_event: run the migrations first (runMigrations from @tinnox/db/migrate), then install the guard',
    );
  }
  const stale = staleListProblems(state.tables);
  if (stale.length > 0) throw new Error(stale.join(' '));
  const settings = guardSettings();
  await client.query(
    `SELECT set_config('audit_debt.skipped_tables', $1, true),
            set_config('audit_debt.exempt_columns', $2, true),
            set_config('audit_debt.purge_stack', $3, true),
            set_config('audit_debt.fingerprint', $4, true)`,
    [
      settings.skippedTables,
      settings.exemptColumns,
      settings.purgeStack,
      fingerprint(state.tables),
    ],
  );
  await client.query(DROP_GUARD);
  await client.query(NOTE_FUNCTION);
  await client.query(PAID_FUNCTION);
  await client.query(SETTLE_FUNCTION);
  await client.query(REVOKE_FUNCTIONS);
  await client.query(CREATE_TRIGGERS);
  await client.query(STAMP_GUARD);
  // The loop of CREATE_TRIGGERS and auditedTables() read the same lists; this fails if they
  // ever disagree about a table.
  if (!isWhole(await readState(client))) {
    throw new Error(
      'the audit-debt guard was installed and is not whole: the triggers in the database are not the ones auditedTables() expects (packages/db/src/audit-debt-guard.ts)',
    );
  }
}

/**
 * Installs the guard, replacing one that is there. Connects as tinnox_migrator (connectMigrator
 * refuses any other role) and refuses a database whose name does not end in `_test`. The schema
 * must be migrated: the guard goes on the tables that exist now, and a table a later migration
 * adds is audited from the next install on, unless it joins a list above.
 */
export async function installAuditDebtGuard(migratorUrl: string): Promise<void> {
  await asMigrator(migratorUrl, async (client) => {
    await install(client, await readState(client));
  });
}

/**
 * Installs the guard unless it is there, whole and current. The set-up of every integration
 * test file calls it: a file that rebuilt the schema (the migration tests) or removed the guard
 * (the catalogue test) leaves none behind, and the next file gets it back.
 * @returns true when it had to install
 */
export async function ensureAuditDebtGuard(migratorUrl: string): Promise<boolean> {
  return asMigrator(migratorUrl, async (client) => {
    const state = await readState(client);
    if (isWhole(state)) return false;
    await install(client, state);
    return true;
  });
}

/** Removes every object of the guard; a database without it is left as it is. */
export async function removeAuditDebtGuard(migratorUrl: string): Promise<void> {
  await asMigrator(migratorUrl, async (client) => {
    await client.query(DROP_GUARD);
  });
}

/**
 * Runs `work` while changes to `table` owe no audit row, for the test of a path that is
 * unaudited by a recorded decision (`why` names it). While a decision is still open (the step
 * 16 report put two to Michael), `why` starts "undecided" and says so; the guard itself lets
 * nothing through for them. Everything else stays judged, and the guard is whole again when
 * this returns. Not for arranging data: do that as tinnox_migrator,
 * or on a connection named by unjudgedSql.
 */
export async function whileUnauditedAllowed<T>(
  migratorUrl: string,
  table: string,
  why: string,
  work: () => Promise<T>,
): Promise<T> {
  if (why.trim().length < 20) {
    throw new Error('whileUnauditedAllowed needs the decision that leaves this path unaudited');
  }
  const allow = (stop: boolean): Promise<void> =>
    asMigrator(migratorUrl, async (client) => {
      const { tables } = await readState(client);
      if (!auditedTables(tables).includes(table)) {
        throw new Error(`${table} is not a table the audit-debt guard watches`);
      }
      await client.query("SELECT set_config('audit_debt.allowed_table', $1, true)", [table]);
      await client.query(stop ? STOP_NOTING : START_NOTING);
    });
  await allow(true);
  try {
    return await work();
  } finally {
    await allow(false);
  }
}

/** The refusals the guard made on any connection of this process since the last `take`. */
export interface AuditDebtWatch {
  /** The messages, oldest first; the list is empty afterwards. */
  take(): string[];
}

const watching = Symbol.for('tinnox.auditDebtWatch');

function isWatch(value: unknown): value is AuditDebtWatch {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'take') === 'function'
  );
}

/**
 * Remembers every refusal of the guard that reaches this process, whoever catches it. A route
 * answers 500 for one and logs nothing in tests, and product code may swallow one (the sign-out
 * fallback does), so the test would fail on a status with no word of why; the set-up of every
 * integration test file fails the test with the guard's own message instead. It reads the
 * errors of pg's Client.query, which every pool and client of the process goes through.
 */
export function watchAuditDebt(): AuditDebtWatch {
  const existing: unknown = Reflect.get(pg.Client.prototype, watching);
  if (isWatch(existing)) return existing;
  const seen: string[] = [];
  const note = (error: unknown): void => {
    if (errorField(error, 'code') !== AUDIT_DEBT_SQLSTATE) return;
    const message = errorField(error, 'message');
    seen.push(typeof message === 'string' ? message : 'audit debt (no message)');
  };
  const original: unknown = Reflect.get(pg.Client.prototype, 'query');
  if (typeof original !== 'function')
    throw new Error('pg.Client.prototype.query is not a function');
  const patched = function query(this: pg.Client, ...args: unknown[]): unknown {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (error: unknown, ...rest: unknown[]): unknown => {
        note(error);
        const answer: unknown = Reflect.apply(callback, undefined, [error, ...rest]);
        return answer;
      };
    }
    const result: unknown = Reflect.apply(original, this, args);
    // Observed only: the caller still gets the rejection.
    if (result instanceof Promise) result.then(undefined, note);
    return result;
  };
  const watch: AuditDebtWatch = { take: () => seen.splice(0) };
  Reflect.set(pg.Client.prototype, 'query', patched);
  Reflect.set(pg.Client.prototype, watching, watch);
  return watch;
}
