/**
 * The fault harness tests itself (adoption plan section 4.2, step 33): for each mode of
 * ./support/faults.ts, that the fault really happened at the database, not merely that the
 * harness says so. The proof is read from PostgreSQL: the SQLSTATE and the raising routine of
 * the server's own error, a transaction the server aborted, a backend that is gone from
 * pg_stat_activity, a row that is or is not there for another connection.
 *
 * The code under test here is a plain transaction (withOrg) on a wrapped pool of the test's own,
 * so each case shows exactly what a transaction of packages/db sees. The race helpers of
 * ./support/race.ts are checked at the end.
 */
import { randomUUID } from 'node:crypto';
import type { OrgTx } from '@tinnox/db';
import { withOrg, type Pool, type PoolClient } from '@tinnox/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  backendPid,
  createDisplay,
  createOrg,
  FAULT_LOCK_CLASSES,
  FAULT_SQLSTATE,
  faultHarness,
  faultyPool,
  signIn,
  startTestApp,
  waitForLockWait,
  waitForLockWaiters,
  type Delivered,
  type TestApp,
  type TestOrg,
} from './support.ts';

const INSERT_FOLDER = 'INSERT INTO folder (id, org_id, name) VALUES ($1, app_org_id(), $2)';
const AT_FOLDER = /^INSERT INTO folder/;
const IN_ABORTED_TRANSACTION = '25P02';

describe('the fault harness (step 33)', () => {
  const faults = faultHarness();
  let t: TestApp;
  let org: TestOrg;
  /** The test's own statements: never wrapped, so it sees what the database holds. */
  let sql: Pool;
  /** The pool of the code under test: `sql` behind the harness. */
  let faulty: Pool;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg('Fault harness');
    sql = t.testSql('the fault harness tests itself on folders and tags that no route made');
    faulty = faults.wrapPool(sql);
  });
  afterEach(() => {
    faults.disarmAll();
  });
  afterAll(async () => {
    await t.close();
  });

  const folderName = (): string => `Fault ${randomUUID()}`;
  /** The ids of the organisation's folders with this name, read on a connection of the test. */
  const folders = (name: string): Promise<string[]> =>
    withOrg(sql, org.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM folder WHERE name = $1', [
        name,
      ]);
      return rows.map((row) => row.id);
    });
  /** What the server lists for a backend, or undefined when it is gone. */
  const backend = async (pid: number) => {
    const { rows } = await sql.query<{ state: string; query: string }>(
      'SELECT state, query FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    return rows[0];
  };
  /** The pid of the backend the next transaction of the code under test runs on. */
  const nextPid = () =>
    withOrg(
      faulty,
      org.orgId,
      async (tx) =>
        (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
    );
  /** What `work` threw. */
  const thrownBy = async (work: Promise<unknown>): Promise<Error> => {
    const thrown: unknown = await work.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(thrown instanceof Error)) throw new Error('the work did not fail');
    return thrown;
  };
  /** The server's own error: node-postgres parses one only from an ErrorResponse message. */
  const fromServer = (error: Error) =>
    error instanceof pg.DatabaseError
      ? { code: error.code, routine: error.routine, message: error.message }
      : { notFromTheServer: error.message };
  /**
   * A transaction of the code under test: one folder, then the statement the fault strikes at
   * (`struck`). Returns what the struck statement threw inside the transaction, the SQLSTATE of
   * the next statement on the same transaction, and the backend's pid.
   */
  const strikeAfterOneFolder = async (
    first: string,
    struck: (tx: OrgTx) => Promise<unknown>,
  ): Promise<{ thrown: Error; next: string | undefined; pid: number }> => {
    let seen: { thrown: Error; next: string | undefined; pid: number } | undefined;
    await thrownBy(
      withOrg(faulty, org.orgId, async (tx) => {
        const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid;
        if (pid === undefined) throw new Error('no pid');
        await tx.query(INSERT_FOLDER, [randomUUID(), first]);
        const thrown = await thrownBy(struck(tx));
        const after = await thrownBy(tx.query('SELECT 1'));
        seen = { thrown, next: after instanceof pg.DatabaseError ? after.code : undefined, pid };
        throw thrown;
      }),
    );
    if (seen === undefined) throw new Error('the transaction never reached the struck statement');
    return seen;
  };
  /** A rival: a transaction of the test's own, left open by `change`; the harness commits it. */
  const withRival = async (
    change: (rival: PoolClient) => Promise<unknown>,
    work: (rival: PoolClient) => Promise<void>,
  ): Promise<void> => {
    const rival = await sql.connect();
    try {
      await rival.query('BEGIN');
      await rival.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await change(rival);
      await work(rival);
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined);
      rival.release();
    }
  };

  it('hold: the statement is not sent until release, and the backend sits in its open transaction', async () => {
    const name = folderName();
    const held = faults.hold((text) => AT_FOLDER.test(text));
    const inserting = withOrg(faulty, org.orgId, (tx) =>
      tx.query(INSERT_FOLDER, [randomUUID(), name]),
    );
    const pid = await held.reached;
    // The server's last statement of that backend is the one before the insert.
    const waiting = await backend(pid);
    expect(waiting?.state).toBe('idle in transaction');
    expect(waiting?.query).toContain('set_config');
    expect(await folders(name)).toEqual([]);
    held.release();
    await inserting;
    expect(await folders(name)).toHaveLength(1);
  });

  it('lost-commit-answer: the server commits, and the code sees a lost connection in place of the answer', async () => {
    const name = folderName();
    const fault = faults.arm({ mode: 'lost-commit-answer', at: AT_FOLDER });
    const thrown = await thrownBy(
      withOrg(faulty, org.orgId, (tx) => tx.query(INSERT_FOLDER, [randomUUID(), name])),
    );
    expect(thrown.name).toBe('CommitOutcomeUnknownError');
    expect(thrown.cause).toEqual(new Error('Connection terminated unexpectedly'));
    const seen = await fault.delivered;
    // The server answered COMMIT with the tag of a commit (it answers ROLLBACK for a
    // transaction it aborted), and the row is there for another connection.
    expect(seen).toMatchObject({ mode: 'lost-commit-answer', commitTag: 'COMMIT', sqlstate: null });
    expect(await folders(name)).toHaveLength(1);
    // The connection was really lost after the answer: the backend is gone from the server, so
    // the code's ROLLBACK failed and the pool destroyed the connection rather than reuse it.
    expect(seen.killed).toEqual({ pid: seen.pid, gone: true });
    expect(await backend(seen.pid)).toBeUndefined();
    expect(await nextPid()).not.toBe(seen.pid);
    // It struck once: the next transaction commits and is told so.
    const next = folderName();
    await withOrg(faulty, org.orgId, (tx) => tx.query(INSERT_FOLDER, [randomUUID(), next]));
    expect(await folders(next)).toHaveLength(1);
  });

  it('lost-commit-answer: a transaction without the statement keeps its answer, and a standing fault strikes each time', async () => {
    const lossy = faultyPool(sql, { mode: 'lost-commit-answer', at: AT_FOLDER });
    expect(
      await withOrg(lossy, org.orgId, async (tx) => (await tx.query('SELECT 1 AS one')).rows),
    ).toEqual([{ one: 1 }]);
    for (const name of [folderName(), folderName()]) {
      const thrown = await thrownBy(
        withOrg(lossy, org.orgId, (tx) => tx.query(INSERT_FOLDER, [randomUUID(), name])),
      );
      expect(thrown.name).toBe('CommitOutcomeUnknownError');
      expect(await folders(name)).toHaveLength(1);
    }
  });

  it('never-sent: the server never sees the statement, and the code sees the error given', async () => {
    const name = folderName();
    const refusal = Object.assign(new pg.DatabaseError('a refusal the test made up', 0, 'error'), {
      code: '23001',
    });
    const fault = faults.arm({ mode: 'never-sent', at: AT_FOLDER, error: refusal });
    let pid: number | undefined;
    let lastSeenByServer: string | undefined;
    const thrown = await thrownBy(
      withOrg(faulty, org.orgId, async (tx) => {
        pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        try {
          await tx.query(INSERT_FOLDER, [randomUUID(), name]);
        } finally {
          lastSeenByServer = (await backend(pid ?? 0))?.query;
        }
      }),
    );
    expect(thrown).toBe(refusal);
    const given = await fault.delivered;
    expect(given).toMatchObject({ mode: 'never-sent', pid, sqlstate: '23001' });
    // The last statement the server saw on that backend is the one before the insert.
    expect(lastSeenByServer).toBe('SELECT pg_backend_pid() AS pid');
    expect(await folders(name)).toEqual([]);
    // A database error the test gave is no lost connection: the backend is still there.
    expect(given.killed).toBeUndefined();
    expect(await backend(given.pid)).toBeDefined();

    // Without an error of its own, a lost connection: the backend is really ended.
    const lost = faults.arm({ mode: 'never-sent', at: AT_FOLDER });
    expect(
      (
        await thrownBy(
          withOrg(faulty, org.orgId, (tx) => tx.query(INSERT_FOLDER, [randomUUID(), name])),
        )
      ).message,
    ).toBe('Connection terminated unexpectedly');
    expect(await folders(name)).toEqual([]);
    const ended = await lost.delivered;
    expect(ended.killed).toEqual({ pid: ended.pid, gone: true });
    expect(await backend(ended.pid)).toBeUndefined();
    expect(await nextPid()).not.toBe(ended.pid);
  });

  it('backend-killed: the backend is gone from the server, its transaction rolled back, and the statement fails on the dead connection', async () => {
    const first = folderName();
    const second = folderName();
    const fault = faults.arm({ mode: 'backend-killed', at: (text) => text.includes('-- struck') });
    let pid: number | undefined;
    const thrown = await thrownBy(
      withOrg(faulty, org.orgId, async (tx) => {
        pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        await tx.query(INSERT_FOLDER, [randomUUID(), first]);
        await tx.query(`${INSERT_FOLDER} -- struck`, [randomUUID(), second]);
      }),
    );
    const seen = await fault.delivered;
    expect(seen).toMatchObject({ mode: 'backend-killed', pid, killed: { pid, gone: true } });
    expect(seen.error).toBe(thrown);
    // What node-postgres answers on a connection it knows is lost: no SQLSTATE.
    expect(fromServer(thrown)).toEqual({
      notFromTheServer: 'Client has encountered a connection error and is not queryable',
    });
    // The server no longer lists the backend, and neither folder was kept.
    expect(await backend(pid ?? 0)).toBeUndefined();
    expect(await folders(first)).toEqual([]);
    expect(await folders(second)).toEqual([]);
    // The pool opens another connection for the next transaction.
    const after = await withOrg(faulty, org.orgId, async (tx) => {
      await tx.query(INSERT_FOLDER, [randomUUID(), second]);
      return (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    });
    expect(after).not.toBe(pid);
    expect(await folders(second)).toHaveLength(1);
  });

  it('killBackend: ends a connection that sends nothing, and returns after its error listeners ran', async () => {
    const client = await faulty.connect();
    const errors: Error[] = [];
    client.on('error', (error: Error) => errors.push(error));
    const pid = backendPid(client);
    try {
      expect(await faults.killBackend(pid)).toEqual({ pid, gone: true });
      // Already seen by the client, so nothing is left to wait for: the server's own notice
      // (57P01, admin_shutdown) first, then the end of the connection.
      expect(
        errors.map((error) => (error instanceof pg.DatabaseError ? error.code : null)),
      ).toEqual(['57P01', null]);
      expect(await backend(pid)).toBeUndefined();
    } finally {
      client.release(true);
    }
    await expect(faults.killBackend(pid)).rejects.toThrow(/not a connection this harness/);
  });

  it.each([
    ['deadlock', 'DeadLockReport', 'deadlock detected'],
    ['statement-timeout', 'ProcessInterrupts', 'canceling statement due to statement timeout'],
    ['lock-timeout', 'ProcessInterrupts', 'canceling statement due to lock timeout'],
  ] as const)(
    '%s: PostgreSQL raises it in the transaction of the code, and aborts that transaction',
    async (mode, routine, message) => {
      const first = folderName();
      const second = folderName();
      const fault = faults.arm({ mode, at: (text) => text.includes('-- struck') });
      const seen = await strikeAfterOneFolder(first, (tx) =>
        tx.query(`${INSERT_FOLDER} -- struck`, [randomUUID(), second]),
      );
      // Raised by the server, in the routine that raises it for real.
      expect(fromServer(seen.thrown)).toEqual({ code: FAULT_SQLSTATE[mode], routine, message });
      // The server aborted the transaction: it refuses the next statement.
      expect(seen.next).toBe(IN_ABORTED_TRANSACTION);
      const delivered = await fault.delivered;
      expect(delivered).toMatchObject({ mode, pid: seen.pid, sqlstate: FAULT_SQLSTATE[mode] });
      expect(delivered.error).toBe(seen.thrown);
      expect(await folders(first)).toEqual([]);
      expect(await folders(second)).toEqual([]);
      // The timeouts were set for that transaction only, and no lock of the harness is left.
      const after = await withOrg(faulty, org.orgId, async (tx) => {
        const { rows } = await tx.query<{ statement: string; lock: string; locks: number }>(
          `SELECT current_setting('statement_timeout') AS statement,
                  current_setting('lock_timeout') AS lock,
                  (SELECT count(*)::int FROM pg_locks
                    WHERE locktype = 'advisory' AND classid BETWEEN $1 AND $2) AS locks`,
          [FAULT_LOCK_CLASSES.from, FAULT_LOCK_CLASSES.to],
        );
        return rows[0];
      });
      expect(after).toEqual({ statement: '15s', lock: '5s', locks: 0 });
    },
  );

  // A deadline under the role's statement_timeout (15 s), which a sleep under a SET LOCAL that
  // held for nothing would run into.
  it.each(['deadlock', 'statement-timeout', 'lock-timeout'] as const)(
    '%s outside a transaction: raised in a transaction of its own, which is then rolled back',
    { timeout: 10_000 },
    async (mode) => {
      const fault = faults.arm({ mode, at: (text) => text.includes('-- struck') });
      const client = await faulty.connect();
      const pid = backendPid(client);
      try {
        const thrown = await thrownBy(client.query('SELECT 1 -- struck'));
        expect(fromServer(thrown)).toMatchObject({ code: FAULT_SQLSTATE[mode] });
        expect(await fault.delivered).toMatchObject({ mode, pid, sqlstate: FAULT_SQLSTATE[mode] });
        // The connection is out of any transaction again, with its own timeouts and no lock.
        expect(await backend(pid)).toMatchObject({ state: 'idle' });
        const { rows } = await client.query<{ statement: string; lock: string; locks: number }>(
          `SELECT current_setting('statement_timeout') AS statement,
                  current_setting('lock_timeout') AS lock,
                  (SELECT count(*)::int FROM pg_locks
                    WHERE locktype = 'advisory' AND classid BETWEEN $1 AND $2) AS locks`,
          [FAULT_LOCK_CLASSES.from, FAULT_LOCK_CLASSES.to],
        );
        expect(rows[0]).toEqual({ statement: '15s', lock: '5s', locks: 0 });
      } finally {
        client.release();
      }
    },
  );

  it('disarmAll: a fault that never struck is taken back, named, and a held statement goes on', async () => {
    const unused = faults.arm({ mode: 'deadlock', at: /^INSERT INTO nothing/ });
    const name = folderName();
    const held = faults.hold((text) => AT_FOLDER.test(text));
    const inserting = withOrg(faulty, org.orgId, (tx) =>
      tx.query(INSERT_FOLDER, [randomUUID(), name]),
    );
    await held.reached;
    faults.disarmAll();
    await inserting;
    expect(await folders(name)).toHaveLength(1);
    await expect(unused.delivered).rejects.toThrow(
      'the deadlock fault armed at /^INSERT INTO nothing/ never struck: the test ended with it still armed',
    );
  });

  it('unique-violation: the insert waits for the rival that has the key, and loses when it commits', async () => {
    const name = folderName();
    const rivalId = randomUUID();
    let delivered: Delivered | undefined;
    let seen: Awaited<ReturnType<typeof strikeAfterOneFolder>> | undefined;
    await withRival(
      (rival) => rival.query(INSERT_FOLDER, [rivalId, name]),
      async (rival) => {
        const fault = faults.arm({ mode: 'unique-violation', at: /-- struck/, rival });
        seen = await strikeAfterOneFolder(folderName(), (tx) =>
          tx.query(`${INSERT_FOLDER} -- struck`, [randomUUID(), name]),
        );
        delivered = await fault.delivered;
      },
    );
    if (seen === undefined) throw new Error('not struck');
    expect(fromServer(seen.thrown)).toMatchObject({ code: '23505', routine: '_bt_check_unique' });
    expect((seen.thrown as pg.DatabaseError).constraint).toBe('folder_org_name_key');
    expect(seen.next).toBe(IN_ABORTED_TRANSACTION);
    expect(delivered).toMatchObject({ mode: 'unique-violation', pid: seen.pid, sqlstate: '23505' });
    // The rival's row is the one that is there.
    expect(await folders(name)).toEqual([rivalId]);
  });

  it('foreign-key-violation: the insert waits for the rival that deletes the row it refers to, and loses when it commits', async () => {
    const operator = await signIn(t, org);
    const display = await createDisplay(operator, org, 'Fault harness screen');
    const tagId = randomUUID();
    await withOrg(sql, org.orgId, (tx) =>
      tx.query(
        "INSERT INTO tag (id, org_id, scope, name) VALUES ($1, app_org_id(), 'display', $2)",
        [tagId, `fault-${tagId.slice(0, 8)}`],
      ),
    );
    let thrown: Error | undefined;
    let delivered: Delivered | undefined;
    await withRival(
      (rival) => rival.query('DELETE FROM tag WHERE id = $1', [tagId]),
      async (rival) => {
        const fault = faults.arm({
          mode: 'foreign-key-violation',
          at: /^INSERT INTO display_tag/,
          rival,
        });
        thrown = await thrownBy(
          withOrg(faulty, org.orgId, (tx) =>
            tx.query(
              'INSERT INTO display_tag (display_id, tag_id, org_id) VALUES ($1, $2, app_org_id())',
              [display.id, tagId],
            ),
          ),
        );
        delivered = await fault.delivered;
      },
    );
    if (thrown === undefined) throw new Error('not struck');
    expect(fromServer(thrown)).toMatchObject({ code: '23503', routine: 'ri_ReportViolation' });
    expect((thrown as pg.DatabaseError).constraint).toBe('display_tag_tag_fk');
    expect(delivered).toMatchObject({ mode: 'foreign-key-violation', sqlstate: '23503' });
  });

  it('serialization-failure: at REPEATABLE READ the update waits for the rival that changed the row, and fails when it commits', async () => {
    const id = randomUUID();
    const name = folderName();
    await withOrg(sql, org.orgId, (tx) => tx.query(INSERT_FOLDER, [id, name]));
    const RENAME = 'UPDATE folder SET name = $2 WHERE id = $1';
    const isolation = (tx: OrgTx) =>
      tx
        .query<{ transaction_isolation: string }>('SHOW transaction_isolation')
        .then((result) => result.rows[0]?.transaction_isolation);
    let thrown: Error | undefined;
    let level: string | undefined;
    let delivered: Delivered | undefined;
    await withRival(
      (rival) => rival.query(RENAME, [id, `${name} rival`]),
      async (rival) => {
        const fault = faults.arm({ mode: 'serialization-failure', at: /^UPDATE folder/, rival });
        thrown = await thrownBy(
          withOrg(faulty, org.orgId, async (tx) => {
            level = await isolation(tx);
            await tx.query(RENAME, [id, `${name} own`]);
          }),
        );
        delivered = await fault.delivered;
      },
    );
    if (thrown === undefined) throw new Error('not struck');
    expect(level).toBe('repeatable read');
    expect(fromServer(thrown)).toMatchObject({
      code: '40001',
      message: 'could not serialize access due to concurrent update',
    });
    expect(delivered).toMatchObject({ mode: 'serialization-failure', sqlstate: '40001' });
    expect(await folders(`${name} rival`)).toEqual([id]);
    // Once it has struck, a transaction starts at the level the pool gives it.
    expect(await withOrg(faulty, org.orgId, isolation)).toBe('read committed');
  });

  it('says so when the fault was not delivered: a rival that holds nothing, and a fault disarmed', async () => {
    const name = folderName();
    await withRival(
      // The rival inserted another name, so the insert of the code waits for nothing.
      (rival) => rival.query(INSERT_FOLDER, [randomUUID(), folderName()]),
      async (rival) => {
        const fault = faults.arm({ mode: 'unique-violation', at: AT_FOLDER, rival });
        await withOrg(faulty, org.orgId, (tx) => tx.query(INSERT_FOLDER, [randomUUID(), name]));
        await expect(fault.delivered).rejects.toThrow(
          /the unique-violation fault was not delivered at "INSERT INTO folder.*ended without waiting/,
        );
      },
    );
    // The statement of the code went through as it would have without the harness.
    expect(await folders(name)).toHaveLength(1);

    const unused = faults.arm({ mode: 'deadlock', at: AT_FOLDER });
    unused.disarm();
    await expect(unused.delivered).rejects.toThrow(
      'the deadlock fault was disarmed before it struck',
    );
    const free = folderName();
    await withOrg(faulty, org.orgId, (tx) => tx.query(INSERT_FOLDER, [randomUUID(), free]));
    expect(await folders(free)).toHaveLength(1);
  });

  describe('the race helpers', () => {
    const LOCK = 'SELECT 1 FROM folder WHERE id = $1 FOR UPDATE';

    it('waitForLockWait and waitForLockWaiters see a wait on the server, and say at once when the side that had to wait did not', async () => {
      const id = randomUUID();
      await withOrg(sql, org.orgId, (tx) => tx.query(INSERT_FOLDER, [id, folderName()]));
      await withRival(
        (holder) => holder.query(LOCK, [id]),
        async (holder) => {
          const waiter = await sql.connect();
          try {
            await waiter.query('BEGIN');
            await waiter.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
            const waiting = waiter.query(LOCK, [id]);
            await waitForLockWait(sql, backendPid(waiter), 'the second lock', { waiter: waiting });
            expect(
              await waitForLockWaiters(sql, backendPid(holder), 1, 'the second lock', {
                waiter: waiting,
              }),
            ).toEqual([backendPid(waiter)]);
            await holder.query('ROLLBACK');
            await waiting;
          } finally {
            await waiter.query('ROLLBACK').catch(() => undefined);
            waiter.release();
          }
          // No lock is held now: a side that ends without waiting is reported, not waited for.
          // The deadline is far beyond the test's own, so only that report can end the wait.
          const free = sql.query('SELECT 1');
          const never = { waiter: free, timeoutMs: 600_000 };
          await expect(
            waitForLockWaiters(sql, backendPid(holder), 1, 'nothing to wait for', never),
          ).rejects.toThrow('nothing to wait for: the side that had to wait ended without waiting');
          await expect(
            waitForLockWait(sql, backendPid(holder), 'nothing to wait for', never),
          ).rejects.toThrow('nothing to wait for: the side that had to wait ended without waiting');
        },
      );
    });
  });
});
