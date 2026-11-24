/**
 * The start-up decision of assertRuntimeRole (plan row AG-1.3) over facts as the catalogue
 * gives them. packages/db/test/rls.integration.test.ts reads those facts from a real catalogue
 * and tests/integration/runtime-role-refusal.test.ts starts both entry points against it.
 */
import { describe, expect, it } from 'vitest';
import {
  createPool,
  RuntimeRoleError,
  runtimeRoleProblems,
  startupSettingsProblem,
  type RuntimeRoleFacts,
} from './pool.ts';

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

describe('startupSettingsProblem: a connection string must not replace what createPool sends', () => {
  // Made up, and plainly a placeholder so the secret scan does not take it for a real one:
  // no problem text may carry it.
  const PASSWORD = 'not-a-real-one';
  const BASE = `postgres://tinnox_app:${PASSWORD}@127.0.0.1:5432/tinnox`;

  it('accepts a connection string with no query, or with transport parameters only', () => {
    for (const url of [
      BASE,
      `${BASE}?sslmode=verify-full`,
      `${BASE}?application_name=other&ssl=true`,
      // A socket directory and a database name: pg reads no query from this form.
      '/var/run/postgresql tinnox',
    ]) {
      expect(startupSettingsProblem(url)).toBeNull();
    }
  });

  it.each(['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'])(
    'refuses %s, names it and says what to do, without the connection string or the value',
    (parameter) => {
      const problem = startupSettingsProblem(`${BASE}?sslmode=require&${parameter}=marker-0`);
      expect(problem).toMatch(
        new RegExp(`^the database connection string sets ${parameter} in its query`),
      );
      expect(problem).toContain('remove that parameter from the connection string');
      expect(problem).not.toContain(PASSWORD);
      expect(problem).not.toContain('marker-0');
    },
  );

  it('names every parameter found, and the variable when the caller gives one', () => {
    const problem = startupSettingsProblem(
      `${BASE}?lock_timeout=0&options=-c%20row_security%3Doff`,
      'DATABASE_URL',
    );
    expect(problem).toMatch(/^DATABASE_URL sets options, lock_timeout in its query/);
    expect(problem).toContain('remove those parameters from the connection string');
  });

  it('reads the query as pg does: an encoded name, a URL without a host, a socket URL', () => {
    for (const url of [
      `${BASE}?%6Fptions=-c%20role%3Dtinnox_definer`,
      `postgres://tinnox_app:${PASSWORD}@/tinnox?options=-c%20row_security%3Doff`,
      'socket:/var/run/postgresql?db=tinnox&options=-c%20row_security%3Doff',
    ]) {
      expect(startupSettingsProblem(url), url.replace(PASSWORD, '***')).toMatch(/ sets options /);
    }
  });

  it('refuses a string pg rewrites before it reads it, and says to write a plain URL (SEC-1)', () => {
    // pg-connection-string runs encodeURI over a string with a space or a malformed percent
    // sequence, then reads host, options and statement_timeout from these queries; new URL
    // refuses the first two as they are. The last has no setting and is refused all the same:
    // what pg reads from it is not what this check would read.
    const query = 'host=127.0.0.1&options=-c%20row_security%3Doff&statement_timeout=0';
    for (const url of [
      `postgres://tinnox_app:${PASSWORD}@a b/tinnox?${query}`,
      `postgres://tinnox_app:${PASSWORD}@local<host/tinnox?application_name=%zz&${query}`,
      `postgres://tinnox_app:${PASSWORD}%zz@127.0.0.1:5432/tinnox`,
    ]) {
      const problem = startupSettingsProblem(url, 'DATABASE_URL');
      expect(problem, url.replace(PASSWORD, '***')).toMatch(
        /^DATABASE_URL cannot be read the way pg reads it: .* Write the connection string as a plain URL, postgres:\/\/user:password@host:port\/database, with every special character of the user name and password percent-encoded/,
      );
      expect(problem).not.toContain(PASSWORD);
    }
    expect(() =>
      createPool({ connectionString: `postgres://tinnox_app:${PASSWORD}@a b/tinnox?${query}` }),
    ).toThrow(/^the database connection string cannot be read the way pg reads it/);
  });

  it('refuses a string that is no URL in either form pg tries', () => {
    expect(startupSettingsProblem('postgres://tinnox_app@local<host/tinnox')).toMatch(
      /cannot be read the way pg reads it/,
    );
  });

  it('createPool refuses such a connection string when the pool is created, before any connection', () => {
    expect(() =>
      createPool({ connectionString: `${BASE}?options=-c%20row_security%3Doff` }),
    ).toThrow(/^the database connection string sets options in its query/);
  });
});
