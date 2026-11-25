import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LocalDateTimeSchema,
  ManifestSchema,
  ScheduleRuleSchema,
  WorkingHoursSchema,
} from '@tinnox/contracts';
import { knownZoneArb, unknownZoneArb } from './delivery-state.test-support.ts';
import { ID, WEEKDAYS, display, planSchedule, route } from './fixtures.test-support.ts';
import { buildManifest, manifestVersionFor, type PlanPublicationResult } from './manifest.ts';
import {
  anyZoneArb,
  libraryWith,
  scheduleCaseArb,
  scheduleRuleArb,
  windowArb,
  WINDOWED_MEDIA_ID,
  type ScheduleCase,
} from './schedule.test-support.ts';

// Adoption plan section 4.4, property 3, and D11: every run draws a fresh seed, and a failure
// prints the seed and the shrunk counterexample. A counterexample is committed below as a plain
// example test with its fix, never as a seed or path.

const IDENTITY = { publicationId: ID.pubA, createdAt: new Date('2026-11-25T00:00:00.000Z') };

function planOf(c: ScheduleCase): PlanPublicationResult {
  return planSchedule(c.playlists, c.schedule, {
    display: c.display,
    mediaById: c.mediaById,
    route: route(c.maxItems),
  });
}

/** True when some event names a playlist other than the default (ids compare without case). */
function namesAnotherPlaylist(c: ScheduleCase): boolean {
  const own = c.schedule.defaultPlaylistId.toLowerCase();
  return c.schedule.events.some((event) => event.playlistId.toLowerCase() !== own);
}

describe('schedule generators: self-checks', () => {
  it('rules parse with ScheduleRuleSchema', () => {
    fc.assert(
      fc.property(scheduleRuleArb, (rule) => {
        expect(ScheduleRuleSchema.safeParse(rule).error?.issues ?? []).toEqual([]);
      }),
    );
  });

  it('media windows parse with LocalDateTimeSchema, from before until', () => {
    fc.assert(
      fc.property(windowArb, ({ from, until }) => {
        if (from !== null) expect(LocalDateTimeSchema.safeParse(from).success).toBe(true);
        if (until !== null) expect(LocalDateTimeSchema.safeParse(until).success).toBe(true);
        if (from !== null && until !== null) expect(from < until).toBe(true);
      }),
    );
  });

  it('schedule cases hold 1 to 8 playlists, 0 to 50 events and hours the schema accepts', () => {
    fc.assert(
      fc.property(scheduleCaseArb(false, anyZoneArb), (c) => {
        const count = Object.keys(c.playlists).length;
        expect(count).toBeGreaterThanOrEqual(1);
        expect(count).toBeLessThanOrEqual(8);
        expect(c.schedule.events.length).toBeLessThanOrEqual(50);
        for (const { playlistId: _, ...rule } of c.schedule.events) {
          expect(ScheduleRuleSchema.safeParse(rule).success).toBe(true);
        }
        if (c.display.workingHours !== null) {
          expect(WorkingHoursSchema.safeParse(c.display.workingHours).success).toBe(true);
        }
      }),
    );
  });
});

describe('planSchedulePublication: properties (property 3)', () => {
  it('in a zone this runtime knows, an accepted plan builds, parses, and is version 4 exactly when an event names another playlist', () => {
    fc.assert(
      fc.property(scheduleCaseArb(false, knownZoneArb), (c) => {
        const plan = planOf(c);
        if (!plan.ok) {
          expect(plan.issues.length).toBeGreaterThan(0);
          return;
        }
        const manifest = buildManifest(plan.draft, IDENTITY);
        expect(ManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest))).success).toBe(true);
        expect(manifest.schemaVersion === 4).toBe(namesAnotherPlaylist(c));
      }),
    );
  });

  it('in a zone this runtime refuses, an accepted plan builds only at version 1 (today: the zone question is open)', () => {
    // Today's behaviour, stated on purpose: the planner accepts any zone name, and
    // buildManifest's zone check (packages/domain/src/manifest.ts, a recorded shortcut) throws
    // at version 2 or later, which the API answers 500. What an unknown zone should do is
    // Michael's decision (adoption plan step 30).
    fc.assert(
      fc.property(scheduleCaseArb(false, unknownZoneArb), (c) => {
        const plan = planOf(c);
        if (!plan.ok) return;
        const version = manifestVersionFor(plan.draft);
        expect(version === 4).toBe(namesAnotherPlaylist(c));
        if (version === 1) {
          expect(ManifestSchema.safeParse(buildManifest(plan.draft, IDENTITY)).success).toBe(true);
        } else {
          expect(() => buildManifest(plan.draft, IDENTITY)).toThrow(RangeError);
        }
      }),
    );
  });
});

describe('planSchedulePublication: today’s behaviour outside the generators', () => {
  const image = { mediaId: ID.jpeg, durationMs: 5000, fit: null };
  const PLAYLISTS = {
    [ID.listDefault]: { name: 'Reception loop', items: [image] },
    [ID.listLunch]: { name: 'Lunch', items: [image] },
  };
  const lunch = { playlistId: ID.listLunch, days: WEEKDAYS, start: '11:30', end: '14:00' };

  it('unknown zone: a schedule that needs version 4 is planned, then buildManifest throws', () => {
    // The shrunk form of the case the plan suspected (section 4.4, "Suspected to fail today").
    const plan = planSchedule(
      PLAYLISTS,
      { defaultPlaylistId: ID.listDefault, events: [lunch] },
      { display: display({ timeZone: 'Mars/Olympus_Mons' }) },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(manifestVersionFor(plan.draft)).toBe(4);
    expect(() => buildManifest(plan.draft, IDENTITY)).toThrow(RangeError);
  });

  it('unknown zone: a playlist that needs only version 1 builds, and the zone is not in it', () => {
    const plan = planSchedule(
      PLAYLISTS,
      { defaultPlaylistId: ID.listDefault, events: [] },
      { display: display({ timeZone: 'Mars/Olympus_Mons' }) },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(buildManifest(plan.draft, IDENTITY).schemaVersion).toBe(1);
  });

  it('a media window year outside 1000 to 9999 is planned, then buildManifest throws (database guard: step 31, D7)', () => {
    // timestamp(0) holds such a year (0006) and to_char gives '0999' or '10000'; the manifest's
    // LocalDateTimeSchema refuses both. Since 0016 the column refuses them (media_availability_year,
    // D7), so only a database older than 0016 could hand the planner one.
    for (const from of ['0999-12-31T23:00', '10000-01-01T00:00']) {
      const plan = planSchedule(
        {
          [ID.listDefault]: { name: 'Windowed', items: [{ ...image, mediaId: WINDOWED_MEDIA_ID }] },
        },
        { defaultPlaylistId: ID.listDefault, events: [] },
        { mediaById: libraryWith({ from, until: null }) },
      );
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(() => buildManifest(plan.draft, IDENTITY)).toThrow(
        'built manifest failed schema validation: assets.0.availableFrom',
      );
    }
  });
});
