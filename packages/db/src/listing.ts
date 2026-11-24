/**
 * The answer of a lookup that has a row limit (adoption plan step 22; review round 3, SCX-02).
 *
 * A list cut off by its limit is not the whole set, so only the `complete: true` branch has
 * `items`. A caller that removes anything because a row is absent from the list can only reach
 * the rows by narrowing on `complete`; the other branch holds a `sample`, for work that is safe
 * on any part of the set (a scan of the oldest jobs). `anyOf` reads either, in the one place a
 * caller says by its name that it does not need the whole set.
 */
export type Listing<T> =
  | { readonly complete: true; readonly items: readonly T[] }
  | { readonly complete: false; readonly sample: readonly T[] };

/**
 * A lookup returned `rows` under the limit the database really applied. A list that fills its
 * limit may have been cut off, so it counts as incomplete: the database does not say.
 */
export function listingOf<T>(rows: readonly T[], appliedLimit: number): Listing<T> {
  return rows.length < appliedLimit
    ? { complete: true, items: rows }
    : { complete: false, sample: rows };
}

/** The rows of either branch, for work that does not depend on the list being the whole set. */
export function anyOf<T>(listing: Listing<T>): readonly T[] {
  return listing.complete ? listing.items : listing.sample;
}
