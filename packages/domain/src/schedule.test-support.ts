// fast-check generators for scheduled publications (adoption plan section 4.4, properties 3 and 8).
//
// Choosing a generator: the constraints that matter sit in superRefine checks (checkScheduleRule:
// start and end differ; DayHoursSchema: start before end; LocalDateTimeSchema: a real date and
// time with a year from 1000 to 9999), so each generator builds its values to meet them by
// construction, at any minute, and schedule.property.test.ts checks that each one parses with its
// schema. A counterexample whose input fails its own self-check is a generator bug, not a
// product bug: fix the generator first.
//
// What is drawn is what the API can hand the planner: playlists of ready, still-processing and
// unsupported media and apps (so plans are refused as well as accepted), events naming a playlist
// in either letter case or one that was deleted, every rotation, working hours at any minute, and
// every IANA zone this runtime supports or a name it refuses (a site row's zone is length-checked
// only, 0001). Media windows stay within the years LocalDateTimeSchema takes; a stored window
// outside them is an example test, not a generated case (its database guard is step 31, D7).
import fc from 'fast-check';
import {
  ROTATIONS,
  type LocalDateTime,
  type ScheduleRule,
  type Transition,
} from '@tinnox/contracts';
import {
  hhmm,
  knownZoneArb,
  unknownZoneArb,
  workingHoursArb,
} from './delivery-state.test-support.ts';
import { ID, display, library, type FixturePlaylist } from './fixtures.test-support.ts';
import type { DisplayTarget, DraftItem, MediaRecord, PlaybackOptions } from './types.ts';

const MINUTES_PER_DAY = 24 * 60;

/** The eight playlists a generated schedule may use; [0] is the default playlist. */
export const PLAYLIST_IDS: readonly string[] = [
  ID.listDefault,
  ID.listLunch,
  ID.listEvening,
  ID.listBand,
  '66666666-6666-4666-8666-00000000000e',
  '66666666-6666-4666-8666-00000000000f',
  '66666666-6666-4666-8666-000000000010',
  '66666666-6666-4666-8666-000000000011',
];
/** A playlist that was deleted: the planner refuses an event that names it. */
export const DELETED_PLAYLIST_ID = '66666666-6666-4666-8666-0000000000ff';
/** An image whose window is drawn with the case. */
export const WINDOWED_MEDIA_ID = '22222222-2222-4222-8222-000000000007';

/** Seven days, Monday first, at least one ticked (ScheduleDaysSchema). */
const daysArb = fc
  .tuple(fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }), fc.nat({ max: 6 }))
  .map(([days, forced]) => days.map((day, n) => day || (n === forced && !days.some(Boolean))));

/** A rule ScheduleRuleSchema accepts, at any minute; an end drawn equal to the start moves on. */
export const scheduleRuleArb: fc.Arbitrary<ScheduleRule> = fc
  .record({
    days: daysArb,
    start: fc.integer({ min: 0, max: MINUTES_PER_DAY - 1 }),
    end: fc.integer({ min: 1, max: MINUTES_PER_DAY }),
  })
  .map(({ days, start, end }) => ({
    days,
    start: hhmm(start),
    end: hhmm(end === start ? end + 1 : end),
  }));

/** Minutes from 1000-01-01T00:00Z to 9999-12-31T23:59Z: the range LocalDateTimeSchema takes. */
const FIRST_MINUTE = Date.UTC(1000, 0, 1) / 60_000;
const LAST_MINUTE = Date.UTC(9999, 11, 31, 23, 59) / 60_000;
const localDateTime = (minute: number): LocalDateTime =>
  new Date(minute * 60_000).toISOString().slice(0, 16);

/** A media window the planner can be given: either end open, or both with from before until. */
export const windowArb: fc.Arbitrary<{ from: LocalDateTime | null; until: LocalDateTime | null }> =
  fc
    .tuple(
      fc.option(fc.integer({ min: FIRST_MINUTE, max: LAST_MINUTE }), { nil: null, freq: 2 }),
      fc.option(fc.integer({ min: FIRST_MINUTE, max: LAST_MINUTE }), { nil: null, freq: 2 }),
    )
    .map(([a, b]) => {
      if (a !== null && b !== null && a === b) return { from: localDateTime(a), until: null };
      const [from, until] = a !== null && b !== null && a > b ? [b, a] : [a, b];
      return {
        from: from === null ? null : localDateTime(from),
        until: until === null ? null : localDateTime(until),
      };
    });

/** The fixture library plus one image with the drawn window. */
export function libraryWith(window: {
  from: LocalDateTime | null;
  until: LocalDateTime | null;
}): Map<string, MediaRecord> {
  const records = library();
  const jpeg = records.get(ID.jpeg);
  if (jpeg !== undefined) {
    records.set(WINDOWED_MEDIA_ID, {
      ...jpeg,
      id: WINDOWED_MEDIA_ID,
      availableFrom: window.from,
      availableUntil: window.until,
    });
  }
  return records;
}

const fitArb = fc.constantFrom(null, 'contain' as const, 'cover' as const);

/** Items that plan: images with a duration, the H.264 video, the two apps, the windowed image. */
const readyItemArb: fc.Arbitrary<DraftItem> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      mediaId: fc.constantFrom(ID.jpeg, ID.png, WINDOWED_MEDIA_ID),
      durationMs: fc.integer({ min: 1_000, max: 60_000 }),
      fit: fitArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mediaId: fc.constant(ID.video),
      durationMs: fc.constant(null),
      fit: fitArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      appId: fc.constantFrom(ID.clock, ID.ticker),
      durationMs: fc.integer({ min: 1_000, max: 60_000 }),
    }),
  },
);

/** Items that are refused: still processing, failed, a codec the browser route lacks. */
const refusedItemArb: fc.Arbitrary<DraftItem> = fc.record({
  mediaId: fc.constantFrom(ID.processing, ID.failed, ID.hevc),
  durationMs: fc.constant(null),
  fit: fc.constant(null),
});

// The defaults (and no hours, rotation 0, no window) are weighted up, so version 1 is reached too.
const playbackArb: fc.Arbitrary<PlaybackOptions> = fc.oneof(
  fc.constant({ transition: 'cut' as const, shuffle: false }),
  fc.record({ transition: fc.constantFrom<Transition>('cut', 'fade'), shuffle: fc.boolean() }),
);

/** A playlist; with `ready` false it may be empty or hold an item that is refused. */
export const playlistArb = (ready: boolean): fc.Arbitrary<FixturePlaylist> =>
  fc.record({
    name: fc.constant('Playlist'),
    items: ready
      ? fc.array(readyItemArb, { minLength: 1, maxLength: 5 })
      : fc.oneof(
          {
            weight: 19,
            arbitrary: fc.array(fc.oneof({ weight: 19, arbitrary: readyItemArb }, refusedItemArb), {
              minLength: 1,
              maxLength: 5,
            }),
          },
          fc.constant([]),
        ),
    playback: playbackArb,
  });

/** One event: a playlist of the schedule in either letter case, or (`ready` false) a deleted one. */
const eventArb = (playlists: number, ready: boolean) =>
  fc.record({
    playlistId: fc
      .tuple(
        ready
          ? fc.constantFrom(...PLAYLIST_IDS.slice(0, playlists))
          : fc.oneof(
              { weight: 199, arbitrary: fc.constantFrom(...PLAYLIST_IDS.slice(0, playlists)) },
              fc.constant(DELETED_PLAYLIST_ID),
            ),
        fc.boolean(),
      )
      .map(([id, shout]) => (shout ? id.toUpperCase() : id)),
    rule: scheduleRuleArb,
  });

export interface ScheduleCase {
  readonly playlists: Readonly<Record<string, FixturePlaylist>>;
  readonly schedule: {
    readonly defaultPlaylistId: string;
    readonly events: readonly {
      readonly playlistId: string;
      readonly days: readonly boolean[];
      readonly start: string;
      readonly end: string;
    }[];
  };
  readonly display: DisplayTarget;
  readonly mediaById: Map<string, MediaRecord>;
  readonly maxItems: number;
}

/**
 * One to eight playlists and zero to fifty events, on a display with drawn working hours,
 * rotation and zone. `ready` true draws only what plans (the drafts of property 8); false also
 * draws refusals (property 3). `zone` chooses the zones drawn.
 */
export const scheduleCaseArb = (
  ready: boolean,
  zone: fc.Arbitrary<string>,
): fc.Arbitrary<ScheduleCase> =>
  fc.integer({ min: 1, max: PLAYLIST_IDS.length }).chain((count) =>
    fc
      .record({
        playlists: fc.array(playlistArb(ready), { minLength: count, maxLength: count }),
        events: fc.array(eventArb(count, ready), { maxLength: 50 }),
        workingHours: fc.oneof(fc.constant(null), workingHoursArb),
        rotation: fc.oneof(fc.constant(0 as const), fc.constantFrom(...ROTATIONS)),
        timeZone: zone,
        window: windowArb,
        maxItems: ready
          ? fc.constant(200)
          : fc.oneof({ weight: 4, arbitrary: fc.constant(200) }, fc.constantFrom(5, 20)),
      })
      .map(({ playlists, events, workingHours, rotation, timeZone, window, maxItems }) => ({
        playlists: Object.fromEntries(playlists.map((p, n) => [PLAYLIST_IDS[n] ?? '', p])),
        schedule: {
          defaultPlaylistId: ID.listDefault,
          events: events.map(({ playlistId, rule }) => ({ playlistId, ...rule })),
        },
        display: display({ workingHours, rotation, timeZone }),
        mediaById: libraryWith(window),
        maxItems,
      })),
  );

/** Every zone this runtime knows, or (one case in ten) a name it refuses. */
export const anyZoneArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 9, arbitrary: knownZoneArb },
  unknownZoneArb,
);
