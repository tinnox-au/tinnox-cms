/**
 * What the transaction helpers do with the pooled connection when a transaction ends,
 * including the case the integration tests cannot produce on demand: a ROLLBACK that fails.
 */
import pg from 'pg';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CommitOutcomeUnknownError,
  poolAsTx,
  withOrg,
  withoutOrg,
  withResolvedOrg,
  type Autocommit,
  type Pool,
  type Tx,
} from './index.ts';

const ORG = '00000000-0000-4000-8000-000000000001';

/**
 * A pool with one connection that records its statements and how it was released, how often a
 * connection was taken, and the statements sent to the pool itself.
 */
function fakePool(
  failing: readonly string[] = [],
  failure?: (text: string) => Error,
  /** COMMIT is answered only once this resolves. */
  commitWaitsFor: Promise<void> = Promise.resolve(),
) {
  const statements: string[] = [];
  const released: (Error | undefined)[] = [];
  const taken: number[] = [];
  const onPool: string[] = [];
  const listeners = new Set<(error: Error) => void>();
  const client = {
    on: (_event: 'error', listener: (error: Error) => void) => listeners.add(listener),
    removeListener: (_event: 'error', listener: (error: Error) => void) =>
      listeners.delete(listener),
    query: (text: string) => {
      statements.push(text);
      if (failing.includes(text)) {
        return Promise.reject(failure?.(text) ?? new Error(`${text} failed`));
      }
      return text === 'COMMIT'
        ? commitWaitsFor.then(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] });
    },
    release: (error?: Error) => {
      released.push(error);
    },
  };
  const pool = {
    connect: () => {
      taken.push(statements.length);
      return Promise.resolve(client);
    },
    query: (text: string) => {
      onPool.push(text);
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
  /** What the pg client does when the server closes the connection. */
  const lose = (): void => {
    for (const listener of listeners) listener(new Error('Connection terminated unexpectedly'));
  };
  return { pool, statements, released, listeners, lose, taken, onPool };
}

describe('pooled connection after a transaction', () => {
  it('goes back to the pool after a commit', async () => {
    const { pool, statements, released } = fakePool();
    expect(await withOrg(pool, ORG, () => Promise.resolve('done'))).toBe('done');
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(released).toEqual([undefined]);
  });

  it('goes back to the pool after a rollback that worked, and the work’s error is thrown', async () => {
    const { pool, statements, released } = fakePool();
    await expect(withoutOrg(pool, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(released).toEqual([undefined]);
  });

  it('is destroyed, not reused, when the rollback fails', async () => {
    for (const run of [
      (pool: Pool) => withOrg(pool, ORG, () => Promise.reject(new Error('boom'))),
      (pool: Pool) => withoutOrg(pool, () => Promise.reject(new Error('boom'))),
      (pool: Pool) =>
        withResolvedOrg(pool, async (_tx, enterOrg) => {
          await enterOrg(ORG);
          throw new Error('boom');
        }),
    ]) {
      const { pool, released } = fakePool(['ROLLBACK']);
      // The caller still sees why the work failed, not the rollback error.
      await expect(run(pool)).rejects.toThrow('boom');
      // pg destroys a client that is released with an error.
      expect(released).toHaveLength(1);
      expect(released[0]).toBeInstanceOf(Error);
      expect(released[0]?.message).toBe('ROLLBACK failed');
    }
  });

  it('listens for a lost connection while it is checked out, and destroys it', async () => {
    const { pool, released, listeners, lose } = fakePool();
    await withoutOrg(pool, () => {
      expect(listeners.size).toBe(1);
      lose();
      return Promise.resolve();
    });
    expect(released[0]?.message).toBe('Connection terminated unexpectedly');
    // The listener is gone again, so a pooled connection does not collect one per use.
    expect(listeners.size).toBe(0);
  });

  it('rolls back when the commit fails, and is destroyed if that fails too', async () => {
    const committing = fakePool(['COMMIT']);
    await expect(withoutOrg(committing.pool, () => Promise.resolve(1))).rejects.toThrow(
      CommitOutcomeUnknownError,
    );
    expect(committing.statements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(committing.released).toEqual([undefined]);

    const both = fakePool(['COMMIT', 'ROLLBACK']);
    await expect(withoutOrg(both.pool, () => Promise.resolve(1))).rejects.toThrow(
      CommitOutcomeUnknownError,
    );
    expect(both.released[0]).toBeInstanceOf(Error);
  });
});

/** What PostgreSQL sends when it refuses a statement, as the pg driver parses it. */
function serverError(code: string, severity = 'ERROR'): pg.DatabaseError {
  const error = new pg.DatabaseError(`server refused (${code})`, 0, 'error');
  error.code = code;
  error.severity = severity;
  return error;
}

describe('a COMMIT that does not confirm (review round 3, SCX-03)', () => {
  const runs = [
    (pool: Pool) => withOrg(pool, ORG, () => Promise.resolve('done')),
    (pool: Pool) => withoutOrg(pool, () => Promise.resolve('done')),
    (pool: Pool) =>
      withResolvedOrg(pool, async (_tx, enterOrg) => {
        await enterOrg(ORG);
        return 'done';
      }),
  ];

  it('reports an unknown outcome, not a rollback, when the answer to COMMIT is lost', async () => {
    for (const run of runs) {
      const lost = new Error('Connection terminated unexpectedly');
      const { pool } = fakePool(['COMMIT'], () => lost);
      const error: unknown = await run(pool).catch((thrown: unknown) => thrown);
      // Callers must not undo work outside the database: the transaction may have committed.
      expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
      expect((error as Error).cause).toBe(lost);
    }
  });

  it('treats a shutdown or other server error at COMMIT as unknown too', async () => {
    const { pool } = fakePool(['COMMIT'], () => serverError('57P01', 'FATAL'));
    await expect(withoutOrg(pool, () => Promise.resolve(1))).rejects.toThrow(
      CommitOutcomeUnknownError,
    );
  });

  it('treats SQLSTATE 40003 (statement completion unknown) as unknown, although it is class 40', async () => {
    const unknown = serverError('40003');
    const { pool } = fakePool(['COMMIT'], () => unknown);
    const error: unknown = await withoutOrg(pool, () => Promise.resolve(1)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect((error as Error).cause).toBe(unknown);
  });

  it('passes on a refusal that rolled the transaction back: a deferred constraint or a serialization failure', async () => {
    for (const code of ['23505', '40001', '40P01']) {
      const refusal = serverError(code);
      const { pool } = fakePool(['COMMIT'], () => refusal);
      await expect(withoutOrg(pool, () => Promise.resolve(1))).rejects.toBe(refusal);
    }
  });

  it('does not touch the error of work that failed before COMMIT', async () => {
    const { pool, statements } = fakePool();
    const error: unknown = await withoutOrg(pool, () => Promise.reject(new Error('boom'))).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect((error as Error).message).toBe('boom');
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

const HANDLE_CLOSED =
  'a transaction handle was used after its transaction ended: the callback given to withOrg, withoutOrg or withResolvedOrg had already returned or thrown, so the statement was not sent. Await every query inside the callback, and do not keep tx, or pass it to work that outlives the callback.';

describe('a transaction handle after its transaction ended (U-2)', () => {
  it('refuses a statement on a handle kept after the commit, and sends nothing', async () => {
    for (const run of [
      (pool: Pool, keep: (tx: Tx) => void) =>
        withOrg(pool, ORG, async (tx) => {
          keep(tx);
        }),
      (pool: Pool, keep: (tx: Tx) => void) =>
        withoutOrg(pool, async (tx) => {
          keep(tx);
        }),
      (pool: Pool, keep: (tx: Tx) => void) =>
        withResolvedOrg(pool, async (tx) => {
          keep(tx);
        }),
    ]) {
      const { pool, statements } = fakePool();
      const kept: Tx[] = [];
      await run(pool, (tx) => kept.push(tx));
      const sent = [...statements];
      await expect(kept[0]?.query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
      expect(statements).toEqual(sent);
    }
  });

  it('refuses it after a rollback too', async () => {
    const { pool, statements } = fakePool();
    const kept: Tx[] = [];
    await expect(
      withoutOrg(pool, async (tx) => {
        kept.push(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(kept[0]?.query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('refuses a statement from work the callback started and did not await, even before COMMIT has answered', async () => {
    let answerCommit: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answerCommit = resolve;
    });
    const { pool, statements } = fakePool([], undefined, answered);
    let started: (work: Promise<unknown>) => void = () => undefined;
    const late = new Promise<unknown>((resolve) => {
      started = resolve;
    });
    const transaction = withOrg(pool, ORG, async (tx) => {
      // Not awaited: the first statement is sent inside the transaction, the second after the
      // callback has returned (a timer away), while COMMIT is still waiting for its answer.
      started(
        tx
          .query('FIRST')
          .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
          .then(() => tx.query('SECOND')),
      );
    });
    await expect(late).rejects.toThrow(HANDLE_CLOSED);
    expect(statements.slice(-2)).toEqual(['FIRST', 'COMMIT']);
    answerCommit();
    await transaction;
    expect(statements).not.toContain('SECOND');
  });

  it('refuses enterOrg after the transaction ended', async () => {
    const { pool, statements } = fakePool();
    const kept: ((orgId: string) => Promise<void>)[] = [];
    await withResolvedOrg(pool, async (_tx, enterOrg) => {
      kept.push(enterOrg);
    });
    await expect(kept[0]?.(ORG)).rejects.toThrow(HANDLE_CLOSED);
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
  });

  it('gives each transaction its own handle: a new one works while an old one stays closed', async () => {
    const { pool, statements } = fakePool();
    const kept: Tx[] = [];
    await withoutOrg(pool, async (tx) => {
      kept.push(tx);
    });
    await withoutOrg(pool, async (tx) => {
      await tx.query('SELECT 2');
      await expect(kept[0]?.query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
    });
    expect(statements).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'SELECT 2', 'COMMIT']);
  });
});

/** The section 3.4 sentence, after the name of the function that was refused. */
const nested = (opener: string): string =>
  `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of withOrg, withoutOrg or withResolvedOrg, or in a helper it called). This opens a second transaction on another connection that commits independently. Pass the outer tx to the helper.`;

// Every nesting below goes through a function defined outside the callback: lint reports the
// form it can read (tinnox/no-nested-transaction), and these cases are the rest, which only
// run() sees.
describe('a transaction inside another (U-3)', () => {
  const inItsOwnTransaction = (pool: Pool, text: string): Promise<unknown> =>
    withoutOrg(pool, (tx) => tx.query(text));
  const onThePool = (pool: Pool, text: string): Promise<unknown> => poolAsTx(pool).query(text);
  const openers = [
    ['withOrg', (pool: Pool, fn: () => Promise<unknown>) => withOrg(pool, ORG, fn)],
    ['withoutOrg', (pool: Pool, fn: () => Promise<unknown>) => withoutOrg(pool, fn)],
    ['withResolvedOrg', (pool: Pool, fn: () => Promise<unknown>) => withResolvedOrg(pool, fn)],
  ] as const;

  it('refuses every opener inside every other, before a second connection is taken, and rolls the outer back', async () => {
    for (const [, outer] of openers) {
      for (const [name, inner] of openers) {
        const { pool, statements, released, taken } = fakePool();
        await expect(
          outer(pool, () => inner(pool, () => Promise.resolve('inner'))),
        ).rejects.toThrow(nested(name));
        expect(taken).toHaveLength(1);
        expect(statements.at(-1)).toBe('ROLLBACK');
        expect(statements).not.toContain('COMMIT');
        expect(released).toEqual([undefined]);
      }
    }
  });

  it('refuses it in a helper the callback calls, where no lint rule can see it', async () => {
    const { pool, taken } = fakePool();
    const helper = async (): Promise<void> => {
      await Promise.resolve();
      await withOrg(pool, ORG, () => Promise.resolve());
    };
    await expect(withOrg(pool, ORG, () => helper())).rejects.toThrow(nested('withOrg'));
    expect(taken).toHaveLength(1);
  });

  it('refuses a statement on the pool through poolAsTx, which is a transaction of its own', async () => {
    const { pool, onPool } = fakePool();
    await expect(
      withOrg(pool, ORG, () => onThePool(pool, 'SELECT sec.something()')),
    ).rejects.toThrow(nested('poolAsTx(pool).query'));
    expect(onPool).toEqual([]);
    // Outside a transaction it is sent as before.
    await onThePool(pool, 'SELECT sec.something()');
    expect(onPool).toEqual(['SELECT sec.something()']);
  });

  it('allows one transaction after another, and transactions side by side', async () => {
    const { pool, statements } = fakePool();
    await withOrg(pool, ORG, () => Promise.resolve());
    await withoutOrg(pool, () => Promise.resolve());
    await Promise.all([
      withOrg(pool, ORG, () => Promise.resolve()),
      withResolvedOrg(pool, () => Promise.resolve()),
    ]);
    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(4);
  });

  it('allows a second transaction after the first rolled back, as a recorded refusal needs (DEC-35)', async () => {
    const { pool, statements } = fakePool();
    try {
      await withOrg(pool, ORG, () => Promise.reject(new Error('refused')));
    } catch {
      await withOrg(pool, ORG, (tx) => tx.query('INSERT audit'));
    }
    const SET_ORG = "SELECT set_config('app.org_id', $1, true)";
    expect(statements).toEqual([
      'BEGIN',
      SET_ORG,
      'ROLLBACK',
      'BEGIN',
      SET_ORG,
      'INSERT audit',
      'COMMIT',
    ]);
  });

  it('does not count work that outlives the callback: once the outer has ended, it may open its own', async () => {
    const { pool, statements } = fakePool();
    let later: Promise<unknown> = Promise.resolve();
    let release: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withOrg(pool, ORG, async () => {
      // Started inside the callback, so it carries the callback's context; it runs after.
      later = ended.then(() => inItsOwnTransaction(pool, 'LATER'));
    });
    release();
    await later;
    expect(statements.at(-2)).toBe('LATER');
  });

  it('leaves the path usable after a refusal the callback caught', async () => {
    const { pool, statements } = fakePool();
    await withOrg(pool, ORG, async (tx) => {
      await expect(inItsOwnTransaction(pool, 'INNER')).rejects.toThrow(nested('withoutOrg'));
      await tx.query('STILL OPEN');
    });
    expect(statements).toEqual([
      'BEGIN',
      "SELECT set_config('app.org_id', $1, true)",
      'STILL OPEN',
      'COMMIT',
    ]);
  });
});

// D2, CX-01: the type checker holds that what takes a Tx is never given a handle that commits
// each statement on its own. `npm run typecheck` reads this file: an unused @ts-expect-error
// is an error, so each case fails the build the day its line compiles.
describe('Tx and Autocommit (D2)', () => {
  const needsTx = (tx: Tx): Tx => tx;
  const takesEither = (handle: Autocommit): Autocommit => handle;

  it('a pool is not a Tx, nor is the handle of poolAsTx, nor an object with a query method', () => {
    const { pool } = fakePool();
    const autocommit = poolAsTx(pool);
    const handMade = { query: autocommit.query };
    // @ts-expect-error a pool commits each statement on its own, so it is not a Tx
    needsTx(pool);
    // @ts-expect-error poolAsTx gives an Autocommit, which is not a Tx
    needsTx(autocommit);
    // @ts-expect-error only run() in tx.ts can make a Tx: the mark is not exported
    needsTx(handMade);

    expectTypeOf(poolAsTx).returns.toEqualTypeOf<Autocommit>();
    expectTypeOf<Autocommit>().not.toExtend<Tx>();
    expectTypeOf<Pool>().not.toExtend<Tx>();
    expect(takesEither(autocommit)).toBe(autocommit);
  });

  it('every opener hands its callback a Tx, which is also accepted where either handle is', async () => {
    const { pool } = fakePool();
    const seen: Tx[] = [];
    await withOrg(pool, ORG, async (tx) => {
      seen.push(needsTx(tx));
    });
    await withoutOrg(pool, async (tx) => {
      seen.push(needsTx(tx));
    });
    await withResolvedOrg(pool, async (tx) => {
      seen.push(needsTx(tx));
      expect(takesEither(tx)).toBe(tx);
    });
    expect(seen).toHaveLength(3);
    expectTypeOf<Tx>().toExtend<Autocommit>();
  });
});
