/**
 * Pairing, two transactions at a time (adoption plan section 4.7, item 2, and step 32). The
 * model-based test (pairing-model.integration.test.ts) runs its commands one after another;
 * here two of them are open at once, each on its own connection as the runtime role, and one
 * is stopped between its statements so that both orders of every pair are held:
 *
 *   claim against collection, revocation against collection, removal of the claimer against
 *   collection, and the credential lookup against revocation (the window D8 states).
 *
 * A side that has to wait is seen waiting on the server (`waitForLockWaiters`), for the lock of
 * the other side's backend, before the other side commits.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deviceByTokenHash,
  pairingClaim,
  pairingComplete,
  pairingCancelClaims,
  pairingCreate,
  poolAsTx,
  revokeDisplayPlayer,
  type Autocommit,
  type OrgTx,
} from '../src/index.ts';
import {
  databaseOn,
  heldTransactions,
  twoTransactions,
  waitForLockWaiters,
  withOrg,
  type Pool,
  type PoolClient,
} from '../src/testing.ts';
import {
  appPool,
  asDefiner,
  createOrg,
  hash,
  inTx,
  migratorClient,
  pairingCode,
  type TestOrg,
} from './support.ts';

let pool: Pool;
let db: Autocommit;
let migrator: pg.Client;
let org: TestOrg;

beforeAll(async () => {
  pool = appPool('holds two pairing transactions open against each other, as the runtime role', 4);
  db = poolAsTx(databaseOn(pool));
  migrator = await migratorClient();
  org = await createOrg(migrator, 'Pairing races');
});
afterAll(async () => {
  await pool.end();
  await migrator.end();
});

interface Claimed {
  readonly pairingId: string;
  readonly pollingTokenHash: Buffer;
  readonly deviceTokenHash: Buffer;
}

/** A display of the organisation with no player and no claim. */
async function newDisplay(): Promise<string> {
  const id = randomUUID();
  await migrator.query('BEGIN');
  await migrator.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
  await migrator.query(
    `INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height)
     VALUES ($1, $2, $3, 'Race display', 640, 360)`,
    [id, org.orgId, org.siteId],
  );
  await migrator.query('COMMIT');
  return id;
}

/** A second member, an Editor, who claims codes and can be removed by the Owner. */
async function newMember(): Promise<string> {
  const id = randomUUID();
  await migrator.query('BEGIN');
  await migrator.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
  await migrator.query(
    "INSERT INTO membership (id, org_id, oidc_sub, role) VALUES ($1, $2, $3, 'editor')",
    [id, org.orgId, `pairing-race-${id}`],
  );
  await migrator.query('COMMIT');
  return id;
}

async function newCode(): Promise<Claimed & { readonly code: string }> {
  const code = pairingCode();
  const pollingTokenHash = hash();
  const created = await inTx(pool, (tx) =>
    pairingCreate(tx, {
      code,
      pollingTokenHash,
      clientKey: `race-${randomUUID()}`,
      ttlSeconds: 600,
      maxSessionsPerClient: 10,
      windowSeconds: 600,
    }),
  );
  if (created.outcome !== 'created') throw new Error(`pairing not created: ${created.outcome}`);
  return { code, pairingId: created.pairingId, pollingTokenHash, deviceTokenHash: hash() };
}

/** A code claimed for the display, committed, that its player has not collected yet. */
async function claimed(displayId: string, membershipId = org.membershipId): Promise<Claimed> {
  const pairing = await newCode();
  const claim = await withOrg(pool, org.orgId, (tx) =>
    pairingClaim(tx, {
      code: pairing.code,
      displayId,
      membershipId,
      maxFailures: 5,
      windowSeconds: 600,
    }),
  );
  expect(claim.outcome).toBe('claimed');
  return pairing;
}

// The statements of the two sides, as the wrappers of ../src/sec.ts and the routes send them.
const CLAIM =
  'SELECT outcome, replaced_registration_id, cancelled_pairing_ids FROM sec.pairing_claim($1, $2, $3, 5, 600)';
const COMPLETE = 'SELECT outcome, registration_id FROM sec.pairing_complete($1, $2, $3)';
const REMOVE = 'UPDATE membership SET removed_at = now(), removed_by = $2 WHERE id = $1';
const END_SESSIONS = 'SELECT sec.session_revoke_membership($1)';

const collect = (client: Pick<OrgTx, 'query'>, p: Claimed) =>
  client.query<{ outcome: string; registration_id: string | null }>(COMPLETE, [
    p.pairingId,
    p.pollingTokenHash,
    p.deviceTokenHash,
  ]);

/**
 * Two connections of the pool, each in an open transaction for the organisation
 * (`twoTransactions`), with the pid of each backend. `work` commits the ones it means to;
 * whatever is still open afterwards is rolled back.
 */
async function sides(work: (first: Side, second: Side) => Promise<void>): Promise<void> {
  const side = async (client: PoolClient): Promise<Side> => {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return { client, pid: rows[0]?.pid ?? 0 };
  };
  await twoTransactions(pool, org.orgId, async (first, second) => {
    await work(await side(first), await side(second));
  });
}
interface Side {
  readonly client: PoolClient;
  readonly pid: number;
}

/** Resolves once `waiting`'s statement waits for a lock that `holder` holds. */
const waitsFor = (holder: Side, what: string) => waitForLockWaiters(pool, holder.pid, 1, what);

async function stateOf(displayId: string, pairings: readonly Claimed[]) {
  const sessions = await asDefiner<{ id: string; status: string }>(
    migrator,
    'SELECT id, status FROM public.pairing_session WHERE id = ANY($1::uuid[])',
    [pairings.map((p) => p.pairingId)],
  );
  const active = await asDefiner<{ id: string }>(
    migrator,
    'SELECT id FROM public.player_registration WHERE display_id = $1 AND revoked_at IS NULL',
    [displayId],
  );
  return {
    statuses: pairings.map((p) => sessions.find((s) => s.id === p.pairingId)?.status),
    active: active.map((r) => r.id),
    accepted: await Promise.all(
      pairings.map(async (p) => (await deviceByTokenHash(db, p.deviceTokenHash)) !== null),
    ),
  };
}

describe('claim against collection', () => {
  it('a newer claim that commits while the older claim’s collection waits for it: the collection is refused, and the newer claim completes', async () => {
    const display = await newDisplay();
    const older = await claimed(display);
    const newer = await newCode();
    await sides(async (claiming, collecting) => {
      const claim = await claiming.client.query<{
        outcome: string;
        cancelled_pairing_ids: string[];
      }>(CLAIM, [newer.code, display, org.membershipId]);
      expect(claim.rows[0]).toMatchObject({
        outcome: 'claimed',
        cancelled_pairing_ids: [older.pairingId],
      });
      // The collection reads the older claim's row, which the newer claim has cancelled and not
      // committed: it waits, then reads the cancellation.
      const late = collect(collecting.client, older);
      await waitsFor(claiming, 'the collection never waited for the newer claim');
      await claiming.client.query('COMMIT');
      expect((await late).rows[0]).toEqual({ outcome: 'not_claimable', registration_id: null });
      await collecting.client.query('COMMIT');
    });
    expect(await stateOf(display, [older, newer])).toEqual({
      statuses: ['expired', 'claimed'],
      active: [],
      accepted: [false, false],
    });
    const done = await inTx(pool, (tx) => pairingComplete(tx, newer));
    expect(done.outcome).toBe('completed');
  });

  it('a collection that commits while a newer claim waits for it: the player it made is replaced by the claim, never left beside the next one', async () => {
    const display = await newDisplay();
    const older = await claimed(display);
    const newer = await newCode();
    await sides(async (collecting, claiming) => {
      const collected = await collect(collecting.client, older);
      expect(collected.rows[0]?.outcome).toBe('completed');
      const registration = collected.rows[0]?.registration_id;
      // The claim cancels the display's older claims, and the older one's row is locked.
      const late = claiming.client.query<{
        outcome: string;
        replaced_registration_id: string | null;
        cancelled_pairing_ids: string[];
      }>(CLAIM, [newer.code, display, org.membershipId]);
      await waitsFor(collecting, 'the newer claim never waited for the collection');
      await collecting.client.query('COMMIT');
      // The older claim was collected, so there was nothing to cancel, and a player to replace.
      expect((await late).rows[0]).toEqual({
        outcome: 'claimed',
        replaced_registration_id: registration,
        cancelled_pairing_ids: [],
      });
      await claiming.client.query('COMMIT');
    });
    expect(await stateOf(display, [older, newer])).toEqual({
      statuses: ['completed', 'claimed'],
      active: [],
      accepted: [false, false],
    });
    const done = await inTx(pool, (tx) => pairingComplete(tx, newer));
    expect(done.outcome).toBe('completed');
    expect((await stateOf(display, [older, newer])).accepted).toEqual([false, true]);
  });
});

/** The two sides of a race in which one runs revokeDisplayPlayer, which takes an OrgTx (SDC-07). */
const heldSides = (work: Parameters<typeof heldTransactions>[2]) =>
  heldTransactions(pool, org.orgId, work);

describe('revocation against collection', () => {
  it('a revocation that commits while the collection waits for it: the claim is cancelled and no player is made', async () => {
    const display = await newDisplay();
    const pairing = await claimed(display);
    await heldSides(async (revoking, collecting) => {
      // As POST /api/displays/:id/revoke-player: the claims, then the row, then the registration.
      expect(await revokeDisplayPlayer(revoking.tx, display)).toEqual({
        cancelledPairingIds: [pairing.pairingId],
        revokedRegistrationId: null,
      });
      const late = collect(collecting.tx, pairing);
      await waitForLockWaiters(
        pool,
        revoking.pid,
        1,
        'the collection never waited for the revocation',
        {
          waiter: late,
        },
      );
      await revoking.commit();
      expect((await late).rows[0]).toEqual({ outcome: 'not_claimable', registration_id: null });
      await collecting.commit();
    });
    expect(await stateOf(display, [pairing])).toEqual({
      statuses: ['expired'],
      active: [],
      accepted: [false],
    });
  });

  it('a collection that commits while the revocation waits for it: the revocation then ends the player it made', async () => {
    const display = await newDisplay();
    const pairing = await claimed(display);
    await heldSides(async (collecting, revoking) => {
      const collected = await collect(collecting.tx, pairing);
      expect(collected.rows[0]?.outcome).toBe('completed');
      // Its first step, the cancellation of the display's claims, waits for the claim's row.
      const revocation = revokeDisplayPlayer(revoking.tx, display);
      await waitForLockWaiters(
        pool,
        collecting.pid,
        1,
        'the revocation never waited for the collection',
        {
          waiter: revocation,
        },
      );
      await collecting.commit();
      // Its later statements read the registration the collection committed.
      expect(await revocation).toEqual({
        cancelledPairingIds: [],
        revokedRegistrationId: collected.rows[0]?.registration_id,
      });
      await revoking.commit();
    });
    expect(await stateOf(display, [pairing])).toEqual({
      statuses: ['completed'],
      active: [],
      accepted: [false],
    });
  });
});

describe('the lock order of ending a player (SCX-01, SDC-07)', () => {
  it("revokeDisplayPlayer waits for the display's pairing lock before it locks the display row", async () => {
    const display = await newDisplay();
    await heldSides(async (holding, revoking) => {
      // The pairing lock, as a claim, a collection's cancellation or another revocation holds it.
      expect(await pairingCancelClaims(holding.tx, display)).toEqual([]);
      const revocation = revokeDisplayPlayer(revoking.tx, display);
      await waitForLockWaiters(
        pool,
        holding.pid,
        1,
        'the revocation never waited for the pairing lock',
        {
          locktype: 'advisory',
          waiter: revocation,
        },
      );
      // Still waiting for that lock, it has not locked the row yet: the holder can, at once.
      // Locking the row first would let a claim that holds the pairing lock deadlock with it.
      const row = await holding.tx.query('SELECT 1 FROM display WHERE id = $1 FOR UPDATE NOWAIT', [
        display,
      ]);
      expect(row.rowCount).toBe(1);
      await holding.rollback();
      expect(await revocation).toEqual({ cancelledPairingIds: [], revokedRegistrationId: null });
    });
  });
});

describe('removal of the claimer against collection (RCX-01)', () => {
  it('a removal that commits while the collection waits for the member row: the collection is refused and the claim is spent', async () => {
    const display = await newDisplay();
    const member = await newMember();
    const pairing = await claimed(display, member);
    await sides(async (removing, collecting) => {
      // As POST /api/members/:id/remove: the removal and the cut-off in one transaction.
      await removing.client.query(REMOVE, [member, org.membershipId]);
      await removing.client.query(END_SESSIONS, [member]);
      const late = collect(collecting.client, pairing);
      await waitsFor(removing, 'the collection never waited for the removal');
      await removing.client.query('COMMIT');
      expect((await late).rows[0]).toEqual({ outcome: 'not_claimable', registration_id: null });
      await collecting.client.query('COMMIT');
    });
    expect(await stateOf(display, [pairing])).toEqual({
      statuses: ['expired'],
      active: [],
      accepted: [false],
    });
  });

  it('a sign out everywhere that commits while the collection waits: refused, with the member still in the organisation', async () => {
    const display = await newDisplay();
    const member = await newMember();
    const pairing = await claimed(display, member);
    await sides(async (ending, collecting) => {
      await ending.client.query(END_SESSIONS, [member]);
      const late = collect(collecting.client, pairing);
      await waitsFor(ending, 'the collection never waited for the cut-off');
      await ending.client.query('COMMIT');
      expect((await late).rows[0]).toEqual({ outcome: 'not_claimable', registration_id: null });
      await collecting.client.query('COMMIT');
    });
    expect((await stateOf(display, [pairing])).statuses).toEqual(['expired']);
  });

  it('a collection that commits while the removal waits for it: the player was paired while the claimer still had access, and stays', async () => {
    const display = await newDisplay();
    const member = await newMember();
    const pairing = await claimed(display, member);
    await sides(async (collecting, removing) => {
      const collected = await collect(collecting.client, pairing);
      expect(collected.rows[0]?.outcome).toBe('completed');
      // The collection holds the member row for share until it commits.
      const late = removing.client.query(REMOVE, [member, org.membershipId]);
      await waitsFor(collecting, 'the removal never waited for the collection');
      await collecting.client.query('COMMIT');
      expect((await late).rowCount).toBe(1);
      await removing.client.query(END_SESSIONS, [member]);
      await removing.client.query('COMMIT');
    });
    expect(await stateOf(display, [pairing])).toEqual({
      statuses: ['completed'],
      active: [expect.any(String)],
      accepted: [true],
    });
  });
});

describe('credential lookup against revocation (the window of D8)', () => {
  it('a lookup does not wait for a revocation that has not committed and still resolves; one that starts after the commit does not', async () => {
    const display = await newDisplay();
    const pairing = await claimed(display);
    const done = await inTx(pool, (tx) => pairingComplete(tx, pairing));
    expect(done.outcome).toBe('completed');
    await heldSides(async (revoking, other) => {
      expect((await revokeDisplayPlayer(revoking.tx, display))?.revokedRegistrationId).toBe(
        done.outcome === 'completed' ? done.registrationId : null,
      );
      // Read on the pool, in no transaction, as the player routes read it: no lock is taken,
      // so this request is past its lookup while the revocation commits.
      expect(await deviceByTokenHash(db, pairing.deviceTokenHash)).toMatchObject({
        displayId: display,
      });
      // The same from inside another open transaction.
      const inside = await other.tx.query(
        'SELECT registration_id FROM sec.device_by_token_hash($1)',
        [pairing.deviceTokenHash],
      );
      expect(inside.rowCount).toBe(1);
      await revoking.commit();
      expect(await deviceByTokenHash(db, pairing.deviceTokenHash)).toBeNull();
      // READ COMMITTED: the open transaction's next lookup reads the revocation too.
      const after = await other.tx.query(
        'SELECT registration_id FROM sec.device_by_token_hash($1)',
        [pairing.deviceTokenHash],
      );
      expect(after.rowCount).toBe(0);
    });
  });
});
