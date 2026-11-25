import fc from 'fast-check';
import { ManifestV4Schema, type ManifestV4, type WorkingHours } from '@tinnox/contracts';
import { describe, expect, it } from 'vitest';
import { KNOWN_ZONES, UNKNOWN_ZONES, momentArb } from './time-rules.test-support.ts';
import { playableIndexes } from './time-rules.ts';

// Adoption plan section 4.4, property 2, and D11: every run draws a fresh seed, and a failure
// prints the seed and the shrunk counterexample. A counterexample is committed below as a plain
// example test with its fix, never as a seed or path.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// The oracle reads the wall clock through its own formatter, not localWallClock.
const formatters = new Map<string, Intl.DateTimeFormat | null>();

interface Wall {
  readonly day: number;
  readonly minute: number;
  readonly stamp: string;
}

function oracleWall(epochMs: number, zone: string): Wall | null {
  if (!formatters.has(zone)) {
    try {
      formatters.set(
        zone,
        new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          hourCycle: 'h23',
          weekday: 'long',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      );
    } catch {
      formatters.set(zone, null);
    }
  }
  const formatter = formatters.get(zone);
  if (formatter === null || formatter === undefined) return null;
  const p = Object.fromEntries(formatter.formatToParts(epochMs).map((x) => [x.type, x.value]));
  return {
    day: WEEKDAYS.indexOf(p.weekday ?? ''),
    minute: Number(p.hour) * 60 + Number(p.minute),
    stamp: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`,
  };
}

function open(hours: WorkingHours | null, wall: Wall): boolean {
  const today = hours === null ? { start: '00:00', end: '24:00' } : hours[wall.day];
  return (
    today !== null &&
    today !== undefined &&
    minutesOf(today.start) <= wall.minute &&
    wall.minute < minutesOf(today.end)
  );
}

function covers(rule: { days: boolean[]; start: string; end: string }, wall: Wall): boolean {
  const [start, end, t] = [minutesOf(rule.start), minutesOf(rule.end), wall.minute];
  if (end > start) return rule.days[wall.day] === true && start <= t && t < end;
  return (
    (rule.days[wall.day] === true && t >= start) ||
    (rule.days[(wall.day + 6) % 7] === true && t < end)
  );
}

/** The slice each manifest index is in, from the playlist counts. */
function sliceOf(m: ManifestV4): number[] {
  return m.schedule.playlists.flatMap((p, s) => Array.from({ length: p.count }, () => s));
}

/**
 * What should play: an untrusted clock (behind the publication by more than five minutes) or zone
 * plays the default playlist whole; outside hours nothing; otherwise the first covering event
 * whose playlist has something in its window, skipping failed playlists, then the default.
 */
function oracle(m: ManifestV4, epochMs: number, skip: ReadonlySet<number>): number[] {
  const slice = sliceOf(m);
  const indexes = (s: number) => slice.flatMap((owner, i) => (owner === s ? [i] : []));
  const wall = epochMs < Date.parse(m.createdAt) - 300_000 ? null : oracleWall(epochMs, m.timeZone);
  if (wall === null) return indexes(0);
  if (!open(m.workingHours, wall)) return [];
  const order = [...m.schedule.events.filter((e) => covers(e, wall)).map((e) => e.playlist), 0];
  for (const s of order.filter((s) => s === 0 || !skip.has(s))) {
    const playable = indexes(s).filter((i) => {
      const a = m.assets[i];
      if (a === undefined || a.kind === 'app') return a !== undefined;
      return (
        (a.availableFrom ?? '') <= wall.stamp &&
        (a.availableUntil === null || wall.stamp < a.availableUntil)
      );
    });
    if (playable.length > 0) return playable;
  }
  return [];
}

describe('time-rules generators: self-checks', () => {
  it('manifests parse with ManifestV4Schema', () => {
    fc.assert(
      fc.property(momentArb(fc.constantFrom(...KNOWN_ZONES)), ({ manifest }) => {
        expect(ManifestV4Schema.safeParse(manifest).error?.issues ?? []).toEqual([]);
      }),
    );
  });
});

describe('playableIndexes: properties (property 2)', () => {
  it('at any instant in any zone, what plays is one playlist slice and equals the oracle', () => {
    fc.assert(
      fc.property(momentArb(fc.constantFrom(...KNOWN_ZONES)), ({ manifest, epochMs, skip }) => {
        const playing = playableIndexes(manifest, epochMs, skip);
        expect(new Set(playing.map((i) => sliceOf(manifest)[i])).size).toBeLessThanOrEqual(1);
        expect(playing).toEqual(oracle(manifest, epochMs, skip));
      }),
    );
  });

  it('a zone this runtime refuses plays the default playlist whole (today: the zone question is open)', () => {
    // Today's behaviour, stated on purpose: the player fails open on an unknown zone, ignoring
    // working hours, events and windows. What an unknown zone should do is Michael's decision
    // (adoption plan step 30).
    fc.assert(
      fc.property(momentArb(fc.constantFrom(...UNKNOWN_ZONES)), ({ manifest, epochMs, skip }) => {
        const count = manifest.schedule.playlists[0]?.count ?? 0;
        expect(playableIndexes(manifest, epochMs, skip)).toEqual(
          Array.from({ length: count }, (_, i) => i),
        );
      }),
    );
  });
});
