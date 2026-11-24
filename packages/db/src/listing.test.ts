import { describe, expect, expectTypeOf, it } from 'vitest';
import { anyOf, listingOf, type Listing } from './listing.ts';
import { mediaProcessingJobs, MEDIA_PROCESSING_JOBS_CAP } from './sec.ts';

describe('Listing (SCX-02)', () => {
  it('is complete only when the rows are fewer than the limit', () => {
    expect(listingOf([1, 2], 3)).toEqual({ complete: true, items: [1, 2] });
    expect(listingOf([], 1)).toEqual({ complete: true, items: [] });
  });

  it('is incomplete when the rows fill the limit: the list may have been cut off', () => {
    expect(listingOf([1, 2, 3], 3)).toEqual({ complete: false, sample: [1, 2, 3] });
  });

  it('has `items` only in the complete branch, so clean-up must narrow before it reads them', () => {
    const listing = listingOf([1], 5);
    // @ts-expect-error `items` does not exist until `complete` is checked.
    void listing.items;
    if (listing.complete) expectTypeOf(listing.items).toEqualTypeOf<readonly number[]>();
    else expectTypeOf(listing.sample).toEqualTypeOf<readonly number[]>();
    expectTypeOf<Listing<number>>().toEqualTypeOf<
      | { readonly complete: true; readonly items: readonly number[] }
      | { readonly complete: false; readonly sample: readonly number[] }
    >();
  });

  it('anyOf reads either branch', () => {
    expect(anyOf(listingOf([1], 5))).toEqual([1]);
    expect(anyOf(listingOf([1], 1))).toEqual([1]);
  });

  it('mediaProcessingJobs returns a Listing, capped where migration 0003 caps it', () => {
    expectTypeOf(mediaProcessingJobs).returns.resolves.toMatchTypeOf<{ complete: boolean }>();
    expect(MEDIA_PROCESSING_JOBS_CAP).toBe(5000);
  });
});
