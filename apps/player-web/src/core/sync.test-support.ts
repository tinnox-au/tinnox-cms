// fast-check generators for the player's restore of its active publication (adoption plan
// section 4.4, property 14, FCX-02).
//
// Choosing a generator: a case is a shape, not a manifest: the schemaVersion (1 to 5), which
// assets of a fixed pool the play list uses (two to five entries, repeats allowed), whether an app
// item is added (version 3 and later) and which pool assets the browser evicted. The manifest is
// built from it with the helpers of fakes.test-support.ts, and sync.property.test.ts checks that
// it parses with ManifestSchema. A counterexample whose manifest fails that self-check is a
// generator bug, not a product bug.
import fc from 'fast-check';

export const POOL_SIZE = 4;

export interface RestoreCase {
  readonly version: 1 | 2 | 3 | 4 | 5;
  /** Pool indexes of the play list's media entries, in order. */
  readonly picks: readonly number[];
  readonly withApp: boolean;
  /** Pool indexes whose files are gone from the asset store. */
  readonly evicted: readonly number[];
}

const poolIndexes = Array.from({ length: POOL_SIZE }, (_, n) => n);

export const restoreCaseArb: fc.Arbitrary<RestoreCase> = fc.record({
  version: fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const, 5 as const),
  picks: fc.array(fc.nat({ max: POOL_SIZE - 1 }), { minLength: 2, maxLength: 5 }),
  withApp: fc.boolean(),
  evicted: fc.subarray(poolIndexes),
});
