/**
 * The migration runner refuses a directory that does not fit the database's recorded
 * history before it applies anything (backend review round 1, CX-03). Each case offers
 * the fully migrated test database a directory with one fault and a harmless new
 * migration, and checks that the new migration was not applied. connectMigrator, which
 * the runner and the test reset connect through, refuses a connection whose session_user or
 * current_user is not tinnox_migrator, so the session must act as the migrator (poteto
 * adoption plan, D4). The runner also checks the schema invariants after each file and before
 * its COMMIT, and once when nothing is pending (packages/db/src/schema-invariants.ts, EAX-12).
 */
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { connectMigrator, resetTestDatabase, runMigrations } from '../src/migrate.ts';
import { actingAs, migratorClient, migratorUrl, superuserUrl } from './support.ts';

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

  it('reports a file the server refused at COMMIT as rolled back, with no history row (step 24)', async () => {
    // A deferred constraint is checked at COMMIT, after the runner's own checks passed; the
    // temporary table goes with the transaction either way.
    const error = await runWith(async (directory) => {
      await writeFile(
        join(directory, '9999_probe.sql'),
        `CREATE TEMP TABLE runner_commit_probe (n integer UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP;
         INSERT INTO runner_commit_probe VALUES (1), (1);\n`,
      );
    });
    expect(error).toMatch(
      /^migration 9999_probe\.sql failed at COMMIT and was rolled back: duplicate key value violates unique constraint "runner_commit_probe_n_key"/,
    );
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

describe('the runner sends its own lock_timeout (AG-4.12)', () => {
  afterAll(async () => {
    const client = await migratorClient();
    try {
      await client.query("DELETE FROM public.schema_migrations WHERE name LIKE '%_probe.sql'");
    } finally {
      await client.end();
    }
  });

  it('has 30 s on its session, a migration sees it, and a role default of 0 does not decide it', async () => {
    // The connection asks for lock_timeout = 0 at start-up, as a database without the role
    // default of 01-roles.sh would give. The probe migration fails when the session it runs
    // in is not at 30 s, so a runner that sends nothing, or a constant that drifts from the 30 s
    // AGENTS.md section 4 states, fails here. The literal is on purpose: the constant is not used.
    const url = new URL(migratorUrl());
    url.searchParams.set('options', '-c lock_timeout=0');
    const directory = await mkdtemp(join(tmpdir(), 'tinnox-migrate-'));
    try {
      const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql'));
      for (const name of names) await copyFile(join(MIGRATIONS, name), join(directory, name));
      await writeFile(
        join(directory, '9999_probe.sql'),
        `DO $$ BEGIN
           IF current_setting('lock_timeout') <> '30s' THEN
             RAISE EXCEPTION 'lock_timeout is %', current_setting('lock_timeout');
           END IF;
         END $$;\n`,
      );
      const result = await runMigrations({ connectionString: url.toString(), directory });
      expect(result.applied).toEqual(['9999_probe.sql']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('says another run holds its lock when the wait passes the 30 s, keeping the cause (BEH-2)', async () => {
    // Another run in progress: a session that holds the runner's advisory lock (migrate.ts).
    const other = await migratorClient();
    let failure: unknown;
    try {
      await other.query('SELECT pg_advisory_lock(7411660001)');
      const started = Date.now();
      failure = await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS })
        .then(() => 'the run did not wait')
        .catch((error: unknown) => error);
      expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
    } finally {
      await other.end();
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "another migration run holds the runner's advisory lock and did not finish within 30s: " +
        'wait for it to finish and run db:migrate again',
    );
    expect((failure as Error).cause).toMatchObject({ code: '55P03' });
    // The refused run left nothing waiting on the lock: the next run would take it at once.
    const next = await migratorClient();
    try {
      const taken = await next.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(7411660001) AS ok',
      );
      expect(taken.rows[0]?.ok).toBe(true);
    } finally {
      await next.end();
    }
  }, 60_000);
});

describe('the runner owns the schema invariants (plan section 3.3, EAX-12)', () => {
  /** One query as tinnox_migrator on a connection of its own. */
  async function asMigrator<R extends pg.QueryResultRow>(text: string): Promise<R[]> {
    const client = await migratorClient();
    try {
      return (await client.query<R>(text)).rows;
    } finally {
      await client.end();
    }
  }
  const exists = async (regtype: 'regclass' | 'regprocedure', name: string): Promise<boolean> =>
    (
      await asMigrator<{ found: boolean }>(`SELECT to_${regtype}('${name}') IS NOT NULL AS found`)
    )[0]?.found === true;
  /** The runner's advisory lock is the only one anything takes on this database. */
  const advisoryLocks = async (): Promise<number> =>
    (
      await asMigrator<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l
         WHERE l.locktype = 'advisory'
           AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      )
    )[0]?.n ?? -1;
  const clearProbes = (): Promise<unknown> =>
    asMigrator("DELETE FROM public.schema_migrations WHERE name LIKE '%_probe.sql'");

  afterAll(async () => {
    // Nothing below should be left behind; if a runner that no longer checks applied a probe,
    // this keeps the shared database fit for the files that run after this one.
    await clearProbes();
    await asMigrator('DROP TABLE IF EXISTS public.runner_probe');
    const admin = new pg.Client({ connectionString: superuserUrl() });
    await admin.connect();
    try {
      await admin.query('DROP FUNCTION IF EXISTS sec.runner_probe()');
    } finally {
      await admin.end();
    }
  });

  it('rolls back a migration whose sec.* function has no SET clause, though the guard copied from 0013 passes it (EAX-12)', async () => {
    // The guard as merged: the DO block of 0013 that raises "sec functions with unsafe
    // definition". For a function with no SET clause proconfig is NULL, NOT (NULL) is not
    // true, and the block raises nothing.
    const merged = await readFile(join(MIGRATIONS, '0013_roles_and_members.sql'), 'utf8');
    const guards = [...merged.matchAll(/^DO \$\$\n(?:(?!^DO \$\$).)*?^END \$\$;\n/gms)]
      .map((block) => block[0])
      .filter((block) => block.includes('sec functions with unsafe definition'));
    expect(guards).toHaveLength(1);

    const error = await runWith(async (directory) => {
      await writeFile(
        join(directory, '9999_probe.sql'),
        `SET LOCAL ROLE tinnox_definer;
         CREATE FUNCTION sec.runner_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
         REVOKE ALL ON FUNCTION sec.runner_probe() FROM PUBLIC;
         GRANT EXECUTE ON FUNCTION sec.runner_probe() TO tinnox_app;
         RESET ROLE;
         ${guards[0] ?? ''}`,
      );
    });
    expect(error).toMatch(
      /^migration 9999_probe\.sql failed and was rolled back: the schema breaks 1 invariant /,
    );
    expect(error).toMatch(
      /sec\.runner_probe\(\) does not pin its search_path \(its SET clauses: none\).*SET search_path = pg_catalog, pg_temp/,
    );
    expect(await exists('regprocedure', 'sec.runner_probe()')).toBe(false);
    expect(await probeRows()).toBe(0);
    expect(await advisoryLocks()).toBe(0);
  });

  it('rolls back the file that breaks an invariant with its history row, and keeps the file before it', async () => {
    try {
      const error = await runWith(async (directory) => {
        await writeFile(join(directory, '9998_probe.sql'), PROBE_SQL);
        await writeFile(
          join(directory, '9999_probe.sql'),
          'CREATE TABLE public.runner_probe (id integer PRIMARY KEY);\n',
        );
      });
      expect(error).toMatch(/^migration 9999_probe\.sql failed and was rolled back: /);
      expect(error).toMatch(
        /public\.runner_probe is without forced row-level security: add ALTER TABLE public\.runner_probe ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY/,
      );
      expect(await exists('regclass', 'public.runner_probe')).toBe(false);
      expect(
        await asMigrator(
          "SELECT name FROM public.schema_migrations WHERE name LIKE '%_probe.sql' ORDER BY 1",
        ),
      ).toEqual([{ name: '9998_probe.sql' }]);
      expect(await advisoryLocks()).toBe(0);
    } finally {
      await clearProbes();
    }
  });

  it('refuses a database that was changed outside the migrations, alters nothing and gives the lock back', async () => {
    const grant = 'EXECUTE ON FUNCTION sec.display_alert_orgs()';
    const admin = new pg.Client({ connectionString: superuserUrl() });
    await admin.connect();
    try {
      await admin.query(`GRANT ${grant} TO PUBLIC`);
      // Nothing is pending: the run changes nothing and fails.
      await expect(
        runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS }),
      ).rejects.toThrow(
        /^the schema breaks 1 invariant \(packages\/db\/src\/schema-invariants\.ts\):\n {2}- sec\.display_alert_orgs\(\) is executable by PUBLIC, tinnox_app, not by tinnox_app alone/,
      );
      await expect(
        runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS }),
      ).rejects.toThrow(
        // The advice names the objects no migration can repair (SEC-4, BEH-1).
        /\nNo migration was pending and this run changed nothing: .* An object an extension or the administrator created is removed from this database by the administrator instead \(DROP EXTENSION for an extension's object\)\. Then run again\.$/,
      );
      expect(await advisoryLocks()).toBe(0);
      // A pending file is refused too, and told that the fault is older than it.
      const error = await runWith(async (directory) => {
        await writeFile(join(directory, '9999_probe.sql'), PROBE_SQL);
      });
      expect(error).toMatch(/^migration 9999_probe\.sql failed and was rolled back: /);
      expect(error).toMatch(
        /sec\.display_alert_orgs\(\) is executable by PUBLIC, tinnox_app.* \(It was so before this run: the database was changed outside the migrations\.\)/,
      );
      expect(await probeRows()).toBe(0);
      expect(await advisoryLocks()).toBe(0);
    } finally {
      await admin.query(`REVOKE ${grant} FROM PUBLIC`);
      await admin.end();
    }
    // Put right by hand, the next run checks again and passes.
    const again = await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS });
    expect(again.applied).toEqual([]);
  });

  it('refuses a table opened to PUBLIC: a grant that reaches tinnox_app without naming it', async () => {
    // session is read before the organisation is known, so it has no policy and no grant.
    // With these two statements tinnox_app reads every organisation's sessions, and its own
    // ACL entry on the table is still empty.
    const admin = new pg.Client({ connectionString: superuserUrl() });
    await admin.connect();
    try {
      await admin.query('CREATE POLICY runner_probe_open ON public.session USING (true)');
      await admin.query('GRANT SELECT ON public.session TO PUBLIC');
      await expect(
        runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS }),
      ).rejects.toThrow(
        /^the schema breaks 1 invariant .*\n {2}- public\.session must have exactly one policy, .* and has: runner_probe_open FOR ALL PERMISSIVE TO \{public\} USING true WITH CHECK none\. tinnox_app holds SELECT through PUBLIC on it/,
      );
      expect(await advisoryLocks()).toBe(0);
    } finally {
      await admin.query('REVOKE SELECT ON public.session FROM PUBLIC');
      await admin.query('DROP POLICY IF EXISTS runner_probe_open ON public.session');
      await admin.end();
    }
    const again = await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS });
    expect(again.applied).toEqual([]);
  });

  it('with a fault older than the run, applies no file unless the first pending one repairs it', async () => {
    const fn = 'sec.display_alert_orgs()';
    const publicMayExecute = async (): Promise<boolean> =>
      (
        await asMigrator<{ may: boolean }>(
          `SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS may`,
        )
      )[0]?.may === true;
    const repair = `SET LOCAL ROLE tinnox_definer;
       REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC;
       RESET ROLE;\n`;
    const admin = new pg.Client({ connectionString: superuserUrl() });
    await admin.connect();
    try {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`);
      // The repair sorts after a file that does not repair: that file is checked first, fails on
      // the older fault and is rolled back, so the repair is never reached.
      const behind = await runWith(async (directory) => {
        await writeFile(join(directory, '9998_probe.sql'), PROBE_SQL);
        await writeFile(join(directory, '9999_probe.sql'), repair);
      });
      expect(behind).toMatch(/^migration 9998_probe\.sql failed and was rolled back: /);
      expect(behind).toMatch(
        /sec\.display_alert_orgs\(\) is executable by PUBLIC, tinnox_app.* \(It was so before this run: /,
      );
      expect(behind).toMatch(
        /\nA problem that was so before this run is not this file's doing, but no file is applied while it stands\. .*the first one pending.* An object an extension or the administrator created is removed from this database by the administrator instead \(DROP EXTENSION for an extension's object\)\. Then run again\.$/,
      );
      expect(await probeRows()).toBe(0);
      expect(await publicMayExecute()).toBe(true);
      expect(await advisoryLocks()).toBe(0);
      // The repair is the first pending file: it and the file after it are applied.
      const first = await runWith(async (directory) => {
        await writeFile(join(directory, '9998_probe.sql'), repair);
        await writeFile(join(directory, '9999_probe.sql'), PROBE_SQL);
      });
      expect(first).toBe('the directory was accepted');
      expect(await probeRows()).toBe(2);
      expect(await publicMayExecute()).toBe(false);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`);
      await admin.end();
      await clearProbes();
    }
  });

  it('reads the catalogue without leaving its search_path for what fires at COMMIT', async () => {
    // A deferred trigger fires at COMMIT, after the runner has read the catalogue with
    // search_path = pg_catalog. It must find the migration's own search_path again. Everything
    // here is temporary: the table goes at COMMIT and the function with the runner's session.
    try {
      const error = await runWith(async (directory) => {
        await writeFile(
          join(directory, '9999_probe.sql'),
          `CREATE FUNCTION pg_temp.runner_probe_path() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF current_setting('search_path') = 'pg_catalog' THEN
               RAISE EXCEPTION 'search_path at COMMIT is the one the invariant reader set';
             END IF;
             RETURN NULL;
           END $$;
           CREATE TEMP TABLE runner_probe (id integer) ON COMMIT DROP;
           CREATE CONSTRAINT TRIGGER runner_probe_deferred AFTER INSERT ON runner_probe
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.runner_probe_path();
           INSERT INTO runner_probe VALUES (1);\n`,
        );
      });
      expect(error).toBe('the directory was accepted');
      expect(await probeRows()).toBe(1);
    } finally {
      await clearProbes();
    }
  });
});

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
