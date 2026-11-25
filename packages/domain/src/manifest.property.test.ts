import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE,
  LAYOUT_UNITS,
  ManifestSchema,
  ROTATIONS,
  type LayoutBox,
  type Manifest,
  type WorkingHours,
} from '@tinnox/contracts';
import { knownZoneArb, workingHoursArb } from './delivery-state.test-support.ts';
import {
  EVERY_DAY,
  ID,
  clockContent,
  display,
  planLayout,
  planSchedule,
  route,
} from './fixtures.test-support.ts';
import { schemaZonesArb, screenArb, type Screen } from './layout.test-support.ts';
import { buildManifest, manifestVersionFor, type PlanPublicationResult } from './manifest.ts';
import {
  draftMatchesManifest,
  type ComparedItemField,
  type DraftManifestDifference,
  type PlaybackField,
} from './push.ts';
import {
  PLAYLIST_IDS,
  libraryWith,
  playlistArb,
  scheduleCaseArb,
  windowArb,
} from './schedule.test-support.ts';
import type { PublicationDraft } from './types.ts';

// Adoption plan section 4.4, properties 7 and 8, and D11: every run draws a fresh seed, and a
// failure prints the seed and the shrunk counterexample. A counterexample is committed below as
// a plain example test with its fix, never as a seed or path.

const IDENTITY = { publicationId: ID.pubA, createdAt: new Date('2026-11-25T00:00:00.000Z') };
const WEEK: WorkingHours = [1, 2, 3, 4, 5, 6, 7].map(() => ({ start: '08:00', end: '18:00' }));

/** A version 1 draft of two images, from the planner, to switch features on in. */
function baseDraft(): PublicationDraft {
  const plan = planSchedule(
    {
      [ID.listDefault]: {
        name: 'Two images',
        items: [
          { mediaId: ID.jpeg, durationMs: 5000, fit: null },
          { mediaId: ID.png, durationMs: 5000, fit: null },
        ],
      },
    },
    { defaultPlaylistId: ID.listDefault, events: [] },
  );
  if (!plan.ok) throw new Error('the base draft must plan');
  return plan.draft;
}

const FEATURES = [
  'window',
  'app',
  'fade',
  'shuffle',
  'rotation',
  'hours',
  'schedule',
  'zones',
] as const;
type Feature = (typeof FEATURES)[number];

/** The version each feature needs on its own (the docstring of manifestVersionFor). */
const VERSION_OF: Readonly<Record<Feature, 1 | 2 | 3 | 4 | 5>> = {
  window: 2,
  fade: 2,
  shuffle: 2,
  rotation: 2,
  hours: 2,
  app: 3,
  schedule: 4,
  zones: 5,
};

function draftWith(on: ReadonlySet<Feature>): PublicationDraft {
  const base = baseDraft();
  const [first, ...rest] = base.items;
  if (first === undefined || first.kind === 'app') throw new Error('unreachable');
  const items = [
    on.has('window') ? { ...first, availableFrom: '2030-01-01T00:00' } : first,
    ...rest,
    ...(on.has('app')
      ? [{ kind: 'app' as const, appId: ID.clock, durationMs: 5000, content: clockContent }]
      : []),
  ];
  const transition = on.has('fade') ? ('fade' as const) : ('cut' as const);
  const shuffle = on.has('shuffle');
  const head = { count: 1, transition, shuffle };
  const tail = { count: items.length - 1, transition: 'cut' as const, shuffle: false };
  return {
    ...base,
    items,
    transition,
    shuffle,
    rotation: on.has('rotation') ? 90 : 0,
    workingHours: on.has('hours') ? WEEK : null,
    schedule: on.has('schedule')
      ? {
          playlists: [head, tail],
          events: [{ playlist: 1, days: EVERY_DAY, start: '09:00', end: '17:00' }],
        }
      : null,
    zones: on.has('zones')
      ? [
          { ...head, rect: { x: 0, y: 0, width: 960, height: 1080 } },
          { ...tail, rect: { x: 960, y: 0, width: 960, height: 1080 } },
        ]
      : null,
  };
}

describe('manifestVersionFor: the whole feature lattice (property 7, exhaustive)', () => {
  // 2^8 combinations, no randomness: a finite lattice is checked whole.
  const combinations = Array.from({ length: 2 ** FEATURES.length }, (_, mask) =>
    FEATURES.filter((_, bit) => (mask & (1 << bit)) !== 0),
  );

  it('the version chosen is the largest any switched-on feature needs, and the build carries it', () => {
    for (const features of combinations) {
      const draft = draftWith(new Set(features));
      const expected = Math.max(1, ...features.map((f) => VERSION_OF[f]));
      expect({ features, version: manifestVersionFor(draft) }).toEqual({
        features,
        version: expected,
      });
      if (features.includes('schedule') && features.includes('zones')) {
        // Never built: a draft has a schedule or zones, not both.
        expect(() => buildManifest(draft, IDENTITY)).toThrow('a draft has a schedule or zones');
      } else {
        const manifest = buildManifest(draft, IDENTITY);
        expect(manifest.schemaVersion).toBe(expected);
        expect(ManifestSchema.safeParse(manifest).success).toBe(true);
      }
    }
  });
});

const MIN_SIDE = ABSOLUTE.minCanvasSidePx;
const MAX_SIDE = ABSOLUTE.maxCanvasSidePx;

/**
 * A screen on which every zone resolves to at least 16 px each way, so the layout half of
 * property 8 is not mostly refused plans (with any screen only about 13% planned). A content
 * area of 17 x 10 000 / (the thinnest zone's units) px is enough: zoneRect rounds each edge, so a
 * zone loses at most 1 px. A zone set too thin for even the largest canvas keeps any screen and
 * is refused by the planner.
 */
const fittingScreenArb = (zones: readonly LayoutBox[]): fc.Arbitrary<Screen> => {
  const least = (units: number) =>
    Math.max(MIN_SIDE, Math.ceil(((MIN_SIDE + 1) * LAYOUT_UNITS) / units));
  const width = least(Math.min(...zones.map((z) => z.width)));
  const height = least(Math.min(...zones.map((z) => z.height)));
  if (width > MAX_SIDE || height > MAX_SIDE) return screenArb;
  return fc
    .record({
      area: fc.record({
        width: fc.integer({ min: width, max: MAX_SIDE }),
        height: fc.integer({ min: height, max: MAX_SIDE }),
      }),
      margin: fc.record({ x: fc.nat(), y: fc.nat(), right: fc.nat(), bottom: fc.nat() }),
      framed: fc.boolean(),
    })
    .map(({ area, margin, framed }) => {
      if (!framed) return { canvas: area, contentRect: null };
      // The content area sits inside a canvas at most MAX_SIDE each way.
      const x = margin.x % (MAX_SIDE - area.width + 1);
      const y = margin.y % (MAX_SIDE - area.height + 1);
      const canvas = {
        width: area.width + x + (margin.right % (MAX_SIDE - area.width - x + 1)),
        height: area.height + y + (margin.bottom % (MAX_SIDE - area.height - y + 1)),
      };
      return { canvas, contentRect: { x, y, ...area } };
    });
};

/** Drafts from layout plans: 2 to 4 schema-shaped zones over ready playlists, on a screen they fit. */
const layoutPlanArb: fc.Arbitrary<PlanPublicationResult> = schemaZonesArb
  .chain((zones) =>
    fc.record({
      screen: fittingScreenArb(zones),
      zones: fc.constant(zones),
      playlists: fc.array(playlistArb(true), { minLength: 4, maxLength: 4 }),
      workingHours: fc.oneof(fc.constant(null), workingHoursArb),
      rotation: fc.constantFrom(...ROTATIONS),
      timeZone: knownZoneArb,
      window: windowArb,
    }),
  )
  .map(({ screen, zones, playlists, workingHours, rotation, timeZone, window }) =>
    planLayout(
      Object.fromEntries(playlists.map((p, n) => [PLAYLIST_IDS[n] ?? '', p])),
      zones.map((zone, n) => ({ playlistId: PLAYLIST_IDS[n] ?? '', ...zone })),
      {
        display: display({ ...screen, workingHours, rotation, timeZone }),
        // The ready playlists may name the windowed image, which only this library holds.
        mediaById: libraryWith(window),
      },
    ),
  );

/** Drafts from schedule plans of ready playlists, in zones this runtime knows. */
const schedulePlanArb: fc.Arbitrary<PlanPublicationResult> = scheduleCaseArb(
  true,
  knownZoneArb,
).map((c) =>
  planSchedule(c.playlists, c.schedule, {
    display: c.display,
    mediaById: c.mediaById,
    route: route(c.maxItems),
  }),
);

type Asset = Manifest['assets'][number];
type MediaAsset = Extract<Asset, { assetId: string }>;
type AppAsset = Extract<Asset, { kind: 'app' }>;
type Zone = Extract<Manifest, { schemaVersion: 5 }>['zones'][number];
/** Every way to make one change of a kind to `m`, or none where the kind does not apply. */
type Variants = (m: Manifest) => readonly Manifest[];

const OTHER_SHA = 'f'.repeat(64);

/** `list` once per entry, with that entry changed, where `change` applies to it. */
function eachEntry<T>(list: readonly T[], change: (entry: T) => T | null): T[][] {
  return list.flatMap((entry, n) => {
    const changed = change(entry);
    return changed === null ? [] : [list.map((other, k) => (k === n ? changed : other))];
  });
}

/** `m` once per asset `change` applies to, with that asset changed. */
const eachAsset =
  (change: (asset: Asset) => Asset | null): Variants =>
  (m) =>
    eachEntry<Asset>(m.assets, change).map((assets) => ({ ...m, assets }) as Manifest);
const eachMedia = (change: (asset: MediaAsset) => Asset | null): Variants =>
  eachAsset((a) => (a.kind === 'app' ? null : change(a)));
const eachApp = (change: (asset: AppAsset) => Asset | null): Variants =>
  eachAsset((a) => (a.kind === 'app' ? change(a) : null));

const otherTransition = (t: 'cut' | 'fade') => (t === 'cut' ? ('fade' as const) : ('cut' as const));
const otherEnd = (end: string) => (end === '24:00' ? '23:59' : '24:00');
const MEDIA_STAND_IN = {
  assetId: ID.jpeg,
  mediaType: 'image/jpeg',
  kind: 'image',
  bytes: 1,
  sha256: OTHER_SHA,
  fit: 'contain',
  width: 16,
  height: 16,
  availableFrom: null,
  availableUntil: null,
} as const;

/**
 * Every field firstDraftManifestDifference (push.ts) reads, each with every change a player would
 * act on. The keys are typed by push.ts's own DraftManifestDifference kinds, PlaybackField and
 * ComparedItemField, so a field added to those unions does not compile until it has a mutation
 * here; a field the function starts reading inside an existing one (a new key of the schedule, a
 * zone or a rectangle) needs a variant added by hand under that key.
 */
const MUTATIONS: Readonly<
  Record<
    | Exclude<DraftManifestDifference['kind'], 'playback' | 'item'>
    | PlaybackField
    | ComparedItemField,
    Variants
  >
> = {
  display: (m) => [{ ...m, displayId: ID.otherDisplay }],
  canvas: (m) => [
    { ...m, canvas: { ...m.canvas, width: m.canvas.width + 1 } },
    { ...m, canvas: { ...m.canvas, height: m.canvas.height + 1 } },
  ],
  content_rect: (m) => {
    const r = m.contentRect;
    if (r === null) return [{ ...m, contentRect: { x: 1, y: 1, width: 16, height: 16 } }];
    return [
      { ...m, contentRect: null },
      { ...m, contentRect: { ...r, x: r.x + 1 } },
      { ...m, contentRect: { ...r, y: r.y + 1 } },
      { ...m, contentRect: { ...r, width: r.width + 1 } },
      { ...m, contentRect: { ...r, height: r.height + 1 } },
    ];
  },
  item_count: (m) => (m.assets.length < 2 ? [] : [{ ...m, assets: m.assets.slice(1) } as Manifest]),
  schemaVersion: (m) => [{ ...m, schemaVersion: m.schemaVersion === 1 ? 2 : 1 } as Manifest],
  transition: (m) =>
    m.schemaVersion === 1 ? [] : [{ ...m, transition: otherTransition(m.transition) }],
  shuffle: (m) => (m.schemaVersion === 1 ? [] : [{ ...m, shuffle: !m.shuffle }]),
  rotation: (m) =>
    m.schemaVersion === 1
      ? []
      : [
          {
            ...m,
            rotation: ROTATIONS[(ROTATIONS.indexOf(m.rotation) + 1) % ROTATIONS.length] ?? 0,
          },
        ],
  workingHours: (m) => {
    if (m.schemaVersion === 1) return [];
    if (m.workingHours === null) return [{ ...m, workingHours: WEEK }];
    return [
      { ...m, workingHours: null },
      ...eachEntry(m.workingHours, (day) =>
        day === null ? { start: '00:00', end: '24:00' } : { ...day, end: otherEnd(day.end) },
      ).map((workingHours) => ({ ...m, workingHours })),
    ];
  },
  timeZone: (m) =>
    m.schemaVersion === 1
      ? []
      : [{ ...m, timeZone: m.timeZone === 'UTC' ? 'Australia/Perth' : 'UTC' }],
  schedule: (m) => {
    if (m.schemaVersion !== 4) return [];
    const withPlaylists = (playlists: typeof m.schedule.playlists) => ({
      ...m,
      schedule: { ...m.schedule, playlists },
    });
    const withEvents = (events: typeof m.schedule.events) => ({
      ...m,
      schedule: { ...m.schedule, events },
    });
    const { playlists, events } = m.schedule;
    return [
      ...eachEntry(playlists, (p) => ({ ...p, count: p.count + 1 })).map(withPlaylists),
      ...eachEntry(playlists, (p) => ({ ...p, transition: otherTransition(p.transition) })).map(
        withPlaylists,
      ),
      ...eachEntry(playlists, (p) => ({ ...p, shuffle: !p.shuffle })).map(withPlaylists),
      ...eachEntry(events, (e) => ({ ...e, playlist: e.playlist + 1 })).map(withEvents),
      ...[0, 1, 2, 3, 4, 5, 6].flatMap((d) =>
        eachEntry(events, (e) => ({ ...e, days: e.days.map((on, k) => (k === d ? !on : on)) })).map(
          withEvents,
        ),
      ),
      ...eachEntry(events, (e) => ({ ...e, start: e.start === '00:00' ? '00:01' : '00:00' })).map(
        withEvents,
      ),
      ...eachEntry(events, (e) => ({ ...e, end: otherEnd(e.end) })).map(withEvents),
    ];
  },
  zones: (m) => {
    if (m.schemaVersion !== 5) return [];
    const changes: ((z: Zone) => Zone)[] = [
      (z) => ({ ...z, rect: { ...z.rect, x: z.rect.x + 1 } }),
      (z) => ({ ...z, rect: { ...z.rect, y: z.rect.y + 1 } }),
      (z) => ({ ...z, rect: { ...z.rect, width: z.rect.width + 1 } }),
      (z) => ({ ...z, rect: { ...z.rect, height: z.rect.height + 1 } }),
      (z) => ({ ...z, count: z.count + 1 }),
      (z) => ({ ...z, transition: otherTransition(z.transition) }),
      (z) => ({ ...z, shuffle: !z.shuffle }),
    ];
    return changes.flatMap((change) =>
      eachEntry<Zone>(m.zones, change).map((zones) => ({ ...m, zones })),
    );
  },
  assetId: eachMedia((a) => ({
    ...a,
    assetId: a.assetId === ID.processing ? ID.failed : ID.processing,
  })),
  sha256: eachMedia((a) => ({ ...a, sha256: a.sha256 === OTHER_SHA ? 'e'.repeat(64) : OTHER_SHA })),
  bytes: eachMedia((a) => ({ ...a, bytes: a.bytes + 1 })),
  mediaType: eachMedia((a) => ({
    ...a,
    mediaType: a.mediaType === 'image/png' ? 'image/jpeg' : 'image/png',
  })),
  // Media to app and back, and an image to a video and back.
  kind: (m) => [
    ...eachAsset((a) =>
      a.kind === 'app'
        ? { ...MEDIA_STAND_IN, durationMs: a.durationMs }
        : { kind: 'app', appId: ID.clock, durationMs: a.durationMs ?? 5000, content: clockContent },
    )(m),
    ...eachMedia((a) => ({ ...a, kind: a.kind === 'image' ? 'video' : 'image' }))(m),
  ],
  durationMs: (m) => [
    ...eachMedia((a) => ({ ...a, durationMs: (a.durationMs ?? 0) + 1 }))(m),
    ...eachApp((a) => ({ ...a, durationMs: a.durationMs + 1 }))(m),
  ],
  fit: eachMedia((a) => ({ ...a, fit: a.fit === 'contain' ? 'cover' : 'contain' })),
  width: eachMedia((a) => ({ ...a, width: a.width + 1 })),
  height: eachMedia((a) => ({ ...a, height: a.height + 1 })),
  availableFrom: eachMedia((a) =>
    'availableFrom' in a
      ? { ...a, availableFrom: a.availableFrom === null ? '2030-01-01T00:00' : null }
      : null,
  ),
  availableUntil: eachMedia((a) =>
    'availableUntil' in a
      ? { ...a, availableUntil: a.availableUntil === null ? '2030-01-01T00:00' : null }
      : null,
  ),
  appId: eachApp((a) => ({ ...a, appId: a.appId === ID.ticker ? ID.clock : ID.ticker })),
  // One setting changed, and one setting added.
  content: (m) => [
    ...eachApp((a) => {
      const settings: Record<string, unknown> = a.content.settings;
      const [key] = Object.keys(settings);
      if (key === undefined) return null;
      const value = settings[key];
      const other = typeof value === 'boolean' ? !value : `${String(value)}x`;
      return { ...a, content: { ...a.content, settings: { ...settings, [key]: other } } } as Asset;
    })(m),
    ...eachApp(
      (a) =>
        ({
          ...a,
          content: { ...a.content, settings: { ...a.content.settings, extra: 'x' } },
        }) as unknown as Asset,
    )(m),
  ],
};

describe('draftMatchesManifest: generators (property 8)', () => {
  it('layout plans mostly plan, so fc.pre discards few cases', () => {
    // Measured over 3000 draws: about 97% of layout plans succeed and schedule plans always do,
    // so property 8 discards about 2% of its cases (it was about 44%). The rest are zone sets
    // too thin for any canvas, which the planner refuses.
    const plans = fc.sample(layoutPlanArb, 500);
    expect(plans.filter((plan) => plan.ok).length / plans.length).toBeGreaterThan(0.85);
  });
});

describe('draftMatchesManifest: properties (property 8)', () => {
  it('a draft matches its manifest after a JSON round trip, and stops matching after every player-visible change', () => {
    fc.assert(
      fc.property(fc.oneof(schedulePlanArb, layoutPlanArb), (plan) => {
        // A refused plan has no draft to compare: a zone set too thin for any screen.
        fc.pre(plan.ok);
        if (!plan.ok) return;
        const stored = ManifestSchema.parse(
          JSON.parse(JSON.stringify(buildManifest(plan.draft, IDENTITY))),
        );
        expect(draftMatchesManifest(plan.draft, stored)).toBe(true);
        // Every applicable mutation, each at every place it applies: one random one a case
        // leaves a dropped comparison found only by chance.
        const stillMatching = Object.entries(MUTATIONS).flatMap(([name, variants]) =>
          variants(stored).flatMap((changed, n) =>
            draftMatchesManifest(plan.draft, changed) ? [`${name} #${n}`] : [],
          ),
        );
        expect(stillMatching).toEqual([]);
      }),
    );
  });
});
