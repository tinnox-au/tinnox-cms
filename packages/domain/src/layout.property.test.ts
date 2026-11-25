import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE,
  CanvasSchema,
  LAYOUT_UNITS,
  LayoutInputSchema,
  LayoutZoneInputSchema,
  ManifestV5Schema,
  RectSchema,
  contentRectProblem,
  type LayoutBox,
} from '@tinnox/contracts';
import { ID, display, planLayout, route, type FixturePlaylist } from './fixtures.test-support.ts';
import { schemaZonesArb, screenArb, storedZonesArb, type Screen } from './layout.test-support.ts';
import { buildManifest, type PlanPublicationResult } from './manifest.ts';

// Adoption plan section 4.4, property 5, and D11: every run draws a fresh seed, and a failure
// prints the seed and the shrunk counterexample. A counterexample is committed below as a plain
// example test with its fix, never as a seed or path.

const PLAYLISTS: Readonly<Record<string, FixturePlaylist>> = {
  [ID.listDefault]: {
    name: 'Reception loop',
    items: [{ mediaId: ID.jpeg, durationMs: 5000, fit: null }],
  },
  [ID.listBand]: { name: 'Ticker', items: [{ appId: ID.ticker, durationMs: 10_000 }] },
};
const PLAYLIST_IDS = [ID.listDefault, ID.listBand] as const;

function withPlaylists(zones: readonly LayoutBox[]) {
  return zones.map((zone, n) => ({ playlistId: PLAYLIST_IDS[n % 2] ?? ID.listDefault, ...zone }));
}

function planOn(screen: Screen, zones: readonly LayoutBox[]): PlanPublicationResult {
  return planLayout(PLAYLISTS, withPlaylists(zones), {
    route: route(200, ABSOLUTE.maxLayoutZones),
    display: display(screen),
  });
}

/** True when the plan is refused, or its draft builds a manifest that parses as version 5. */
function refusedOrBuilds(plan: PlanPublicationResult): boolean {
  if (!plan.ok) return plan.issues.length > 0;
  const manifest = buildManifest(plan.draft, {
    publicationId: ID.pubA,
    createdAt: new Date('2026-11-25T00:00:00.000Z'),
  });
  return ManifestV5Schema.safeParse(manifest).success;
}

describe('layout generators: self-checks', () => {
  it('screens parse with CanvasSchema and RectSchema, the content rectangle inside the canvas', () => {
    fc.assert(
      fc.property(screenArb, ({ canvas, contentRect }) => {
        expect(CanvasSchema.safeParse(canvas).success).toBe(true);
        if (contentRect !== null) {
          expect(RectSchema.safeParse(contentRect).success).toBe(true);
          expect(contentRectProblem(canvas, contentRect)).toBeNull();
        }
      }),
    );
  });

  it('schema-shaped zone sets parse with LayoutInputSchema', () => {
    fc.assert(
      fc.property(schemaZonesArb, (zones) => {
        const parsed = LayoutInputSchema.safeParse({ name: 'Layout', zones: withPlaylists(zones) });
        expect(parsed.error?.issues ?? []).toEqual([]);
      }),
    );
  });

  it('database-shaped zone sets are what layout_zone holds: at most four, each inside the square', () => {
    fc.assert(
      fc.property(storedZonesArb, (zones) => {
        expect(zones.length).toBeLessThanOrEqual(ABSOLUTE.maxLayoutZones);
        for (const zone of withPlaylists(zones)) {
          // The predicate of layout_zone_in_bounds (db/migrations/0011_stage_b_layouts.sql).
          expect(zone.x + zone.width).toBeLessThanOrEqual(LAYOUT_UNITS);
          expect(zone.y + zone.height).toBeLessThanOrEqual(LAYOUT_UNITS);
          expect(LayoutZoneInputSchema.safeParse(zone).success).toBe(true);
        }
      }),
    );
  });
});

describe('planLayoutPublication: counterexamples of property 5 (LYX-03)', () => {
  // Each threw before the fix: the first from planLayoutPublication itself ("a layout always has
  // a main zone"), the other two from buildManifest's self-check, which the API answered 500.
  const SCREEN: Screen = { canvas: { width: 16, height: 16 }, contentRect: null };

  it('LYX-03: a layout with no zones is refused, not thrown on (the shrunk counterexample)', () => {
    const plan = planOn(SCREEN, []);
    expect(plan).toEqual({
      ok: false,
      issues: [
        {
          index: null,
          code: 'zone_count_out_of_range',
          path: 'layout',
          message:
            'This layout has 0 zones; a layout needs 2 to 4. Open the layout and save it with 2 to 4 zones, or assign other content.',
        },
      ],
    });
  });

  it('LYX-03: a layout with one zone is refused', () => {
    const plan = planOn({ canvas: { width: 56, height: 33 }, contentRect: null }, [
      { x: 0, y: 0, width: 2779, height: 4716 },
    ]);
    expect(plan).toEqual({
      ok: false,
      issues: [
        {
          index: null,
          code: 'zone_count_out_of_range',
          path: 'layout',
          message:
            'This layout has 1 zone; a layout needs 2 to 4. Open the layout and save it with 2 to 4 zones, or assign other content.',
        },
      ],
    });
  });

  it('LYX-03: overlapping zones are refused at the later zone, on every screen', () => {
    const overlapping = [
      { x: 0, y: 0, width: 1796, height: 27 },
      { x: 0, y: 0, width: 19, height: 10 },
    ];
    const plan = planOn(
      { canvas: { width: 8564, height: 16_379 }, contentRect: null },
      overlapping,
    );
    expect(plan).toEqual({
      ok: false,
      issues: [
        {
          index: null,
          code: 'zone_overlap',
          path: 'zones[1]',
          message:
            'Zone 2 of the layout overlaps zone 1. Open the layout and save it again so that no zones overlap, or assign other content.',
        },
      ],
    });
    // Refused before the zones are sized: a screen on which they are too small says the same.
    expect(planOn(SCREEN, overlapping)).toEqual(plan);
  });

  it('LYX-03: five zones are refused, and each overlap is named with the zone it overlaps', () => {
    const half = { x: 0, y: 0, width: 5000, height: 10_000 };
    const other = { x: 5000, y: 0, width: 5000, height: 10_000 };
    const plan = planOn(SCREEN, [half, other, half, other, other]);
    expect(plan.ok).toBe(false);
    expect(plan.ok ? [] : plan.issues.map(({ path, message }) => [path, message])).toEqual([
      [
        'layout',
        'This layout has 5 zones; a layout needs 2 to 4. Open the layout and save it with 2 to 4 zones, or assign other content.',
      ],
      [
        'zones[2]',
        'Zone 3 of the layout overlaps zone 1. Open the layout and save it again so that no zones overlap, or assign other content.',
      ],
      [
        'zones[3]',
        'Zone 4 of the layout overlaps zone 2. Open the layout and save it again so that no zones overlap, or assign other content.',
      ],
      [
        'zones[4]',
        'Zone 5 of the layout overlaps zone 2. Open the layout and save it again so that no zones overlap, or assign other content.',
      ],
    ]);
  });

  it('zones that only touch are not an overlap', () => {
    const plan = planOn({ canvas: { width: 1920, height: 1080 }, contentRect: null }, [
      { x: 0, y: 0, width: 5000, height: 10_000 },
      { x: 5000, y: 0, width: 5000, height: 10_000 },
    ]);
    expect(plan.ok).toBe(true);
  });
});

describe('planLayoutPublication: properties', () => {
  it('LYX-03: any zone set the database can hold is refused with issues or builds a version 5 manifest', () => {
    fc.assert(
      fc.property(screenArb, storedZonesArb, (screen, zones) =>
        refusedOrBuilds(planOn(screen, zones)),
      ),
    );
  });

  it('a zone set the schema accepts is refused only for a zone too small on that screen', () => {
    fc.assert(
      fc.property(screenArb, schemaZonesArb, (screen, zones) => {
        const plan = planOn(screen, zones);
        if (!plan.ok) {
          expect(plan.issues.map((issue) => issue.code)).toEqual(
            plan.issues.map(() => 'zone_too_small'),
          );
        }
        expect(refusedOrBuilds(plan)).toBe(true);
      }),
    );
  });
});
