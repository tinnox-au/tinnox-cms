import fc from 'fast-check';
import { ManifestSchema, type Manifest, type PlayerError } from '@tinnox/contracts';
import { describe, expect, it } from 'vitest';
import {
  API_ORIGIN,
  digestBlob,
  DISPLAY_ID,
  EVERY_DAY,
  FakeDeviceApi,
  instantSleep,
  makeAppItem,
  makeAsset,
  makeManifest,
  makeManifestV2,
  makeManifestV3,
  makeManifestV4,
  makeManifestV5,
  MemoryAssetStore,
  MemoryStateStore,
  REGISTRATION_ID,
} from './fakes.test-support.ts';
import { POOL_SIZE, restoreCaseArb, type RestoreCase } from './sync.test-support.ts';
import { syncCycle } from './sync.ts';

// Adoption plan section 4.4, property 14 (FCX-02), and D11: every run draws a fresh seed, and a
// failure prints the seed and the shrunk counterexample. A counterexample is committed below as
// a plain example test with its fix, never as a seed or path.

// Distinct bytes, so distinct SHA-256 digests: one file each in the asset store.
const POOL = await Promise.all(Array.from({ length: POOL_SIZE }, (_, n) => makeAsset(n + 1)));

function manifestOf(c: RestoreCase): Manifest {
  const media = c.picks.map((n) => {
    const entry = POOL[n];
    if (entry === undefined) throw new Error('unreachable');
    return entry.asset;
  });
  const items = c.withApp ? [...media, makeAppItem()] : media;
  const [head, ...tail] = items;
  if (head === undefined) throw new Error('unreachable');
  switch (c.version) {
    case 1:
      return makeManifest(media);
    case 2:
      return makeManifestV2(media);
    case 3:
      return makeManifestV3(items);
    case 4:
      return makeManifestV4(
        [{ items: [head] }, { items: tail }],
        [{ playlist: 1, days: EVERY_DAY, start: '09:00', end: '17:00' }],
      );
    case 5:
      return makeManifestV5([
        { items: [head], rect: { x: 0, y: 0, width: 960, height: 1080 } },
        { items: tail, rect: { x: 960, y: 0, width: 960, height: 1080 } },
      ]);
  }
}

describe('restore generators: self-checks', () => {
  it('manifests parse with ManifestSchema', () => {
    fc.assert(
      fc.property(restoreCaseArb, (c) => {
        expect(ManifestSchema.safeParse(manifestOf(c)).error?.issues ?? []).toEqual([]);
      }),
    );
  });
});

describe('syncCycle: properties (property 14, FCX-02)', () => {
  it('the player restores its active publication for any schemaVersion and any evicted subset', async () => {
    await fc.assert(
      fc.asyncProperty(restoreCaseArb, async (c) => {
        const manifest = manifestOf(c);
        const state = new MemoryStateStore();
        const assets = new MemoryAssetStore();
        const api = new FakeDeviceApi();
        const reported: PlayerError[] = [];
        for (const entry of POOL) api.serve(entry);
        POOL.forEach((entry, n) => {
          if (!c.evicted.includes(n)) assets.seed(entry);
        });
        state.active = { manifest, activatedAt: '2026-11-14T02:00:00.000Z' };
        // The server still wants the active publication.
        api.manifestResults = [{ kind: 'manifest', raw: manifest }];

        const result = await syncCycle({
          registrationId: REGISTRATION_ID,
          displayId: DISPLAY_ID,
          apiOrigin: API_ORIGIN,
          state,
          assets,
          api,
          digest: digestBlob,
          probe: async () => undefined,
          inUse: () => new Set(),
          clock: { now: () => Date.parse('2026-11-14T03:00:00.000Z') },
          sleep: instantSleep(),
          random: () => 0.5,
          signal: new AbortController().signal,
          report: (e) => reported.push(e),
        });

        const missing = c.picks.some((n) => c.evicted.includes(n));
        expect(result).toEqual(
          missing
            ? { kind: 'activated', publicationId: manifest.publicationId }
            : { kind: 'up_to_date' },
        );
        // Asked without If-None-Match exactly when a file is missing, so a 304 cannot hide it.
        expect(api.calls.fetchManifest[0]).toBe(missing ? null : manifest.publicationId);
        for (const n of c.picks) {
          const entry = POOL[n];
          if (entry === undefined) throw new Error('unreachable');
          expect(await assets.has(entry.asset.sha256, entry.asset.bytes)).toBe(true);
        }
        expect(state.active.manifest).toEqual(manifest);
        expect(reported).toEqual([]);
      }),
    );
  });
});
