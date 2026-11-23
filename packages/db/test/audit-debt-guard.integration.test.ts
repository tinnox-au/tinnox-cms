/**
 * The audit-debt guard of the integration test database (adoption plan section 2.1 C, step 16;
 * decision D3): a transaction of the runtime role that changes audited state and commits no
 * audit_event row fails at COMMIT. This file proves the guard itself: what it refuses, what D3
 * exempts, whom it judges, and that it lives beside the schema without changing what the
 * migration runner's invariants read.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditScoped,
  auditUnscoped,
  createPool,
  heartbeatLogPurge,
  loginStatePut,
  loginStateTake,
  pairingCreate,
  pairingPoll,
  pairingPurge,
  poolAsTx,
  sessionByIdHash,
  sessionCreate,
  sessionPurgeExpired,
  sessionRevoke,
  sessionRevokeUnaudited,
  withOrg,
  withoutOrg,
  withResolvedOrg,
  type OrgTx,
  type Pool,
} from '../src/index.ts';
import { readSchemaFacts, schemaInvariantProblems } from '../src/schema-invariants.ts';
import {
  AUDIT_DEBT_SQLSTATE,
  ensureAuditDebtGuard,
  installAuditDebtGuard,
  removeAuditDebtGuard,
  watchAuditDebt,
  whileUnauditedAllowed,
} from '../src/testing.ts';
import {
  appPool,
  asDefiner,
  createOrg,
  hash,
  migratorClient,
  migratorUrl,
  pairingCode,
  type TestOrg,
} from './support.ts';

/** As tinnox_app under a name of product code, the way the API's pool connects: judged. */
let judged: Pool;
/** As tinnox_app for the test's own SQL: not judged. */
let testSql: Pool;
let migrator: pg.Client;
let org: TestOrg;
const refusals = watchAuditDebt();

beforeAll(async () => {
  judged = createPool({
    connectionString: process.env['TEST_DATABASE_URL'] ?? '',
    applicationName: 'tinnox-audit-debt-test',
    max: 2,
  });
  testSql = appPool('the guard test’s own SQL, which the guard must not judge', 2);
  migrator = await migratorClient();
  org = await createOrg(migrator, 'Audit debt');
});
afterAll(async () => {
  // Whatever a failed test left behind, the files after this one get the guard whole.
  await ensureAuditDebtGuard(migratorUrl());
  await judged.end();
  await testSql.end();
  await migrator.end();
});

// The guard reads the insert alone, so the ids these events name need not be rows; an operator
// and an object are still named, as AuditInput requires (AG-3.3).
const ACTOR_ID = randomUUID();
const OBJECT_ID = randomUUID();
const AUDIT = {
  actorType: 'operator',
  actorId: ACTOR_ID,
  action: 'folder.create',
  objectType: 'folder',
  objectId: OBJECT_ID,
  result: 'success',
  detail: null,
} as const;
/** An event of the kind written with no organisation: here only its insert matters. */
const UNSCOPED_AUDIT = {
  actorType: 'anonymous',
  actorId: null,
  action: 'pairing.create',
  objectType: 'pairing_session',
  objectId: OBJECT_ID,
  result: 'success',
  detail: null,
} as const;
const ALERT_AUDIT = {
  actorType: 'system',
  actorId: null,
  objectType: 'display',
  objectId: OBJECT_ID,
  result: 'success',
  detail: { recipients: 1 },
} as const;

const newFolder = (tx: OrgTx, name: string) =>
  tx.query('INSERT INTO folder (org_id, name) VALUES (app_org_id(), $1)', [name]);

async function folders(name: string): Promise<number> {
  return withOrg(testSql, org.orgId, async (tx) => {
    const { rowCount } = await tx.query('SELECT 1 FROM folder WHERE name = $1', [name]);
    return rowCount ?? 0;
  });
}

/**
 * The guard's refusal of `work`: its message, as the driver gave it and as the watch of the
 * file set-up recorded it. Taking it from the watch is what lets a test refuse on purpose.
 */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  const error: unknown = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, 'the commit went through').toBeInstanceOf(pg.DatabaseError);
  const refused = error as pg.DatabaseError;
  expect(refused.code).toBe(AUDIT_DEBT_SQLSTATE);
  expect(refused.constraint).toBe('audit_debt');
  expect(refusals.take()).toEqual([refused.message]);
  return refused.message;
}

/** A pairing session made on the test's own pool, and the token that polls it. */
async function newPairing(): Promise<{ id: string; token: Buffer }> {
  const token = hash();
  const created = await withoutOrg(testSql, (tx) =>
    pairingCreate(tx, {
      code: pairingCode(),
      pollingTokenHash: token,
      clientKey: `audit-debt-${randomUUID()}`,
      ttlSeconds: 600,
      maxSessionsPerClient: 5,
      windowSeconds: 600,
    }),
  );
  if (created.outcome !== 'created') throw new Error(`pairing not created: ${created.outcome}`);
  return { id: created.pairingId, token };
}

/** A live session of the organisation's member, made on the test's own pool. */
async function newSession(): Promise<Buffer> {
  const idHash = hash();
  const created = await withoutOrg(testSql, (tx) =>
    sessionCreate(tx, {
      idHash,
      oidcSub: org.oidcSub,
      // A placeholder of the length the column's CHECK wants.
      csrfToken: 'c'.repeat(43),
      ttlSeconds: 3600,
      idToken: null,
      authTime: new Date(Date.now() + 60_000),
    }),
  );
  if (created.outcome !== 'created') throw new Error(`session not created: ${created.outcome}`);
  return idHash;
}

describe('the audit-debt guard refuses a change with no audit row (D3)', () => {
  it('fails the COMMIT, names the table and says to write the audit row on the same Tx', async () => {
    const message = await refusalOf(withOrg(judged, org.orgId, (tx) => newFolder(tx, 'Unpaid')));
    expect(message).toMatch(
      /^audit debt: this transaction changed public\.folder \(INSERT\) as tinnox_app and commits no audit_event row\./,
    );
    expect(message).toMatch(
      /Write the audit row on the same Tx as the change, with auditScoped\(tx, event\) or auditUnscoped\(tx, event\) from @tinnox\/db/,
    );
    expect(message).toMatch(/packages\/db\/src\/audit-debt-guard\.ts/);
    // Refused means rolled back: run() treats class 23 at COMMIT as a definite failure.
    expect(await folders('Unpaid')).toBe(0);
  });

  it('names every table the transaction changed, once each', async () => {
    const message = await refusalOf(
      withOrg(judged, org.orgId, async (tx) => {
        await newFolder(tx, 'Unpaid one');
        await newFolder(tx, 'Unpaid two');
        await tx.query('UPDATE display SET name = $2 WHERE id = $1', [org.displayId, 'Renamed']);
        await tx.query('DELETE FROM folder WHERE name = $1', ['Unpaid two']);
      }),
    );
    expect(message).toContain(
      'changed public.folder (INSERT), public.display (UPDATE), public.folder (DELETE) as tinnox_app',
    );
  });

  it('passes when the audit row is on the same Tx, before or after the change, scoped or not', async () => {
    await withOrg(judged, org.orgId, async (tx) => {
      await newFolder(tx, 'Paid after');
      await auditScoped(tx, AUDIT);
    });
    await withOrg(judged, org.orgId, async (tx) => {
      await auditScoped(tx, AUDIT);
      await newFolder(tx, 'Paid before');
    });
    // sec.audit_unscoped inserts as tinnox_definer; the session is still the runtime role's.
    // The unscoped writer takes the handle from before the organisation is entered.
    await withResolvedOrg(judged, async (tx, enterOrg) => {
      await newFolder(await enterOrg(org.orgId), 'Paid unscoped');
      await auditUnscoped(tx, UNSCOPED_AUDIT);
    });
    expect(await folders('Paid after')).toBe(1);
    expect(await folders('Paid before')).toBe(1);
    expect(await folders('Paid unscoped')).toBe(1);
  });

  it('refuses the change when its audit row is written in a second transaction (CX-01)', async () => {
    await refusalOf(withOrg(judged, org.orgId, (tx) => newFolder(tx, 'Paid too late')));
    await withOrg(judged, org.orgId, (tx) => auditScoped(tx, AUDIT));
    expect(await folders('Paid too late')).toBe(0);
  });

  it('refuses a statement that commits on its own: the session revoked with no audit row', async () => {
    const idHash = await newSession();
    const message = await refusalOf(sessionRevokeUnaudited(judged, idHash));
    expect(message).toContain('changed public.session (UPDATE) as tinnox_app');
    // The same revocation with its audit row.
    await withoutOrg(judged, async (tx) => {
      expect(await sessionRevoke(tx, idHash)).not.toBeNull();
      await auditUnscoped(tx, { ...AUDIT, action: 'auth.logout', objectType: 'membership' });
    });
  });

  it('takes a debt, or a payment, back with the savepoint that is rolled back', async () => {
    const client = await judged.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await client.query('SAVEPOINT attempt');
      await client.query("INSERT INTO folder (org_id, name) VALUES (app_org_id(), 'Undone')");
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await client.query("INSERT INTO folder (org_id, name) VALUES (app_org_id(), 'Kept')");
      await client.query('SAVEPOINT attempt');
      await client.query(
        `INSERT INTO audit_event (org_id, actor_type, action, result)
         VALUES (app_org_id(), 'system', 'folder.create', 'success')`,
      );
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      const message = await refusalOf(client.query('COMMIT'));
      expect(message).toContain('public.folder (INSERT)');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await folders('Kept')).toBe(0);
  });
});

describe('what D3 exempts owes nothing', () => {
  it('the heartbeat log and the delivery state a heartbeat reports', async () => {
    const [registration] = await asDefiner<{ id: string }>(
      migrator,
      'INSERT INTO public.player_registration (org_id, display_id, token_hash) VALUES ($1, $2, $3) RETURNING id',
      [org.orgId, org.displayId, hash()],
    );
    await withOrg(judged, org.orgId, async (tx) => {
      await tx.query(
        `INSERT INTO heartbeat_log (org_id, display_id, registration_id, seq, accepted, received_at, payload)
         VALUES (app_org_id(), $1, $2, 1, true, now() - interval '2 hours', '{}')`,
        [org.displayId, registration?.id],
      );
      await tx.query('UPDATE display_delivery SET last_seq = 1 WHERE display_id = $1', [
        org.displayId,
      ]);
    });
    // The purge of that history, in a statement of its own as housekeeping sends it.
    expect(await heartbeatLogPurge(poolAsTx(judged), 3600)).toBeGreaterThanOrEqual(1);
  });

  it('login state, put and taken', async () => {
    const stateHash = hash();
    await loginStatePut(poolAsTx(judged), {
      stateHash,
      codeVerifier: 'v'.repeat(43),
      nonce: 'n'.repeat(43),
      returnTo: null,
      ttlSeconds: 60,
    });
    expect(await loginStateTake(poolAsTx(judged), stateHash)).not.toBeNull();
  });

  it('session activity: last_seen_at alone', async () => {
    const idHash = await newSession();
    expect(await sessionByIdHash(poolAsTx(judged), idHash, 3600)).not.toBeNull();
  });

  it('the wrong-attempt counter of a pairing poll, but not the attempt that locks the session', async () => {
    const pairing = await newPairing();
    const wrong = (maxWrongAttempts: number) =>
      withoutOrg(judged, (tx) =>
        pairingPoll(tx, { pairingId: pairing.id, pollingTokenHash: hash(), maxWrongAttempts }),
      );
    expect((await wrong(5)).outcome).toBe('wrong_token');
    // The lock changes status too, and that is audited as pairing.lock by the route.
    const message = await refusalOf(wrong(2));
    expect(message).toContain('changed public.pairing_session (UPDATE) as tinnox_app');
  });

  it('the purges, told apart by the function that makes the write', async () => {
    const idHash = await newSession();
    const pairing = await newPairing();
    await asDefiner(
      migrator,
      `UPDATE public.session SET revoked_at = now() - interval '2 days' WHERE id_hash = $1`,
      [idHash],
    );
    await asDefiner(
      migrator,
      `UPDATE public.pairing_session SET created_at = now() - interval '2 hours' WHERE id = $1`,
      [pairing.id],
    );
    expect(await sessionPurgeExpired(poolAsTx(judged))).toBeGreaterThanOrEqual(1);
    expect(await pairingPurge(poolAsTx(judged), 3600)).toBeGreaterThanOrEqual(1);
  });
});

// Neither write is exempt by D3, so the guard refuses both. Whether they are audited or exempt is
// a decision for Michael (step 16 report); until then only the product tests that make them let
// them pass, each with whileUnauditedAllowed and the reason "undecided".
describe('writes D3 does not name are judged until they are decided', () => {
  it('the alert check closing an offline episode without an e-mail', async () => {
    const offlineSince = new Date(Date.now() - 3_600_000);
    // Opening an episode is audited state: without its row it is refused.
    const opening = await refusalOf(
      withOrg(judged, org.orgId, (tx) =>
        tx.query(
          'INSERT INTO display_alert (display_id, org_id, offline_since) VALUES ($1, app_org_id(), $2)',
          [org.displayId, offlineSince],
        ),
      ),
    );
    expect(opening).toContain('public.display_alert (INSERT)');
    await withOrg(judged, org.orgId, async (tx) => {
      await tx.query(
        'INSERT INTO display_alert (display_id, org_id, offline_since) VALUES ($1, app_org_id(), $2)',
        [org.displayId, offlineSince],
      );
      await auditScoped(tx, { ...ALERT_AUDIT, action: 'display.offline_alert' });
    });
    const closing = await refusalOf(
      withOrg(judged, org.orgId, (tx) =>
        tx.query('DELETE FROM display_alert WHERE display_id = $1', [org.displayId]),
      ),
    );
    expect(closing).toContain('public.display_alert (DELETE)');
    // A close with its e-mail writes display.online_alert in the same transaction.
    await withOrg(judged, org.orgId, async (tx) => {
      await tx.query('DELETE FROM display_alert WHERE display_id = $1', [org.displayId]);
      await auditScoped(tx, { ...ALERT_AUDIT, action: 'display.online_alert' });
    });
  });

  it('a pairing session past its expiry, marked expired by the next poll of it', async () => {
    const pairing = await newPairing();
    await asDefiner(
      migrator,
      `UPDATE public.pairing_session SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [pairing.id],
    );
    const message = await refusalOf(
      withoutOrg(judged, (tx) =>
        pairingPoll(tx, {
          pairingId: pairing.id,
          pollingTokenHash: pairing.token,
          maxWrongAttempts: 5,
        }),
      ),
    );
    expect(message).toContain('public.pairing_session (UPDATE)');
  });
});

describe('whom the guard judges', () => {
  it('not tinnox_migrator, which arranges data for tests', async () => {
    await migrator.query('BEGIN');
    await migrator.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    await migrator.query('INSERT INTO folder (org_id, name) VALUES ($1, $2)', [
      org.orgId,
      'By the migrator',
    ]);
    await migrator.query('COMMIT');
    expect(await folders('By the migrator')).toBe(1);
  });

  it('not a tinnox_app connection named for the test’s own SQL', async () => {
    await withOrg(testSql, org.orgId, (tx) => newFolder(tx, 'By the test'));
    expect(await folders('By the test')).toBe(1);
  });

  it('lets one table through for the test of a path that is unaudited by decision, and only meanwhile', async () => {
    const idHash = await newSession();
    const ended = await whileUnauditedAllowed(
      migratorUrl(),
      'session',
      'this test stands in for the accepted CX-01 residual of the sign-out route',
      async () => {
        // Another table is judged as ever.
        await refusalOf(withOrg(judged, org.orgId, (tx) => newFolder(tx, 'Still judged')));
        return sessionRevokeUnaudited(judged, idHash);
      },
    );
    expect(ended).toBe(true);
    await refusalOf(sessionRevokeUnaudited(judged, await newSession()));
    await expect(
      whileUnauditedAllowed(migratorUrl(), 'session', 'because', () => Promise.resolve()),
    ).rejects.toThrow(/needs the decision that leaves this path unaudited/);
    await expect(
      whileUnauditedAllowed(
        migratorUrl(),
        'heartbeat_log',
        'a table the guard does not watch at all',
        () => Promise.resolve(),
      ),
    ).rejects.toThrow(/heartbeat_log is not a table the audit-debt guard watches/);
  });
});

describe('the guard beside the schema', () => {
  const guardObjects = async (): Promise<string[]> => {
    const { rows } = await migrator.query<{ name: string }>(
      `SELECT 'function ' || p.proname AS name FROM pg_proc p WHERE p.proname LIKE 'audit\\_debt\\_%'
       UNION ALL
       SELECT 'trigger ' || t.tgname || ' on ' || t.tgrelid::regclass::text FROM pg_trigger t
       WHERE t.tgname LIKE 'audit\\_debt\\_%'
       ORDER BY 1`,
    );
    return rows.map((row) => row.name);
  };

  it('refuses a database that is not a test database, before it reads anything else', async () => {
    const other = new URL(migratorUrl());
    other.pathname = '/postgres';
    for (const touch of [installAuditDebtGuard, ensureAuditDebtGuard, removeAuditDebtGuard]) {
      await expect(touch(other.toString())).rejects.toThrow(
        /refusing to touch the audit-debt guard in database "postgres": it is a test-only guard/,
      );
    }
  });

  it('refuses any role but tinnox_migrator', async () => {
    await expect(installAuditDebtGuard(process.env['TEST_DATABASE_URL'] ?? '')).rejects.toThrow(
      /must log in and act as role tinnox_migrator/,
    );
  });

  it('keeps the invariants the migration runner checks, and gives nobody a privilege', async () => {
    const reader = await migratorClient();
    try {
      await reader.query('SET search_path = pg_catalog');
      expect(schemaInvariantProblems(await readSchemaFacts(reader))).toEqual([]);
    } finally {
      await reader.end();
    }
    const { rows } = await migrator.query(
      `SELECT p.proname::text AS name, pg_get_userbyid(p.proowner)::text AS owner,
              p.prosecdef AS definer, p.proconfig AS settings, p.proacl::text AS acl
       FROM pg_proc p WHERE p.proname LIKE 'audit\\_debt\\_%' ORDER BY 1`,
    );
    expect(rows).toEqual(
      ['audit_debt_note', 'audit_debt_paid', 'audit_debt_settle'].map((name) => ({
        name,
        owner: 'tinnox_migrator',
        definer: false,
        settings: ['search_path=pg_catalog, pg_temp'],
        acl: '{tinnox_migrator=X/tinnox_migrator}',
      })),
    );
  });

  it('is on every table but the exempt ones, is removed without a trace and comes back whole', async () => {
    expect(await ensureAuditDebtGuard(migratorUrl())).toBe(false);
    const installed = await guardObjects();
    expect(installed).toContain('trigger audit_debt_paid on audit_event');
    expect(installed).toContain('trigger audit_debt_note on media');
    expect(installed).toContain('trigger audit_debt_settle on media');
    for (const exempt of [
      'heartbeat_log',
      'login_state',
      'display_delivery',
      'schema_migrations',
    ]) {
      expect(installed.filter((name) => name.endsWith(` on ${exempt}`))).toEqual([]);
    }

    await removeAuditDebtGuard(migratorUrl());
    expect(await guardObjects()).toEqual([]);
    // Nothing judges now.
    await withOrg(judged, org.orgId, (tx) => newFolder(tx, 'While removed'));
    expect(await folders('While removed')).toBe(1);

    expect(await ensureAuditDebtGuard(migratorUrl())).toBe(true);
    expect(await guardObjects()).toEqual(installed);
    await refusalOf(withOrg(judged, org.orgId, (tx) => newFolder(tx, 'Judged again')));
  });

  it('is put back whole when one of its triggers was left disabled', async () => {
    await migrator.query('ALTER TABLE public.folder DISABLE TRIGGER audit_debt_note');
    await withOrg(judged, org.orgId, (tx) => newFolder(tx, 'While disabled'));
    expect(await ensureAuditDebtGuard(migratorUrl())).toBe(true);
    expect(await ensureAuditDebtGuard(migratorUrl())).toBe(false);
    await refusalOf(withOrg(judged, org.orgId, (tx) => newFolder(tx, 'Enabled again')));
  });
});
