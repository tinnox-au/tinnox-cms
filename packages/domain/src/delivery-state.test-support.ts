// fast-check generators for the delivery state (adoption plan section 4.4, properties 9 and 11).
//
// Choosing a generator: the constraints that matter sit in refinements (DayHoursSchema: start
// before end; WorkingHoursSchema: at least one open day; AlertOfflineMinutesSchema: whole half
// hours), so each generator builds its values to meet them by construction and carries a
// self-check in delivery-state.property.test.ts that its output parses with that schema. A
// counterexample whose input fails its own self-check is a generator bug, not a product bug.
//
// Working hours are drawn at any minute, as DayHoursSchema allows (EAX-02, EAU-01): hours on
// quarter hours or 5-minute marks cannot reach the class of bug those findings were. Instants
// are drawn at any millisecond.
import fc from 'fast-check';
import {
  ABSOLUTE,
  PLAYER_ERROR_CODES,
  type HeartbeatV1,
  type PlayerError,
  type WorkingHours,
} from '@tinnox/contracts';
import { heartbeat } from './fixtures.test-support.ts';

const MINUTES_PER_DAY = 24 * 60;
export const DAY_MS = 24 * 60 * 60_000;

/** Minutes since midnight (0 to 1440) as 'HH:mm'; 1440 is '24:00'. */
export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** One open day: a start from 00:00 to 23:59 and a later end up to 24:00, at any minute. */
const dayHoursArb = fc
  .integer({ min: 0, max: MINUTES_PER_DAY - 1 })
  .chain((start) =>
    fc
      .integer({ min: start + 1, max: MINUTES_PER_DAY })
      .map((end) => ({ start: hhmm(start), end: hhmm(end) })),
  );

/** Working hours WorkingHoursSchema accepts: seven days, Monday first, at least one open. */
export const workingHoursArb: fc.Arbitrary<WorkingHours> = fc
  .tuple(
    fc.array(fc.option(dayHoursArb, { nil: null }), { minLength: 7, maxLength: 7 }),
    fc.nat({ max: 6 }),
    dayHoursArb,
  )
  .map(([days, forced, open]) =>
    days.some((day) => day !== null) ? days : days.map((day, n) => (n === forced ? open : day)),
  );

/** Delays AlertOfflineMinutesSchema accepts: 30 to 2880 minutes in whole half hours. */
export const offlineMinutesArb: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 96 })
  .map((halves) => halves * 30);

/** Every IANA zone this runtime supports. */
export const KNOWN_ZONES: readonly string[] = Intl.supportedValuesOf('timeZone');

/** Zone names this runtime refuses, as a site row could hold them (length 1 to 64 only, 0001). */
export const UNKNOWN_ZONES: readonly string[] = ['Mars/Olympus_Mons', 'Not/A_Zone', 'AEST+11'];

export const knownZoneArb: fc.Arbitrary<string> = fc.constantFrom(...KNOWN_ZONES);
export const unknownZoneArb: fc.Arbitrary<string> = fc.constantFrom(...UNKNOWN_ZONES);

/** Instants from 2026 to 2035, at any millisecond. */
export const instantArb: fc.Arbitrary<number> = fc.integer({
  min: Date.UTC(2026, 0, 1),
  max: Date.UTC(2036, 0, 1) - 1,
});

/**
 * Time since the last report: mostly within the 48-hour range of the delays, sometimes past the
 * 14 days that offlineDue scans, at any millisecond.
 */
export const elapsedArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 3 * DAY_MS }),
  fc.integer({ min: 0, max: 16 * DAY_MS }),
);

const uuidArb = fc.uuid({ version: 4 });

const playerErrorArb: fc.Arbitrary<PlayerError> = fc.record({
  code: fc.constantFrom(...PLAYER_ERROR_CODES),
  message: fc.constantFrom('Request failed.', 'No space left.'),
  at: fc.constant('2026-11-14T00:00:00.000Z'),
  publicationId: fc.option(uuidArb, { nil: null }),
  assetId: fc.option(uuidArb, { nil: null }),
});

/** A report HeartbeatV1Schema accepts, with every field a later report could change drawn. */
export const heartbeatArb = (seq: fc.Arbitrary<number>): fc.Arbitrary<HeartbeatV1> =>
  fc
    .record({
      seq,
      downloadedPublicationId: fc.option(uuidArb, { nil: null }),
      active: fc.option(
        fc.record({
          publicationId: uuidArb,
          itemIndex: fc.nat({ max: ABSOLUTE.maxPlaylistItems }),
        }),
        { nil: null },
      ),
      playerState: fc.constantFrom('idle', 'playing', 'error'),
      staging: fc.option(
        fc
          .record({
            publicationId: uuidArb,
            phase: fc.constantFrom('downloading', 'verifying', 'ready', 'failed'),
            a: fc.nat({ max: ABSOLUTE.maxPlaylistItems }),
            b: fc.nat({ max: ABSOLUTE.maxPlaylistItems }),
          })
          // HeartbeatV1Schema refuses more assets done than in total.
          .map(({ publicationId, phase, a, b }) => ({
            publicationId,
            phase,
            assetsDone: Math.min(a, b),
            assetsTotal: Math.max(a, b),
          })),
        { nil: null },
      ),
      errors: fc.array(playerErrorArb, { maxLength: ABSOLUTE.maxHeartbeatErrors }),
    })
    // HeartbeatV1Schema: the active publication and item come together, and playing needs them.
    .map(({ active, playerState, ...fields }) =>
      heartbeat({
        ...fields,
        activePublicationId: active?.publicationId ?? null,
        activeItemIndex: active?.itemIndex ?? null,
        playerState: active === null && playerState === 'playing' ? 'idle' : playerState,
      }),
    );
