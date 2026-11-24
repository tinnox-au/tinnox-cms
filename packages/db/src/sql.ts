/**
 * SQL text that was written in the source (OTH-12): values always travel as parameters ($1, $2),
 * never inside the statement. Most statements are one literal. A statement that is put together
 * at run time (a clause that is only sometimes there, one of two fixed table names, a list of
 * conditions) is put together from `SqlFragment`s, and the only ways to make one are below, none
 * of which takes a value from a request.
 *
 * The lint rule tinnox/sql-fragments (scripts/eslint-rules/sql-fragments.ts) holds the other
 * half: the text given to `query()` may interpolate only an UPPER_CASE module constant or a
 * `SqlFragment`. A cast to `SqlFragment` is refused outside this file (NO_BRAND_CAST in
 * eslint.config.js); `as never` and a value typed `any` are not seen and are left to review.
 */
declare const sqlFragmentBrand: unique symbol;

/** Fixed SQL text. Made only by `sql`, `sqlParameter` and `joinSql`. */
export type SqlFragment = string & { readonly [sqlFragmentBrand]: true };

/**
 * A tag for fixed SQL text: sql`FOR SHARE`. Only other fragments may be interpolated, so the
 * result is still text from the source: sql`id < ${sqlParameter(2)}::bigint`.
 */
export function sql(strings: TemplateStringsArray, ...parts: readonly SqlFragment[]): SqlFragment {
  // The same text an untagged template gives: the cooked strings with the parts between them.
  return String.raw({ raw: strings }, ...parts) as SqlFragment;
}

/**
 * The placeholder of the parameter at `position` (from 1): `$1`, `$2`. For a statement whose
 * parameter list grows with the conditions asked for: `sqlParameter(values.push(value))`.
 */
export function sqlParameter(position: number): SqlFragment {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new Error('a statement parameter is numbered from 1');
  }
  return `$${position}` as SqlFragment;
}

/** The fragments joined with `separator` between them: joinSql(conditions, sql` AND `). */
export function joinSql(parts: readonly SqlFragment[], separator: SqlFragment): SqlFragment {
  return parts.join(separator) as SqlFragment;
}
