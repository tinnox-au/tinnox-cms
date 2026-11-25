/**
 * Migration 0014, e-mail alerts for screens (CMS-15, docs/portal-v2/stage-c-alerts.md section 7).
 *
 * Builds a database at migration 0013 with the seeders of the migrate-forward chain (levels.ts,
 * atLevel): among the organisations of the earlier levels, level 0013's seeder
 * (levels/seed-0013.ts) leaves two organisations with an Owner and a display each, in plain SQL
 * valid at 0013. Then it applies 0014 with the real migration runner, and checks that existing
 * displays get the defaults (an offline e-mail after 30 minutes, the back-online e-mail on), the
 * exact grants, and the two sec.* functions.
 *
 * The database is atLevel's own, dropped in `afterAll`; the shared integration-test database is
 * not touched.
 */
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertRecipientByTokenHash, displayAlertOrgs, poolAsTx } from '../src/index.ts';
import { withOrg, type Pool, databaseOn } from '../src/testing.ts';
import type { MigrationResult } from '../src/migrate.ts';
import { MIGRATIONS, atLevel, type LevelDatabase } from './levels.ts';
import { BEFORE_ALERTS_A, BEFORE_ALERTS_B } from './levels/seed-0013.ts';
import { appPool, testOrgId } from './support.ts';

const TARGET = '0014_display_alerts.sql';

let level: LevelDatabase | undefined;
let migrator: pg.Client | undefined;
let pool: Pool | undefined;
let upgrade: MigrationResult;
/** Every organisation of the levels before 0014, read as the administrator before the upgrade. */
let organisations: string[];

const org = (seeded: typeof BEFORE_ALERTS_B) => ({
  orgId: testOrgId(seeded.org),
  membershipId: seeded.owner,
});
const a = org(BEFORE_ALERTS_A);
const b = org(BEFORE_ALERTS_B);

beforeAll(async () => {
  const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
  expect(names).toContain(TARGET);
  expect(names.filter((n) => n < TARGET)).toHaveLength(13);
  level = await atLevel('0013', { seed: true });
  const admin = await level.administrator();
  try {
    const { rows } = await admin.query<{ id: string }>('SELECT id FROM organization ORDER BY id');
    organisations = rows.map((r) => r.id);
  } finally {
    await admin.end();
  }
  migrator = await level.migrator();
  upgrade = await level.upgrade();
  pool = appPool('tries the upgraded schema as the runtime role', 2, level.appUrl);
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

describe('migration 0014 on a database that already holds displays', () => {
  it('is applied on top of 0013, once', async () => {
    const later = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n > TARGET);
    expect(upgrade.alreadyApplied).toHaveLength(13);
    expect(upgrade.applied).toEqual([TARGET, ...later.sort()]);
    const again = await clients().level.upgrade();
    expect(again.applied).toEqual([]);
  });

  it('gives every existing display the defaults: 30 minutes and the back-online e-mail', async () => {
    for (const org of [a, b]) {
      const rows = await withOrg(clients().pool, org.orgId, async (tx) => {
        const result = await tx.query<{
          alert_offline_minutes: number | null;
          alert_back_online: boolean;
        }>('SELECT alert_offline_minutes, alert_back_online FROM display');
        return result.rows;
      });
      expect(rows).toEqual([{ alert_offline_minutes: 30, alert_back_online: true }]);
    }
  });
});

describe('grants', () => {
  const tablePrivileges = async (table: string, grantee: string) => {
    const { rows } = await clients().migrator.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 ORDER BY 1`,
      [table, grantee],
    );
    return rows.map((r) => r.privilege_type);
  };
  const columns = async (table: string, grantee: string, privilege: string) => {
    const { rows } = await clients().migrator.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = $3
       ORDER BY 1`,
      [table, grantee, privilege],
    );
    return rows.map((r) => r.column_name);
  };

  it('let tinnox_app update the two alert settings of a display', async () => {
    const updatable = await columns('display', 'tinnox_app', 'UPDATE');
    expect(updatable).toContain('alert_offline_minutes');
    expect(updatable).toContain('alert_back_online');
  });

  it('let tinnox_app open and close an episode, never change one', async () => {
    expect(await tablePrivileges('display_alert', 'tinnox_app')).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
    ]);
    expect(await columns('display_alert', 'tinnox_app', 'UPDATE')).toEqual([]);
    expect(await tablePrivileges('display_alert', 'tinnox_definer')).toEqual([]);
  });

  it('let tinnox_app change only the confirmation of an address', async () => {
    expect(await tablePrivileges('alert_recipient', 'tinnox_app')).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
    ]);
    expect(await columns('alert_recipient', 'tinnox_app', 'UPDATE')).toEqual([
      'confirm_expires_at',
      'confirm_token_hash',
      'confirmed_at',
    ]);
  });

  it('let tinnox_definer read five address columns, never the address', async () => {
    expect(await tablePrivileges('alert_recipient', 'tinnox_definer')).toEqual([]);
    expect(await columns('alert_recipient', 'tinnox_definer', 'SELECT')).toEqual([
      'confirm_expires_at',
      'confirm_token_hash',
      'confirmed_at',
      'id',
      'org_id',
    ]);
  });
});

describe('sec.* functions', () => {
  it('list organisation ids for the alert check, and nothing else', async () => {
    const ids = await displayAlertOrgs(poolAsTx(databaseOn(clients().pool)));
    // Every organisation of every level before 0014, these two among them.
    expect(ids).toEqual(organisations);
    expect(ids).toEqual(expect.arrayContaining([a.orgId, b.orgId]));
  });

  it('resolve only an unexpired, unconfirmed token', async () => {
    const { migrator: client, pool: app } = clients();
    const live = randomBytes(32);
    const expired = randomBytes(32);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [a.orgId]);
    // Each with its adder, as the API stores them: an address with none is dead (D22).
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO alert_recipient (org_id, email, created_by, confirm_token_hash, confirm_expires_at)
       VALUES ($1, 'live@example.com', $4, $2, now() + interval '1 day'),
              ($1, 'expired@example.com', $4, $3, now() - interval '1 second')
       RETURNING id`,
      [a.orgId, live, expired, a.membershipId],
    );
    await client.query('COMMIT');
    const tx = poolAsTx(databaseOn(app));
    expect(await alertRecipientByTokenHash(tx, live)).toEqual({
      orgId: a.orgId,
      recipientId: inserted.rows[0]?.id,
    });
    expect(await alertRecipientByTokenHash(tx, expired)).toBeNull();
    expect(await alertRecipientByTokenHash(tx, randomBytes(32))).toBeNull();
  });
});

describe('alert address shape', () => {
  it('refuses name, group, list and quoted forms the mailer would deliver elsewhere', async () => {
    const { pool: app } = clients();
    for (const email of [
      'attacker<victim@corp.com>',
      'foo,bar@evil.com',
      'a:b@corp.com;',
      '"x"@corp.com',
      'a b@corp.com',
    ]) {
      await expect(
        withOrg(app, b.orgId, (tx) =>
          tx.query(
            `INSERT INTO alert_recipient (org_id, email, confirm_token_hash, confirm_expires_at)
             VALUES (app_org_id(), $1, $2, now() + interval '1 day')`,
            [email, randomBytes(32)],
          ),
        ),
        email,
      ).rejects.toMatchObject({ code: '23514', constraint: 'alert_recipient_email_shape' });
    }
  });
});
