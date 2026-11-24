/**
 * The database handle of createDatabase (adoption plan section 2.4, step 21): what the API holds
 * as AppContext.db in place of a pool. The type cases are checked by `npm run typecheck`, which
 * reads this file: an unused @ts-expect-error is an error there.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  assertRuntimeRole,
  changeOrg,
  changePreOrg,
  createDatabase,
  ping,
  poolAsTx,
  readOrg,
  sessionLockConnection,
  type Database,
} from './index.ts';
import type { MigratorPool } from './migrate.ts';
import { databaseOn, type Pool } from './testing.ts';

/** A pool whose own query answers with `answer`, recording what it was sent. */
const answering = (answer: () => Promise<unknown>) => {
  const sent: unknown[][] = [];
  const pool = {
    query: (...args: unknown[]) => {
      sent.push(args);
      return answer();
    },
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return { pool, sent };
};

describe('the database handle (step 21)', () => {
  it('a pool is not a Database: the API cannot be handed one where the handle is wanted', () => {
    // Never called: these lines are for the type checker.
    const cases = async (pool: Pool, db: Database, migrator: MigratorPool): Promise<void> => {
      await ping(db);
      // @ts-expect-error a pg Pool is not the handle of createDatabase
      await ping(pool);
      // @ts-expect-error nor is it for a read
      await readOrg(pool, undefined as never, () => Promise.resolve());
      // @ts-expect-error nor for the lookups before the organisation is known
      poolAsTx(pool);
      // @ts-expect-error nor for the start-up role check
      await assertRuntimeRole(pool);
      // @ts-expect-error nor for the alert check's lock connection
      await sessionLockConnection(pool);
      // The migrator's checked pool is its own handle, for an offline tool's changePreOrg.
      await ping(migrator);
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<Pool>().not.toExtend<Database>();
    // The handle has no statement of its own and no connection to hand out.
    expectTypeOf<Database>().not.toHaveProperty('query');
    expectTypeOf<Database>().not.toHaveProperty('connect');
    expectTypeOf(readOrg).parameter(0).toEqualTypeOf<Database>();
    expectTypeOf(changeOrg).parameter(0).toEqualTypeOf<Database>();
    expectTypeOf(changePreOrg).parameter(0).toEqualTypeOf<Database>();
    expectTypeOf(poolAsTx).parameter(0).toEqualTypeOf<Database>();
  });

  it('createDatabase refuses a connection string createPool refuses, before any connection', () => {
    expect(() => createDatabase({ connectionString: '' })).toThrow(
      'database connection string is not configured',
    );
  });

  it('refuses at run time a value no function of the package made a handle, and sends nothing', async () => {
    const { pool, sent } = answering(() => Promise.resolve({ rows: [] }));
    await expect(ping(pool as never)).rejects.toThrow(
      'this is not a database of @tinnox/db: pass the Database that createDatabase(options) returned (AppContext.db in the API). A test wraps a pool of its own with databaseOn(pool) from @tinnox/db/testing; an offline tool passes the pool that connectMigrator returned (@tinnox/db/migrate)',
    );
    expect(sent).toEqual([]);
  });

  it('end closes the pool behind the handle (the shutdown of an entry point)', async () => {
    let ended = 0;
    const pool = {
      end: () => {
        ended += 1;
        return Promise.resolve();
      },
    } as unknown as Pool;
    await databaseOn(pool).end();
    expect(ended).toBe(1);
  });
});

describe('ping (the liveness probe of /readyz)', () => {
  it('sends one statement that reads no table, on the pool itself', async () => {
    const { pool, sent } = answering(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));
    await expect(ping(databaseOn(pool))).resolves.toBeUndefined();
    expect(sent).toEqual([['SELECT 1']]);
  });

  it('rejects with what the pool failed with, so the caller can report the database as down', async () => {
    const { pool } = answering(() => Promise.reject(new Error('Connection terminated')));
    await expect(ping(databaseOn(pool))).rejects.toThrow('Connection terminated');
  });
});
