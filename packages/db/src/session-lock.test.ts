/**
 * withSessionLock against a pool that answers by hand (EAX-06, adoption plan step 22): what it
 * sends on its connection, and whether that connection goes back to the pool or is closed. The
 * same against PostgreSQL, with a second holder and a killed backend, is in
 * packages/db/test/session-lock.integration.test.ts.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { withSessionLock } from './session-lock.ts';
import { databaseOn, type Pool } from './testing.ts';

const LOCK = 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok';
const UNLOCK = 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok';

interface Answers {
  readonly lock?: () => Promise<unknown>;
  readonly unlock?: () => Promise<unknown>;
}

/** A pool of one connection that answers the lock and the unlock, recording what it saw. */
function fakePool(answers: Answers = {}) {
  const sent: { text: string; values: unknown }[] = [];
  const released: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: (text: string, values: unknown) => {
      sent.push({ text, values });
      const answer = text === LOCK ? answers.lock : text === UNLOCK ? answers.unlock : undefined;
      return answer?.() ?? Promise.resolve({ rows: [{ ok: true }] });
    },
    // Called with no argument, the pool keeps the connection; with an error, it closes it.
    release: (error?: unknown) => {
      released.push(error);
    },
  });
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { db: databaseOn(pool), client, sent, released };
}

const answer = (ok: boolean) => () => Promise.resolve({ rows: [{ ok }] });

describe('withSessionLock (EAX-06)', () => {
  it('EAX-06: takes the lock, runs the work, gives the lock back and returns the connection', async () => {
    const { db, sent, released, client } = fakePool();
    let seen: AbortSignal | undefined;
    const outcome = await withSessionLock(db, 'display_alerts', (signal) => {
      seen = signal;
      return Promise.resolve('done');
    });
    expect(outcome).toEqual({ held: true, value: 'done' });
    // The key the alert check took before the helper existed.
    expect(sent).toEqual([
      { text: LOCK, values: ['tinnox.display_alerts'] },
      { text: UNLOCK, values: ['tinnox.display_alerts'] },
    ]);
    expect(seen?.aborted).toBe(false);
    expect(released).toEqual([undefined]);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('EAX-06: does nothing when another session holds the lock, and returns the connection', async () => {
    const { db, sent, released } = fakePool({ lock: answer(false) });
    let ran = false;
    const outcome = await withSessionLock(db, 'display_alerts', () => {
      ran = true;
      return Promise.resolve();
    });
    expect(outcome).toEqual({ held: false });
    expect(ran).toBe(false);
    expect(sent.map((s) => s.text)).toEqual([LOCK]);
    expect(released).toEqual([undefined]);
  });

  it('EAX-06: gives the lock back when the work throws, and rethrows its error', async () => {
    const { db, sent, released } = fakePool();
    await expect(
      withSessionLock(db, 'display_alerts', () => Promise.reject(new Error('the work failed'))),
    ).rejects.toThrow('the work failed');
    expect(sent.map((s) => s.text)).toEqual([LOCK, UNLOCK]);
    expect(released).toEqual([undefined]);
  });

  it('EAX-06: closes the connection when the unlock answers that the lock was not held', async () => {
    const { db, released } = fakePool({ unlock: answer(false) });
    const outcome = await withSessionLock(db, 'display_alerts', () => Promise.resolve(1));
    expect(outcome).toEqual({ held: true, value: 1 });
    expect(released).toEqual([new Error('advisory lock was not held')]);
  });

  it('EAX-06: closes the connection when the unlock fails, and keeps the error of the work', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const { db, released } = fakePool({ unlock: () => Promise.reject(lost) });
    await expect(
      withSessionLock(db, 'display_alerts', () => Promise.reject(new Error('the work failed'))),
    ).rejects.toThrow('the work failed');
    expect(released).toEqual([lost]);
  });

  it('EAX-06: closes the connection when the lock statement fails, and runs no work', async () => {
    const refused = new Error('canceling statement due to statement timeout');
    const { db, sent, released } = fakePool({ lock: () => Promise.reject(refused) });
    let ran = false;
    await expect(
      withSessionLock(db, 'display_alerts', () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toBe(refused);
    expect(ran).toBe(false);
    expect(sent.map((s) => s.text)).toEqual([LOCK]);
    expect(released).toEqual([refused]);
  });

  it('EAX-06: aborts the signal with the error when the lock connection is lost, and closes it', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    // Even an unlock that seems to answer does not put a connection that reported an error back.
    const { db, client, released } = fakePool();
    const seen = await withSessionLock(db, 'display_alerts', (signal) => {
      const before = signal.aborted;
      client.emit('error', lost);
      const reason: unknown = signal.reason;
      return Promise.resolve({ before, after: signal.aborted, reason });
    });
    expect(seen).toEqual({ held: true, value: { before: false, after: true, reason: lost } });
    expect(released).toEqual([lost]);
    expect(client.listenerCount('error')).toBe(0);
  });
});
