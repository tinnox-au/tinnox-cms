import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { eventCovers, ScheduleRuleSchema } from './schedule.ts';
import { hhmm, minutesOf, scheduleRuleArb } from './schedule.test-support.ts';

// Adoption plan section 4.4, property 1, and D11: every run draws a fresh seed, and a failure
// prints the seed and the shrunk counterexample. A counterexample is committed below as a plain
// example test with its fix, never as a seed or path.

const MINUTES_PER_DAY = 24 * 60;

describe('schedule generators: self-checks', () => {
  it('rules parse with ScheduleRuleSchema', () => {
    fc.assert(
      fc.property(scheduleRuleArb, (rule) => {
        expect(ScheduleRuleSchema.safeParse(rule).error?.issues ?? []).toEqual([]);
      }),
    );
  });
});

describe('eventCovers: properties', () => {
  it('a rule covers exactly ticked days × its length in minutes of a week', () => {
    fc.assert(
      fc.property(scheduleRuleArb, (rule) => {
        const start = minutesOf(rule.start);
        const end = minutesOf(rule.end);
        // Past midnight the event runs from its start to midnight, then from midnight to its end.
        const length = end > start ? end - start : MINUTES_PER_DAY - start + end;
        let covered = 0;
        for (let day = 0; day < 7; day += 1) {
          for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
            if (eventCovers(rule, day, hhmm(minute))) covered += 1;
          }
        }
        expect(covered).toBe(rule.days.filter(Boolean).length * length);
      }),
    );
  });
});
