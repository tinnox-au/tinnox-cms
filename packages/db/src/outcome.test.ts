/**
 * classifyDbError and the registry it reads (adoption plan section 2.3, step 25). That the
 * registry equals the migrated schema is packages/db/test/catalogue.integration.test.ts.
 */
import pg from 'pg';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { commitFailure, CommitOutcomeUnknownError } from './commit-outcome.ts';
import {
  CONSTRAINTS,
  isConstraintName,
  STAGE_A_CONSTRAINTS,
  STAGE_B_CONSTRAINTS,
  STAGE_C_CONSTRAINTS,
  type ConstraintName,
} from './constraints.ts';
import { classifyDbError, isLockTimeout, type DbFailure } from './outcome.ts';

/** What PostgreSQL sends when it refuses a statement, as the pg driver parses it. */
function serverError(code: string | undefined, constraint?: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`server refused (${code ?? 'no code'})`, 0, 'error');
  error.code = code;
  error.constraint = constraint;
  return error;
}

describe('classifyDbError (step 25)', () => {
  it('names a registered constraint raised with its own SQLSTATE', () => {
    const cases: [string, ConstraintName][] = [
      ['23505', 'tag_org_scope_name_key'],
      ['23503', 'media_folder_fk'],
      ['23001', 'membership_last_owner'],
      ['23001', 'schedule_event_playlist_guard'],
      ['23514', 'media_default_duration_images_only'],
    ];
    for (const [code, name] of cases) {
      expect(classifyDbError(serverError(code, name))).toEqual({ kind: 'constraint', name });
    }
  });

  it('calls any other integrity violation unmapped, with its SQLSTATE and the name if there is one', () => {
    // Not in the registry.
    expect(classifyDbError(serverError('23503', 'media_org_id_fkey'))).toEqual({
      kind: 'unmapped_constraint',
      sqlstate: '23503',
      name: 'media_org_id_fkey',
    });
    // Registered, but raised with another SQLSTATE than the registry's: not what it means there.
    expect(classifyDbError(serverError('23503', 'tag_org_scope_name_key'))).toEqual({
      kind: 'unmapped_constraint',
      sqlstate: '23503',
      name: 'tag_org_scope_name_key',
    });
    // NOT NULL names no constraint; neither does a guard that raises with no CONSTRAINT option.
    for (const constraint of [undefined, '']) {
      expect(classifyDbError(serverError('23502', constraint))).toEqual({
        kind: 'unmapped_constraint',
        sqlstate: '23502',
        name: null,
      });
    }
    // The test database's audit-debt guard: a private subclass no registry name can match.
    expect(classifyDbError(serverError('23U01', 'audit_debt'))).toEqual({
      kind: 'unmapped_constraint',
      sqlstate: '23U01',
      name: 'audit_debt',
    });
  });

  it('reads a constraint name only on an integrity violation', () => {
    expect(classifyDbError(serverError('22001', 'tag_org_scope_name_key'))).toEqual({
      kind: 'other',
      sqlstate: '22001',
    });
  });

  it('calls 42501 denied: a grant or row-level security refused the statement', () => {
    expect(classifyDbError(serverError('42501'))).toEqual({ kind: 'denied' });
  });

  it('calls a serialization failure, a deadlock and a lock or statement timeout transient', () => {
    for (const code of ['40001', '40P01', '55P03', '57014'] as const) {
      expect(classifyDbError(serverError(code))).toEqual({ kind: 'transient', sqlstate: code });
    }
  });

  it('calls every other server error other, 40003 and a shutdown included', () => {
    for (const code of ['40003', '57P01', '22P02', '25006', 'P0001', '53300']) {
      expect(classifyDbError(serverError(code))).toEqual({ kind: 'other', sqlstate: code });
    }
  });

  it('calls a pg error with no code, or one that is not a SQLSTATE, other with no SQLSTATE', () => {
    for (const code of [undefined, '', '2350', 'unique_violation']) {
      expect(classifyDbError(serverError(code)), String(code)).toEqual({
        kind: 'other',
        sqlstate: null,
      });
    }
  });

  it('returns null for anything the server did not raise, even with a code and a constraint', () => {
    const lookalike = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'tag_org_scope_name_key',
    });
    for (const thrown of [
      lookalike,
      { code: '23505', constraint: 'tag_org_scope_name_key' },
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      new Error('Connection terminated unexpectedly'),
      '23505',
      null,
      undefined,
    ]) {
      expect(classifyDbError(thrown)).toBeNull();
    }
  });

  it('classes a refusal at COMMIT as the server raised it, and an unknown outcome not at all (step 24)', () => {
    // The deferred unique key of 0001 that a real refusal at COMMIT trips
    // (../test/commit-outcome.integration.test.ts): not registered, so unmapped.
    const deferred = serverError('23505', 'playlist_item_playlist_id_position_key');
    expect(commitFailure(deferred)).toBe(deferred);
    expect(classifyDbError(commitFailure(deferred))).toEqual({
      kind: 'unmapped_constraint',
      sqlstate: '23505',
      name: 'playlist_item_playlist_id_position_key',
    });
    expect(classifyDbError(commitFailure(serverError('40001')))).toEqual({
      kind: 'transient',
      sqlstate: '40001',
    });
    // The server may have committed: no kind of DbFailure says so, and the cause is not read,
    // so a caller cannot take a lost answer for a rollback.
    for (const lost of [serverError('40003'), serverError('57P01'), new Error('timeout')]) {
      const unknown = commitFailure(lost);
      expect(unknown).toBeInstanceOf(CommitOutcomeUnknownError);
      expect(classifyDbError(unknown)).toBeNull();
    }
  });

  it('tells a lock timeout from the other transient failures (step 26)', () => {
    expect(isLockTimeout(classifyDbError(serverError('55P03')))).toBe(true);
    for (const code of ['40001', '40P01', '57014', '23505', '42501']) {
      expect(isLockTimeout(classifyDbError(serverError(code))), code).toBe(false);
    }
    // Only an error the server raised: a look-alike with the code is not one.
    const lookalike = Object.assign(new Error('lock timeout'), { code: '55P03' });
    expect(isLockTimeout(classifyDbError(lookalike))).toBe(false);
    expect(isLockTimeout(classifyDbError(commitFailure(serverError('57P01'))))).toBe(false);
  });

  it('returns a closed union', () => {
    expectTypeOf<DbFailure['kind']>().toEqualTypeOf<
      'constraint' | 'unmapped_constraint' | 'denied' | 'transient' | 'other'
    >();
    expectTypeOf<
      Extract<DbFailure, { kind: 'constraint' }>['name']
    >().toEqualTypeOf<ConstraintName>();
  });
});

describe('the constraint registry (step 25, U-9)', () => {
  it('names constraints by a closed union of its keys', () => {
    const name: ConstraintName = 'tag_org_scope_name_key';
    expect(CONSTRAINTS[name].sqlstate).toBe('23505');
    // @ts-expect-error a name the registry does not have
    const unknown: ConstraintName = 'tag_org_scope_name_kye';
    expect(isConstraintName(unknown)).toBe(false);
    expect(isConstraintName('tag_org_scope_name_key')).toBe(true);
    // Not a key inherited from Object.prototype.
    expect(isConstraintName('toString')).toBe(false);
  });

  it('holds every name of the stage lists, which the type checker also holds (satisfies)', () => {
    const listed = [STAGE_A_CONSTRAINTS, STAGE_B_CONSTRAINTS, STAGE_C_CONSTRAINTS].flatMap(
      (list): string[] => Object.values(list),
    );
    expect(listed.filter((name) => !isConstraintName(name))).toEqual([]);
  });

  it('says what each name means, on which table', () => {
    for (const [name, entry] of Object.entries(CONSTRAINTS)) {
      expect(entry.table, name).toMatch(/^public\.[a-z_]+$/);
      expect(entry.means.length, name).toBeGreaterThan(20);
    }
  });
});
