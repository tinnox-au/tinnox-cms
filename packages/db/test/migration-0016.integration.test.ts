/**
 * Migration 0016: the two address shapes take the contract's own shape, and both ends of a media
 * window the years 1000 to 9999 (adoption plan step 31, D7).
 *
 * Rebuilds the test database at migration 0015 with addresses and windows on the boundaries the
 * new checks draw, plus one row of each that the old checks let in and the new ones refuse. The
 * first upgrade must stop, name those three rows by table and id (never the address), and change
 * nothing. Once a person has closed, removed and cleared them, the upgrade applies, keeps every
 * other row as it was, keeps row-level security, grants and ownership, and the runtime role can
 * store exactly what the contract takes.
 *
 * It resets the shared integration-test database; `afterAll` always leaves it at the newest
 * migration.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg, type Pool } from '../src/testing.ts';
import { resetTestDatabase, runMigrations, type MigrationResult } from '../src/migrate.ts';
import {
  appPool,
  createOrg,
  migratorClient,
  migratorUrl,
  pgViolation,
  type TestOrg,
} from './support.ts';

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);
const TARGET = '0016_twin_guards.sql';
const TABLES = ['member_invite', 'alert_recipient', 'media'] as const;

/** 254 characters, the longest address either length check takes. */
const LONGEST = `${'l'.repeat(254 - '@example.com'.length)}@example.com`;
/** Addresses the old shapes took and the new ones take too: non-ASCII included (D7). */
const KEPT_INVITES = ['name@example.com', 'Ünïcödé@exämple.de', 'a@b.c', LONGEST];
const KEPT_ALERTS = ['name@example.com', 'ünïcödé@exämple.de', 'a@b.c', LONGEST];
/** The first and last minute LocalDateTimeSchema takes, and an ordinary window. */
const KEPT_WINDOWS: readonly (readonly [string | null, string | null])[] = [
  ['1000-01-01 00:00:00', '9999-12-31 23:59:00'],
  ['2026-12-01 09:00:00', null],
  [null, null],
];

let scratch: string | undefined;
let migrator: pg.Client | undefined;
let pool: Pool | undefined;
let org: TestOrg;
let refused: unknown;
let afterRefusal: { applied: string[]; definitions: Record<string, string>; rows: unknown[] };
let upgrade: MigrationResult;
let rowsBefore: unknown[];
const bad = { invite: '', alert: '', media: '' };

function clients(): { migrator: pg.Client; pool: Pool } {
  if (migrator === undefined || pool === undefined) throw new Error('beforeAll did not finish');
  return { migrator, pool };
}

/** Statements as the migrator inside the organisation, in one transaction, as TINNOX's scripts write. */
async function asOrg<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const { migrator: client } = clients();
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const insertInvite = (client: pg.Client, email: string) =>
  client
    .query<{ id: string }>(
      `INSERT INTO member_invite (org_id, role, name, email, invited_by, expires_at)
       VALUES (app_org_id(), 'editor', $1, $2, $3, now() + interval '14 days') RETURNING id`,
      [`Invited ${randomUUID()}`, email, org.membershipId],
    )
    .then((r) => r.rows[0]?.id ?? '');
const insertAlert = (client: pg.Client, email: string) =>
  client
    .query<{ id: string }>(
      `INSERT INTO alert_recipient (org_id, email, created_by, confirm_token_hash, confirm_expires_at)
       VALUES (app_org_id(), $1, $2, $3, now() + interval '1 day') RETURNING id`,
      [email, org.membershipId, randomBytes(32)],
    )
    .then((r) => r.rows[0]?.id ?? '');
const insertMedia = (client: pg.Client, from: string | null, until: string | null) =>
  client
    .query<{ id: string }>(
      `INSERT INTO media (org_id, kind, status, mime_type, bytes, sha256, original_name,
                          available_from, available_until)
       VALUES (app_org_id(), 'image', 'processing', 'image/png', 10, $1, 'window.png', $2, $3)
       RETURNING id`,
      ['cd'.repeat(32), from, until],
    )
    .then((r) => r.rows[0]?.id ?? '');

/** Every row of the three tables, as text, read inside the organisation. */
const everyRow = () =>
  asOrg(async (client) => {
    const read = async (sql: string): Promise<unknown[]> =>
      (await client.query<Record<string, unknown>>(sql)).rows;
    return [
      ...(await read('SELECT * FROM member_invite ORDER BY id')),
      ...(await read(
        'SELECT id, email, confirmed_at, created_by FROM alert_recipient ORDER BY id',
      )),
      ...(await read(
        `SELECT id, available_from::text, available_until::text, status FROM media ORDER BY id`,
      )),
    ];
  });

async function appliedNames(): Promise<string[]> {
  const { rows } = await clients().migrator.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY 1',
  );
  return rows.map((r) => r.name);
}

async function shapeDefinitions(): Promise<Record<string, string>> {
  const { rows } = await clients().migrator.query<{ name: string; definition: string }>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conname IN ('member_invite_email_shape', 'alert_recipient_email_shape',
                       'media_availability_year')
     ORDER BY 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.definition]));
}

beforeAll(async () => {
  const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
  const earlier = names.filter((n) => n < TARGET);
  expect(names).toContain(TARGET);
  expect(earlier).toHaveLength(15);
  scratch = await mkdtemp(join(tmpdir(), 'tinnox-migration-0016-'));
  for (const name of earlier) await copyFile(join(MIGRATIONS, name), join(scratch, name));
  await resetTestDatabase(migratorUrl());
  await runMigrations({ connectionString: migratorUrl(), directory: scratch });

  migrator = await migratorClient();
  pool = appPool('tries the upgraded address and window checks as the runtime role', 2);
  org = await createOrg(migrator, 'Before 0016');

  await asOrg(async (client) => {
    for (const email of KEPT_INVITES) await insertInvite(client, email);
    for (const email of KEPT_ALERTS) await insertAlert(client, email);
    for (const [from, until] of KEPT_WINDOWS) await insertMedia(client, from, until);
    // A closed invite keeps no address (member_invite_open): NULL passes the new shape.
    const closed = await insertInvite(client, 'closed@example.com');
    await client.query("UPDATE member_invite SET status = 'cancelled' WHERE id = $1", [closed]);
  });
  rowsBefore = await everyRow();

  // What only SQL by hand could store at 0015: the old shapes and the bare timestamp took them.
  await asOrg(async (client) => {
    bad.invite = await insertInvite(client, 'secret@nodot');
    bad.alert = await insertAlert(client, 'secret@one@two');
    bad.media = await insertMedia(client, '0999-12-31 23:59:00', null);
  });
  const withBad = await everyRow();
  const definitionsBefore = await shapeDefinitions();
  refused = await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS }).then(
    () => 'applied',
    (error: unknown) => error,
  );
  afterRefusal = {
    applied: await appliedNames(),
    definitions: await shapeDefinitions(),
    rows: await everyRow(),
  };
  expect(afterRefusal.definitions).toEqual(definitionsBefore);
  expect(afterRefusal.rows).toEqual(withBad);

  // What a person decides for each, as the message asks: close the invite, remove the address, clear
  // the window. The migration itself never does.
  await asOrg(async (client) => {
    await client.query("UPDATE member_invite SET status = 'cancelled' WHERE id = $1", [bad.invite]);
    await client.query('DELETE FROM alert_recipient WHERE id = $1', [bad.alert]);
    await client.query('UPDATE media SET available_from = NULL WHERE id = $1', [bad.media]);
  });
  rowsBefore = (await everyRow()).filter(
    (row) => ![bad.invite, bad.media].includes((row as { id: string }).id),
  );
  upgrade = await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await migrator?.end();
  // Whatever happened above, leave the shared test database at the newest migration.
  await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS });
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

describe('migration 0016 on a database with a row the new checks refuse', () => {
  it('stops, naming each such row by table and id and never its address, and changes nothing', () => {
    expect(refused).toMatchObject({ cause: { code: '23514' } });
    const { message } = refused as Error;
    expect(message).toBe(
      `migration 0016_twin_guards.sql failed and was rolled back: migration 0016 changed nothing: these rows break the rule it adds (an address like name@example.com, a media window year from 1000 to 9999): ${[
        `alert_recipient ${bad.alert}`,
        `media ${bad.media}`,
        `member_invite ${bad.invite}`,
      ].join(
        ', ',
      )}. Each is tenant data: correct, close or remove it with its organisation, then run the migrations again.`,
    );
    expect(message).not.toContain('secret');
    expect(afterRefusal.applied).not.toContain(TARGET);
  });
});

describe('migration 0016 once those rows are settled', () => {
  it('is applied on top of 0015, once', async () => {
    const later = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n > TARGET);
    expect(upgrade.alreadyApplied).toHaveLength(15);
    expect(upgrade.applied).toEqual([TARGET, ...later.sort()]);
    const again = await runMigrations({ connectionString: migratorUrl(), directory: MIGRATIONS });
    expect(again.applied).toEqual([]);
  });

  it('keeps every row: boundary addresses, non-ASCII addresses, a closed invite and both year ends', async () => {
    // The closed invite, and the media item of createOrg.
    expect(rowsBefore.length).toBe(
      KEPT_INVITES.length + 1 + KEPT_ALERTS.length + KEPT_WINDOWS.length + 1,
    );
    const after = (await everyRow()).filter(
      (row) => ![bad.invite, bad.media].includes((row as { id: string }).id),
    );
    expect(after).toEqual(rowsBefore);
  });

  it('holds the contract shape, with no ASCII restriction, and the year range on both columns', async () => {
    expect(await shapeDefinitions()).toEqual({
      alert_recipient_email_shape:
        "CHECK (((email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'::text) AND (email = lower(email)) AND (email !~ '[][<>()\\\\,;:\"[:space:]]'::text)))",
      media_availability_year:
        "CHECK ((((available_from IS NULL) OR ((available_from >= '1000-01-01 00:00:00'::timestamp without time zone) AND (available_from <= '9999-12-31 23:59:59'::timestamp without time zone))) AND ((available_until IS NULL) OR ((available_until >= '1000-01-01 00:00:00'::timestamp without time zone) AND (available_until <= '9999-12-31 23:59:59'::timestamp without time zone)))))",
      member_invite_email_shape:
        "CHECK ((email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'::text))",
    });
  });

  it('keeps row-level security forced, the owner, and the grants of 0013 and 0014', async () => {
    const { rows } = await clients().migrator.query<{
      name: string;
      forced: boolean;
      owner: string;
    }>(
      `SELECT relname AS name, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner
       FROM pg_class WHERE relname = ANY ($1) AND relnamespace = 'public'::regnamespace ORDER BY 1`,
      [TABLES],
    );
    expect(rows).toEqual(
      [...TABLES].sort().map((name) => ({ name, forced: true, owner: 'tinnox_migrator' })),
    );
    const definer = await clients().migrator.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'alert_recipient'
         AND grantee = 'tinnox_definer' AND privilege_type = 'SELECT' ORDER BY 1`,
    );
    expect(definer.rows.map((r) => r.column_name)).toEqual([
      'confirm_expires_at',
      'confirm_token_hash',
      'confirmed_at',
      'id',
      'org_id',
    ]);
  });

  it('lets the runtime role store the boundaries and refuses one step past each', async () => {
    const { pool: app } = clients();
    const attempt = (sql: string, values: unknown[]) =>
      pgViolation(withOrg(app, org.orgId, (tx) => tx.query(sql, values)));
    const invite = (email: string) =>
      attempt(
        `INSERT INTO member_invite (org_id, role, name, email, invited_by, expires_at)
         VALUES (app_org_id(), 'viewer', $1, $2, $3, now() + interval '14 days')`,
        [`New ${randomUUID()}`, email, org.membershipId],
      );
    const alert = (email: string) =>
      attempt(
        `INSERT INTO alert_recipient (org_id, email, confirm_token_hash, confirm_expires_at)
         VALUES (app_org_id(), $1, $2, now() + interval '1 day')`,
        [email, randomBytes(32)],
      );
    const window = (from: string | null, until: string | null) =>
      attempt(
        `INSERT INTO media (id, org_id, kind, status, mime_type, bytes, sha256, original_name,
                            available_from, available_until)
         VALUES ($1, app_org_id(), 'image', 'processing', 'image/png', 10, $2, 'w.png', $3, $4)`,
        [randomUUID(), 'ef'.repeat(32), from, until],
      );

    const unique = () => randomUUID().slice(0, 8);
    expect(await invite(`ü${unique()}@exämple.de`)).toBeNull();
    expect(await alert(`ü${unique()}@exämple.de`)).toBeNull();
    for (const email of [
      'a@b',
      'a@b@c',
      'a@b.c@d.e',
      '@b.c',
      'a@.',
      'a@b.',
      'a b@c.de',
      'a@b.c\n',
    ]) {
      expect(await invite(email), email).toEqual({
        code: '23514',
        constraint: 'member_invite_email_shape',
      });
      expect(await alert(email), email).toEqual({
        code: '23514',
        constraint: 'alert_recipient_email_shape',
      });
    }
    expect(await window('1000-01-01T00:00', '9999-12-31T23:59')).toBeNull();
    for (const [from, until] of [
      ['0999-12-31T23:59', null],
      [null, '10000-01-01T00:00'],
      ['2026-01-01T00:00', '10000-01-01T00:00'],
      ['-infinity', null],
      [null, 'infinity'],
    ] as const) {
      expect(await window(from, until), `${from} to ${until}`).toEqual({
        code: '23514',
        constraint: 'media_availability_year',
      });
    }
  });
});
