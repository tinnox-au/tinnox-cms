import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { Pool } from './pool.ts';
import {
  SchemaInvariantError,
  assertSchemaInvariants,
  schemaProblemsInTransaction,
} from './schema-invariants.ts';

const MIGRATOR_ROLE = 'tinnox_migrator';

declare const migratorBrand: unique symbol;
/**
 * A pool that connectMigrator has checked: its session acts as tinnox_migrator. The brand
 * stops a mistake at compile time, since tsc refuses the runtime pool or a plain superuser
 * pool where a MigratorPool is wanted. It does not stop a deliberate cast by itself: lint
 * refuses a cast to MigratorPool outside this file (NO_MIGRATOR_POOL_CAST in eslint.config.js),
 * and what that rule cannot see is left to review.
 */
export type MigratorPool = Pool & { readonly [migratorBrand]: true };

/**
 * The one way the offline tools connect as tinnox_migrator: the runner, the test reset, the
 * seed and provisioning all come through here (poteto adoption plan, decision D4). Test
 * helpers that arrange data, and the administrator's psql session for the incident scripts,
 * connect without it. Refuses unless current_user and session_user are both tinnox_migrator:
 * the session then acts with the migrator's rights and under its identity, which the 0013
 * exemptions test. So neither the runtime role nor the superuser (even after SET ROLE
 * tinnox_migrator, whose writes the 0013 exemptions would not cover) can run them. A superuser
 * cannot pass by setting session_authorization at startup either: PostgreSQL 17 keeps
 * session_user as the login (checked on 2026-11-22). The check runs once, at connect, on the
 * pool's one connection, which is kept while idle. If that connection drops, the pool opens
 * another with the same connection string on the next use and does not check it again.
 */
export async function connectMigrator(
  connectionString: string,
  options: { readonly applicationName: string },
): Promise<MigratorPool> {
  const pool = new pg.Pool({
    connectionString,
    application_name: options.applicationName,
    max: 1,
    idleTimeoutMillis: 0,
  });
  // As createPool: a lost idle connection must not crash the tool.
  pool.on('error', () => undefined);
  try {
    const { rows } = await pool.query<{ current_user: string; session_user: string }>(
      'SELECT current_user, session_user',
    );
    const who = rows[0];
    if (who?.current_user !== MIGRATOR_ROLE || who.session_user !== MIGRATOR_ROLE) {
      throw new Error(
        `this tool must log in and act as role ${MIGRATOR_ROLE}, but the connection logs in as ` +
          `${who?.session_user ?? 'unknown'} and acts as ${who?.current_user ?? 'unknown'}; ` +
          `use the ${MIGRATOR_ROLE} connection string without a role setting`,
      );
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return pool as MigratorPool;
}

export interface MigrationOptions {
  /** Connection string for role tinnox_migrator; connectMigrator refuses any other. */
  readonly connectionString: string;
  /** Directory holding NNNN_name.sql files. */
  readonly directory: string;
  readonly log?: (message: string) => void;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/** A migration file name; the first group is its four-digit number. */
export const MIGRATION_FILE_PATTERN = /^([0-9]{4})_[a-z0-9_]+\.sql$/;
/** Arbitrary constant; serialises concurrent migration runs on one database. */
const ADVISORY_LOCK_KEY = 7_411_660_001;
/**
 * How long a migration statement (or the wait for the advisory lock) may wait for a lock. The
 * runner sends it on its own session, so it holds on a database whatever its role defaults say
 * (AGENTS.md section 4, Locks). infra/postgres/init/01-roles.sh sets the same value as a default
 * for ad-hoc sessions as tinnox_migrator.
 */
export const MIGRATION_LOCK_TIMEOUT = '30s';

export type MigrationNameProblem =
  | { readonly kind: 'pattern'; readonly name: string }
  | { readonly kind: 'duplicate'; readonly name: string; readonly number: string };

/**
 * Checks migration file names in the order given (the runner passes them sorted): each looks
 * like 0001_description.sql and no number repeats. Shared by the runner, which refuses the
 * first problem before it connects, and by `npm run check:migrations`, which reports them all.
 */
export function validateMigrationNames(names: readonly string[]): MigrationNameProblem[] {
  const problems: MigrationNameProblem[] = [];
  const versions = new Set<string>();
  for (const name of names) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (match === null || match[1] === undefined) {
      problems.push({ kind: 'pattern', name });
      continue;
    }
    if (versions.has(match[1])) problems.push({ kind: 'duplicate', name, number: match[1] });
    versions.add(match[1]);
  }
  return problems;
}

/** The runner's error text for a name problem. */
export function migrationNameMessage(problem: MigrationNameProblem): string {
  return problem.kind === 'pattern'
    ? `migration file name must look like 0001_description.sql: ${problem.name}`
    : `duplicate migration number ${problem.number}`;
}

/**
 * Applies pending SQL migrations in file-name order. Each file runs in its own
 * transaction together with its schema_migrations row, so a failure leaves no
 * partial migration. The directory is checked against the recorded history first:
 * an applied file that is missing or changed, or a new file numbered before an
 * applied one, is an error and nothing is applied.
 *
 * The runner owns the schema invariants (./schema-invariants.ts; plan section 3.3, EAX-12), so
 * no migration pastes a guard for them. It checks them after each file and before that file's
 * COMMIT: a file that leaves the schema outside them is rolled back with its history row, the
 * files before it in the same run stay applied (each passed the check), and the run fails
 * naming every object and what to do. The next run starts at the same file. A run with nothing
 * pending checks once, so a database changed by hand is refused too, with nothing altered.
 * Either way the run ends in the `finally` below, which gives the advisory lock back.
 *
 * A problem that was there before the run refuses the first pending file as well, unless that
 * file repairs it: no file is committed on a schema outside the invariants, as the guards pasted
 * into 0001 to 0014 never let one. So a repair is a migration that is the first one pending, or
 * is made by hand; a repair that sorts after another pending file is never reached.
 */
export async function runMigrations(options: MigrationOptions): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);
  const names = (await readdir(options.directory)).filter((n) => n.endsWith('.sql')).sort();
  const [problem] = validateMigrationNames(names);
  if (problem !== undefined) throw new Error(migrationNameMessage(problem));

  const pool = await connectMigrator(options.connectionString, {
    applicationName: 'tinnox-migrate',
  });
  // One session for the whole run: the advisory lock below is held by it.
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end().catch(() => undefined);
    throw error;
  });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    // Before the advisory lock, which a lock_timeout also bounds. Session level (is_local false):
    // each migration's BEGIN and ROLLBACK leave it alone.
    await client.query("SELECT set_config('lock_timeout', $1, false)", [MIGRATION_LOCK_TIMEOUT]);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = await client.query<{ name: string; sha256: string }>(
      'SELECT name, sha256 FROM public.schema_migrations',
    );
    const doneByName = new Map(done.rows.map((r) => [r.name, r.sha256]));

    // Check the whole bundle against the recorded history before anything is applied, so a
    // bundle that does not fit this database is refused with the schema exactly as it was.
    for (const name of doneByName.keys()) {
      if (!names.includes(name))
        throw new Error(`database has migration ${name} that is missing from ${options.directory}`);
    }
    const lastApplied = [...doneByName.keys()].sort().at(-1);
    const pending: { name: string; sql: string; digest: string }[] = [];
    for (const name of names) {
      const sql = await readFile(join(options.directory, name), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const previous = doneByName.get(name);
      if (previous === undefined) {
        if (lastApplied !== undefined && name < lastApplied) {
          throw new Error(
            `migration ${name} is new but sorts before ${lastApplied}, which is already applied; give it the next number`,
          );
        }
        pending.push({ name, sql, digest });
      } else if (previous !== digest) {
        throw new Error(
          `migration ${name} was changed after it was applied; add a new migration instead`,
        );
      } else {
        alreadyApplied.push(name);
      }
    }

    // What is already wrong before this run touches anything. With files pending this read
    // refuses nothing by itself, because the first of them may be the repair. Only the first:
    // the check after each file refuses every problem, the older ones included. The list lets
    // that failure say which problems the file did not make, and how to get past them.
    await client.query('BEGIN');
    let knownBefore: string[];
    try {
      knownBefore = await schemaProblemsInTransaction(client);
    } finally {
      await client.query('ROLLBACK');
    }

    for (const { name, sql, digest } of pending) {
      log(`applying ${name}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, $2)', [
          name,
          digest,
        ]);
        await assertSchemaInvariants(client, knownBefore);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`migration ${name} failed and was rolled back: ${message}`, {
          cause: error,
        });
      }
      applied.push(name);
    }
    if (pending.length === 0 && knownBefore.length > 0) {
      throw new SchemaInvariantError(
        knownBefore,
        'No migration was pending and this run changed nothing: the database was changed ' +
          'outside the migrations, or these rules are newer than it. Put it right in a new ' +
          'migration, or by hand as the database administrator, and run again.',
      );
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
  return { applied, alreadyApplied };
}

/**
 * TEST DATABASES ONLY. Drops everything the migrator owns in schemas public and
 * sec so migrations can run from scratch. Refuses any database whose name does
 * not end in `_test`.
 */
export async function resetTestDatabase(connectionString: string): Promise<void> {
  const pool = await connectMigrator(connectionString, { applicationName: 'tinnox-test-reset' });
  try {
    const db = await pool.query<{ name: string }>('SELECT current_database() AS name');
    const name = db.rows[0]?.name ?? '';
    if (!name.endsWith('_test')) {
      throw new Error(`refusing to reset database "${name}": only *_test databases may be reset`);
    }
    await pool.query('DROP SCHEMA IF EXISTS sec CASCADE');
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
}
