/**
 * changeOrg, changePreOrg and readOrg against PostgreSQL (adoption plan section 2.1 B, step 19;
 * AG-3.1, SCR-34): the audit rows a change returns commit with it or not at all, a READ ONLY
 * read refuses every write, and what the wrapper cannot see (an `unaudited` that is not true)
 * is caught by the audit-debt guard. The statements and the types are in
 * ../src/change.test.ts and ../src/tx.test.ts.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeOrg,
  changePreOrg,
  createPool,
  issueWritePermit,
  membershipForCheck,
  pairingCreate,
  readOrg,
  unaudited,
  withOrg,
  type AuditInput,
  type OrgTx,
  type Pool,
  type WritePermit,
} from '../src/index.ts';
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
        return Promise.resolve({ value: 1, audit: unaudited('read_only') });
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
        return { value: 1, audit: unaudited('read_only') };
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

  it('writes the event with no organisation when none was entered, with the change', async () => {
    const pairingId = await changePreOrg(judged, async (pre) => {
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
    await changePreOrg(judged, async (_pre, enterOrg) => {
      const tx = await enterOrg(org.orgId);
      const id = await newFolder(tx, 'Entered and audited');
      return { value: id, audit: folderCreated(id) };
    });
    expect(await committed('Entered and audited')).toEqual({
      folders: 1,
      audited: ['folder.create'],
    });
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
