/**
 * The start-up decision of assertRuntimeRole (plan row AG-1.3) over facts as the catalogue
 * gives them. packages/db/test/rls.integration.test.ts reads those facts from a real catalogue
 * and tests/integration/runtime-role-refusal.test.ts starts both entry points against it.
 */
import { describe, expect, it } from 'vitest';
import { RuntimeRoleError, runtimeRoleProblems, type RuntimeRoleFacts } from './pool.ts';

const RUNTIME: RuntimeRoleFacts = {
  currentUser: 'tinnox_app',
  sessionUser: 'tinnox_app',
  superuser: false,
  bypassRls: false,
  replication: false,
  createRole: false,
  createDb: false,
  memberOf: [],
  owns: [],
};

describe('runtimeRoleProblems (AG-1.3)', () => {
  it('accepts tinnox_app as infra/postgres/init/01-roles.sh makes it', () => {
    expect(runtimeRoleProblems(RUNTIME)).toEqual([]);
  });

  it('refuses another login or another acting role, and says which DATABASE_URL to use', () => {
    for (const facts of [
      { ...RUNTIME, currentUser: 'tinnox_migrator', sessionUser: 'tinnox_migrator' },
      { ...RUNTIME, sessionUser: 'postgres' },
    ]) {
      const problems = runtimeRoleProblems(facts);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(
        `logs in as ${facts.sessionUser} and acts as ${facts.currentUser}, not tinnox_app`,
      );
      expect(problems[0]).toContain('set DATABASE_URL to the tinnox_app connection string');
    }
  });

  it('refuses a tinnox_app that is superuser, has BYPASSRLS, REPLICATION, CREATEROLE or CREATEDB, is a member or owns something', () => {
    const cases: [Partial<RuntimeRoleFacts>, string][] = [
      [{ superuser: true }, 'ALTER ROLE tinnox_app NOSUPERUSER'],
      [{ bypassRls: true }, 'ALTER ROLE tinnox_app NOBYPASSRLS'],
      [{ replication: true }, 'ALTER ROLE tinnox_app NOREPLICATION'],
      [{ createRole: true }, 'ALTER ROLE tinnox_app NOCREATEROLE'],
      [{ createDb: true }, 'ALTER ROLE tinnox_app NOCREATEDB'],
      [
        { memberOf: ['pg_read_all_data', 'tinnox_definer'] },
        'is a member of pg_read_all_data, tinnox_definer',
      ],
      [{ owns: ['table media_tag'] }, 'owns table media_tag, and an owner can alter'],
    ];
    for (const [change, expected] of cases) {
      const problems = runtimeRoleProblems({ ...RUNTIME, ...change });
      expect(problems, expected).toHaveLength(1);
      expect(problems[0], expected).toContain(expected);
    }
  });

  it('lists every problem at once, and at most five owned objects by name', () => {
    const owns = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `table ${name}`);
    const problems = runtimeRoleProblems({
      currentUser: 'postgres',
      sessionUser: 'postgres',
      superuser: true,
      bypassRls: true,
      replication: true,
      createRole: true,
      createDb: true,
      memberOf: ['pg_monitor'],
      owns,
    });
    expect(problems).toHaveLength(8);
    expect(problems[1]).toContain('role postgres is a superuser');
    expect(problems[7]).toContain('owns table a, table b, table c, table d, table e and 2 more');
  });

  it('keeps the problems on the error for the entry point to print', () => {
    const error = new RuntimeRoleError(['one', 'two']);
    expect(error.problems).toEqual(['one', 'two']);
    expect(error.message).toBe('one; two');
  });
});
