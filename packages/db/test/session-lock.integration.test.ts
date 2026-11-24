/**
 * withSessionLock against PostgreSQL (EAX-06, adoption plan step 22): a second holder, from
 * another pool as a second runner would be, is refused while the first holds the lock; the lock
 * is free again after work that throws; a lost lock connection aborts the work's signal; and no
 * connection goes back to the pool still holding the lock. The alert check's own cases (it skips,
 * and stops claiming when the connection is lost) are in tests/integration/display-alerts.test.ts.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSessionLock, type Database } from '../src/index.ts';
import { databaseOn, type Pool, type PoolClient } from '../src/testing.ts';
import { appPool, migratorClient } from './support.ts';

const KEY = 'tinnox.display_alerts';

let pool: Pool;
let db: Database;
let other: pg.Client;

beforeAll(async () => {
  pool = appPool('takes the session lock through withSessionLock, as the runtime role', 1);
  db = databaseOn(pool);
  other = await migratorClient();
});
afterAll(async () => {
  await pool.end();
  await other.end();
});

/** Whether another session could take the lock now (given back again at once). */
async function free(): Promise<boolean> {
  const { rows } = await other.query<{ got: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS got',
    [KEY],
  );
  if (rows[0]?.got !== true) return false;
  await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [KEY]);
  return true;
}

/** How long a wait for the server to end a backend may take on a loaded runner (TST-4). */
const BACKEND_GONE_MS = 10_000;

/**
 * Whether the lock becomes free within BACKEND_GONE_MS. Where the lock went with a closed or
 * ended backend, nothing waits for that backend to exit: pg-pool ends a released client without
 * awaiting it, and the server releases a dying backend's locks after the client has seen it go.
 * A passing run returns at the first poll that finds the lock free.
 */
async function freeSoon(): Promise<boolean> {
  const deadline = Date.now() + BACKEND_GONE_MS;
  for (;;) {
    if (await free()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The backend that holds the lock, if any. */
async function holder(): Promise<number | undefined> {
  const { rows } = await other.query<{ pid: number }>(
    `SELECT l.pid FROM pg_locks l,
       LATERAL (SELECT hashtextextended($1, 0) AS k) h
     WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
       AND l.classid = ((h.k >> 32) & 4294967295)::oid
       AND l.objid = (h.k & 4294967295)::oid`,
    [KEY],
  );
  return rows[0]?.pid;
}

/** The backend of the pool's one connection, read on that connection. */
async function pooledBackend(): Promise<number> {
  const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
}

/**
 * The database of `pool`, whose connections answer the unlock as a transaction-mode pooler can:
 * false, with the lock still held on the backend (the unlock is not sent).
 */
function unlockAnswersFalse(): Database {
  const answering = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, name, receiver) {
        if (name === 'query') {
          return (text: unknown, ...rest: unknown[]) =>
            typeof text === 'string' && text.includes('pg_advisory_unlock')
              ? Promise.resolve({ rows: [{ ok: false }] })
              : (target.query as (...args: unknown[]) => unknown).call(target, text, ...rest);
        }
        const value: unknown = Reflect.get(target, name, receiver);
        return typeof value === 'function' ? (value.bind(target) as unknown) : value;
      },
    });
  const wrapped = new Proxy(pool, {
    get(target, name, receiver) {
      if (name === 'connect') return async () => answering(await target.connect());
      const value: unknown = Reflect.get(target, name, receiver);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
  return databaseOn(wrapped);
}

describe('withSessionLock (EAX-06)', () => {
  it('EAX-06: refuses a second holder while the first holds the lock, and frees it after', async () => {
    const second = appPool('a second runner that tries the same session lock', 1);
    try {
      const seen = await withSessionLock(db, 'display_alerts', async () => {
        let ran = false;
        const outcome = await withSessionLock(databaseOn(second), 'display_alerts', () => {
          ran = true;
          return Promise.resolve();
        });
        return { outcome, ran, free: await free() };
      });
      expect(seen).toEqual({
        held: true,
        value: { outcome: { held: false }, ran: false, free: false },
      });
      expect(await free()).toBe(true);
      // The second runner can take it now.
      expect(await withSessionLock(databaseOn(second), 'display_alerts', () => free())).toEqual({
        held: true,
        value: false,
      });
    } finally {
      await second.end();
    }
  });

  it('EAX-06: gives the lock back when the work throws, and keeps the connection', async () => {
    const before = await pooledBackend();
    await expect(
      withSessionLock(db, 'display_alerts', () => Promise.reject(new Error('the work failed'))),
    ).rejects.toThrow('the work failed');
    expect(await free()).toBe(true);
    expect(await holder()).toBeUndefined();
    // The unlock answered true, so the same connection went back to the pool.
    expect(await pooledBackend()).toBe(before);
  });

  it('EAX-06: closes the connection rather than return it still holding the lock', async () => {
    const before = await pooledBackend();
    const outcome = await withSessionLock(unlockAnswersFalse(), 'display_alerts', async () =>
      holder(),
    );
    // The lock was held by the pool's one connection while the work ran.
    expect(outcome).toEqual({ held: true, value: before });
    // The unlock was never sent: only closing that connection gave the lock back.
    expect(await pooledBackend()).not.toBe(before);
    expect(await freeSoon(), 'the session lock was still held after its backend ended').toBe(true);
  });

  it('EAX-06: aborts the signal when the lock connection is lost, and frees the lock', async () => {
    const outcome = await withSessionLock(db, 'display_alerts', async (signal) => {
      const pid = await holder();
      expect(pid).toBeDefined();
      // The runtime role may end a backend of its own role.
      const killer = appPool('ends the backend that holds the session lock', 1);
      try {
        await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      } finally {
        await killer.end();
      }
      // Ends at once when the socket error arrives; the deadline is for a loaded runner (TST-4).
      const deadline = Date.now() + BACKEND_GONE_MS;
      while (!signal.aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const reason: unknown = signal.reason;
      return { aborted: signal.aborted, reason };
    });
    expect(outcome).toEqual({
      held: true,
      value: { aborted: true, reason: expect.any(Error) as unknown },
    });
    expect(await freeSoon(), 'the session lock was still held after its backend ended').toBe(true);
    // The pool opens a new connection for the next caller.
    expect(await pooledBackend()).toBeTypeOf('number');
  });
});
