// fast-check generators for weekly rules (adoption plan section 4.4, property 1).
//
// Choosing a generator: the constraint that matters sits in a superRefine check
// (checkScheduleRule: start and end differ), beside two refinements on the times (start is never
// 24:00, end is never 00:00), so the generator builds its rules to meet them by construction, at
// any minute, and schedule.property.test.ts checks that each one parses with ScheduleRuleSchema.
// A counterexample whose input fails that self-check is a generator bug, not a product bug.
import fc from 'fast-check';
import type { ScheduleRule } from './schedule.ts';

const MINUTES_PER_DAY = 24 * 60;

/** Minutes since midnight (0 to 1440) as LocalTimeSchema's 'HH:mm'; 1440 is '24:00'. */
export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** 'HH:mm' (00:00 to 24:00) as minutes since midnight. */
export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

/** Seven days, Monday first, at least one ticked (ScheduleDaysSchema). */
export const daysArb: fc.Arbitrary<boolean[]> = fc
  .tuple(fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }), fc.nat({ max: 6 }))
  .map(([days, forced]) => days.map((day, n) => day || (n === forced && !days.some(Boolean))));

/**
 * A rule ScheduleRuleSchema accepts: a start from 00:00 to 23:59 and an end from 00:01 to 24:00,
 * at any minute, never equal. An end drawn equal to the start moves one minute later.
 */
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
