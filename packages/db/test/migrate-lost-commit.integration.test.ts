/**
 * The migration runner loses its connection at the COMMIT of a file, for real (adoption plan
 * step 33; the runner's unknown-outcome arm, step 24, was reached only by a unit test of
 * commitMigration with a fake client). The runner cannot know whether the file was applied, and
 * both are true somewhere:
 *
 *  - the backend is ended while the server is still committing (a deferred trigger of the file
 *    holds the COMMIT at a lock of the test's, and killBackend of '@tinnox/db/testing' ends it):
 *    the server rolled the file back, and the history has no row;
 *  - the server commits and its answer never arrives (a relay between the runner and PostgreSQL
 *    passes the COMMIT on, reads the answer and drops the connection instead of passing it
 *    back): the file is applied, with its history row.
 *
 * In both the runner reports the same thing, that it does not know and that running again is
 * safe, and the next run proves it: it applies the file in the first case and skips it in the
 * second. A scratch database, so the runner's history there is these files alone.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.ts';
import { createLevelDatabase, type LevelDatabase } from './levels.ts';
import { backendPid, killBackend, waitForLockWaiters } from './support.ts';

/** The advisory lock the first file's deferred trigger waits for at COMMIT. */
const HOLD = [0x7a17_33e0, 1] as const;
const UNCONFIRMED = (name: string): string =>
  `migration ${name}: the server did not confirm its COMMIT, so it may or may not be applied. ` +
  'Run db:migrate again: the file commits with its schema_migrations row, so the next run ' +
  'skips it if it was applied and applies it if it was not';

/** What a run threw. */
async function thrownBy(run: Promise<unknown>): Promise<Error> {
  const thrown: unknown = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(thrown instanceof Error)) throw new Error('the run did not fail');
  return thrown;
}

/**
 * A relay in front of PostgreSQL that passes everything on, both ways, until the client sends
 * COMMIT: that goes to the server too, and when the server's answer to it arrives the relay
 * drops the connection instead of passing the answer back. `answered` is the answer it kept.
 */
async function relayLosingCommitAnswer(target: { host: string; port: number }): Promise<{
  readonly port: number;
  readonly answered: Promise<string>;
  close(): Promise<void>;
}> {
  // The simple-query message node-postgres sends for client.query('COMMIT').
  const commit = Buffer.concat([
    Buffer.from('Q'),
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('COMMIT\0'),
  ]);
  let resolve: (answer: string) => void = () => undefined;
  const answered = new Promise<string>((done) => {
    resolve = done;
  });
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    sockets.add(client).add(upstream);
    let sent = false;
    client.on('data', (chunk) => {
      if (chunk.includes(commit)) sent = true;
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!sent) {
        client.write(chunk);
        return;
      }
      // CommandComplete carries the tag of what the server did: 'COMMIT' when it committed.
      resolve(chunk.subarray(5, chunk.indexOf(0, 5)).toString('latin1'));
      client.destroy();
      upstream.destroy();
    });
    for (const socket of [client, upstream]) {
      socket.on('error', () => undefined);
      socket.on('close', () => {
        client.destroy();
        upstream.destroy();
      });
    }
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return {
    port: (server.address() as AddressInfo).port,
    answered,
    close: () =>
      new Promise((closed) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          closed();
        });
      }),
  };
}

describe('the migration runner loses its connection at COMMIT (step 33)', () => {
  let db: LevelDatabase;
  let directory: string;
  let administrator: pg.Client;

  const history = async (): Promise<string[]> =>
    (
      await administrator.query<{ name: string }>(
        'SELECT name FROM public.schema_migrations ORDER BY name',
      )
    ).rows.map((row) => row.name);
  /** The rows of the table the two files insert into: one per file that is applied. */
  const applied = async (): Promise<string[]> =>
    (
      await administrator.query<{ file: string }>(
        'SELECT file FROM public.runner_commit_probe ORDER BY file',
      )
    ).rows.map((row) => row.file);
  const run = (connectionString = db.migratorUrl) => runMigrations({ connectionString, directory });

  beforeAll(async () => {
    db = await createLevelDatabase('tinnox_runner_commit_test');
    administrator = await db.administrator();
    directory = await mkdtemp(join(tmpdir(), 'tinnox-migrate-commit-'));
    await writeFile(
      join(directory, '0001_base.sql'),
      `CREATE TABLE public.runner_commit_probe (file text PRIMARY KEY);
       ALTER TABLE public.runner_commit_probe ENABLE ROW LEVEL SECURITY;
       ALTER TABLE public.runner_commit_probe FORCE ROW LEVEL SECURITY;
       CREATE POLICY runner_commit_probe_all ON public.runner_commit_probe USING (true) WITH CHECK (true);\n`,
    );
    expect((await run()).applied).toEqual(['0001_base.sql']);
  });
  afterAll(async () => {
    await administrator.end();
    await rm(directory, { recursive: true, force: true });
    await db.drop();
  });

  it('reports an unknown outcome when its backend is ended during COMMIT: the server rolled the file back, and the next run applies it', async () => {
    // The file's deferred trigger runs at COMMIT and waits for a lock the test holds, so the
    // runner's backend is inside its COMMIT, with every check of the runner behind it.
    await writeFile(
      join(directory, '0002_held.sql'),
      `INSERT INTO public.runner_commit_probe VALUES ('0002_held.sql');
       CREATE TEMP TABLE runner_commit_hold (n integer) ON COMMIT DROP;
       CREATE FUNCTION pg_temp.runner_commit_hold() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_advisory_xact_lock(${String(HOLD[0])}, ${String(HOLD[1])});
         RETURN NULL;
       END $$;
       CREATE CONSTRAINT TRIGGER runner_commit_hold AFTER INSERT ON runner_commit_hold
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.runner_commit_hold();
       INSERT INTO runner_commit_hold VALUES (1);\n`,
    );
    const holder = await db.administrator();
    let error: Error;
    try {
      await holder.query('SELECT pg_advisory_lock($1, $2)', [...HOLD]);
      const running = run();
      const [runner] = await waitForLockWaiters(
        administrator,
        backendPid(holder),
        1,
        "the runner's COMMIT never waited for the lock of the file's deferred trigger",
        { locktype: 'advisory', waiter: running },
      );
      if (runner === undefined) throw new Error('no backend waited');
      // The statement the server is running for that backend is the runner's COMMIT.
      const { rows } = await administrator.query<{ application_name: string; query: string }>(
        'SELECT application_name, query FROM pg_stat_activity WHERE pid = $1',
        [runner],
      );
      expect(rows).toEqual([{ application_name: 'tinnox-migrate', query: 'COMMIT' }]);
      expect(await killBackend(administrator, runner)).toEqual({ pid: runner, gone: true });
      error = await thrownBy(running);
    } finally {
      await holder.end();
    }

    expect(error.name).toBe('CommitOutcomeUnknownError');
    expect(error.message).toBe(UNCONFIRMED('0002_held.sql'));
    // The server never finished the COMMIT: neither the file's row nor its history row.
    expect(await history()).toEqual(['0001_base.sql']);
    expect(await applied()).toEqual([]);

    // Running again is safe, as the message says: the file is applied now, once.
    expect(await run()).toEqual({ applied: ['0002_held.sql'], alreadyApplied: ['0001_base.sql'] });
    expect(await history()).toEqual(['0001_base.sql', '0002_held.sql']);
    expect(await applied()).toEqual(['0002_held.sql']);
  });

  it('reports the same when the server committed and its answer never arrived: the file is applied, and the next run skips it', async () => {
    await writeFile(
      join(directory, '0003_unanswered.sql'),
      "INSERT INTO public.runner_commit_probe VALUES ('0003_unanswered.sql');\n",
    );
    const direct = new URL(db.migratorUrl);
    const relay = await relayLosingCommitAnswer({
      host: direct.hostname,
      port: Number(direct.port),
    });
    try {
      const through = new URL(db.migratorUrl);
      through.hostname = '127.0.0.1';
      through.port = String(relay.port);
      const error = await thrownBy(run(through.toString()));
      expect(error.name).toBe('CommitOutcomeUnknownError');
      expect(error.message).toBe(UNCONFIRMED('0003_unanswered.sql'));
      // The server answered the COMMIT with the tag of a commit; the runner never saw it.
      expect(await relay.answered).toBe('COMMIT');
    } finally {
      await relay.close();
    }

    // The file is applied, with its history row.
    const all = ['0001_base.sql', '0002_held.sql', '0003_unanswered.sql'];
    expect(await history()).toEqual(all);
    expect(await applied()).toEqual(['0002_held.sql', '0003_unanswered.sql']);

    // The next run finds it in the history and applies nothing a second time.
    expect(await run()).toEqual({ applied: [], alreadyApplied: all });
    expect(await applied()).toEqual(['0002_held.sql', '0003_unanswered.sql']);
  });
});
