/**
 * What the transaction helpers do with the pooled connection when a transaction ends,
 * including the case the integration tests cannot produce on demand: a ROLLBACK that fails.
 */
import pg from 'pg';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CommitOutcomeUnknownError,
  lockOrgMembership,
  poolAsTx,
  readOrg,
  sessionRevokeMembership,
  type AuditInput,
  type Autocommit,
  type OrgId,
  type OrgReadTx,
  type OrgTx,
  type Pool,
  type PreOrgTx,
  type Tx,
} from './index.ts';
import { newOrgId } from './migrate.ts';
import {
  testOrgId,
  withNoOrgSet,
  auditScoped,
  withOrg,
  withoutOrg,
  withResolvedOrg,
} from './testing.ts';

const ORG = testOrgId('00000000-0000-4000-8000-000000000001');

/** What sends a statement on either kind of handle: a PreOrgTx has no query of its own. */
const statementsOn = (tx: Tx): Autocommit => ('query' in tx ? tx : withNoOrgSet(tx));

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
  'a transaction handle was used after its transaction ended: the callback given to withOrg, withoutOrg, withResolvedOrg, readOrg, changeOrg or changePreOrg had already returned or thrown, so the statement was not sent. Await every query inside the callback, and do not keep tx, or pass it to work that outlives the callback.';

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
      if (kept[0] === undefined) throw new Error('the callback did not run');
      await expect(statementsOn(kept[0]).query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
      expect(statements).toEqual(sent);
    }
  });

  it('refuses a statement on the handle enterOrg returned, kept after the commit', async () => {
    const { pool, statements } = fakePool();
    const kept: OrgTx[] = [];
    await withResolvedOrg(pool, async (_tx, enterOrg) => {
      kept.push(await enterOrg(ORG));
    });
    const sent = [...statements];
    await expect(kept[0]?.query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
    expect(statements).toEqual(sent);
  });

  it('refuses it after a rollback too', async () => {
    const { pool, statements } = fakePool();
    const kept: PreOrgTx[] = [];
    await expect(
      withoutOrg(pool, async (tx) => {
        kept.push(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    if (kept[0] === undefined) throw new Error('the callback did not run');
    await expect(withNoOrgSet(kept[0]).query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
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
    const kept: ((orgId: OrgId) => Promise<OrgTx>)[] = [];
    await withResolvedOrg(pool, async (_tx, enterOrg) => {
      kept.push(enterOrg);
    });
    await expect(kept[0]?.(ORG)).rejects.toThrow(HANDLE_CLOSED);
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
  });

  it('gives each transaction its own handle: a new one works while an old one stays closed', async () => {
    const { pool, statements } = fakePool();
    const kept: PreOrgTx[] = [];
    await withoutOrg(pool, async (tx) => {
      kept.push(tx);
    });
    await withoutOrg(pool, async (tx) => {
      await withNoOrgSet(tx).query('SELECT 2');
      if (kept[0] === undefined) throw new Error('the first callback did not run');
      await expect(withNoOrgSet(kept[0]).query('SELECT 1')).rejects.toThrow(HANDLE_CLOSED);
    });
    expect(statements).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'SELECT 2', 'COMMIT']);
  });
});

/** The section 3.4 sentence, after the name of the function that was refused. */
const nested = (opener: string): string =>
  `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of withOrg, withoutOrg, withResolvedOrg, readOrg, changeOrg or changePreOrg, or in a helper it called). This opens a second transaction on another connection that commits independently. Pass the outer tx to the helper.`;

// Every nesting below goes through a function defined outside the callback: lint reports the
// form it can read (tinnox/no-nested-transaction), and these cases are the rest, which only
// run() sees.
describe('a transaction inside another (U-3)', () => {
  const inItsOwnTransaction = (pool: Pool, text: string): Promise<unknown> =>
    withoutOrg(pool, (tx) => withNoOrgSet(tx).query(text));
  const onThePool = (pool: Pool, text: string): Promise<unknown> => poolAsTx(pool).query(text);
  const openers = [
    ['withOrg', (pool: Pool, fn: () => Promise<unknown>) => withOrg(pool, ORG, fn)],
    ['withoutOrg', (pool: Pool, fn: () => Promise<unknown>) => withoutOrg(pool, fn)],
    ['withResolvedOrg', (pool: Pool, fn: () => Promise<unknown>) => withResolvedOrg(pool, fn)],
    ['readOrg', (pool: Pool, fn: () => Promise<unknown>) => readOrg(pool, ORG, fn)],
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

  it('every opener hands its callback a Tx, and an OrgTx is also accepted where either handle is', async () => {
    const { pool } = fakePool();
    const seen: Tx[] = [];
    await withOrg(pool, ORG, async (tx) => {
      seen.push(needsTx(tx));
      expect(takesEither(tx)).toBe(tx);
    });
    await withoutOrg(pool, async (tx) => {
      seen.push(needsTx(tx));
    });
    await withResolvedOrg(pool, async (tx, enterOrg) => {
      seen.push(needsTx(tx), needsTx(await enterOrg(ORG)));
    });
    expect(seen).toHaveLength(4);
    expectTypeOf<OrgTx>().toExtend<Autocommit>();
  });
});

// AG-2.3 (adoption plan step 18): the organisation a query runs for is a type that only the
// database's own answers have, so nothing read from a request can be handed to withOrg or
// enterOrg. Checked by `npm run typecheck`, as above.
describe('OrgId: a string is not an organisation (AG-2.3)', () => {
  const PLAIN = '00000000-0000-4000-8000-000000000001';

  it('withOrg and enterOrg refuse a plain string, a field of an object and a template', async () => {
    const { pool, statements } = fakePool();
    const body: { orgId: string } = { orgId: PLAIN };
    // @ts-expect-error a string is not an OrgId: it must come from a lookup of sec.ts
    await withOrg(pool, PLAIN, async () => undefined);
    // @ts-expect-error nor is a string field, whatever it is called
    await withOrg(pool, body.orgId, async () => undefined);
    // @ts-expect-error nor is a string built from an OrgId: the result is a string again
    await withOrg(pool, `${ORG}`, async () => undefined);
    await withResolvedOrg(pool, async (_tx, enterOrg) => {
      // @ts-expect-error enterOrg takes an OrgId too
      await enterOrg(PLAIN);
    });
    // The fake pool has no row-level security to protect, so the forced calls above did run.
    expect(statements.filter((text) => text === 'BEGIN')).toHaveLength(4);

    expectTypeOf<string>().not.toExtend<OrgId>();
    expectTypeOf<OrgId>().toExtend<string>();
    expectTypeOf(withOrg).parameter(1).toEqualTypeOf<OrgId>();
  });

  it('the offline tools and the tests have their own makers, outside the runtime entry', () => {
    expectTypeOf(newOrgId).returns.toEqualTypeOf<OrgId>();
    expectTypeOf(testOrgId).returns.toEqualTypeOf<OrgId>();
    expect(testOrgId(PLAIN)).toBe(PLAIN);
    expect(newOrgId(PLAIN)).toBe(PLAIN);
    // With no argument, a fresh id that withOrg accepts.
    expect(newOrgId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newOrgId()).not.toBe(newOrgId());
  });

  it('still checks the value at run time, for one that got the type without being an id', async () => {
    const { pool, statements } = fakePool();
    await expect(withOrg(pool, testOrgId('not-a-uuid'), async () => undefined)).rejects.toThrow(
      'withOrg requires a lower-case UUID organisation id',
    );
    await expect(
      withResolvedOrg(pool, (_tx, enterOrg) =>
        enterOrg(testOrgId('ABCDEF00-0000-4000-8000-000000000001')),
      ),
    ).rejects.toThrow('enterOrg requires a lower-case UUID organisation id');
    // withOrg refused before it took a connection; enterOrg inside its transaction, which rolled back.
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

// AG-2.1, AG-2.2 (adoption plan step 18): a statement of the caller's own goes on an OrgTx only,
// and a transaction with no organisation yet is a PreOrgTx, which has no query. Checked by
// `npm run typecheck`, as above.
describe('OrgTx and PreOrgTx (AG-2.1, AG-2.2)', () => {
  const needsOrg = (tx: OrgTx): OrgTx => tx;
  const needsPre = (tx: PreOrgTx): PreOrgTx => tx;

  it('withOrg gives an OrgTx, which is not accepted where a PreOrgTx is needed', async () => {
    const { pool, statements } = fakePool();
    await withOrg(pool, ORG, async (tx) => {
      needsOrg(tx);
      // @ts-expect-error the organisation is set: what records "no organisation" does not take it
      needsPre(tx);
      await tx.query('TENANT QUERY');
    });
    expect(statements).toEqual([
      'BEGIN',
      "SELECT set_config('app.org_id', $1, true)",
      'TENANT QUERY',
      'COMMIT',
    ]);
  });

  it('withoutOrg gives a PreOrgTx: no query, and not accepted where an OrgTx is needed', async () => {
    const { pool, statements } = fakePool();
    await withoutOrg(pool, async (tx) => {
      needsPre(tx);
      // @ts-expect-error a PreOrgTx is not accepted where an OrgTx is needed
      needsOrg(tx);
      // @ts-expect-error a tenant query with no organisation does not compile: there is no query
      expect(tx.query).toBeUndefined();
      expect('query' in tx).toBe(false);
    });
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    expectTypeOf<PreOrgTx>().not.toHaveProperty('query');
    expectTypeOf<PreOrgTx>().not.toExtend<Autocommit>();
    expectTypeOf<PreOrgTx>().not.toExtend<OrgTx>();
    expectTypeOf<OrgTx>().not.toExtend<PreOrgTx>();
  });

  it('withResolvedOrg gives a PreOrgTx, and enterOrg the OrgTx of the same transaction', async () => {
    const { pool, statements, taken } = fakePool();
    await withResolvedOrg(pool, async (tx, enterOrg) => {
      needsPre(tx);
      // @ts-expect-error before enterOrg there is no organisation: a PreOrgTx is not an OrgTx
      needsOrg(tx);
      const inOrg = needsOrg(await enterOrg(ORG));
      await inOrg.query('TENANT QUERY');
      // The handle from before is still the same transaction, for a sec.* wrapper that takes it.
      await withNoOrgSet(tx).query('SAME TRANSACTION');
    });
    expect(statements).toEqual([
      'BEGIN',
      "SELECT set_config('app.org_id', $1, true)",
      'TENANT QUERY',
      'SAME TRANSACTION',
      'COMMIT',
    ]);
    expect(taken).toHaveLength(1);
  });
});

// SCR-34 (adoption plan step 19): a read runs in a READ ONLY transaction, on a handle that
// nothing that writes takes. The database's half (SQLSTATE 25006 for a write) is in
// packages/db/test/change.integration.test.ts; the types' half is checked by `npm run
// typecheck`, as above.
describe('readOrg (SCR-34)', () => {
  const needsOrg = (tx: OrgTx): OrgTx => tx;
  const reads = (tx: OrgReadTx): OrgReadTx => tx;
  const takesEither = (handle: Autocommit): Autocommit => handle;
  const FOLDER_CREATED = {
    actorType: 'operator',
    actorId: 'a-member-id',
    action: 'folder.create',
    objectType: 'folder',
    objectId: 'a-folder-id',
    result: 'success',
    detail: null,
  } as const satisfies AuditInput;

  it('opens a READ ONLY transaction with the organisation set, and commits it', async () => {
    const { pool, statements, released, taken } = fakePool();
    expect(
      await readOrg(pool, ORG, async (tx) => {
        await tx.query('TENANT READ');
        return 'read';
      }),
    ).toBe('read');
    expect(statements).toEqual([
      'BEGIN READ ONLY',
      "SELECT set_config('app.org_id', $1, true)",
      'TENANT READ',
      'COMMIT',
    ]);
    expect(taken).toHaveLength(1);
    expect(released).toEqual([undefined]);
  });

  it('rolls back when the read throws, takes an OrgId only, and closes its handle like any other', async () => {
    const { pool, statements } = fakePool();
    await expect(readOrg(pool, ORG, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(statements).toEqual([
      'BEGIN READ ONLY',
      "SELECT set_config('app.org_id', $1, true)",
      'ROLLBACK',
    ]);
    await expect(readOrg(pool, testOrgId('not-a-uuid'), () => Promise.resolve())).rejects.toThrow(
      'readOrg requires a lower-case UUID organisation id',
    );

    const kept: OrgReadTx[] = [];
    await readOrg(pool, ORG, async (tx) => {
      kept.push(tx);
    });
    await expect(kept[0]?.query('LATE')).rejects.toThrow(HANDLE_CLOSED);
    expect(statements).not.toContain('LATE');
  });

  it('gives a handle that is not accepted by what writes, while an OrgTx is accepted by what reads', () => {
    // Never called: these lines are for the type checker.
    const cases = async (read: OrgReadTx, org: OrgTx): Promise<void> => {
      // A helper that only reads takes either handle.
      reads(read);
      reads(org);
      // @ts-expect-error the handle of readOrg is not an OrgTx: a helper that writes refuses it
      needsOrg(read);
      // @ts-expect-error nor does the scoped audit writer take it
      await auditScoped(read, FOLDER_CREATED);
      // @ts-expect-error nor the member revocation
      await sessionRevokeMembership(read, 'a-member-id');
      // @ts-expect-error nor the membership lock
      await lockOrgMembership(read);
      // What the types cannot say: a statement is text, so one that writes still compiles on
      // the read handle. The database refuses it (SQLSTATE 25006).
      await read.query('UPDATE display SET name = $1', ['compiles']);
      // And the handle has a query, so it is an Autocommit: a lookup of sec.ts takes it, and so
      // would a wrapper typed for any handle that writes (loginStatePut, the purges).
      takesEither(read);
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<OrgReadTx>().not.toExtend<OrgTx>();
    expectTypeOf<OrgReadTx>().not.toExtend<Tx>();
    expectTypeOf<OrgReadTx>().not.toExtend<PreOrgTx>();
    expectTypeOf<OrgTx>().toExtend<OrgReadTx>();
    expectTypeOf<PreOrgTx>().not.toExtend<OrgReadTx>();
    expectTypeOf(readOrg).parameter(1).toEqualTypeOf<OrgId>();
  });
});
