import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AlertOfflineMinutesSchema,
  HeartbeatV1Schema,
  WorkingHoursSchema,
  type HeartbeatV1,
  type WorkingHours,
} from '@tinnox/contracts';
import {
  DAY_MS,
  elapsedArb,
  heartbeatArb,
  hhmm,
  instantArb,
  knownZoneArb,
  offlineMinutesArb,
  unknownZoneArb,
  workingHoursArb,
} from './delivery-state.test-support.ts';
import {
  EMPTY_REPORTED_STATE,
  offlineDue,
  reduceHeartbeat,
  type ReportedState,
} from './delivery-state.ts';
import { ID } from './fixtures.test-support.ts';

// Adoption plan section 4.4, properties 9 and 11, and D11: every run draws a fresh seed, and a
// failure prints the seed and the shrunk counterexample. A counterexample is committed below as
// a plain example test with its fix, never as a seed or path.

const MINUTE_MS = 60_000;
const SCAN_MS = 14 * DAY_MS;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// The oracle reads the wall clock through its own formatter, not localWallClock, so a fault in
// the shared reader shows up as a difference.
const oracleFormatters = new Map<string, Intl.DateTimeFormat>();

/** Day (0 is Monday) and minute of the day in `zone` at `epochMs`. */
function oracleWall(epochMs: number, zone: string): { day: number; minute: number } {
  let formatter = oracleFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'long',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    oracleFormatters.set(zone, formatter);
  }
  // One formatToParts call a reading: the oracles make about 20 000 readings a case.
  const parts = formatter.formatToParts(epochMs);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: WEEKDAYS.indexOf(part('weekday')),
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

function oracleInside(epochMs: number, hours: WorkingHours, zone: string): boolean {
  const wall = oracleWall(epochMs, zone);
  const today = hours[wall.day] ?? null;
  return (
    today !== null && minutesOf(today.start) <= wall.minute && wall.minute < minutesOf(today.end)
  );
}

/**
 * Milliseconds inside working hours from `from` to `to`, counted minute by minute. Offsets are
 * whole quarter hours from 2026 to 2035, so the wall clock shows one minute for the whole of a
 * UTC minute and a minute is inside or outside as a whole.
 */
function workingMs(from: number, to: number, hours: WorkingHours, zone: string): number {
  let inside = 0;
  for (let minute = Math.floor(from / MINUTE_MS) * MINUTE_MS; minute < to; minute += MINUTE_MS) {
    if (oracleInside(minute, hours, zone)) {
      inside += Math.min(minute + MINUTE_MS, to) - Math.max(minute, from);
    }
  }
  return inside;
}

/**
 * The rule of DEC-37 A4 with the 14-day rule of EAX-02: due once the working minutes since the
 * report, counted over at most the last 14 days, reach the delay; a screen silent for 14 days or
 * more whose working minutes in those days never reach it is due whenever it is inside hours.
 * Null hours count every minute. (An unknown zone is not given to this oracle: see below.)
 */
function oracleDue(
  last: number,
  now: number,
  minutes: number,
  hours: WorkingHours | null,
  zone: string,
): boolean {
  const need = minutes * MINUTE_MS;
  if (now - last < need) return false;
  if (hours === null) return true;
  if (workingMs(Math.max(last, now - SCAN_MS), now, hours, zone) >= need) return true;
  return last <= now - SCAN_MS && oracleInside(now, hours, zone);
}

/**
 * The first instant at which the oracle's rule is due: the moment the minute-by-minute count from
 * the report reaches the delay, or, when 14 days of working minutes fall short of it, the first
 * moment inside hours from 14 days after the report on.
 */
function oracleDueAt(last: number, minutes: number, hours: WorkingHours, zone: string): number {
  const need = minutes * MINUTE_MS;
  const end = last + SCAN_MS;
  let inside = 0;
  for (let minute = Math.floor(last / MINUTE_MS) * MINUTE_MS; minute < end; minute += MINUTE_MS) {
    if (!oracleInside(minute, hours, zone)) continue;
    const from = Math.max(minute, last);
    const to = Math.min(minute + MINUTE_MS, end);
    if (inside + (to - from) >= need) return from + (need - inside);
    inside += to - from;
  }
  // At least one day a week is open, so this ends within 8 days.
  for (let t = end; ; t = (Math.floor(t / MINUTE_MS) + 1) * MINUTE_MS) {
    if (oracleInside(t, hours, zone)) return t;
  }
}

/**
 * A screen silent for 14 to 17 days whose only open day is now's weekday, 1 to 4 minutes long,
 * with its start or its end at now's own local minute plus or minus 0 or 1.
 */
const fallbackEdgeArb = fc
  .record({
    zone: knownZoneArb,
    now: instantArb,
    silentBeyond: fc.integer({ min: 0, max: 3 * DAY_MS }),
    minutes: offlineMinutesArb,
    side: fc.constantFrom('start', 'end'),
    // On the minute itself half the time: there `<` and `<=` differ.
    offset: fc.oneof(fc.constant(0), fc.constantFrom(-1, 1)),
    span: fc.integer({ min: 1, max: 4 }),
  })
  .map(({ zone, now, silentBeyond, minutes, side, offset, span }) => {
    const wall = oracleWall(now, zone);
    const edge = wall.minute + offset;
    const [start, end] =
      side === 'end'
        ? [Math.max(0, Math.max(1, edge) - span), Math.max(1, edge)]
        : [Math.min(1439, Math.max(0, edge)), Math.min(1440, Math.max(0, edge) + span)];
    const hours: WorkingHours = Array.from({ length: 7 }, (_, day) =>
      day === wall.day ? { start: hhmm(start), end: hhmm(end) } : null,
    );
    return { last: now - SCAN_MS - silentBeyond, now, minutes, hours, zone };
  });

const due = (
  last: number,
  now: number,
  minutes: number,
  hours: WorkingHours | null,
  zone: string,
) => offlineDue(new Date(last), new Date(now), minutes, hours, zone);

describe('delivery-state generators: self-checks', () => {
  it('working hours parse with WorkingHoursSchema', () => {
    fc.assert(
      fc.property(workingHoursArb, (hours) => {
        expect(WorkingHoursSchema.safeParse(hours).error?.issues ?? []).toEqual([]);
      }),
    );
  });

  it('the fallback-edge cases parse with WorkingHoursSchema and are silent for 14 days or more', () => {
    fc.assert(
      fc.property(fallbackEdgeArb, ({ last, now, hours }) => {
        expect(WorkingHoursSchema.safeParse(hours).error?.issues ?? []).toEqual([]);
        expect(now - last).toBeGreaterThanOrEqual(SCAN_MS);
      }),
    );
  });

  it('delays parse with AlertOfflineMinutesSchema', () => {
    fc.assert(
      fc.property(offlineMinutesArb, (minutes) => {
        expect(AlertOfflineMinutesSchema.safeParse(minutes).success).toBe(true);
      }),
    );
  });

  it('heartbeats parse with HeartbeatV1Schema', () => {
    fc.assert(
      fc.property(heartbeatArb(fc.nat()), (report) => {
        expect(HeartbeatV1Schema.safeParse(report).error?.issues ?? []).toEqual([]);
      }),
    );
  });
});

describe('offlineDue: properties (property 11, EAX-02, EAU-01)', () => {
  // The two oracle properties count up to 14 days minute by minute through Intl (about 20 000
  // formatter calls a case, 20 to 40 ms): 50 and 25 runs keep each near a second, under the
  // 5-second test timeout on a busy runner. The other properties run fast-check's default 100.
  it('comes due exactly when a minute-by-minute count of working minutes reaches the delay', () => {
    fc.assert(
      fc.property(
        instantArb,
        elapsedArb,
        offlineMinutesArb,
        fc.option(workingHoursArb, { nil: null }),
        knownZoneArb,
        (last, elapsed, minutes, hours, zone) => {
          expect(due(last, last + elapsed, minutes, hours, zone)).toBe(
            oracleDue(last, last + elapsed, minutes, hours, zone),
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('is due at the instant the count reaches the delay and not a millisecond before', () => {
    // Drawn at the boundary itself: a random `now` almost never lands in the few minutes where a
    // sampled count and an exact one disagree (EAU-01), nor after 14 days on short hours (EAX-02).
    fc.assert(
      fc.property(
        instantArb,
        offlineMinutesArb,
        workingHoursArb,
        knownZoneArb,
        (last, minutes, hours, zone) => {
          const at = oracleDueAt(last, minutes, hours, zone);
          expect([
            due(last, at - 1, minutes, hours, zone),
            due(last, at, minutes, hours, zone),
          ]).toEqual([false, true]);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('is never due before the delay has elapsed, in any zone', () => {
    fc.assert(
      fc.property(
        instantArb,
        elapsedArb,
        offlineMinutesArb,
        fc.option(workingHoursArb, { nil: null }),
        fc.oneof(knownZoneArb, unknownZoneArb),
        (last, elapsed, minutes, hours, zone) => {
          if (due(last, last + elapsed, minutes, hours, zone)) {
            expect(elapsed).toBeGreaterThanOrEqual(minutes * MINUTE_MS);
          }
        },
      ),
    );
  });

  it('once due within the 14 days scanned, stays due as now grows within them', () => {
    // After 14 silent days the rule is the fallback (due whenever inside hours), which is not
    // monotone: see the example below.
    fc.assert(
      fc.property(
        instantArb,
        fc.integer({ min: 0, max: SCAN_MS }),
        fc.integer({ min: 0, max: SCAN_MS }),
        offlineMinutesArb,
        fc.option(workingHoursArb, { nil: null }),
        knownZoneArb,
        (last, a, b, minutes, hours, zone) => {
          const [earlier, later] = a <= b ? [a, b] : [b, a];
          if (due(last, last + earlier, minutes, hours, zone)) {
            expect(due(last, last + later, minutes, hours, zone)).toBe(true);
          }
        },
      ),
    );
  });

  it('after 14 silent days on short hours, is due exactly when inside hours, at their edges too', () => {
    // The 14-day fallback reads withinWorkingHours at `now`, and a random hour edge almost never
    // lands on now's own minute, so a `<` written as `<=` there would pass the properties above.
    // One open day a week of 1 to 4 minutes is at most 3 x 8 real minutes in 14 days (a span in
    // a repeated daylight-saving hour counts twice), short of the 30-minute minimum delay, so
    // the answer is the fallback alone: inside hours at `now`.
    fc.assert(
      fc.property(fallbackEdgeArb, ({ last, now, minutes, hours, zone }) => {
        expect(due(last, now, minutes, hours, zone)).toBe(oracleInside(now, hours, zone));
      }),
      // Each case scans 14 days (about 10 ms); 30 runs hit an end on now's minute with
      // probability 1 - (3/4)^30, above 99.9%.
      { numRuns: 30 },
    );
  });

  it('null hours count every minute', () => {
    fc.assert(
      fc.property(
        instantArb,
        elapsedArb,
        offlineMinutesArb,
        knownZoneArb,
        (last, elapsed, minutes, zone) => {
          expect(due(last, last + elapsed, minutes, null, zone)).toBe(
            elapsed >= minutes * MINUTE_MS,
          );
        },
      ),
    );
  });

  it('an unknown zone counts every minute, whatever the hours (today: the zone question is open)', () => {
    // Today's behaviour, stated on purpose: a zone this runtime refuses fails open, as the
    // player does. What an unknown zone should do is Michael's decision (adoption plan step 30).
    fc.assert(
      fc.property(
        instantArb,
        elapsedArb,
        offlineMinutesArb,
        workingHoursArb,
        unknownZoneArb,
        (last, elapsed, minutes, hours, zone) => {
          expect(due(last, last + elapsed, minutes, hours, zone)).toBe(
            elapsed >= minutes * MINUTE_MS,
          );
        },
      ),
    );
  });
});

describe('offlineDue: counterexamples of property 11 (EAU-01, EAX-02)', () => {
  it('EAU-01, EAX-02: one minute a week off the 5-minute marks comes due at its first open minute after 14 days', () => {
    // The shrunk counterexample the boundary property printed against the parent of 9a215b1:
    // 05:16 to 05:17 on Fridays is never seen by a walk that samples at 5-minute marks, and two
    // minutes in 14 days never reach 30, so that version never alerted. Silent since Thursday
    // 1 January 2026, the 14 days end on Thursday 15 January; Friday 16 January 05:16 is the
    // first open moment after them.
    const fridays: WorkingHours = [
      null,
      null,
      null,
      null,
      { start: '05:16', end: '05:17' },
      null,
      null,
    ];
    const last = Date.parse('2026-01-01T00:00:00.000Z');
    const at = Date.parse('2026-01-16T05:16:00.000Z');
    expect(due(last, at - 1, 30, fridays, 'Africa/Abidjan')).toBe(false);
    expect(due(last, at, 30, fridays, 'Africa/Abidjan')).toBe(true);
    expect(oracleDueAt(last, 30, fridays, 'Africa/Abidjan')).toBe(at);
  });
});

describe('offlineDue: the 14-day fallback is not monotone (documented shortcut)', () => {
  it('after 14 silent days, a delay longer than 14 days of working minutes is due only while open', () => {
    // Half an hour on Mondays is one hour in 14 days, short of a 48-hour delay, so the delay is
    // never reached by counting; after 14 silent days the alert is due at an open moment and
    // not at a closed one. The alert check opens its episode at the first due run, so the
    // e-mail is sent once either way (apps/api/src/alerts.ts).
    const mondays: WorkingHours = [
      { start: '09:00', end: '09:30' },
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const last = Date.parse('2026-11-02T00:00:00Z'); // a Monday
    expect(due(last, Date.parse('2026-11-16T09:10:00Z'), 2880, mondays, 'UTC')).toBe(true);
    expect(due(last, Date.parse('2026-11-16T10:00:00Z'), 2880, mondays, 'UTC')).toBe(false);
  });
});

/** Folds reports into the stored state in the order given; also returns each `accepted`. */
function arrive(reports: readonly HeartbeatV1[]): { state: ReportedState; accepted: boolean[] } {
  const accepted: boolean[] = [];
  const state = reports.reduce((current, report, n) => {
    const result = reduceHeartbeat(current, {
      registrationId: ID.regA,
      report,
      receivedAt: new Date(Date.UTC(2026, 10, 14, 0, 0, n)),
    });
    accepted.push(result.accepted);
    return result.state;
  }, EMPTY_REPORTED_STATE);
  return { state, accepted };
}

/**
 * One registration's reports with distinct seqs, plus repeats of some seqs, in any arrival order.
 * A repeat is either an identical copy (a replay) or a report with the same seq and its other
 * fields drawn afresh (a forged or buggy one): an identical copy alone cannot tell "first to
 * arrive wins" from "last to arrive wins".
 */
const arrivalsArb = fc
  .uniqueArray(fc.nat({ max: Number.MAX_SAFE_INTEGER }), { minLength: 1, maxLength: 8 })
  .chain((seqs): fc.Arbitrary<HeartbeatV1[]> =>
    fc.tuple(...seqs.map((seq) => heartbeatArb(fc.constant(seq)))),
  )
  .chain((reports) =>
    fc
      .array(
        fc.nat({ max: reports.length - 1 }).chain((n): fc.Arbitrary<readonly HeartbeatV1[]> => {
          const original = reports[n];
          return original === undefined
            ? fc.constant([])
            : fc.oneof(
                fc.constant([original]),
                heartbeatArb(fc.constant(original.seq)).map((r) => [r]),
              );
        }),
        { maxLength: 8 },
      )
      .chain((repeats) => {
        const all = [...reports, ...repeats.flat()];
        return fc.tuple(
          fc.constant(reports),
          fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }),
        );
      }),
  );

const fieldsOf = (r: HeartbeatV1 | ReportedState) => ({
  downloadedPublicationId: r.downloadedPublicationId,
  activePublicationId: r.activePublicationId,
  activeItemIndex: r.activeItemIndex,
  playerState: r.playerState,
  staging: r.staging,
  errors: r.errors,
});

describe('reduceHeartbeat: properties (property 9)', () => {
  it('any arrival order of one registration’s reports ends at the first to arrive with the highest seq', () => {
    // The rule (delivery-state.ts): a report whose seq is not greater than the stored one is
    // ignored, so of two reports with the same seq the first to arrive wins.
    fc.assert(
      fc.property(arrivalsArb, ([reports, order]) => {
        const highestSeq = Math.max(...reports.map((r) => r.seq));
        const winner = order.find((r) => r.seq === highestSeq);
        const { state, accepted } = arrive(order);
        expect(state.registrationId).toBe(ID.regA);
        expect(state.lastSeq).toBe(highestSeq);
        expect(fieldsOf(state)).toEqual(winner === undefined ? undefined : fieldsOf(winner));
        // Accepted exactly when its seq is above every seq that arrived before it.
        expect(accepted).toEqual(
          order.map((r, n) => order.slice(0, n).every((earlier) => earlier.seq < r.seq)),
        );
      }),
    );
  });
});
