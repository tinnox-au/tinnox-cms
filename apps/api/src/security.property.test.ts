import fc from 'fast-check';
import { MediaIdSchema, MediaUrlQuerySchema } from '@tinnox/contracts';
import { describe, expect, it } from 'vitest';
import {
  claimsArb,
  expiryArb,
  nowNearArb,
  secretArb,
  signatureArb,
  uuidArb,
} from './security.test-support.ts';
import { buildMediaUrl, signMediaUrl, verifyMediaUrl, type MediaUrlClaims } from './security.ts';

// Adoption plan section 4.4, property 10, and D11: every run draws a fresh seed, and a failure
// prints the seed and the shrunk counterexample. A counterexample is committed below as a plain
// example test with its fix, never as a seed or path.

const CLAIM_FIELDS = ['registrationId', 'publicationId', 'assetId', 'expiresAtSeconds'] as const;

/** `claims` with one field replaced by a different value of its kind (letter case counts). */
function changed(
  claims: MediaUrlClaims,
  field: (typeof CLAIM_FIELDS)[number],
  id: string,
  expiry: number,
  recase: boolean,
): MediaUrlClaims {
  if (field === 'expiresAtSeconds') {
    const step = expiry < 1e12 - 1 ? 1 : -1;
    return { ...claims, expiresAtSeconds: expiry === claims[field] ? expiry + step : expiry };
  }
  const own = claims[field];
  // The same id in another letter case is another claim too (`reg` is not lower-cased).
  const recased = [...own]
    .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    .join('');
  if (recase && recased !== own) return { ...claims, [field]: recased };
  // A drawn id equal to the old one gets another last digit.
  const other = id === own ? `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}` : id;
  return { ...claims, [field]: other };
}

describe('signed media URL generators: self-checks', () => {
  it('a URL built from the claims parses with MediaUrlQuerySchema and the asset parameter', () => {
    fc.assert(
      fc.property(secretArb, claimsArb, (secret, claims) => {
        const url = new URL(buildMediaUrl('https://api.signage.example', secret, claims));
        const query = MediaUrlQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        expect(query.error?.issues ?? []).toEqual([]);
        expect(MediaIdSchema.safeParse(claims.assetId).success).toBe(true);
      }),
    );
  });

  it('signatures have the shape MediaUrlQuerySchema accepts', () => {
    fc.assert(
      fc.property(signatureArb, (sig) => {
        expect(/^[A-Za-z0-9_-]{43}$/.test(sig)).toBe(true);
      }),
    );
  });
});

describe('verifyMediaUrl: properties (property 10)', () => {
  it('the claims it was signed for verify until they expire', () => {
    fc.assert(
      fc.property(
        secretArb,
        claimsArb.chain((claims) =>
          fc.tuple(fc.constant(claims), nowNearArb(claims.expiresAtSeconds)),
        ),
        (secret, [claims, now]) => {
          expect(verifyMediaUrl(secret, claims, signMediaUrl(secret, claims), now)).toBe(
            now < claims.expiresAtSeconds ? 'ok' : 'expired',
          );
        },
      ),
    );
  });

  it('any one changed claim fails verification, whatever the time', () => {
    fc.assert(
      fc.property(
        secretArb,
        claimsArb,
        fc.constantFrom(...CLAIM_FIELDS),
        uuidArb,
        expiryArb,
        fc.boolean(),
        expiryArb,
        (secret, claims, field, id, expiry, recase, now) => {
          const signature = signMediaUrl(secret, claims);
          expect(
            verifyMediaUrl(secret, changed(claims, field, id, expiry, recase), signature, now),
          ).toBe('bad_signature');
        },
      ),
    );
  });

  it('another signature or another secret fails verification', () => {
    fc.assert(
      fc.property(
        secretArb,
        secretArb,
        claimsArb,
        signatureArb,
        expiryArb,
        (secret, other, claims, forged, now) => {
          const signature = signMediaUrl(secret, claims);
          if (forged !== signature)
            expect(verifyMediaUrl(secret, claims, forged, now)).toBe('bad_signature');
          if (other !== secret) {
            expect(verifyMediaUrl(other, claims, signature, now)).toBe('bad_signature');
          }
        },
      ),
    );
  });
});
