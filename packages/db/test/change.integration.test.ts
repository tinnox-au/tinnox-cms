/**
 * changeOrg, changePreOrg, changeOrgAsMigrator and readOrg against PostgreSQL (adoption plan
 * section 2.1 B, steps 19 and 20; AG-3.1, SCR-34): the audit rows a change returns commit with
 * it or not at all, a READ ONLY read refuses every write, and what the wrapper cannot see (an
 * `unaudited` that is not true) is caught by the audit-debt guard. The statements and the types
 * are in ../src/change.test.ts and ../src/tx.test.ts.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeOrg,
  changePreOrg,
  createPool,
  issueAuditStatement,
  issueWritePermit,
  membershipForCheck,
  pairingCreate,
  readOrg,
  termsOfStatement,
  unaudited,
  withOrg,
  type AuditInput,
  type AuditStatement,
  type OrgTx,
  type Pool,
  type WritePermit,
} from '../src/index.ts';
import {
  asDefiner,
  auditedInSql,
  changeOrgAsMigrator,
  connectMigrator,
  type MigratorPool,
} from '../src/migrate.ts';
import {
  AUDIT_DEBT_SQLSTATE,
  ensureAuditDebtGuard,
  watchAuditDebt,
  whileAuditFails,
} from '../src/testing.ts';
import {
  appPool,
  createOrg,
  hash,
  migratorClient,
  migratorUrl,
  pairingCode,
  superuserUrl,
  type TestOrg,
} from './support.ts';

/** As tinnox_app under a name of product code, the way the API's pool connects: judged. */
let judged: Pool;
/** As tinnox_app for the test's own SQL: what it reads back. */
let testSql: Pool;
let migrator: pg.Client;
let org: TestOrg;
let other: TestOrg;
const refusals = watchAuditDebt();

beforeAll(async () => {
  judged = createPool({
    connectionString: process.env['TEST_DATABASE_URL'] ?? '',
    applicationName: 'tinnox-change-test',
    max: 2,
  });
  testSql = appPool('the changeOrg test reads back what a change committed', 2);
  migrator = await migratorClient();
  org = await createOrg(migrator, 'Change');
  other = await createOrg(migrator, 'Change other');
});
afterAll(async () => {
  await ensureAuditDebtGuard(migratorUrl());
  await judged.end();
  await testSql.end();
  await migrator.end();
});

const newFolder = async (tx: OrgTx, name: string): Promise<string> => {
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO folder (org_id, name) VALUES (app_org_id(), $1) RETURNING id',
    [name],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('folder insert returned no row');
  return id;
};

const folderCreated = (id: string) =>
  ({
    actorType: 'operator',
    actorId: org.membershipId,
    action: 'folder.create',
    objectType: 'folder',
    objectId: id,
    result: 'success',
    detail: null,
  }) as const satisfies AuditInput;

/** What the test's own pool sees of a folder and of its audit rows, in the organisation. */
async function committed(name: string): Promise<{ folders: number; audited: string[] }> {
  return withOrg(testSql, org.orgId, async (tx) => {
    const found = await tx.query<{ id: string }>('SELECT id FROM folder WHERE name = $1', [name]);
    const audit = await tx.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE object_type = 'folder' AND object_id = ANY($1::text[]) ORDER BY id`,
      [found.rows.map((row) => row.id)],
    );
    return { folders: found.rowCount ?? 0, audited: audit.rows.map((row) => row.action) };
  });
}

/**
 * A permit as the role guard issues it: its re-check reads the member row FOR SHARE, as
 * assertStillAllowed does, and the statement is the row of POST /api/folders.
 */
function permit(): WritePermit<string> {
  return issueWritePermit({
    recheck: async (tx) => {
      // A far-future session time, so no cut-off applies to the fixture's member.
      const row = await membershipForCheck(tx, org.membershipId, '2999-01-01T00:00:00.000Z');
      if (row === null) throw new Error('not a member of this organisation');
      return row.role;
    },
    stated: { actions: ['folder.create'] },
    statedIn: 'the row of POST /api/folders in ROUTE_PERMISSIONS (test)',
  });
}

const rejection = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('changeOrg against the database (AG-3.1, SCR-34)', () => {
  it('commits the change and the audit row it returned, with the role the re-check read', async () => {
    const role = await changeOrg(judged, org.orgId, permit(), async (tx, granted) => {
      const id = await newFolder(tx, 'Changed and audited');
      return { value: granted, audit: folderCreated(id) };
    });
    expect(role).toBe('owner');
    expect(await committed('Changed and audited')).toEqual({
      folders: 1,
      audited: ['folder.create'],
    });
  });

  it('rolls the change back when its audit row cannot be written (CX-01)', async () => {
    const { result, refused } = await whileAuditFails(migratorUrl(), 'folder.create', () =>
      rejection(
        changeOrg(judged, org.orgId, permit(), async (tx) => {
          const id = await newFolder(tx, 'Audit fails');
          return { value: id, audit: folderCreated(id) };
        }),
      ),
    );
    expect(refused).toBe(1);
    expect(result).toBeInstanceOf(pg.DatabaseError);
    expect(await committed('Audit fails')).toEqual({ folders: 0, audited: [] });
  });

  it('commits nothing of a change that recorded an action its route does not state', async () => {
    const error = await rejection(
      changeOrg(judged, org.orgId, permit(), async (tx) => {
        const id = await newFolder(tx, 'Unstated');
        return {
          value: id,
          audit: [
            folderCreated(id),
            { ...folderCreated(id), action: 'folder.delete', detail: { movedToRoot: 0 } },
          ],
        };
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^changeOrg: the change recorded folder\.delete, which the row of POST \/api\/folders in ROUTE_PERMISSIONS \(test\) does not state: it states folder\.create\./,
    );
    expect(await committed('Unstated')).toEqual({ folders: 0, audited: [] });
  });

  it('refuses the change of a member of another organisation at the re-check, before it runs', async () => {
    let ran = false;
    await expect(
      changeOrg(judged, other.orgId, permit(), () => {
        ran = true;
        return Promise.resolve({ value: 1, audit: unaudited('nothing_changed') });
      }),
    ).rejects.toThrow('not a member of this organisation');
    expect(ran).toBe(false);
  });

  // What types and the wrapper cannot see (plan section 2.1: "a false unaudited"). The guard of
  // the test database sees it: the COMMIT fails, so every route an integration test runs is held.
  it('an unaudited() that is not true fails at COMMIT under the audit-debt guard', async () => {
    const error = await rejection(
      changeOrg(judged, org.orgId, permit(), async (tx) => {
        await newFolder(tx, 'Falsely unaudited');
        return { value: 1, audit: unaudited('nothing_changed') };
      }),
    );
    expect(error).toBeInstanceOf(pg.DatabaseError);
    expect((error as pg.DatabaseError).code).toBe(AUDIT_DEBT_SQLSTATE);
    expect(refusals.take()).toEqual([(error as pg.DatabaseError).message]);
    expect(await committed('Falsely unaudited')).toEqual({ folders: 0, audited: [] });
  });
});

describe('changePreOrg against the database (AG-3.1)', () => {
  const pairingCreated = (id: string) =>
    ({
      actorType: 'anonymous',
      actorId: null,
      action: 'pairing.create',
      objectType: 'pairing_session',
      objectId: id,
      result: 'success',
      detail: null,
    }) as const satisfies AuditInput;

  /** As a route outside the operator table states it, in its entry of OTHER_ROUTE_AUDIT. */
  const stating = (...actions: AuditInput['action'][]): AuditStatement =>
    issueAuditStatement({
      stated: { actions },
      statedIn: 'the entry of the route in OTHER_ROUTE_AUDIT (test)',
    });

  it('writes the event with no organisation when none was entered, with the change', async () => {
    const pairingId = await changePreOrg(judged, stating('pairing.create'), async (pre) => {
      const created = await pairingCreate(pre, {
        code: pairingCode(),
        pollingTokenHash: hash(),
        clientKey: 'change-test-client',
        ttlSeconds: 600,
        maxSessionsPerClient: 5,
        windowSeconds: 600,
      });
      if (created.outcome !== 'created') throw new Error(`pairing not created: ${created.outcome}`);
      return { value: created.pairingId, audit: pairingCreated(created.pairingId) };
    });
    // A row with no organisation is visible to no application role: read as the administrator.
    const admin = new pg.Client({ connectionString: superuserUrl() });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ org_id: string | null; action: string }>(
        `SELECT org_id, action FROM audit_event WHERE object_type = 'pairing_session' AND object_id = $1`,
        [pairingId],
      );
      expect(rows).toEqual([{ org_id: null, action: 'pairing.create' }]);
    } finally {
      await admin.end();
    }
  });

  it('writes the event for the organisation the change entered', async () => {
    await changePreOrg(judged, stating('folder.create'), async (_pre, enterOrg) => {
      const tx = await enterOrg(org.orgId);
      const id = await newFolder(tx, 'Entered and audited');
      return { value: id, audit: folderCreated(id) };
    });
    expect(await committed('Entered and audited')).toEqual({
      folders: 1,
      audited: ['folder.create'],
    });
  });

  // Adoption plan step 20: the route's statement is held before the organisation is known too.
  it('commits nothing of a change that recorded an action its route does not state', async () => {
    const error = await rejection(
      changePreOrg(judged, stating('alert_recipient.confirm'), async (_pre, enterOrg) => {
        const tx = await enterOrg(org.orgId);
        const id = await newFolder(tx, 'Entered and unstated');
        return { value: id, audit: folderCreated(id) };
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^changePreOrg: the change recorded folder\.create, which the entry of the route in OTHER_ROUTE_AUDIT \(test\) does not state: it states alert_recipient\.confirm\./,
    );
    expect(await committed('Entered and unstated')).toEqual({ folders: 0, audited: [] });
  });
});

// Adoption plan step 20: an offline tool changes an organisation with the permit of its
// migrator connection. No role is read again, and the audit rows still commit with the change.
describe('changeOrgAsMigrator against the database (AG-3.1, SCR-34)', () => {
  let pool: MigratorPool;
  const PROVISIONING = issueAuditStatement({
    stated: { actions: ['folder.create'] },
    statedIn: 'the audits of the command in PROVISION_COMMANDS (test)',
  });

  beforeAll(async () => {
    pool = await connectMigrator(migratorUrl(), { applicationName: 'tinnox-test-offline-change' });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('commits the change and the audit row it returned, as the migrator', async () => {
    const who = await changeOrgAsMigrator(pool, org.orgId, PROVISIONING, async (tx) => {
      const id = await newFolder(tx, 'Changed offline');
      const { rows } = await tx.query<{ current_user: string }>('SELECT current_user');
      return { value: rows[0]?.current_user, audit: folderCreated(id) };
    });
    expect(who).toBe('tinnox_migrator');
    expect(await committed('Changed offline')).toEqual({ folders: 1, audited: ['folder.create'] });
  });

  it('rolls the change back when its audit row cannot be written (CX-01)', async () => {
    const { result, refused } = await whileAuditFails(migratorUrl(), 'folder.create', () =>
      rejection(
        changeOrgAsMigrator(pool, org.orgId, PROVISIONING, async (tx) => {
          const id = await newFolder(tx, 'Offline audit fails');
          return { value: id, audit: folderCreated(id) };
        }),
      ),
    );
    expect(refused).toBe(1);
    expect(result).toBeInstanceOf(pg.DatabaseError);
    expect(await committed('Offline audit fails')).toEqual({ folders: 0, audited: [] });
  });

  it('commits nothing of a change that recorded an action the tool does not state', async () => {
    const error = await rejection(
      changeOrgAsMigrator(
        pool,
        org.orgId,
        issueAuditStatement({
          stated: { actions: ['membership.create'] },
          statedIn: termsOfStatement('a test', PROVISIONING).statedIn,
        }),
        async (tx) => {
          const id = await newFolder(tx, 'Offline and unstated');
          return { value: id, audit: folderCreated(id) };
        },
      ),
    );
    expect((error as Error).message).toMatch(
      /^changeOrg: the change recorded folder\.create, which the audits of the command in PROVISION_COMMANDS \(test\) does not state: it states membership\.create\./,
    );
    expect(await committed('Offline and unstated')).toEqual({ folders: 0, audited: [] });
  });

  it('takes the seed’s synthetic data unaudited only under a statement that names no action (step 20 ruling, DEC-38)', async () => {
    // The seed states no action: its change may say development_seed, and commits no row.
    const SEED = issueAuditStatement({
      stated: { actions: [] },
      statedIn: 'the development seed (test)',
    });
    await changeOrgAsMigrator(pool, org.orgId, SEED, async (tx) => {
      await newFolder(tx, 'Seeded');
      return { value: undefined, audit: unaudited('development_seed') };
    });
    expect(await committed('Seeded')).toEqual({ folders: 1, audited: [] });
    // A provisioning command states the actions it writes, so it cannot say it.
    const error = await rejection(
      changeOrgAsMigrator(pool, org.orgId, PROVISIONING, async (tx) => {
        await newFolder(tx, 'Provisioned as seed');
        return { value: undefined, audit: unaudited('development_seed') };
      }),
    );
    expect((error as Error).message).toMatch(
      /^changeOrg: the change returned unaudited\('development_seed'\), but the audits of the command in PROVISION_COMMANDS \(test\) does not grant it\./,
    );
    expect(await committed('Provisioned as seed')).toEqual({ folders: 0, audited: [] });
  });

  it('refuses the runtime pool, which connectMigrator never checked', async () => {
    await expect(
      changeOrgAsMigrator(judged as never, org.orgId, PROVISIONING, async (tx) => {
        const id = await newFolder(tx, 'Offline on the runtime pool');
        return { value: id, audit: folderCreated(id) };
      }),
    ).rejects.toThrow(/^changeOrgAsMigrator requires the pool that connectMigrator returned/);
    expect(await committed('Offline on the runtime pool')).toEqual({ folders: 0, audited: [] });
  });

  it('refuses a statement the tool wrote in place, before anything is sent (step 20 review)', async () => {
    const written = { stated: { actions: ['folder.create'] }, statedIn: 'x' } as never;
    await expect(
      changeOrgAsMigrator(pool, org.orgId, written, async (tx) => {
        const id = await newFolder(tx, 'Offline under its own statement');
        return { value: id, audit: folderCreated(id) };
      }),
    ).rejects.toThrow(
      /^changeOrgAsMigrator requires the audit statement of its route or command, as the table that holds it gives it: .* provisionStatement\(command\) \(scripts\/lib\/provision\.ts\)/,
    );
    expect(await committed('Offline under its own statement')).toEqual({
      folders: 0,
      audited: [],
    });
  });
});

// Adoption plan step 20, D25: provisioning's `pending` expires invites and writes their audit
// rows in one statement, as tinnox_definer. Its change returns auditedInSql(result, action) in
// place of events, and the wrapper takes that only for a statement that did write a row: the
// count is the server's own answer to the statement (INSERT 0 n), since neither role can read
// audit_event across organisations to count again.
describe('auditedInSql against the database (D25)', () => {
  let pool: MigratorPool;
  const PENDING = issueAuditStatement({
    stated: { actions: ['invite.cancel'] },
    statedIn: 'the audits of pending in PROVISION_COMMANDS (test)',
  });
  /** The shape of provisioning's expiry, for one invite: its row and its audit row together. */
  const EXPIRE_ONE = `
    WITH closed AS (
      UPDATE public.member_invite i SET status = 'expired'
      WHERE i.id = $1 AND i.status = 'pending'
      RETURNING i.id, i.org_id, i.role
    )
    INSERT INTO public.audit_event (org_id, actor_type, actor_id, action, object_type, object_id, result, detail)
    SELECT closed.org_id, 'system', NULL, 'invite.cancel', 'invite', closed.id::text, 'success',
           jsonb_build_object('role', closed.role, 'reason', 'expired', 'executedBy', $2::text)
    FROM closed`;

  beforeAll(async () => {
    pool = await connectMigrator(migratorUrl(), { applicationName: 'tinnox-test-audited-in-sql' });
  });
  afterAll(async () => {
    await pool.end();
  });

  const invite = (name: string): Promise<string> =>
    withOrg(pool, org.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO member_invite (org_id, role, name, email, invited_by, expires_at)
         VALUES (app_org_id(), 'viewer', $1, $2, $3, now() + interval '1 day') RETURNING id`,
        [name, `${name.toLowerCase().replaceAll(' ', '.')}@example.com`, org.membershipId],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('invite insert returned no row');
      return id;
    });

  /** What the organisation's own member would see of the invite and its audit rows. */
  const inviteState = (id: string): Promise<{ status: string | undefined; audited: string[] }> =>
    withOrg(testSql, org.orgId, async (tx) => {
      const found = await tx.query<{ status: string }>(
        'SELECT status FROM member_invite WHERE id = $1',
        [id],
      );
      const audit = await tx.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE object_type = 'invite' AND object_id = $1 ORDER BY id`,
        [id],
      );
      return { status: found.rows[0]?.status, audited: audit.rows.map((row) => row.action) };
    });

  it('takes the rows the statement wrote: the invite closes with one audit row, and the wrapper adds none', async () => {
    const id = await invite('Lapsed Example');
    const expired = await changePreOrg(pool, PENDING, async (pre) => {
      const result = await asDefiner(pool, pre, (definer) =>
        definer.query(EXPIRE_ONE, [id, 'sam.staff']),
      );
      return { value: result.rowCount, audit: auditedInSql(result, 'invite.cancel') };
    });
    expect(expired).toBe(1);
    expect(await inviteState(id)).toEqual({ status: 'expired', audited: ['invite.cancel'] });
  });

  it('cannot be used to skip an audit row: a statement that wrote none is refused, and nothing commits', async () => {
    const id = await invite('Kept Example');
    const error = await rejection(
      changePreOrg(pool, PENDING, async (pre, enterOrg) => {
        // The statement finds no invite under this id, so it inserts no audit row...
        const result = await asDefiner(pool, pre, (definer) =>
          definer.query(EXPIRE_ONE, [randomUUID(), 'sam.staff']),
        );
        // ...and the change closes a real invite all the same, with no event of its own.
        const tx = await enterOrg(org.orgId);
        await tx.query(
          "UPDATE member_invite SET status = 'cancelled' WHERE id = $1 AND org_id = app_org_id()",
          [id],
        );
        return { value: undefined, audit: auditedInSql(result, 'invite.cancel') };
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^changePreOrg: the change returned auditedInSql\(result, 'invite\.cancel'\), but that statement wrote no audit row: the database counted 0 inserted\./,
    );
    expect(await inviteState(id)).toEqual({ status: 'pending', audited: [] });
  });

  it('is held to the statement of its command like any other audit row', async () => {
    const id = await invite('Unstated Example');
    const error = await rejection(
      changePreOrg(
        pool,
        issueAuditStatement({
          stated: { actions: ['membership.create'] },
          statedIn: termsOfStatement('a test', PENDING).statedIn,
        }),
        async (pre) => {
          const result = await asDefiner(pool, pre, (definer) =>
            definer.query(EXPIRE_ONE, [id, 'sam.staff']),
          );
          return { value: undefined, audit: auditedInSql(result, 'invite.cancel') };
        },
      ),
    );
    expect((error as Error).message).toMatch(
      /^changePreOrg: the change recorded invite\.cancel, which the audits of pending in PROVISION_COMMANDS \(test\) does not state: it states membership\.create\./,
    );
    expect(await inviteState(id)).toEqual({ status: 'pending', audited: [] });
  });
});

// The plan marked this unverified: whether a READ ONLY transaction serves the read handlers.
// It does (step 19 ran every read of the operator routes that the integration suite reaches in
// one). These cases hold what READ ONLY then gives: a write in a read fails, whatever its type.
describe('readOrg against the database (SCR-34)', () => {
  const READ_ONLY = '25006';
  const refusedAs = async (work: Promise<unknown>): Promise<string | undefined> => {
    const error = await rejection(work);
    return error instanceof pg.DatabaseError ? error.code : `not refused: ${String(error)}`;
  };

  it('reads the rows of its organisation, and of no other', async () => {
    const seen = await readOrg(judged, org.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM display');
      return rows.map((row) => row.id);
    });
    expect(seen).toEqual([org.displayId]);
  });

  it('refuses an INSERT, an UPDATE, a DELETE and a row lock with SQLSTATE 25006', async () => {
    for (const statement of [
      "INSERT INTO folder (org_id, name) VALUES (app_org_id(), 'Written in a read')",
      "UPDATE display SET name = 'Renamed in a read'",
      'DELETE FROM folder',
      'SELECT id FROM display FOR UPDATE',
      'SELECT id FROM membership FOR SHARE',
    ]) {
      expect(
        await refusedAs(readOrg(judged, org.orgId, (tx) => tx.query(statement))),
        statement,
      ).toBe(READ_ONLY);
    }
    expect(await committed('Written in a read')).toEqual({ folders: 0, audited: [] });
    // Nothing of the audit-debt guard either: a refused statement changed nothing.
    expect(refusals.take()).toEqual([]);
  });

  it('refuses a write made inside a function too, and leaves the connection writable after', async () => {
    // The pool holds two connections: a READ ONLY that outlived its transaction would show here.
    for (let round = 0; round < 3; round += 1) {
      expect(
        await refusedAs(
          readOrg(judged, org.orgId, (tx) =>
            tx.query('SELECT sec.session_revoke_membership($1)', [org.membershipId]),
          ),
        ),
      ).toBe(READ_ONLY);
      await changeOrg(judged, org.orgId, permit(), async (tx) => {
        const id = await newFolder(tx, `After a read ${String(round)}`);
        return { value: id, audit: folderCreated(id) };
      });
    }
    expect((await committed('After a read 2')).folders).toBe(1);
  });
});
