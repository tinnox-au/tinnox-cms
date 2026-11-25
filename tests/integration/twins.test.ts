/**
 * Twins (adoption plan section 4.4 and step 31, D7, U-13): a contract rule and the database CHECK
 * that holds the same value must agree. For generated input, the contract's parsed output is
 * compared with whether an INSERT of it as tinnox_app succeeds, in a transaction that is always
 * rolled back. A refused input goes to the database as the API would have normalised it (the
 * address contracts trim and lower-case), so normalisation alone never reads as a mismatch.
 *
 * "Contract accepts" must equal "database stores", except for the mismatches of TWIN_ALLOW_LIST
 * (twins-registers.ts), which are all "contract refuses, database stores" of a cross-row rule or
 * of a character class. The other way round is never kept: the API would answer 500.
 *
 * It also owns the CHECK constraints that the constraint registry rule of
 * packages/db/test/catalogue.integration.test.ts leaves out (step 25): each is compared by a pair here, or
 * registered in CHECK_TWINS with why it has none.
 *
 * D11: every run draws a fresh seed, and a failure prints the seed and the shrunk counterexample.
 * A counterexample is committed below as a plain example test with its fix, never as a seed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AlertEmailSchema,
  AlertOfflineMinutesSchema,
  InviteEmailSchema,
  LAYOUT_UNITS,
  LayoutInputSchema,
  LayoutZoneInputSchema,
  MediaPatchSchema,
  ScheduleInputSchema,
  rectsOverlap,
} from '@tinnox/contracts';
import { errorField, violatedConstraint, type OrgTx } from '@tinnox/db';
import { createPool, unjudgedSql, withOrg, type Pool } from '@tinnox/db/testing';
import {
  CHECK_TWINS,
  TWIN_ALLOW_LIST,
  TWIN_PAIRS,
  type AllowListName,
  type TwinPair,
} from './twins-registers.ts';
import { createOrg, migratorUrl, type TestOrg } from './support.ts';
import {
  addressArb,
  ASTRAL,
  CONTROL,
  DIRECTION,
  eventsArb,
  JS_ONLY_SPACE,
  NON_ASCII,
  offlineMinutesArb,
  PG_ONLY_SPACE,
  SHARED_SPACE,
  windowArb,
  zonesArb,
  type Box,
  type Rule,
} from './twins.test-support.ts';

const TWINS_FILE = 'tests/integration/twins-registers.ts';

let pool: Pool;
let migrator: pg.Client;
let org: TestOrg & { readonly playlistId: string };

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('TEST_DATABASE_URL is not set');
  pool = createPool({
    connectionString: url,
    applicationName: unjudgedSql(
      'compares each contract with an INSERT of its database twin, rolled back',
    ),
    max: 2,
  });
  migrator = new pg.Client({ connectionString: migratorUrl() });
  await migrator.connect();
  const created = await createOrg('Twins');
  const playlistId = await withOrg(pool, created.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO playlist (org_id, name) VALUES (app_org_id(), 'Twins') RETURNING id",
    );
    return rows[0]?.id ?? '';
  });
  org = { ...created, playlistId };
});
afterAll(async () => {
  await pool.end();
  await migrator.end();
});

// ------------------------------------------------------------------- the comparison

type Parsed<V> = { readonly ok: true; readonly value: V } | { readonly ok: false };
/** What a zod safeParse answers, without importing zod into this workspace. */
type SafeParse<V> = { success: true; data: V } | { success: false };
const parsed = <V>(result: SafeParse<V>): Parsed<V> =>
  result.success ? { ok: true, value: result.data } : { ok: false };

interface Pair<I, V> {
  readonly name: TwinPair;
  readonly parse: (input: I) => Parsed<V>;
  /** What reaches the database for an input the contract refuses: the contract's own normalisation. */
  readonly refusedValue: (input: I) => V;
  readonly store: (tx: OrgTx, value: V) => Promise<unknown>;
  /** The allow-list entries that explain "contract refuses, database stores", or none. */
  readonly allowedBy: (input: I) => readonly AllowListName[];
}

type Stored =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly constraint: string | null };

class RolledBack extends Error {}

/**
 * Runs `store` as tinnox_app in the test organisation and always rolls back. A CHECK violation
 * (23514) or a data error (class 22: a value the column type cannot hold, NUL in text) is the
 * database refusing; any other error means the harness is wrong and fails the test.
 */
async function tryStore(store: (tx: OrgTx) => Promise<unknown>): Promise<Stored> {
  try {
    await withOrg(pool, org.orgId, async (tx) => {
      await store(tx);
      throw new RolledBack('rolled back on purpose');
    });
  } catch (error) {
    if (error instanceof RolledBack) return { ok: true };
    const code = errorField(error, 'code');
    if (typeof code === 'string' && (code === '23514' || code.startsWith('22'))) {
      return { ok: false, code, constraint: violatedConstraint(error) };
    }
    throw error;
  }
  throw new Error('withOrg returned although its callback always throws');
}

/** CHECK names each pair's refusals reached, for the coverage case. */
const reached = new Map<TwinPair, Set<string>>();

/** Null when the two agree or an allow-list entry keeps the mismatch; otherwise what differs. */
async function mismatch<I, V>(pair: Pair<I, V>, input: I): Promise<string | null> {
  const contract = pair.parse(input);
  const value = contract.ok ? contract.value : pair.refusedValue(input);
  const db = await tryStore((tx) => pair.store(tx, value));
  if (!db.ok && db.constraint !== null) {
    const seen = reached.get(pair.name) ?? new Set<string>();
    seen.add(db.constraint);
    reached.set(pair.name, seen);
  }
  if (contract.ok === db.ok) return null;
  const shown = JSON.stringify(value);
  if (contract.ok && !db.ok) {
    return `${pair.name}: the contract accepts ${shown} and the database refuses it (${db.code} ${db.constraint ?? ''}). The API would answer 500: fix whichever side is wrong, in a new migration if it is the database. This direction is never allow-listed (D7).`;
  }
  if (pair.allowedBy(input).length > 0) return null;
  return `${pair.name}: the contract refuses ${shown} and the database stores it. A rule on one row's own columns goes into the database in a new migration with the next number; a rule across rows, or a character class the database is looser on, is an entry of TWIN_ALLOW_LIST in ${TWINS_FILE} with its reason and a property test (D7).`;
}

const assertTwins = <I, V>(pair: Pair<I, V>, arb: fc.Arbitrary<I>, numRuns: number) =>
  fc.assert(
    fc.asyncProperty(arb, async (input) => {
      expect(await mismatch(pair, input)).toBeNull();
    }),
    { numRuns },
  );

// ------------------------------------------------------------------------- the pairs

/** The character classes of the address entries, each kept for the database stores what they hold. */
const ADDRESS_CLASSES: readonly (readonly [AllowListName, RegExp])[] = [
  ['whitespace only JavaScript calls whitespace', /[\u00a0\u1680\u2007\u202f\ufeff]/gu],
  [
    'control and text-direction characters',
    // eslint-disable-next-line no-control-regex -- control characters are what this entry is about
    /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
  ],
];

/**
 * The entries that explain a refused address the database stored: the contract accepts the
 * address once every character of those classes is replaced by one plain letter.
 */
function addressAllowedBy(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: string,
): AllowListName[] {
  const used = ADDRESS_CLASSES.filter(([, chars]) => value.match(chars) !== null);
  if (used.length === 0) return [];
  const plain = used.reduce((text, [, chars]) => text.replace(chars, 'x'), value);
  return schema.safeParse(plain).success ? used.map(([name]) => name) : [];
}

const invitePair: Pair<string, string> = {
  name: 'invite address',
  parse: (input) => parsed(InviteEmailSchema.safeParse(input)),
  refusedValue: (input) => input.trim(),
  store: (tx, email) =>
    tx.query(
      `INSERT INTO member_invite (org_id, role, name, email, invited_by, expires_at)
       VALUES (app_org_id(), 'viewer', $1, $2, $3, now() + interval '14 days')`,
      [`Twin ${randomUUID()}`, email, org.membershipId],
    ),
  allowedBy: (input) => addressAllowedBy(InviteEmailSchema, input.trim()),
};

const alertPair: Pair<string, string> = {
  name: 'alert address',
  parse: (input) => parsed(AlertEmailSchema.safeParse(input)),
  refusedValue: (input) => input.trim().toLowerCase(),
  store: (tx, email) =>
    tx.query(
      `INSERT INTO alert_recipient (org_id, email, created_by, confirm_token_hash, confirm_expires_at)
       VALUES (app_org_id(), $1, $2, $3, now() + interval '1 day')`,
      [email, org.membershipId, randomBytes(32)],
    ),
  allowedBy: (input) => addressAllowedBy(AlertEmailSchema, input.trim().toLowerCase()),
};

interface Window {
  readonly from: string | null;
  readonly until: string | null;
}
const windowPair: Pair<Window, Window> = {
  name: 'media window',
  parse: (input) => {
    const result = MediaPatchSchema.safeParse({
      availableFrom: input.from,
      availableUntil: input.until,
    });
    return result.success
      ? {
          ok: true,
          value: {
            from: result.data.availableFrom ?? null,
            until: result.data.availableUntil ?? null,
          },
        }
      : { ok: false };
  },
  refusedValue: (input) => input,
  // As the media PATCH writes them (apps/api/src/routes/media.ts).
  store: (tx, window) =>
    tx.query(
      `INSERT INTO media (org_id, kind, status, mime_type, bytes, sha256, original_name,
                          available_from, available_until)
       VALUES (app_org_id(), 'image', 'processing', 'image/png', 10, $1, 'twin.png',
               $2::timestamp, $3::timestamp)`,
      ['ab'.repeat(32), window.from, window.until],
    ),
  allowedBy: () => [],
};

/** A days literal as the schedule routes send it, with NULL for an entry the contract refused. */
const daysLiteral = (days: Rule['days']) =>
  `{${days.map((d) => (d === null ? 'NULL' : d ? 't' : 'f')).join(',')}}`;
const schedulePair: Pair<Rule[], Rule[]> = {
  name: 'schedule events',
  parse: (input) => {
    const result = ScheduleInputSchema.safeParse({
      name: 'Twin',
      defaultPlaylistId: org.playlistId,
      events: input.map((rule) => ({ playlistId: org.playlistId, ...rule })),
    });
    return result.success ? { ok: true, value: result.data.events } : { ok: false };
  },
  refusedValue: (input) => input,
  // As the schedule routes write them (apps/api/src/routes/schedules.ts).
  store: async (tx, events) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO schedule (org_id, name, default_playlist_id) VALUES (app_org_id(), $1, $2)
       RETURNING id`,
      [`Twin ${randomUUID()}`, org.playlistId],
    );
    await tx.query(
      `INSERT INTO schedule_event
         (schedule_id, position, org_id, playlist_id, days, start_time, end_time)
       SELECT $1, (t.ordinal - 1)::int, app_org_id(), t.playlist_id, t.days::boolean[],
              t.start_time, t.end_time
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[])
            WITH ORDINALITY AS t(playlist_id, days, start_time, end_time, ordinal)`,
      [
        rows[0]?.id,
        events.map(() => org.playlistId),
        events.map((event) => daysLiteral(event.days)),
        events.map((event) => event.start),
        events.map((event) => event.end),
      ],
    );
  },
  allowedBy: () => [],
};

/** One zone's own rules, without the rules across zones: its fields and its end inside the square. */
const zoneAlone = (box: Box) =>
  LayoutZoneInputSchema.safeParse({ playlistId: org.playlistId, ...box }).success &&
  box.x + box.width <= LAYOUT_UNITS &&
  box.y + box.height <= LAYOUT_UNITS;
const layoutPair: Pair<Box[], Box[]> = {
  name: 'layout zones',
  parse: (input) => {
    const result = LayoutInputSchema.safeParse({
      name: 'Twin',
      zones: input.map((box) => ({ playlistId: org.playlistId, ...box })),
    });
    return result.success ? { ok: true, value: result.data.zones } : { ok: false };
  },
  refusedValue: (input) => input,
  // As the layout routes write them (apps/api/src/routes/layouts.ts).
  store: async (tx, zones) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO layout (org_id, name) VALUES (app_org_id(), $1) RETURNING id',
      [`Twin ${randomUUID()}`],
    );
    await tx.query(
      `INSERT INTO layout_zone (layout_id, position, org_id, playlist_id, x_bp, y_bp, width_bp, height_bp)
       SELECT $1, (t.ordinal - 1)::int, app_org_id(), t.playlist_id, t.x_bp, t.y_bp, t.width_bp, t.height_bp
       FROM unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::int[])
            WITH ORDINALITY AS t(playlist_id, x_bp, y_bp, width_bp, height_bp, ordinal)`,
      [
        rows[0]?.id,
        zones.map(() => org.playlistId),
        zones.map((zone) => zone.x),
        zones.map((zone) => zone.y),
        zones.map((zone) => zone.width),
        zones.map((zone) => zone.height),
      ],
    );
  },
  allowedBy: (input) => {
    // Kept only when every zone passes on its own and at most four would store.
    if (input.length > 4 || !input.every(zoneAlone)) return [];
    if (input.length < 2) return ['zone count below two'];
    const overlap = input.some((a, n) => input.slice(0, n).some((b) => rectsOverlap(a, b)));
    return overlap ? ['overlapping zones'] : [];
  },
};

const offlinePair: Pair<number | null, number | null> = {
  name: 'offline delay',
  parse: (input) => parsed(AlertOfflineMinutesSchema.nullable().safeParse(input)),
  refusedValue: (input) => input,
  store: (tx, minutes) =>
    tx.query(
      `INSERT INTO display (org_id, site_id, name, canvas_width, canvas_height, alert_offline_minutes)
       VALUES (app_org_id(), $1, $2, 640, 360, $3)`,
      [org.siteId, `Twin ${randomUUID()}`, minutes],
    ),
  allowedBy: () => [],
};

// --------------------------------------------------------------- generator self-checks

/** Each named predicate holds for at least one of `n` drawn values. */
function landsOn<T>(arb: fc.Arbitrary<T>, n: number, edges: Record<string, (value: T) => boolean>) {
  const drawn = fc.sample(arb, n);
  return Object.entries(edges)
    .filter(([, holds]) => !drawn.some(holds))
    .map(([name]) => name);
}
const has = (chars: readonly string[]) => (s: string) => chars.some((c) => s.includes(c));

describe('twins generators: self-checks', () => {
  it('addresses land on both answers, on 253 to 255 characters, and on every character class', () => {
    const trimmedLength = (n: number) => (s: string) => [...s.trim()].length === n;
    expect(
      landsOn(addressArb, 3000, {
        'invite accepts': (s) => InviteEmailSchema.safeParse(s).success,
        'invite refuses': (s) => !InviteEmailSchema.safeParse(s).success,
        'alert accepts': (s) => AlertEmailSchema.safeParse(s).success,
        '253 characters': trimmedLength(253),
        '254 characters': trimmedLength(254),
        '255 characters': trimmedLength(255),
        '254 characters outside the BMP': (s) => trimmedLength(254)(s) && s.startsWith('😀'),
        'shared whitespace': has(SHARED_SPACE),
        'JavaScript-only whitespace': has(JS_ONLY_SPACE),
        'PostgreSQL-only whitespace': has(PG_ONLY_SPACE),
        NUL: has(['\u0000']),
        'other control': has(CONTROL.slice(1)),
        'text direction': has(DIRECTION),
        'non-ASCII letter': has(NON_ASCII),
        'combining mark': has(['́']),
        'outside the BMP': has(ASTRAL),
        'upper case': (s) => /[A-Z]/.test(s),
        'two @': (s) => s.split('@').length > 2,
        'no dot after @': (s) => /@[^.]*$/.test(s),
        'a newline at the end': (s) => s.endsWith('\n'),
      }),
    ).toEqual([]);
  });

  it('windows land on years 999, 1000, 9999 and 10000, one end missing, and equal ends', () => {
    const year = (y: string) => (w: Window) => [w.from, w.until].some((s) => s?.startsWith(y));
    expect(
      landsOn(windowArb, 2000, {
        accepted: (w) => windowPair.parse(w).ok,
        refused: (w) => !windowPair.parse(w).ok,
        'year 999': year('0999-'),
        'year 1000': year('1000-'),
        'year 9999': year('9999-'),
        'year 10000': year('10000-'),
        'no start': (w) => w.from === null && w.until !== null,
        'no end': (w) => w.until === null && w.from !== null,
        'equal ends': (w) => w.from !== null && w.from === w.until,
        'one minute apart, accepted': (w) =>
          w.from !== null &&
          w.until !== null &&
          windowPair.parse(w).ok &&
          new Date(`${w.until}Z`).getTime() - new Date(`${w.from}Z`).getTime() === 60_000,
      }),
    ).toEqual([]);
  });

  it('schedules land on 50 and 51 events, empty rules, 24:00 and 00:00, a newline, and bad days', () => {
    const anyRule = (holds: (rule: Rule) => boolean) => (events: Rule[]) => events.some(holds);
    expect(
      landsOn(eventsArb, 2000, {
        accepted: (e) => schedulePair.parse(e).ok,
        refused: (e) => !schedulePair.parse(e).ok,
        'no event': (e) => e.length === 0,
        '50 events': (e) => e.length === 50,
        '51 events': (e) => e.length === 51,
        'start equals end': anyRule((r) => r.start === r.end),
        'start 24:00': anyRule((r) => r.start === '24:00'),
        'end 00:00': anyRule((r) => r.end === '00:00'),
        'end 24:00, accepted': (e) => schedulePair.parse(e).ok && e.some((r) => r.end === '24:00'),
        'a newline at the end': anyRule((r) => r.start.endsWith('\n') || r.end.endsWith('\n')),
        'no day': anyRule((r) => r.days.length === 7 && r.days.every((d) => d === false)),
        'a NULL day': anyRule((r) => r.days.includes(null)),
        'six or eight days': anyRule((r) => r.days.length === 6 || r.days.length === 8),
      }),
    ).toEqual([]);
  });

  it('zone sets land on zero to five zones, the square edge and one past it, touching and overlapping', () => {
    expect(
      landsOn(zonesArb, 2000, {
        accepted: (z) => layoutPair.parse(z).ok,
        'no zone': (z) => z.length === 0,
        'one zone': (z) => z.length === 1,
        'four zones': (z) => z.length === 4,
        'five zones': (z) => z.length === 5,
        'ends on the edge': (z) => z.some((b) => b.x + b.width === LAYOUT_UNITS),
        'ends one past the edge': (z) => z.some((b) => b.x + b.width === LAYOUT_UNITS + 1),
        overlapping: (z) => layoutPair.allowedBy(z).includes('overlapping zones'),
        'not an integer': (z) => z.some((b) => !Number.isSafeInteger(b.x) || b.x >= 2 ** 31),
      }),
    ).toEqual([]);
  });

  it('offline delays land on 30, 2880, one past each, off, and a part of a minute', () => {
    expect(
      landsOn(offlineMinutesArb, 1000, {
        off: (m) => m === null,
        '30': (m) => m === 30,
        '2880': (m) => m === 2880,
        '29': (m) => m === 29,
        '2910': (m) => m === 2910,
        '31': (m) => m === 31,
        'part of a minute': (m) => m !== null && !Number.isInteger(m),
      }),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------------ properties

describe('twins: the contract accepts exactly what the database stores', () => {
  it('invite address: InviteEmailSchema and member_invite_email_shape and _length', async () => {
    await assertTwins(invitePair, addressArb, 1000);
  });

  it('alert address: AlertEmailSchema and alert_recipient_email_shape and _length', async () => {
    await assertTwins(alertPair, addressArb, 1000);
  });

  it('media window: MediaPatchSchema and media_availability_order and _year', async () => {
    await assertTwins(windowPair, windowArb, 500);
  });

  it('schedule events: ScheduleInputSchema and the schedule_event CHECKs', async () => {
    await assertTwins(schedulePair, eventsArb, 300);
  });

  it('layout zones: LayoutInputSchema and layout_zone_in_bounds and _position_range', async () => {
    await assertTwins(layoutPair, zonesArb, 500);
  });

  it('offline delay: AlertOfflineMinutesSchema and display_alert_offline_minutes_range', async () => {
    await assertTwins(offlinePair, offlineMinutesArb, 300);
  });
});

// -------------------------------------------------------------------------- examples

/** Inputs on each edge of each pair: every CHECK a pair claims is refused by one of them. */
const EDGES = {
  'invite address': [
    'a@b.c',
    'a@b',
    'a@b@c.d',
    `${'a'.repeat(242)}@example.com`,
    `${'a'.repeat(243)}@example.com`,
  ],
  'alert address': [
    'A@B.C',
    'a@b',
    'a<b@c.d',
    `${'a'.repeat(242)}@example.com`,
    `${'a'.repeat(243)}@example.com`,
  ],
  'media window': [
    { from: '1000-01-01T00:00', until: '9999-12-31T23:59' },
    { from: '0999-12-31T23:59', until: null },
    { from: null, until: '10000-01-01T00:00' },
    { from: '2026-12-01T09:00', until: '2026-12-01T09:00' },
  ],
  'schedule events': [
    [{ days: [true, false, false, false, false, false, false], start: '00:00', end: '24:00' }],
    [{ days: [true, true, true, true, true, true], start: '09:00', end: '17:00' }],
    [{ days: [true, true, true, true, true, true, true], start: '24:00', end: '17:00' }],
    [{ days: [true, true, true, true, true, true, true], start: '09:00', end: '00:00' }],
    [{ days: [true, true, true, true, true, true, true], start: '09:00', end: '09:00' }],
    Array.from({ length: 51 }, () => ({
      days: [true, true, true, true, true, true, true],
      start: '09:00',
      end: '17:00',
    })),
  ],
  'layout zones': [
    [
      { x: 0, y: 0, width: 1, height: 10_000 },
      { x: 1, y: 0, width: 9999, height: 10_000 },
    ],
    [
      { x: 0, y: 0, width: 5000, height: 10_000 },
      { x: 5000, y: 0, width: 5001, height: 10_000 },
    ],
    Array.from({ length: 5 }, (_, n) => ({ x: n * 2000, y: 0, width: 2000, height: 10_000 })),
  ],
  'offline delay': [null, 30, 2880, 29, 31, 2910],
} satisfies Record<TwinPair, readonly unknown[]>;

const PAIRS = {
  'invite address': invitePair,
  'alert address': alertPair,
  'media window': windowPair,
  'schedule events': schedulePair,
  'layout zones': layoutPair,
  'offline delay': offlinePair,
} as const;

describe('twins: edges and the registers', () => {
  it.each(TWIN_PAIRS)(
    '%s: each edge agrees, and every CHECK the pair claims refuses one of them',
    async (name) => {
      const pair = PAIRS[name] as Pair<unknown, unknown>;
      // Only these edges count, whatever the properties above reached.
      reached.delete(name);
      for (const input of EDGES[name] as readonly unknown[]) {
        expect(await mismatch(pair, input), JSON.stringify(input)).toBeNull();
      }
      const claimed = Object.entries(CHECK_TWINS)
        .filter(([, twin]) => 'pair' in twin && twin.pair === name)
        .map(([key]) => key.split('.').at(-1));
      expect(claimed.length).toBeGreaterThan(0);
      const seen = reached.get(name) ?? new Set<string>();
      expect(claimed.filter((check) => check === undefined || !seen.has(check))).toEqual([]);
    },
  );

  it('every CHECK constraint is compared by a pair or registered with its reason (step 25 left them here)', async () => {
    const { rows } = await migrator.query<{ name: string }>(
      `SELECT n.nspname || '.' || t.relname || '.' || c.conname AS name
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'c' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       ORDER BY 1`,
    );
    const names = rows.map((r) => r.name);
    const problems = [
      ...names
        .filter((name) => CHECK_TWINS[name] === undefined)
        .map(
          (name) =>
            `${name} is a CHECK constraint with no entry in CHECK_TWINS (${TWINS_FILE}). If a contract parses the same value first, add a pair to twins.test.ts that compares them, or name the pair it joins; otherwise register it with the reason it has no twin.`,
        ),
      ...Object.keys(CHECK_TWINS)
        .filter((name) => !names.includes(name))
        .map(
          (name) =>
            `${name} is in CHECK_TWINS (${TWINS_FILE}) and is no longer a CHECK constraint: remove the entry.`,
        ),
    ];
    expect(problems).toEqual([]);
  });

  it('every allow-list entry still explains a real mismatch, and only in the database-looser direction', async () => {
    const cases: readonly [AllowListName, Pair<unknown, unknown>, unknown][] = [
      [
        'whitespace only JavaScript calls whitespace',
        invitePair as Pair<unknown, unknown>,
        'a\u00a0b@example.com',
      ],
      [
        'whitespace only JavaScript calls whitespace',
        alertPair as Pair<unknown, unknown>,
        'a\ufeffb@example.com',
      ],
      [
        'control and text-direction characters',
        invitePair as Pair<unknown, unknown>,
        'a\u0001b@example.com',
      ],
      [
        'control and text-direction characters',
        alertPair as Pair<unknown, unknown>,
        'a\u202eb@example.com',
      ],
      ['zone count below two', layoutPair as Pair<unknown, unknown>, []],
      [
        'zone count below two',
        layoutPair as Pair<unknown, unknown>,
        [{ x: 0, y: 0, width: 10_000, height: 10_000 }],
      ],
      [
        'overlapping zones',
        layoutPair as Pair<unknown, unknown>,
        [
          { x: 0, y: 0, width: 5001, height: 10_000 },
          { x: 5000, y: 0, width: 5000, height: 10_000 },
        ],
      ],
    ];
    for (const [entry, pair, input] of cases) {
      expect(pair.parse(input), `${entry}: the contract refuses`).toMatchObject({ ok: false });
      const db = await tryStore((tx) => pair.store(tx, pair.refusedValue(input)));
      expect(db, `${entry}: the database stores; if it refuses now, remove the entry`).toEqual({
        ok: true,
      });
      expect(pair.allowedBy(input)).toEqual([entry]);
    }
    const used = new Set(cases.map(([entry]) => entry));
    expect(Object.keys(TWIN_ALLOW_LIST).filter((name) => !used.has(name as AllowListName))).toEqual(
      [],
    );
  });

  it('two allow-listed classes in one address are kept together, and a class beside another fault is not', async () => {
    expect(await mismatch(invitePair, 'a\u00a0\u0001b@example.com')).toBeNull();
    expect(invitePair.allowedBy('a\u00a0\u0001b@example.com')).toEqual([
      'whitespace only JavaScript calls whitespace',
      'control and text-direction characters',
    ]);
    // The database refuses 'a\u00a0b@nodot' for its shape, so they agree; the entry never sees it.
    expect(invitePair.allowedBy('a\u00a0b@nodot')).toEqual([]);
    expect(await mismatch(invitePair, 'a\u00a0b@nodot')).toBeNull();
  });

  it('both sides count an address in code points, so characters outside the BMP agree at 254 and 255', async () => {
    // A counterexample to the first allow-list of this step, which assumed zod counts UTF-16 code
    // units: zod 4 counts code points, as char_length does.
    for (const pad of [249, 250]) {
      const address = `${'😀'.repeat(pad)}@b.co`;
      expect(address.length).toBe(pad * 2 + 5);
      expect(invitePair.parse(address)).toMatchObject({ ok: pad === 249 });
      expect(await mismatch(invitePair, address)).toBeNull();
      expect(await mismatch(alertPair, address)).toBeNull();
    }
  });

  it('the database shape takes the non-ASCII addresses the contract takes (D7: no ASCII restriction)', async () => {
    for (const address of ['ünïcödé@exämple.de', 'é@b.co', '中文@例子.中国', 'ß@ẞ.de']) {
      expect(InviteEmailSchema.safeParse(address).success, address).toBe(true);
      expect(await mismatch(invitePair, address), address).toBeNull();
      expect(await mismatch(alertPair, address), address).toBeNull();
    }
  });

  it("an alert address that lower-casing lengthens is measured again on both sides ('İ' becomes two code points)", async () => {
    const address = `${'İ'.repeat(127)}@b.co`;
    expect(address.length).toBe(132);
    expect(address.toLowerCase().length).toBe(259);
    expect(alertPair.parse(address)).toEqual({ ok: false });
    expect(await mismatch(alertPair, address)).toBeNull();
    expect(invitePair.parse(address)).toEqual({ ok: true, value: address });
    expect(await mismatch(invitePair, address)).toBeNull();
  });

  it("PostgreSQL reads '24:00' as the next midnight: a spelling the contract refuses of a value it takes, so not generated", async () => {
    const window = { from: '2026-01-01T24:00', until: null };
    expect(windowPair.parse(window)).toEqual({ ok: false });
    expect(await tryStore((tx) => windowPair.store(tx, window))).toEqual({ ok: true });
    expect(windowPair.parse({ from: '2026-01-02T00:00', until: null })).toMatchObject({ ok: true });
  });
});
