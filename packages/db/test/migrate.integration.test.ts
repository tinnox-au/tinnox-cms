/**
 * The migration runner refuses a directory that does not fit the database's recorded
 * history before it applies anything (backend review round 1, CX-03). Each case offers
 * the fully migrated test database a directory with one fault and a harmless new
 * migration, and checks that the new migration was not applied. connectMigrator, which
 * the runner and the test reset connect through, refuses every login but tinnox_migrator
 * (poteto adoption plan, D4).
 */
import { appendFile, copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { connectMigrator, resetTestDatabase, runMigrations } from '../src/index.ts';
import { migratorClient, migratorUrl, superuserUrl } from './support.ts';

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);
/** Changes no schema, so a runner that wrongly applies it leaves only its history row. */
const PROBE_SQL = 'SELECT 1;\n';

async function probeRows(): Promise<number> {
  const client = await migratorClient();
  try {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM public.schema_migrations WHERE name LIKE '%_probe.sql'",
    );
    return Number(rows[0]?.n);
  } finally {
    await client.end();
  }
}

/** Copies the real migrations, lets `change` damage the copy, and returns the runner's error. */
async function runWith(
  change: (directory: string, names: string[]) => Promise<void>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tinnox-migrate-'));
  try {
    const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) await copyFile(join(MIGRATIONS, name), join(directory, name));
    await change(directory, names);
    try {
      await runMigrations({ connectionString: migratorUrl(), directory });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return 'the directory was accepted';
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('migration history is checked before anything is applied', () => {
  afterAll(async () => {
    const client = await migratorClient();
    try {
      await client.query("DELETE FROM public.schema_migrations WHERE name LIKE '%_probe.sql'");
    } finally {
      await client.end();
    }
  });

  it('refuses a directory that lacks an applied migration, without applying a later one', async () => {
    const error = await runWith(async (directory, names) => {
      await rm(join(directory, names[2] ?? ''));
      await writeFile(join(directory, '9999_probe.sql'), PROBE_SQL);
    });
    expect(error).toMatch(/missing from/);
    expect(await probeRows()).toBe(0);
  });

  it('refuses a directory in which an applied migration was changed', async () => {
    const error = await runWith(async (directory, names) => {
      await appendFile(join(directory, names.at(-1) ?? ''), '\n-- edited after it was applied\n');
      await writeFile(join(directory, '9999_probe.sql'), PROBE_SQL);
    });
    expect(error).toMatch(/was changed after it was applied/);
    expect(await probeRows()).toBe(0);
  });

  it('refuses a new migration numbered before one that is already applied', async () => {
    const error = await runWith(async (directory) => {
      await writeFile(join(directory, '0000_probe.sql'), PROBE_SQL);
    });
    expect(error).toMatch(/sorts before/);
    expect(await probeRows()).toBe(0);
  });

  it('still applies a new migration that follows the applied ones, once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tinnox-migrate-'));
    try {
      const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql'));
      for (const name of names) await copyFile(join(MIGRATIONS, name), join(directory, name));
      await writeFile(join(directory, '9999_probe.sql'), PROBE_SQL);
      const first = await runMigrations({ connectionString: migratorUrl(), directory });
      expect(first.applied).toEqual(['9999_probe.sql']);
      const second = await runMigrations({ connectionString: migratorUrl(), directory });
      expect(second.applied).toEqual([]);
      expect(await probeRows()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
      const client = await migratorClient();
      try {
        await client.query("DELETE FROM public.schema_migrations WHERE name LIKE '%_probe.sql'");
      } finally {
        await client.end();
      }
    }
  });
});

/** `url` with a role set at connection start, as `SET ROLE` would. */
function actingAs(url: string, role: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c role=${role}`);
  return parsed.toString();
}

const REFUSED = /must log in and act as role tinnox_migrator/;

describe('connectMigrator (D4)', () => {
  const wrongLogins = (): [string, string][] => [
    ['the runtime role', process.env['TEST_DATABASE_URL'] ?? ''],
    ['the superuser', superuserUrl()],
    // current_user would pass, session_user does not: the runner's old check let this through.
    ['the superuser acting as the migrator', actingAs(superuserUrl(), 'tinnox_migrator')],
    // session_user would pass, current_user does not.
    ['the migrator acting as the definer', actingAs(migratorUrl(), 'tinnox_definer')],
  ];

  it('connects as tinnox_migrator, logged in and acting', async () => {
    const pool = await connectMigrator(migratorUrl(), { applicationName: 'tinnox-test-connect' });
    try {
      const { rows } = await pool.query('SELECT current_user, session_user');
      expect(rows[0]).toEqual({ current_user: 'tinnox_migrator', session_user: 'tinnox_migrator' });
    } finally {
      await pool.end();
    }
  });

  it('refuses the runtime role and the superuser, even acting as the migrator', async () => {
    for (const [who, url] of wrongLogins()) {
      await expect(
        connectMigrator(url, { applicationName: 'tinnox-test-connect' }),
        who,
      ).rejects.toThrow(REFUSED);
    }
  });

  it('makes the runner refuse them before it applies anything', async () => {
    for (const [who, url] of wrongLogins()) {
      await expect(
        runMigrations({ connectionString: url, directory: MIGRATIONS }),
        who,
      ).rejects.toThrow(REFUSED);
    }
  });

  it('makes the test reset refuse them before it reads the database name', async () => {
    // Pointed at a database the reset would refuse by name, so a reset that skipped the role
    // check fails with the name message here and drops nothing.
    for (const url of [
      superuserUrl('postgres'),
      actingAs(superuserUrl('postgres'), 'tinnox_migrator'),
    ]) {
      await expect(resetTestDatabase(url)).rejects.toThrow(REFUSED);
    }
  });
});
