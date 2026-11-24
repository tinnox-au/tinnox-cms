/**
 * What a route is handed for the database (adoption plan section 2.4, step 21): the Database
 * that createDatabase (@tinnox/db) makes, never a pg Pool. The type cases are checked by
 * `npm run typecheck`, which reads this file: an unused @ts-expect-error is an error there.
 */
import type { Database } from '@tinnox/db';
import type { Pool } from '@tinnox/db/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AppContext } from './context.ts';

describe('AppContext holds the database handle, not a pool (step 21)', () => {
  it('AppContext.db is the Database of createDatabase, and a pg Pool does not fit it', () => {
    // Never called: these lines are for the type checker.
    const cases = (rest: Omit<AppContext, 'db'>, db: Database, pool: Pool): AppContext[] => {
      const handed: AppContext = { ...rest, db };
      // @ts-expect-error a pg Pool is not the handle: product code would get query and connect
      const pooled: AppContext = { ...rest, db: pool };
      // @ts-expect-error and there is no pool beside the handle
      const both: AppContext = { ...rest, db, pool };
      return [handed, pooled, both];
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<AppContext['db']>().toEqualTypeOf<Database>();
    expectTypeOf<AppContext>().not.toHaveProperty('pool');
  });
});
