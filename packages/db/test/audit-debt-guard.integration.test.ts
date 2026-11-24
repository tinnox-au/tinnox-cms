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
  heartbeatLogPurge,
  loginStatePut,
  loginStateTake,
  pairingCancelClaims,
  pairingCreate,
  pairingPoll,
  pairingPurge,
  poolAsTx,
  sessionByIdHash,
  sessionCreate,
  sessionPurgeExpired,
  sessionRevoke,
  sessionRevokeUnaudited,
  type OrgTx,
} from '../src/index.ts';
import { readSchemaFacts, schemaInvariantProblems } from '../src/schema-invariants.ts';
import {
  AUDIT_DEBT_SQLSTATE,
  ensureAuditDebtGuard,
  installAuditDebtGuard,
  removeAuditDebtGuard,
  watchAuditDebt,
  whileUnauditedAllowed,
  auditScoped,
  auditUnscoped,
  withOrg,
  withoutOrg,
  withResolvedOrg,
  createPool,
  type Pool,
  databaseOn,
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
  it('fails the COMMIT, names the table and says to return the audit row from the change', async () => {
    const message = await refusalOf(withOrg(judged, org.orgId, (tx) => newFolder(tx, 'Unpaid')));
    expect(message).toMatch(
      /^audit debt: this transaction changed public\.folder \(INSERT\) as tinnox_app and commits no audit_event row\./,
    );
    expect(message).toMatch(
      /Return the audit event from the change, as \{ value, audit \}, and its wrapper writes the row on the same transaction, so both commit or neither does \(AGENTS\.md section 3\): changeAsOperator, changeAsDevice or changeAsJob in the API \(each on changeOrg of @tinnox\/db\), changePreOrg before the organisation is known, changeOrgAsMigrator in an offline tool\./,
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
    const message = await refusalOf(sessionRevokeUnaudited(databaseOn(judged), idHash));
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
    expect(await heartbeatLogPurge(poolAsTx(databaseOn(judged)), 3600)).toBeGreaterThanOrEqual(1);
  });

  it('login state, put and taken', async () => {
    const stateHash = hash();
    await loginStatePut(poolAsTx(databaseOn(judged)), {
      stateHash,
      codeVerifier: 'v'.repeat(43),
      nonce: 'n'.repeat(43),
      returnTo: null,
      ttlSeconds: 60,
    });
    expect(await loginStateTake(poolAsTx(databaseOn(judged)), stateHash)).not.toBeNull();
  });

  it('session activity: last_seen_at alone', async () => {
    const idHash = await newSession();
    expect(await sessionByIdHash(poolAsTx(databaseOn(judged)), idHash, 3600)).not.toBeNull();
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
    expect(await sessionPurgeExpired(poolAsTx(databaseOn(judged)))).toBeGreaterThanOrEqual(1);
    expect(await pairingPurge(poolAsTx(databaseOn(judged)), 3600)).toBeGreaterThanOrEqual(1);
  });
});

// The step 20 ruling (DEC-38) keeps two writes unaudited as they are today, each named by a
// reason of UNAUDITED_REASONS; whether they are audited is open (CMS-36). The guard does not take
// a declared reason's word: EXEMPT_SHAPES lets through the shape of today's write, and these
// cases show it is that narrow, the neighbouring writes on the same tables still refused.
describe('the writes the step 20 ruling leaves unaudited owe nothing, in their shape only (DEC-38, CMS-36)', () => {
  const status = async (id: string): Promise<string | undefined> => {
    const [row] = await asDefiner<{ status: string }>(
      migrator,
      'SELECT status FROM public.pairing_session WHERE id = $1',
      [id],
    );
    return row?.status;
  };
  const pastItsTime = (id: string) =>
    asDefiner(
      migrator,
      `UPDATE public.pairing_session SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

  it('the alert check closing an offline episode without an e-mail, and not opening one', async () => {
    const offlineSince = new Date(Date.now() - 3_600_000);
    const open = (tx: OrgTx) =>
      tx.query(
        'INSERT INTO display_alert (display_id, org_id, offline_since) VALUES ($1, app_org_id(), $2)',
        [org.displayId, offlineSince],
      );
    // Opening an episode is audited state: without its row it is refused.
    const opening = await refusalOf(withOrg(judged, org.orgId, open));
    expect(opening).toContain('public.display_alert (INSERT)');
    await withOrg(judged, org.orgId, async (tx) => {
      await open(tx);
      await auditScoped(tx, { ...ALERT_AUDIT, action: 'display.offline_alert' });
    });
    // The silent close: alert_closed_silently.
    await withOrg(judged, org.orgId, (tx) =>
      tx.query('DELETE FROM display_alert WHERE display_id = $1', [org.displayId]),
    );
    expect(refusals.take()).toEqual([]);
    // A close with its e-mail writes display.online_alert in the same transaction.
    await withOrg(judged, org.orgId, async (tx) => {
      await open(tx);
      await auditScoped(tx, { ...ALERT_AUDIT, action: 'display.offline_alert' });
    });
    await withOrg(judged, org.orgId, async (tx) => {
      await tx.query('DELETE FROM display_alert WHERE display_id = $1', [org.displayId]);
      await auditScoped(tx, { ...ALERT_AUDIT, action: 'display.online_alert' });
    });
    // The exemption is the DELETE, not the table: a close that also opens again is refused.
    const reopening = await refusalOf(
      withOrg(judged, org.orgId, async (tx) => {
        await open(tx);
        await tx.query('DELETE FROM display_alert WHERE display_id = $1', [org.displayId]);
        await open(tx);
      }),
    );
    expect(reopening).toContain('public.display_alert (INSERT)');
  });

  it('a pairing session past its time, marked expired by the next poll of it', async () => {
    const pairing = await newPairing();
    await pastItsTime(pairing.id);
    const polled = await withoutOrg(judged, (tx) =>
      pairingPoll(tx, {
        pairingId: pairing.id,
        pollingTokenHash: pairing.token,
        maxWrongAttempts: 5,
      }),
    );
    expect(polled.outcome).toBe('expired');
    expect(refusals.take()).toEqual([]);
    expect(await status(pairing.id)).toBe('expired');
  });

  it('pending sessions past their time, marked expired by a pairing request that is then refused', async () => {
    // sec.pairing_create expires every pending session whose time has passed first, also when
    // it then creates none: here the client is over its limit (rate_limited).
    const clientKey = `audit-debt-${randomUUID()}`;
    const create = (tx: Parameters<Parameters<typeof withoutOrg>[1]>[0]) =>
      pairingCreate(tx, {
        code: pairingCode(),
        pollingTokenHash: hash(),
        clientKey,
        ttlSeconds: 600,
        maxSessionsPerClient: 1,
        windowSeconds: 600,
      });
    const first = await withoutOrg(testSql, create);
    if (first.outcome !== 'created') throw new Error(`pairing not created: ${first.outcome}`);
    await pastItsTime(first.pairingId);
    expect((await withoutOrg(judged, create)).outcome).toBe('rate_limited');
    expect(refusals.take()).toEqual([]);
    expect(await status(first.pairingId)).toBe('expired');
  });

  it('but not a pairing session created, locked or ended before its time without its audit row', async () => {
    // A session created with no pairing.create row.
    const created = await refusalOf(
      withoutOrg(judged, (tx) =>
        pairingCreate(tx, {
          code: pairingCode(),
          pollingTokenHash: hash(),
          clientKey: `audit-debt-${randomUUID()}`,
          ttlSeconds: 600,
          maxSessionsPerClient: 5,
          windowSeconds: 600,
        }),
      ),
    );
    expect(created).toContain('public.pairing_session (INSERT)');

    // The lock of a session past its time changes more than its status.
    const locked = await newPairing();
    await pastItsTime(locked.id);
    const locking = await refusalOf(
      withoutOrg(judged, (tx) =>
        pairingPoll(tx, { pairingId: locked.id, pollingTokenHash: hash(), maxWrongAttempts: 1 }),
      ),
    );
    expect(locking).toContain('public.pairing_session (UPDATE)');
    expect(await status(locked.id)).toBe('pending');

    // A claim ended before its expiry: the revocation of the screen's player audits it.
    const claimed = await newPairing();
    await asDefiner(
      migrator,
      `UPDATE public.pairing_session
       SET status = 'claimed', org_id = $2, display_id = $3, claimed_at = now()
       WHERE id = $1`,
      [claimed.id, org.orgId, org.displayId],
    );
    const ending = await refusalOf(
      withOrg(judged, org.orgId, (tx) => pairingCancelClaims(tx, org.displayId)),
    );
    expect(ending).toContain('public.pairing_session (UPDATE)');
    expect(await status(claimed.id)).toBe('claimed');
    // Left as no other case finds it: cancelled, with the row the revocation writes.
    await withOrg(judged, org.orgId, async (tx) => {
      expect(await pairingCancelClaims(tx, org.displayId)).toEqual([claimed.id]);
      await auditScoped(tx, {
        ...AUDIT,
        action: 'player.revoke',
        objectType: 'display',
        detail: {
          reason: 'operator',
          displayId: org.displayId,
          hadActiveRegistration: false,
          cancelledPairingIds: [claimed.id],
        },
      });
    });
  });

  it('nor an expiry by time that changes another column with the status', async () => {
    // No sec.* function today expires a session and changes anything else in one UPDATE, and
    // tinnox_app has no privilege on the table, so a throwaway function of tinnox_definer makes
    // the write: an expiry alone, as the pairing functions make it, or one that also changes the
    // client key. It is dropped before the test ends, so no later invariant check sees it.
    // The shared migrator client is rolled back when a statement fails, so the later tests of
    // this file report their own outcome, not "current transaction is aborted" (TST-8).
    const definerDdl = async (ddl: string): Promise<void> => {
      try {
        await migrator.query(`BEGIN; SET LOCAL ROLE tinnox_definer; ${ddl} RESET ROLE; COMMIT`);
      } catch (error) {
        await migrator.query('ROLLBACK');
        throw error;
      }
    };
    // IF EXISTS: one left by an attempt that was killed before its DROP does not fail this one.
    await definerDdl(
      `DROP FUNCTION IF EXISTS sec.guard_probe_expire(uuid, boolean);
       CREATE FUNCTION sec.guard_probe_expire(p_id uuid, p_touch boolean) RETURNS void
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
         UPDATE public.pairing_session
         SET status = 'expired',
             client_key = CASE WHEN p_touch THEN client_key || '-touched' ELSE client_key END
         WHERE id = p_id
       $$;
       REVOKE ALL ON FUNCTION sec.guard_probe_expire(uuid, boolean) FROM PUBLIC;
       GRANT EXECUTE ON FUNCTION sec.guard_probe_expire(uuid, boolean) TO tinnox_app;`,
    );
    const expire = async (id: string, touch: boolean): Promise<void> => {
      const client = await judged.connect();
      try {
        await client.query('SELECT sec.guard_probe_expire($1, $2)', [id, touch]);
      } finally {
        client.release();
      }
    };
    try {
      const alone = await newPairing();
      await pastItsTime(alone.id);
      await expire(alone.id, false);
      expect(refusals.take()).toEqual([]);
      expect(await status(alone.id)).toBe('expired');

      const touched = await newPairing();
      await pastItsTime(touched.id);
      const touching = await refusalOf(expire(touched.id, true));
      expect(touching).toContain('public.pairing_session (UPDATE)');
      expect(await status(touched.id)).toBe('pending');
    } finally {
      await definerDdl('DROP FUNCTION IF EXISTS sec.guard_probe_expire(uuid, boolean);');
    }
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
        return sessionRevokeUnaudited(databaseOn(judged), idHash);
      },
    );
    expect(ended).toBe(true);
    await refusalOf(sessionRevokeUnaudited(databaseOn(judged), await newSession()));
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
