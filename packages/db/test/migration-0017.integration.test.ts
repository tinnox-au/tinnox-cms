/**
 * Migration 0017: a screen can be deleted (CMS-41). display gets deleted_at, tinnox_app's
 * UPDATE on the column, a guard that makes a deleted display final, and sec.pairing_claim
 * refuses a deleted display, again after the display's pairing lock.
 *
 * Builds a database at migration 0016 with the seeders of the migrate-forward chain (levels.ts,
 * atLevel), whose level 0013 leaves two organisations with an Owner and a display each
 * (levels/seed-0013.ts). Then it applies 0017 with the real migration runner and checks that
 * no display changed, the column, that display_org_idx is unchanged, the grant and the guard,
 * and, as the runtime role, the delete DELETE /api/displays/:id runs (softDeleteDisplay of
 * ../src/display-player.ts) against the guard and against a claim on another connection.
 *
 * The database is atLevel's own, dropped in `afterAll`; the shared integration-test database is
 * not touched.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pairingClaim, pairingComplete, pairingCreate, softDeleteDisplay } from '../src/index.ts';
import { heldTransactions, withOrg, type Pool } from '../src/testing.ts';
import type { MigrationResult } from '../src/migrate.ts';
import { MIGRATIONS, atLevel, type LevelDatabase } from './levels.ts';
import { BEFORE_ALERTS_A } from './levels/seed-0013.ts';
import {
  PG,
  appPool,
  asDefiner,
  hash,
  inTx,
  pairingCode,
  pgViolation,
  testOrgId,
  waitForLockWaiters,
} from './support.ts';

const TARGET = '0017_display_delete.sql';

let level: LevelDatabase | undefined;
let migrator: pg.Client | undefined;
let pool: Pool | undefined;
let upgrade: MigrationResult;
/** Every display of the levels before 0017, read as the administrator before the upgrade. */
let displaysBefore: unknown[];

/** Level 0013's first organisation and its Owner. */
const org = { orgId: testOrgId(BEFORE_ALERTS_A.org), membershipId: BEFORE_ALERTS_A.owner };

const DISPLAYS = 'SELECT id, name, assigned_playlist_id, updated_at FROM display ORDER BY id';

const CLAIM =
  'SELECT outcome, pairing_id, replaced_registration_id, cancelled_pairing_ids FROM sec.pairing_claim($1, $2, $3, 5, 600)';

beforeAll(async () => {
  const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
  expect(names).toContain(TARGET);
  expect(names.filter((n) => n < TARGET)).toHaveLength(16);
  level = await atLevel('0016', { seed: true });
  displaysBefore = await asAdministrator(DISPLAYS);
  migrator = await level.migrator();
  upgrade = await level.upgrade();
  pool = appPool('tries the soft delete of a display as the runtime role', 4, level.appUrl);
});

afterAll(async () => {
  await pool?.end();
  await migrator?.end();
  await level?.drop();
});

function clients(): { level: LevelDatabase; migrator: pg.Client; pool: Pool } {
  if (level === undefined || migrator === undefined || pool === undefined)
    throw new Error('beforeAll did not finish');
  return { level, migrator, pool };
}

async function asAdministrator(sql: string): Promise<unknown[]> {
  if (level === undefined) throw new Error('no level database');
  const admin = await level.administrator();
  try {
    return (await admin.query<Record<string, unknown>>(sql)).rows;
  } finally {
    await admin.end();
  }
}

/** A display of the organisation with no player, no claim and no tag. */
async function newDisplay(): Promise<string> {
  const id = randomUUID();
  const { migrator: client } = clients();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
  await client.query(
    `INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height)
     VALUES ($1, $2, $3, 'Level 0017 display', 640, 360)`,
    [id, org.orgId, BEFORE_ALERTS_A.site],
  );
  await client.query('COMMIT');
  return id;
}

/** Deletes a display with the code DELETE /api/displays/:id runs, in a transaction of its own. */
const deleteDisplay = (displayId: string) =>
  withOrg(clients().pool, org.orgId, (tx) => softDeleteDisplay(tx, displayId));

async function newCode() {
  const code = pairingCode();
  const pollingTokenHash = hash();
  const created = await inTx(clients().pool, (tx) =>
    pairingCreate(tx, {
      code,
      pollingTokenHash,
      clientKey: `m17-${randomUUID()}`,
      ttlSeconds: 600,
      maxSessionsPerClient: 10,
      windowSeconds: 600,
    }),
  );
  if (created.outcome !== 'created') throw new Error(`pairing not created: ${created.outcome}`);
  return { code, pairingId: created.pairingId, pollingTokenHash, deviceTokenHash: hash() };
}

const claim = (code: string, displayId: string) =>
  withOrg(clients().pool, org.orgId, (tx) =>
    pairingClaim(tx, {
      code,
      displayId,
      membershipId: org.membershipId,
      maxFailures: 5,
      windowSeconds: 600,
    }),
  );

async function statusOf(pairingId: string): Promise<string | undefined> {
  const [row] = await asDefiner<{ status: string }>(
    clients().migrator,
    'SELECT status FROM public.pairing_session WHERE id = $1',
    [pairingId],
  );
  return row?.status;
}

describe('migration 0017 on a database that already holds displays', () => {
  it('is applied on top of 0016, once', async () => {
    const later = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n > TARGET);
    expect(upgrade.alreadyApplied).toHaveLength(16);
    expect(upgrade.applied).toEqual([TARGET, ...later.sort()]);
    const again = await clients().level.upgrade();
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain(TARGET);
  });

  it('leaves every display live and unchanged', async () => {
    expect(displaysBefore.length).toBeGreaterThanOrEqual(9);
    expect(await asAdministrator(DISPLAYS)).toEqual(displaysBefore);
    expect(await asAdministrator('SELECT id FROM display WHERE deleted_at IS NOT NULL')).toEqual(
      [],
    );
  });

  it('adds a nullable deleted_at and keeps display_org_idx, which the alert check uses', async () => {
    const { rows: columns } = await clients().migrator.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'display' AND column_name = 'deleted_at'`,
    );
    expect(columns).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
    const { rows: indexes } = await clients().migrator.query<{ name: string; def: string }>(
      `SELECT indexname AS name, indexdef AS def FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'display' AND indexname IN ('display_live_idx', 'display_org_idx')`,
    );
    expect(indexes.map((index) => index.name)).toEqual(['display_org_idx']);
    expect(indexes[0]?.def).toMatch(/\(org_id, created_at\)$/);
  });

  it('lets tinnox_app set deleted_at, and still not delete a display', async () => {
    const { rows: updatable } = await clients().migrator.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'display' AND grantee = 'tinnox_app'
         AND privilege_type = 'UPDATE'`,
    );
    expect(updatable.map((r) => r.column_name)).toContain('deleted_at');
    const { rows: table } = await clients().migrator.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'display' AND grantee = 'tinnox_app'
       ORDER BY 1`,
    );
    expect(table.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('runs the guard before every update of a display, and nobody may call it directly', async () => {
    const { rows } = await clients().migrator.query<{ def: string; everyone: boolean }>(
      `SELECT pg_get_triggerdef(t.oid) AS def,
              has_function_privilege('public', t.tgfoid, 'EXECUTE') AS everyone
       FROM pg_trigger t WHERE t.tgrelid = 'public.display'::regclass
         AND t.tgname = 'display_deleted_guard'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.def).toMatch(
      /^CREATE TRIGGER display_deleted_guard BEFORE UPDATE ON public\.display FOR EACH ROW EXECUTE FUNCTION (public\.)?display_deleted_guard\(\)$/,
    );
    expect(rows[0]?.everyone).toBe(false);
  });

  it('keeps sec.pairing_claim as 0013 created it: owner, pinned search_path, EXECUTE for tinnox_app only', async () => {
    const { rows } = await clients().migrator.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('tinnox_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'sec' AND p.proname = 'pairing_claim'`,
    );
    expect(rows).toEqual([
      {
        owner: 'tinnox_definer',
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
        app: true,
        everyone: false,
      },
    ]);
  });
});

describe('a deleted display is final', () => {
  it('refuses an un-delete, an edit, an assignment and a second delete, and the row stays as the delete left it', async () => {
    const display = await newDisplay();
    await deleteDisplay(display);
    const read = 'SELECT name, deleted_at, updated_at FROM display WHERE id = $1';
    const readRow = () =>
      withOrg(clients().pool, org.orgId, async (tx) => {
        const { rows } = await tx.query<{
          name: string;
          deleted_at: Date | null;
          updated_at: Date;
        }>(read, [display]);
        return rows[0];
      });
    const deleted = await readRow();
    expect(deleted?.name).toBe('Level 0017 display');
    expect(deleted?.deleted_at).toBeInstanceOf(Date);
    for (const sql of [
      'UPDATE display SET deleted_at = NULL WHERE id = $1',
      "UPDATE display SET name = 'Back again' WHERE id = $1",
      'UPDATE display SET assigned_playlist_id = NULL WHERE id = $1',
      'UPDATE display SET deleted_at = now() WHERE id = $1',
    ]) {
      expect(
        await pgViolation(withOrg(clients().pool, org.orgId, (tx) => tx.query(sql, [display]))),
        sql,
      ).toEqual({ code: PG.restrict, constraint: 'display_deleted_guard' });
    }
    expect(await readRow()).toEqual(deleted);
  });

  it('a second delete finds no live row and changes nothing', async () => {
    const display = await newDisplay();
    await deleteDisplay(display);
    expect(await deleteDisplay(display)).toBeNull();
  });
});

describe('pairing a deleted display', () => {
  it('a claim is refused as display_not_found, and the code stays pending', async () => {
    const display = await newDisplay();
    await deleteDisplay(display);
    const pairing = await newCode();
    expect(await claim(pairing.code, display)).toEqual({ outcome: 'display_not_found' });
    expect(await statusOf(pairing.pairingId)).toBe('pending');
  });

  it('a claim that passed the display check while the delete was open waits for its pairing lock, then is refused', async () => {
    const display = await newDisplay();
    const pairing = await newCode();
    await heldTransactions(clients().pool, org.orgId, async (deleting, claiming) => {
      expect(await softDeleteDisplay(deleting.tx, display)).not.toBeNull();
      // The delete has not committed, so the claim's first check finds the display live.
      const late = claiming.tx.query(CLAIM, [pairing.code, display, org.membershipId]);
      await waitForLockWaiters(
        clients().pool,
        deleting.pid,
        1,
        "the claim never waited for the delete's pairing lock",
        { locktype: 'advisory', waiter: late },
      );
      await deleting.commit();
      expect((await late).rows).toEqual([
        {
          outcome: 'display_not_found',
          pairing_id: null,
          replaced_registration_id: null,
          cancelled_pairing_ids: null,
        },
      ]);
      await claiming.commit();
    });
    expect(await statusOf(pairing.pairingId)).toBe('pending');
  });

  it('a claim committed before the delete is cancelled by it and can no longer be collected', async () => {
    const display = await newDisplay();
    const pairing = await newCode();
    expect(await claim(pairing.code, display)).toMatchObject({ outcome: 'claimed' });
    expect((await deleteDisplay(display))?.cancelledPairingIds).toEqual([pairing.pairingId]);
    expect(await inTx(clients().pool, (tx) => pairingComplete(tx, pairing))).toEqual({
      outcome: 'not_claimable',
    });
    expect(await statusOf(pairing.pairingId)).toBe('expired');
  });
});
