/**
 * The released levels of the schema and a database built at one of them (adoption plan section
 * 4.3, decision D13).
 *
 * A level is a migration file that main has stood at: 0004 and every later file in db/migrations,
 * read from the directory each time, with no hand-kept list and no tags. 0001 to 0004 were merged
 * together (1c30f10), so no database was ever at 0001, 0002 or 0003. A branch's own new file is a
 * level too, so its seeder lands with it. Each level has a seeder, levels/seed-NNNN.ts: plain SQL
 * valid at that level, importing nothing but its own folder (eslint.config.js, the db-levels
 * facet), so a fixture for an old level can never be written with today's helpers.
 *
 * `atLevel` builds a database at a level in its own database, created here and dropped by
 * `drop()`, never the development database or the shared integration-test database: a test that
 * starts from an old level can then never leave the shared database behind. Integration files run
 * one at a time (vitest.config.ts), so they share the one name.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { MIGRATION_FILE_PATTERN, runMigrations, type MigrationResult } from '../src/migrate.ts';
import type { Seeder } from './levels/sql.ts';
import { superuserUrl } from './support.ts';

export const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);
export const SEEDERS = join(dirname(fileURLToPath(import.meta.url)), 'levels');
/** The first level main stood at: 0001 to 0004 were merged together in 1c30f10 (D13). */
export const FIRST_RELEASED_LEVEL = '0004';
/** The database `atLevel` builds; its name ends in _test, so resetTestDatabase would take it. */
export const LEVEL_DATABASE = 'tinnox_migrate_test';

const SEEDER_FILE = /^seed-([0-9]{4})\.ts$/;

export interface Level {
  /** Four digits, as in the file name. */
  readonly level: string;
  /** The migration file, e.g. 0012_pairing_upgrade_cleanup.sql. */
  readonly file: string;
}

/** The released levels among `names` (the entries of db/migrations), in order. */
export function releasedLevels(names: readonly string[]): Level[] {
  return names
    .flatMap((file) => {
      const level = MIGRATION_FILE_PATTERN.exec(file)?.[1];
      return level === undefined || level < FIRST_RELEASED_LEVEL ? [] : [{ level, file }];
    })
    .sort((a, b) => a.level.localeCompare(b.level));
}

/**
 * What is wrong with the seeders for `levels`, given the entries of the levels folder: a level
 * with no seeder, and a seeder with no level. Each message says what to do.
 */
export function seederProblems(levels: readonly Level[], entries: readonly string[]): string[] {
  const seeded = new Set(entries.flatMap((name) => SEEDER_FILE.exec(name)?.[1] ?? []));
  const known = new Set(levels.map((l) => l.level));
  return [
    ...levels
      .filter((l) => !seeded.has(l.level))
      .map(
        ({ level, file }) =>
          `db/migrations/${file} is level ${level} of the migrate-forward chain (D13: 0004 and every later file) but has no seeder. ` +
          `Add packages/db/test/levels/seed-${level}.ts exporting \`seeder\`, which plants in plain SQL valid at ${level} the rows an installation at ${level} could hold: ` +
          `export const seeder: Seeder = { level: '${level}', plants: 'what the rows are', seed: async (client) => { ... } }. ` +
          `When ${file} adds nothing a row could hold, export a no-op seeder that says why: ` +
          `export const seeder: Seeder = { level: '${level}', reason: 'only replaces sec.example(); no table or column changes' }. ` +
          `A seeder imports only from its own folder (./sql.ts), never @tinnox/* (D13).`,
      ),
    ...[...seeded]
      .filter((level) => !known.has(level))
      .map(
        (level) =>
          `packages/db/test/levels/seed-${level}.ts seeds level ${level}, but db/migrations has no file ${level}_*.sql at or after ${FIRST_RELEASED_LEVEL}: rename it to the level it seeds, or remove it with the migration it was written for.`,
      ),
  ];
}

/** The levels read from db/migrations now, refused when a seeder is missing or has no level. */
export async function currentLevels(): Promise<Level[]> {
  const levels = releasedLevels(await readdir(MIGRATIONS));
  const problems = seederProblems(levels, await readdir(SEEDERS));
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return levels;
}

/** The seeder of `level`, loaded from levels/seed-NNNN.ts and checked to name its level. */
export async function seederOf(level: string): Promise<Seeder> {
  const path = join(SEEDERS, `seed-${level}.ts`);
  const loaded = (await import(pathToFileURL(path).href)) as { seeder?: Seeder };
  const seeder = loaded.seeder;
  if (seeder?.level !== level) {
    throw new Error(
      `packages/db/test/levels/seed-${level}.ts must export \`seeder\` with level '${level}'`,
    );
  }
  return seeder;
}

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function asAdministrator(...statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: superuserUrl('postgres') });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A database being built level by level. */
export interface LevelDatabase {
  readonly name: string;
  /** tinnox_migrator on this database: the runner, and the seeders. */
  readonly migratorUrl: string;
  /** tinnox_app on this database. */
  readonly appUrl: string;
  /** The administrator on this database: reads every organisation's rows. */
  readonly superuserUrl: string;
  /**
   * Applies every file up to `level` with the real runner, which checks the schema invariants
   * after each file. A refusal names the level and the file.
   */
  applyThrough(level: Level): Promise<MigrationResult>;
  /** Runs the seeder of `level`; call it when the database is at that level. */
  seed(level: Level): Promise<void>;
  /** Applies every file in db/migrations. */
  upgrade(): Promise<MigrationResult>;
  /** A plain client logged in as tinnox_migrator; the caller ends it. */
  migrator(): Promise<pg.Client>;
  /** A plain client logged in as the administrator; the caller ends it. */
  administrator(): Promise<pg.Client>;
  drop(): Promise<void>;
}

/**
 * Creates `database` afresh (dropping what a crashed run left), with the settings of tinnox_test
 * in infra/postgres/init/01-roles.sh, as tests/e2e/support/database.ts and tests/integration/
 * seed.test.ts create theirs. Nothing is applied yet.
 */
export async function createLevelDatabase(database = LEVEL_DATABASE): Promise<LevelDatabase> {
  if (!/^tinnox_[a-z_]+_test$/.test(database)) {
    throw new Error(`a level database is named tinnox_<purpose>_test, not ${database}`);
  }
  await asAdministrator(
    `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    `CREATE DATABASE ${database} OWNER tinnox_migrator ENCODING 'UTF8'`,
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${database} TO tinnox_app`,
    `ALTER DATABASE ${database} SET timezone = 'UTC'`,
  );
  const migratorUrl = withDatabase(need('TEST_DATABASE_MIGRATOR_URL'), database);
  const administratorUrl = superuserUrl(database);
  const connect = async (connectionString: string, applicationName: string) => {
    const client = new pg.Client({ connectionString, application_name: applicationName });
    await client.connect();
    return client;
  };
  const applyThrough = async (level: Level): Promise<MigrationResult> => {
    const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
    const upTo = names.filter((n) => n <= level.file);
    const scratch = await mkdtemp(join(tmpdir(), `tinnox-level-${level.level}-`));
    try {
      for (const name of upTo) await copyFile(join(MIGRATIONS, name), join(scratch, name));
      return await runMigrations({ connectionString: migratorUrl, directory: scratch });
    } catch (error) {
      throw new Error(
        `level ${level.level}: the runner refused ${level.file}: ${
          error instanceof Error ? error.message : String(error)
        }\nWhen the seeders of the levels before it ran, each must leave rows every later migration accepts: fix the seeder that planted the row named above.`,
        { cause: error },
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  return {
    name: database,
    migratorUrl,
    appUrl: withDatabase(need('TEST_DATABASE_URL'), database),
    superuserUrl: administratorUrl,
    applyThrough,
    async seed(level) {
      const seeder = await seederOf(level.level);
      if (!('seed' in seeder)) return;
      const client = await connect(migratorUrl, 'tinnox-test-level-seed');
      try {
        await seeder.seed(client);
      } catch (error) {
        throw new Error(
          `level ${level.level}: packages/db/test/levels/seed-${level.level}.ts failed at its own level: ${
            error instanceof Error ? error.message : String(error)
          }\nA seeder writes plain SQL valid at ${level.file}, with that level's columns and rules.`,
          { cause: error },
        );
      } finally {
        await client.end();
      }
    },
    upgrade: () => runMigrations({ connectionString: migratorUrl, directory: MIGRATIONS }),
    migrator: () => connect(migratorUrl, 'tinnox-test-arrange'),
    administrator: () => connect(administratorUrl, 'tinnox-test-level-read'),
    drop: () => asAdministrator(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
  };
}

/**
 * What a migrated database's catalogue holds, for comparing two builds (the chain's upgraded
 * database with a fresh one) or one build before and after a failed migration
 * (migration-0005.integration.test.ts): tables with their row-level security and owner, columns
 * with their defaults, every constraint's, function's and trigger's definition (functions in
 * public and sec, with their owner), indexes, policies, and the grants on tables, columns and
 * functions, which an upgrade could leave different from a fresh build while the names agree.
 * Read it as tinnox_migrator or the administrator: the privilege views show only grants the
 * reader made or holds.
 */
export type SchemaSnapshot = Readonly<Record<SnapshotPart, string[]>>;
type SnapshotPart =
  | 'migrations'
  | 'tables'
  | 'columns'
  | 'constraints'
  | 'indexes'
  | 'triggers'
  | 'triggerDefinitions'
  | 'functions'
  | 'policies'
  | 'grants'
  | 'tableGrants'
  | 'routineGrants';
export async function schemaSnapshot(client: pg.Client): Promise<SchemaSnapshot> {
  const names = async (sql: string): Promise<string[]> =>
    (await client.query<{ name: string }>(sql)).rows.map((row) => row.name);
  return {
    migrations: await names('SELECT name FROM public.schema_migrations ORDER BY name'),
    tables: await names(
      `SELECT c.relname || ' rls=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity
              || ' owner=' || pg_get_userbyid(c.relowner) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    ),
    columns: await names(
      `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
              || ' ' || coalesce(column_default, '') AS name
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`,
    ),
    constraints: await names(
      `SELECT c.conrelid::regclass::text || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS name
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' ORDER BY 1`,
    ),
    indexes: await names(
      "SELECT indexdef AS name FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1",
    ),
    triggers: await names(
      `SELECT c.relname || '.' || g.tgname || ' ' || g.tgenabled::text AS name
       FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT g.tgisinternal ORDER BY 1`,
    ),
    // The internal triggers of foreign keys are named after oids, which differ between builds;
    // their constraints are compared above.
    triggerDefinitions: await names(
      `SELECT c.relname || '.' || g.tgname || ' ' || pg_get_triggerdef(g.oid) AS name
       FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT g.tgisinternal ORDER BY 1`,
    ),
    functions: await names(
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
              || pg_get_userbyid(p.proowner) || ' ' || md5(pg_get_functiondef(p.oid)) AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'sec') ORDER BY 1`,
    ),
    policies: await names(
      `SELECT tablename || '.' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS name
       FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`,
    ),
    grants: await names(
      `SELECT grantee || ' ' || privilege_type || ' ' || table_name || '.' || column_name AS name
       FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND grantee IN ('tinnox_app', 'tinnox_definer') ORDER BY 1`,
    ),
    // DELETE, TRUNCATE, REFERENCES and TRIGGER are granted on the table only, never per column.
    tableGrants: await names(
      `SELECT grantee || ' ' || privilege_type || ' ' || table_name AS name
       FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND grantee IN ('tinnox_app', 'tinnox_definer', 'PUBLIC')
       ORDER BY 1`,
    ),
    routineGrants: await names(
      `SELECT grantee || ' ' || privilege_type || ' ' || routine_schema || '.' || routine_name AS name
       FROM information_schema.routine_privileges
       WHERE routine_schema IN ('public', 'sec') AND grantee IN ('tinnox_app', 'tinnox_definer') ORDER BY 1`,
    ),
  };
}

/**
 * A database at `level` (four digits), built with the real runner one level at a time from 0004.
 * With `seed`, each level's seeder runs at its level on the way, its own included: the chain of
 * migrate-forward.integration.test.ts up to `level`. The caller drops it.
 */
export async function atLevel(
  level: string,
  options: { readonly seed: boolean; readonly database?: string },
): Promise<LevelDatabase> {
  const levels = await currentLevels();
  const target = levels.findIndex((l) => l.level === level);
  const at = levels[target];
  if (at === undefined) {
    throw new Error(
      `${level} is not a released level: the levels are ${levels.map((l) => l.level).join(', ')}`,
    );
  }
  const db = await createLevelDatabase(options.database);
  try {
    if (!options.seed) await db.applyThrough(at);
    else {
      for (const step of levels.slice(0, target + 1)) {
        await db.applyThrough(step);
        await db.seed(step);
      }
    }
  } catch (error) {
    await db.drop();
    throw error;
  }
  return db;
}
