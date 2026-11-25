// fast-check generators for signed media URLs (adoption plan section 4.4, property 10).
//
// Choosing a generator: the claims are drawn as the media route can parse them from a URL
// (MediaUrlQuerySchema and the asset id parameter: UUIDs in either letter case, an expiry of 10
// to 12 digits), so security.property.test.ts checks that each URL built from them parses. A
// counterexample whose input fails that self-check is a generator bug, not a product bug.
import fc from 'fast-check';
import type { MediaUrlClaims } from './security.ts';

/** A UUID in lower, upper or mixed case. */
export const uuidArb: fc.Arbitrary<string> = fc
  .tuple(fc.uuid(), fc.array(fc.boolean(), { minLength: 36, maxLength: 36 }))
  .map(([id, upper]) =>
    [...id].map((char, n) => (upper[n] === true ? char.toUpperCase() : char)).join(''),
  );

/** Unix seconds of 10 to 12 digits, as `exp` must be. */
export const expiryArb: fc.Arbitrary<number> = fc.integer({ min: 1e9, max: 1e12 - 1 });

/**
 * A `now` for an expiry: any time half of the cases, otherwise the expiry itself or one second
 * either side, where `<` and `<=` differ; an independent draw almost never lands there.
 */
export const nowNearArb = (expiresAtSeconds: number): fc.Arbitrary<number> =>
  fc.oneof(
    expiryArb,
    fc.integer({ min: -1, max: 1 }).map((offset) => expiresAtSeconds + offset),
  );

export const claimsArb: fc.Arbitrary<MediaUrlClaims> = fc.record({
  registrationId: uuidArb,
  publicationId: uuidArb,
  assetId: uuidArb,
  expiresAtSeconds: expiryArb,
});

/** A secret of the length config requires or more. */
export const secretArb: fc.Arbitrary<string> = fc.string({ minLength: 32, maxLength: 96 });

/** A signature of the shape MediaUrlQuerySchema accepts. */
export const signatureArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
  ),
  minLength: 43,
  maxLength: 43,
});
