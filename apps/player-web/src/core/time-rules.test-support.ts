// fast-check generators for the player's time rules (adoption plan section 4.4, property 2).
//
// Choosing a generator: the constraints that matter sit in superRefine checks
// (checkManifestV4Body: playlist counts add up to the assets, events name a playlist that exists,
// the first playlist carries the top-level transition and shuffle; checkScheduleRule;
// DayHoursSchema; window order), so the generator builds its manifests to meet them by
// construction, at any minute, and time-rules.property.test.ts checks that each one parses with
// ManifestV4Schema. A counterexample whose input fails that self-check is a generator bug, not a
// product bug: fix the generator first.
//
// Zones are every IANA zone this runtime supports, plus names it refuses (a site row holds any
// name of 1 to 64 characters, 0001). Instants run from 2026 to 2035; createdAt is drawn up to an
// hour after the instant (a clock behind the publication) and up to a year before it.
//
// Edges: a random bound almost never lands on the instant itself, so a `<` written as `<=` would
// pass. The instant is drawn first, and about half of the window bounds, working-hour edges and
// event edges are its own local minute plus or minus 0 or 1 minute; createdAt is sometimes drawn
// at the five-minute trust limit to the millisecond.
import fc from 'fast-check';
import type { ManifestItemV3, ManifestV4, WorkingHours } from '@tinnox/contracts';
import { DISPLAY_ID } from './fakes.test-support.ts';

const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60_000;

/** Minutes since midnight (0 to 1440) as 'HH:mm'; 1440 is '24:00'. */
export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export const KNOWN_ZONES: readonly string[] = Intl.supportedValuesOf('timeZone');
export const UNKNOWN_ZONES: readonly string[] = ['Mars/Olympus_Mons', 'Not/A_Zone'];

/** Instants from 2026 to 2035, at any millisecond. */
export const instantArb: fc.Arbitrary<number> = fc.integer({
  min: Date.UTC(2026, 0, 1),
  max: Date.UTC(2036, 0, 1) - 1,
});

/** The instant's local wall clock: its stamp as a minute count (read as UTC) and minute of day. */
interface Near {
  readonly stampMinute: number;
  readonly minute: number;
}

const nearFormatters = new Map<string, Intl.DateTimeFormat | null>();

/** The generator's own reading of the wall clock (not localWallClock), or null for an unknown zone. */
function nearOf(epochMs: number, zone: string): Near | null {
  if (!nearFormatters.has(zone)) {
    try {
      nearFormatters.set(
        zone,
        new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      );
    } catch {
      nearFormatters.set(zone, null);
    }
  }
  const formatter = nearFormatters.get(zone);
  if (formatter === null || formatter === undefined) return null;
  const p = Object.fromEntries(formatter.formatToParts(epochMs).map((x) => [x.type, x.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return {
    stampMinute: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / MINUTE_MS + minute,
    minute,
  };
}

/** A minute in [min, max]: any, or (with a near minute) that minute plus or minus 0 or 1. */
function minuteArb(near: number | null, min: number, max: number): fc.Arbitrary<number> {
  const any = fc.integer({ min, max });
  if (near === null) return any;
  return fc.oneof(
    any,
    fc.integer({ min: -1, max: 1 }).map((d) => Math.min(max, Math.max(min, near + d))),
  );
}

const daysArb = fc
  .tuple(fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }), fc.nat({ max: 6 }))
  .map(([days, forced]) => days.map((day, n) => day || (n === forced && !days.some(Boolean))));

/** A rule the manifest accepts, at any minute; an end drawn equal to the start moves on. */
const ruleArb = (near: Near | null) =>
  fc
    .record({
      days: daysArb,
      start: minuteArb(near?.minute ?? null, 0, MINUTES_PER_DAY - 1),
      end: minuteArb(near?.minute ?? null, 1, MINUTES_PER_DAY),
    })
    .map(({ days, start, end }) => ({
      days,
      start: hhmm(start),
      end: hhmm(end === start ? end + 1 : end),
    }));

/** One open day, start before end; two equal minutes move the end on (or the start back). */
const dayHoursArb = (near: Near | null) =>
  fc
    .tuple(
      minuteArb(near?.minute ?? null, 0, MINUTES_PER_DAY),
      minuteArb(near?.minute ?? null, 0, MINUTES_PER_DAY),
    )
    .map(([a, b]) => {
      const [start, end] = a <= b ? [a, b] : [b, a];
      if (start < end) return { start: hhmm(start), end: hhmm(end) };
      return start === MINUTES_PER_DAY
        ? { start: hhmm(start - 1), end: hhmm(end) }
        : { start: hhmm(start), end: hhmm(end + 1) };
    });

/** Working hours WorkingHoursSchema accepts: seven days, at least one open, any minute. */
export const workingHoursArb = (near: Near | null = null): fc.Arbitrary<WorkingHours> =>
  fc
    .tuple(
      fc.array(fc.option(dayHoursArb(near), { nil: null }), { minLength: 7, maxLength: 7 }),
      fc.nat({ max: 6 }),
      dayHoursArb(near),
    )
    .map(([days, forced, open]) =>
      days.some((day) => day !== null) ? days : days.map((day, n) => (n === forced ? open : day)),
    );

/** A window bound near the instants drawn (2025 to 2036), at any minute, or at the instant. */
const boundArb = (near: Near | null) =>
  minuteArb(
    near?.stampMinute ?? null,
    Date.UTC(2025, 0, 1) / MINUTE_MS,
    Date.UTC(2037, 0, 1) / MINUTE_MS,
  ).map((minute) => new Date(minute * MINUTE_MS).toISOString().slice(0, 16));

const windowArb = (near: Near | null) =>
  fc
    .tuple(fc.option(boundArb(near), { nil: null }), fc.option(boundArb(near), { nil: null }))
    .map(([a, b]) => {
      if (a !== null && b !== null && a === b) return { availableFrom: a, availableUntil: null };
      const [from, until] = a !== null && b !== null && a > b ? [b, a] : [a, b];
      return { availableFrom: from, availableUntil: until };
    });

const itemArb = (near: Near | null): fc.Arbitrary<ManifestItemV3> =>
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc.tuple(fc.uuid({ version: 4 }), windowArb(near)).map(([assetId, window]) => ({
        assetId,
        mediaType: 'image/png' as const,
        kind: 'image' as const,
        bytes: 64,
        sha256: 'a'.repeat(64),
        durationMs: 5_000,
        fit: 'contain' as const,
        width: 640,
        height: 360,
        ...window,
      })),
    },
    {
      weight: 1,
      arbitrary: fc.uuid({ version: 4 }).map((appId) => ({
        kind: 'app' as const,
        appId,
        durationMs: 10_000,
        content: {
          type: 'clock' as const,
          settings: {
            hourCycle: '12' as const,
            showSeconds: false,
            textColour: '#ffffff',
            backgroundColour: '#000000',
          },
        },
      })),
    },
  );

/**
 * A version 4 manifest: one to four playlists of one to four items, one to six events. With a
 * `near` wall clock, about half of its edges are drawn at that minute.
 */
export const manifestV4Arb = (
  zone: fc.Arbitrary<string>,
  near: Near | null = null,
): fc.Arbitrary<ManifestV4> =>
  fc
    .array(fc.array(itemArb(near), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 })
    .chain((playlists) =>
      fc.record({
        playlists: fc.constant(playlists),
        playback: fc.array(
          fc.record({
            transition: fc.constantFrom('cut' as const, 'fade' as const),
            shuffle: fc.boolean(),
          }),
          {
            minLength: playlists.length,
            maxLength: playlists.length,
          },
        ),
        events: fc.array(
          fc.record({ playlist: fc.nat({ max: playlists.length - 1 }), rule: ruleArb(near) }),
          { minLength: 1, maxLength: 6 },
        ),
        workingHours: fc.oneof(fc.constant(null), workingHoursArb(near)),
        timeZone: zone,
        publicationId: fc.uuid({ version: 4 }),
      }),
    )
    .map(({ playlists, playback, events, workingHours, timeZone, publicationId }) => {
      const first = playback[0] ?? { transition: 'cut' as const, shuffle: false };
      return {
        schemaVersion: 4 as const,
        publicationId,
        displayId: DISPLAY_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        canvas: { width: 1920, height: 1080 },
        contentRect: null,
        muted: true as const,
        timeZone,
        transition: first.transition,
        shuffle: first.shuffle,
        rotation: 0 as const,
        workingHours,
        assets: playlists.flat(),
        schedule: {
          playlists: playlists.map((items, n) => ({
            count: items.length,
            ...(playback[n] ?? first),
          })),
          events: events.map(({ playlist, rule }) => ({ playlist, ...rule })),
        },
      };
    });

const TRUST_MS = 300_000;

/** A manifest, an instant and the playlists just failed (`skipSlices`), with createdAt set. */
export const momentArb = (
  zone: fc.Arbitrary<string>,
): fc.Arbitrary<{ manifest: ManifestV4; epochMs: number; skip: Set<number> }> =>
  fc
    .tuple(zone, instantArb)
    .chain(([timeZone, epochMs]) =>
      fc.record({
        manifest: manifestV4Arb(fc.constant(timeZone), nearOf(epochMs, timeZone)),
        epochMs: fc.constant(epochMs),
        // Up to an hour after the instant (a clock behind the publication), up to a year before,
        // or at the trust limit (createdAt five minutes after the instant) to the millisecond.
        createdBefore: fc.oneof(
          fc.integer({ min: -60 * MINUTE_MS, max: 366 * 24 * 60 * MINUTE_MS }),
          fc.integer({ min: -TRUST_MS - 1, max: -TRUST_MS + 1 }),
        ),
        skip: fc.array(fc.nat({ max: 3 }), { maxLength: 3 }),
      }),
    )
    .map(({ manifest, epochMs, createdBefore, skip }) => ({
      manifest: { ...manifest, createdAt: new Date(epochMs - createdBefore).toISOString() },
      epochMs,
      skip: new Set(skip),
    }));
