/**
 * Migrate-forward, as one chain (adoption plan section 4.3, decision D13).
 *
 * The levels are read from db/migrations: 0004 and every later file. In a database of its own
 * (levels.ts; never the development database or the shared integration-test database), the chain
 * applies each level with the real migration runner, which checks the schema invariants after
 * every file, and runs that level's seeder at it (levels/seed-NNNN.ts, plain SQL valid at its
 * level). So every migration meets the rows of every level before it, as on an installation that
 * has followed main since 0004. At the newest migration it asserts what each migration did to each
 * seeded row, that rows, audit rows and stored manifests are kept, and that the catalogue equals
 * a fresh build.
 *
 * A level without a seeder fails here with the file to add; a seeder that leaves a row a later
 * migration refuses fails at that later level, naming it.
 */
import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deviceByRegistrationId,
  deviceByTokenHash,
  poolAsTx,
  sessionByIdHash,
} from '../src/index.ts';
import type { MigrationResult } from '../src/migrate.ts';
import { databaseOn } from '../src/testing.ts';
import {
  MIGRATIONS,
  atLevel,
  createLevelDatabase,
  currentLevels,
  releasedLevels,
  schemaSnapshot,
  type Level,
  type LevelDatabase,
} from './levels.ts';
import { A as A4, B as B4, LONG_AGO, PENDING_PAIRING, manifestOf } from './levels/seed-0004.ts';
import { A as A5 } from './levels/seed-0005.ts';
import { AVAILABLE_FROM, WORKING_HOURS } from './levels/seed-0006.ts';
import { A as A7, CLOCK_SETTINGS } from './levels/seed-0007.ts';
import { A as A9, WEEKDAYS } from './levels/seed-0009.ts';
import {
  COMPLETED_REGISTRATION,
  LAYOUT,
  PAIRINGS,
  UPGRADE_A,
  UPGRADE_B,
  UPGRADE_C,
} from './levels/seed-0011.ts';
import { BEFORE_ALERTS_A, BEFORE_ALERTS_B, INVITE_EMAIL } from './levels/seed-0013.ts';
import { RECIPIENTS } from './levels/seed-0014.ts';
import { DELETED_DISPLAY } from './levels/seed-0017.ts';
import { appPool } from './support.ts';

/**
 * Rows a migration writes itself, by level and table; every other table keeps its row count
 * across every migration. 0012 audits the cancellation of 0011's claims once per screen.
 */
const ROWS_WRITTEN_BY: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  '0012': { audit_event: 2 },
};

type Counts = Record<string, number>;
type AuditRow = Record<string, unknown> & { id: string; action: string };

let levels: Level[];
let db: LevelDatabase | undefined;
let fresh: LevelDatabase | undefined;
let admin: pg.Client | undefined;
/** Row counts across each migration: [level, before it was applied, after]. */
const across: [string, Counts, Counts][] = [];
/** Every audit row, as it was right after each seeder ran. */
const auditAsWritten = new Map<string, AuditRow>();
let upgrade: MigrationResult;
let again: MigrationResult;

function reader(): pg.Client {
  if (admin === undefined) throw new Error('beforeAll did not finish');
  return admin;
}

async function rows<R extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<R[]> {
  return (await reader().query<R>(sql, values)).rows;
}

/** Row counts of every table, read as the administrator (row-level security does not apply). */
async function counts(client: pg.Client): Promise<Counts> {
  const tables = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations' ORDER BY 1`,
  );
  const result: Counts = {};
  for (const { name } of tables.rows) {
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.${name}`,
    );
    result[name] = counted.rows[0]?.n ?? -1;
  }
  return result;
}

const AUDIT_COLUMNS =
  'id::text AS id, occurred_at, org_id, actor_type, actor_id, action, object_type, object_id, result, detail';

beforeAll(async () => {
  levels = await currentLevels();
  db = await createLevelDatabase();
  for (const level of levels) {
    const client = await db.administrator();
    try {
      const before = await counts(client);
      await db.applyThrough(level);
      across.push([level.level, before, await counts(client)]);
      await db.seed(level);
      const audit = await client.query<AuditRow>(`SELECT ${AUDIT_COLUMNS} FROM audit_event`);
      for (const row of audit.rows) auditAsWritten.set(row.id, row);
    } finally {
      await client.end();
    }
  }
  upgrade = await db.upgrade();
  again = await db.upgrade();
  admin = await db.administrator();
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
  await fresh?.drop();
});

describe('the levels (D13)', () => {
  it('are 0004 and every later file of db/migrations, each with a seeder', async () => {
    const files = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
    expect(levels).toEqual(releasedLevels(files));
    expect(levels[0]?.level).toBe('0004');
    expect(levels.at(-1)?.file).toBe(files.at(-1));
    expect(files.filter((n) => n < '0004')).toEqual([
      '0001_schema.sql',
      '0002_security_functions.sql',
      '0003_api_lookups.sql',
    ]);
  });
});

describe('the chain from 0004 to the newest migration', () => {
  it('ends at the newest migration, and a second run applies nothing', async () => {
    const files = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
    // Every file is a level, so the chain applied them all; the upgrade to HEAD finds nothing
    // left, and checks the schema invariants once more, as a run with nothing pending does.
    expect(upgrade).toEqual({ applied: [], alreadyApplied: files });
    expect(again).toEqual({ applied: [], alreadyApplied: files });
  });

  it('keeps the row count of every table across each migration, but for the rows a migration writes itself', () => {
    expect(across.map(([level]) => level)).toEqual(levels.map((l) => l.level));
    for (const [level, before, after] of across.slice(1)) {
      const changed: Counts = {};
      for (const [table, n] of Object.entries(after)) {
        const delta = n - (before[table] ?? 0);
        if (delta !== 0) changed[table] = delta;
      }
      for (const table of Object.keys(before)) {
        if (!(table in after)) changed[table] = -(before[table] ?? 0);
      }
      expect(changed, `rows changed by ${level}`).toEqual(ROWS_WRITTEN_BY[level] ?? {});
    }
  });

  it('accounts for every row: what the seeders planted and what 0012 wrote', async () => {
    expect(await counts(reader())).toEqual({
      alert_recipient: 2,
      app: 1,
      audit_event: 8,
      display: 10,
      display_alert: 1,
      display_delivery: 3,
      display_tag: 1,
      folder: 1,
      heartbeat_log: 1,
      layout: 1,
      layout_zone: 2,
      login_state: 0,
      media: 1,
      media_tag: 1,
      member_invite: 1,
      membership: 9,
      organization: 7,
      pairing_claim_failure: 0,
      pairing_session: 9,
      player_registration: 2,
      playlist: 2,
      playlist_item: 2,
      publication: 3,
      publication_asset: 3,
      schedule: 1,
      schedule_event: 1,
      session: 3,
      site: 7,
      tag: 2,
    });
  });

  it('keeps every audit row as it was written, and adds a category to those from before 0005', async () => {
    const now = await rows<AuditRow & { category: string }>(
      `SELECT ${AUDIT_COLUMNS}, category FROM audit_event ORDER BY id`,
    );
    expect(now).toHaveLength(auditAsWritten.size);
    for (const row of now) {
      const { category, ...rest } = row;
      expect(rest, `audit row ${row.id}`).toEqual(auditAsWritten.get(row.id));
      expect(category).toBe(row.action.split('.')[0]);
    }
  });

  // Not parsed with the contracts' ManifestSchema, as the plan has it: packages/db takes only
  // types from @tinnox/contracts (D19), tests included. seed-0004 writes them in the shape the
  // M0 API built, which ManifestSchema still takes; what the chain holds is that no migration
  // touched them.
  it('keeps every stored manifest exactly as it was published', async () => {
    const stored = await rows<{ id: string; display_id: string; manifest: unknown }>(
      'SELECT id, display_id, manifest FROM publication ORDER BY id',
    );
    expect(stored.map((p) => p.id)).toEqual([A4.publication1, A4.publication2, A4.publication3]);
    for (const { id, display_id: displayId, manifest } of stored) {
      expect(manifest, `publication ${id}`).toEqual(JSON.parse(manifestOf(id, displayId)));
    }
  });

  it('leaves the catalogue of a fresh build of the newest migration', async () => {
    const newest = levels.at(-1);
    if (newest === undefined) throw new Error('no level');
    fresh = await atLevel(newest.level, { seed: false, database: 'tinnox_migrate_fresh_test' });
    const client = await fresh.administrator();
    try {
      const built = await schemaSnapshot(client);
      expect(await schemaSnapshot(reader())).toEqual(built);
      // Spot checks, so the comparison cannot pass on two equally empty snapshots.
      expect(built.migrations).toHaveLength(levels.length + 3);
      expect(String(built.constraints)).toContain('media_availability_year');
      expect(String(built.tableGrants)).toContain('tinnox_app DELETE');
      expect(String(built.triggerDefinitions)).toContain('CREATE TRIGGER');
    } finally {
      await client.end();
    }
  });
});

describe('what each migration did to the seeded rows', () => {
  it('0005 assigns each display of 0004 the playlist of its desired publication, and keeps updated_at', async () => {
    const displays = await rows<{
      id: string;
      assigned_playlist_id: string | null;
      assigned_schedule_id: string | null;
    }>(
      'SELECT id, assigned_playlist_id, assigned_schedule_id FROM display WHERE org_id = ANY($1) ORDER BY id',
      [[A4.org, B4.org]],
    );
    expect(displays).toEqual([
      { id: A4.published, assigned_playlist_id: A4.playlist1, assigned_schedule_id: null },
      { id: A4.republished, assigned_playlist_id: A4.playlist2, assigned_schedule_id: null },
      // Never published, so 0005 assigned nothing; seed-0009 gave it a schedule.
      { id: A4.neverPublished, assigned_playlist_id: null, assigned_schedule_id: A9.schedule },
      { id: B4.display, assigned_playlist_id: null, assigned_schedule_id: null },
    ]);
    // No seeder touched these two after 0004: an assignment by a migration is not an edit.
    const untouched = await rows<{ updated_at: Date }>(
      'SELECT updated_at FROM display WHERE id = ANY($1)',
      [[A4.published, B4.display]],
    );
    expect(untouched.map((r) => r.updated_at.toISOString())).toEqual([LONG_AGO, LONG_AGO]);
  });

  it('0006 gives the displays and playlists of 0004 its defaults, and keeps what seed-0006 set', async () => {
    const displays = await rows<{ id: string; rotation: number; working_hours: unknown }>(
      'SELECT id, rotation, working_hours FROM display WHERE org_id = $1 ORDER BY id',
      [A4.org],
    );
    expect(displays).toEqual([
      { id: A4.published, rotation: 0, working_hours: null },
      { id: A4.republished, rotation: 90, working_hours: WORKING_HOURS },
      { id: A4.neverPublished, rotation: 0, working_hours: null },
    ]);
    expect(
      await rows(
        'SELECT id, description, transition, shuffle, deleted_at FROM playlist ORDER BY id',
        [],
      ),
    ).toEqual([
      {
        id: A4.playlist1,
        description: 'The first playlist',
        transition: 'cut',
        shuffle: false,
        deleted_at: null,
      },
      { id: A4.playlist2, description: null, transition: 'fade', shuffle: true, deleted_at: null },
    ]);
  });

  it('keeps the image of 0004 as 0005 and 0006 left it, inside the years 0016 takes', async () => {
    expect(
      await rows(
        `SELECT id, status, name, description, folder_id, default_duration_ms,
                to_char(available_from, 'YYYY-MM-DD HH24:MI:SS') AS available_from, available_until
         FROM media`,
      ),
    ).toEqual([
      {
        id: A4.media,
        status: 'ready',
        name: 'Pixel',
        description: 'One pixel, four times',
        folder_id: A5.folder,
        default_duration_ms: 8000,
        available_from: AVAILABLE_FROM,
        available_until: null,
      },
    ]);
    expect(await rows('SELECT media_id, tag_id FROM media_tag')).toEqual([
      { media_id: A4.media, tag_id: A5.mediaTag },
    ]);
    expect(await rows('SELECT display_id, tag_id FROM display_tag')).toEqual([
      { display_id: A4.published, tag_id: A5.displayTag },
    ]);
    expect(await rows('SELECT id, scope, colour FROM tag ORDER BY id')).toEqual([
      { id: A5.mediaTag, scope: 'media', colour: 'amber' },
      { id: A5.displayTag, scope: 'display', colour: 'teal' },
    ]);
  });

  it('keeps the playlist items of 0004 and 0007: one image, one app with a duration and no fit', async () => {
    expect(
      await rows(
        'SELECT playlist_id, position, media_id, app_id, duration_ms, fit FROM playlist_item ORDER BY playlist_id',
      ),
    ).toEqual([
      {
        playlist_id: A4.playlist1,
        position: 0,
        media_id: A4.media,
        app_id: null,
        duration_ms: 5000,
        fit: null,
      },
      {
        playlist_id: A4.playlist2,
        position: 0,
        media_id: null,
        app_id: A7.clock,
        duration_ms: 10000,
        fit: null,
      },
    ]);
    expect(await rows('SELECT id, type, settings FROM app')).toEqual([
      { id: A7.clock, type: 'clock', settings: CLOCK_SETTINGS },
    ]);
  });

  it('0011 assigns no layout to a display from before it', async () => {
    expect(
      await rows('SELECT id, assigned_layout_id FROM display WHERE id = ANY($1) ORDER BY id', [
        [A4.published, A4.republished, A4.neverPublished, B4.display],
      ]),
    ).toEqual(
      [A4.published, A4.republished, A4.neverPublished, B4.display]
        .sort()
        .map((id) => ({ id, assigned_layout_id: null })),
    );
  });

  it('keeps the schedule of 0009 and the layout of 0011', async () => {
    expect(await rows('SELECT id, default_playlist_id FROM schedule')).toEqual([
      { id: A9.schedule, default_playlist_id: A4.playlist1 },
    ]);
    expect(
      await rows('SELECT schedule_id, playlist_id, days, start_time, end_time FROM schedule_event'),
    ).toEqual([
      {
        schedule_id: A9.schedule,
        playlist_id: A4.playlist2,
        days: WEEKDAYS,
        start_time: '09:00',
        end_time: '17:00',
      },
    ]);
    expect(
      await rows(
        'SELECT layout_id, position, playlist_id, x_bp, y_bp, width_bp, height_bp FROM layout_zone ORDER BY position',
      ),
    ).toEqual([
      {
        layout_id: LAYOUT,
        position: 0,
        playlist_id: A4.playlist1,
        x_bp: 0,
        y_bp: 0,
        width_bp: 10000,
        height_bp: 8500,
      },
      {
        layout_id: LAYOUT,
        position: 1,
        playlist_id: A4.playlist2,
        x_bp: 0,
        y_bp: 8500,
        width_bp: 10000,
        height_bp: 1500,
      },
    ]);
  });

  it('0012 cancels the claims of 0011 that could still complete, audits each screen once, and leaves the other sessions', async () => {
    const statuses = await rows<{ id: string; status: string }>(
      'SELECT id, status FROM pairing_session ORDER BY id',
    );
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
      [A4.pairingCompleted]: 'completed',
      [PENDING_PAIRING.id]: 'pending',
      [PAIRINGS.firstOfTwo.id]: 'expired',
      [PAIRINGS.secondOfTwo.id]: 'expired',
      [PAIRINGS.otherOrg.id]: 'expired',
      // Past its expiry, so it could not complete anyway: not touched and not audited.
      [PAIRINGS.lapsed.id]: 'claimed',
      [PAIRINGS.pending.id]: 'pending',
      [PAIRINGS.locked.id]: 'locked',
      [PAIRINGS.completed.id]: 'completed',
    });
    expect(
      await rows(
        `SELECT org_id, actor_type, actor_id, object_type, object_id, result, detail
         FROM audit_event WHERE action = 'pairing.cancel' ORDER BY object_id`,
      ),
    ).toEqual(
      [
        {
          org_id: UPGRADE_A.org,
          object_id: UPGRADE_A.display,
          detail: {
            reason: 'upgrade',
            cancelledPairingIds: [PAIRINGS.firstOfTwo.id, PAIRINGS.secondOfTwo.id].sort(),
          },
        },
        {
          org_id: UPGRADE_B.org,
          object_id: UPGRADE_B.display,
          detail: { reason: 'upgrade', cancelledPairingIds: [PAIRINGS.otherOrg.id] },
        },
      ]
        .map((row) => ({
          ...row,
          actor_type: 'system',
          actor_id: null,
          object_type: 'display',
          result: 'success',
        }))
        .sort((x, y) => (x.object_id < y.object_id ? -1 : 1)),
    );
    expect(
      await rows('SELECT id, display_id, revoked_at FROM player_registration ORDER BY id'),
    ).toEqual([
      { id: A4.registration, display_id: A4.published, revoked_at: null },
      { id: COMPLETED_REGISTRATION.id, display_id: UPGRADE_C.display, revoked_at: null },
    ]);
  });

  it('0013 makes every member from before it an Owner, with the first sign-in of their earliest session', async () => {
    const members = await rows<{
      id: string;
      role: string;
      display_name: string | null;
      first_signed_in_at: Date | null;
      removed_at: Date | null;
      sessions_valid_after: Date | null;
    }>(
      `SELECT id, role, display_name, first_signed_in_at, removed_at, sessions_valid_after
       FROM membership ORDER BY id`,
    );
    const at = (iso: string) => new Date(iso);
    const owner = (id: string, first: Date | null) => ({
      id,
      role: 'owner',
      display_name: null,
      first_signed_in_at: first,
      removed_at: null,
      sessions_valid_after: null,
    });
    expect(members).toEqual(
      [
        owner(A4.owner, at(A4.ownerFirstSignIn)),
        owner(A4.second, null),
        owner(B4.owner, at(B4.ownerFirstSignIn)),
        owner(UPGRADE_A.member, null),
        owner(UPGRADE_B.member, null),
        owner(UPGRADE_C.member, null),
        // Created at 0013 as Owners and an Editor: the mapping had nothing to do with them.
        owner(BEFORE_ALERTS_A.owner, null),
        owner(BEFORE_ALERTS_B.owner, null),
        {
          ...owner(BEFORE_ALERTS_A.editor, null),
          role: 'editor',
          display_name: 'Level 0013 Editor',
        },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(await rows('SELECT id, status, role, email FROM member_invite')).toEqual([
      { id: BEFORE_ALERTS_A.invite, status: 'pending', role: 'viewer', email: INVITE_EMAIL },
    ]);
    expect(await rows('SELECT count(*)::int AS n FROM session WHERE revoked_at IS NULL')).toEqual([
      { n: 2 },
    ]);
  });

  it('0014 gives every display from before it the alert defaults, and keeps what seed-0014 set', async () => {
    const displays = await rows<{
      id: string;
      alert_offline_minutes: number | null;
      alert_back_online: boolean;
    }>(
      'SELECT id, alert_offline_minutes, alert_back_online FROM display WHERE id <> $1 ORDER BY id',
      [DELETED_DISPLAY],
    );
    expect(displays).toHaveLength(9);
    for (const display of displays) {
      expect(display, display.id).toEqual({
        id: display.id,
        alert_offline_minutes: display.id === BEFORE_ALERTS_A.display ? 60 : 30,
        alert_back_online: true,
      });
    }
    expect(
      await rows<{ id: string; email: string; confirmed: boolean }>(
        'SELECT id, email, confirmed_at IS NOT NULL AS confirmed FROM alert_recipient ORDER BY id',
      ),
    ).toEqual([
      { id: RECIPIENTS.confirmed.id, email: RECIPIENTS.confirmed.email, confirmed: true },
      { id: RECIPIENTS.unconfirmed.id, email: RECIPIENTS.unconfirmed.email, confirmed: false },
    ]);
    expect(await rows('SELECT display_id, org_id FROM display_alert')).toEqual([
      { display_id: A4.published, org_id: A4.org },
    ]);
  });

  it('0017 deletes no display from before it, and keeps the one seed-0017 deleted', async () => {
    expect(await rows('SELECT id FROM display WHERE deleted_at IS NOT NULL')).toEqual([
      { id: DELETED_DISPLAY },
    ]);
  });
});

// The sec.* functions that look up a session and a device credential were replaced after 0004
// (0010, 0013, 0015), so a row written at 0004 must still be read by today's versions, through
// the wrappers the API calls, as tinnox_app.
describe('rows of 0004 through the sec.* functions of the newest migration', () => {
  const lookups = async <T>(work: (db: ReturnType<typeof poolAsTx>) => Promise<T>): Promise<T> => {
    if (db === undefined) throw new Error('beforeAll did not finish');
    const pool = appPool('reads rows of 0004 through the newest sec.* functions', 1, db.appUrl);
    try {
      return await work(poolAsTx(databaseOn(pool)));
    } finally {
      await pool.end();
    }
  };
  const hash = (byte: number) => Buffer.alloc(32, byte);

  it("a live session of 0004 still resolves to its member, now an Owner, and the ended one doesn't", async () => {
    const [aLive, bLive, aEnded] = await lookups(async (app) => [
      await sessionByIdHash(app, hash(0x52), 1800),
      await sessionByIdHash(app, hash(0x53), 1800),
      await sessionByIdHash(app, hash(0x51), 1800),
    ]);
    expect(aLive).toMatchObject({ membershipId: A4.owner, orgId: A4.org, role: 'owner' });
    expect(bLive).toMatchObject({ membershipId: B4.owner, orgId: B4.org, role: 'owner' });
    expect(aEnded).toBeNull();
  });

  it("the credential of 0004's paired player still resolves to its display", async () => {
    const [byToken, byRegistration] = await lookups(async (app) => [
      await deviceByTokenHash(app, hash(0xa1)),
      await deviceByRegistrationId(app, A4.registration),
    ]);
    expect(byToken).toEqual({
      registrationId: A4.registration,
      orgId: A4.org,
      displayId: A4.published,
    });
    expect(byRegistration).toEqual({ orgId: A4.org, displayId: A4.published });
  });
});
