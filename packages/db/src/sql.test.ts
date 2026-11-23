/**
 * SqlFragment (OTH-12): the three ways to make one give exactly the text an untagged template or
 * a join would, so a statement put together from fragments is byte for byte the statement that
 * was written before; and a plain string is not one. The type cases are checked by
 * `npm run typecheck`, which reads this file: an unused @ts-expect-error is an error there.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { joinSql, sql, sqlParameter, type SqlFragment } from './sql.ts';

describe('sql (OTH-12)', () => {
  it('gives the text as written, like an untagged template', () => {
    expect(sql`FOR KEY SHARE`).toBe('FOR KEY SHARE');
    expect(sql``).toBe('');
    expect(sql`media_tag`).toBe('media_tag');
    // Escapes are read as in any template, and a parameter number is plain text.
    expect(sql`WHERE name = $1\n  AND note <> 'it''s'`).toBe(
      `WHERE name = $1\n  AND note <> 'it''s'`,
    );
  });

  it('puts other fragments in place', () => {
    const column = sql`category`;
    expect(sql`${column} = ANY(${sqlParameter(3)}::text[])`).toBe('category = ANY($3::text[])');
    expect(sql`${sql`a`}${sql`b`}`).toBe('ab');
  });

  it('takes no plain string, so a value cannot be put into a statement by this route', () => {
    const input: string = "x'; DROP TABLE display; --";
    // @ts-expect-error a string is not a SqlFragment: pass it as a parameter ($1).
    expect(sql`name = '${input}'`).toBe(`name = '${input}'`);
    // @ts-expect-error nor may a string be used where a fragment is wanted.
    const fragment: SqlFragment = input;
    expect(fragment).toBe(input);
    // A fragment is still a string, so query(text: string) takes it.
    expectTypeOf<SqlFragment>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<SqlFragment>();
  });
});

describe('sqlParameter (OTH-12)', () => {
  it('is the placeholder of a position from 1, as values.push(value) returns it', () => {
    const values: unknown[] = ['first'];
    expect(sqlParameter(1)).toBe('$1');
    expect(sqlParameter(values.push('second'))).toBe('$2');
    expect(sql`id < ${sqlParameter(2)}::bigint`).toBe('id < $2::bigint');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (position) => {
    expect(() => sqlParameter(position)).toThrow('a statement parameter is numbered from 1');
  });
});

describe('joinSql (OTH-12)', () => {
  it('joins like Array.prototype.join', () => {
    const conditions = [sql`org_id = app_org_id()`, sql`id < $2::bigint`, sql`result = $3`];
    expect(joinSql(conditions, sql` AND `)).toBe(
      ['org_id = app_org_id()', 'id < $2::bigint', 'result = $3'].join(' AND '),
    );
    expect(joinSql([sql`role = $2`], sql`, `)).toBe('role = $2');
    expect(joinSql([], sql`, `)).toBe('');
    // @ts-expect-error the parts are fragments, not strings.
    expect(joinSql(['role = $2'], sql`, `)).toBe('role = $2');
    // @ts-expect-error and so is the separator.
    expect(joinSql([sql`a`, sql`b`], ', ')).toBe('a, b');
  });
});
