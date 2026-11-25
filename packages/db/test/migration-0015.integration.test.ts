/**
 * Migration 0015: sec.session_revoke_membership locks the member row itself, then takes the
 * cut-off (review round 6, RCX-02; its follow-up RFX-01).
 *
 * Builds a database at migration 0014 with the seeders of the migrate-forward chain (levels.ts,
 * atLevel), whose level 0013 leaves two organisations with an Owner each
 * (levels/seed-0013.ts). On it, the test adds members, cut-offs and sessions, runs the race once
 * to record the defect (a bare call that waits for the member row stamps the start of its wait),
 * applies 0015 with the real migration runner, and checks that no row changed, that the function
 * kept its owner, settings and grants, and that the same race now ends with the cut-off after
 * the wait.
 *
 * The database is atLevel's own, dropped in `afterAll`; the shared integration-test database is
 * not touched.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  poolAsTx,
  sessionByIdHash,
  sessionCreate,
  sessionRevokeMembership,
  sha256,
  type Autocommit,
  type SessionCreateResult,
} from '../src/index.ts';
import { withOrg, type Pool, databaseOn } from '../src/testing.ts';
import type { MigrationResult } from '../src/migrate.ts';
import { MIGRATIONS, atLevel, type LevelDatabase } from './levels.ts';
import { BEFORE_ALERTS_A, BEFORE_ALERTS_B } from './levels/seed-0013.ts';
import {
  appPool,
  asDefiner,
  inTx,
  PG,
  pgCode,
  stillWaiting,
  testOrgId,
  twoTransactions,
} from './support.ts';

const TARGET = '0015_session_revoke_locks_first.sql';

/**
 * How long the revocation is left waiting. Past a whole second, because the identity provider's
 * auth_time has whole seconds: a sign-in during the wait is then in a later second than a
 * cut-off stamped when the wait began.
 */
const WAIT_MS = 1_500;

interface Member {
  readonly id: string;
  readonly oidcSub: string;
}
type SignIn = SessionCreateResult & { idHash: Buffer };
interface Race {
  /** The database clock while the revocation was still waiting for the member row. */
  readonly duringWait: Date;
  readonly cutOff: Date;
  /** A sign-in sent while the revocation waited, when the test asked for one. */
  readonly inFlight: SignIn | null;
}

let level: LevelDatabase | undefined;
let migrator: pg.Client | undefined;
let pool: Pool | undefined;
let db: Autocommit;
let upgrade: MigrationResult;
/** The race at 0014, and a sign-in authenticated during its wait, tried after it committed. */
let before: { race: Race; lateSignIn: SignIn };
/** Members and sessions as they stood just before 0015. */
let rowsBefore: unknown[];

/** Two organisations of level 0013, each with its Owner. */
const seeded = (o: typeof BEFORE_ALERTS_B) => ({
  orgId: testOrgId(o.org),
  membershipId: o.owner,
});
const org = seeded(BEFORE_ALERTS_A);
const other = seeded(BEFORE_ALERTS_B);

function clients(): { level: LevelDatabase; migrator: pg.Client; pool: Pool } {
  if (level === undefined || migrator === undefined || pool === undefined) {
    throw new Error('beforeAll did not finish');
  }
  return { level, migrator, pool };
}

/** One statement as the owner of the sec.* functions (BYPASSRLS). */
const asDefinerRows = <R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
) => asDefiner<R>(clients().migrator, text, values);

async function addMember(orgId: string): Promise<Member> {
  const id = randomUUID();
  const oidcSub = `m15-${id}`;
  const { migrator: client } = clients();
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await client.query(
      "INSERT INTO membership (id, org_id, oidc_sub, role) VALUES ($1, $2, $3, 'editor')",
      [id, orgId, oidcSub],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return { id, oidcSub };
}

/** A sign-in as the callback makes it; `authTime` is when the identity provider authenticated it. */
async function signIn(oidcSub: string, authTime: Date = new Date()): Promise<SignIn> {
  const idHash = sha256(`cookie-${randomUUID()}`);
  const result = await inTx(clients().pool, (tx) =>
    sessionCreate(tx, {
      idHash,
      oidcSub,
      csrfToken: 'c'.repeat(43),
      ttlSeconds: 3600,
      idToken: null,
      authTime,
    }),
  );
  return { ...result, idHash };
}

/** The whole second of `at`, as an ID token's auth_time carries it. */
const wholeSecond = (at: Date): Date => new Date(Math.floor(at.getTime() / 1000) * 1000);

const works = async (session: SignIn): Promise<boolean> =>
  session.outcome === 'created' && (await sessionByIdHash(db, session.idHash, 1800)) !== null;

async function everyMemberAndSession(): Promise<unknown[]> {
  const members = await asDefinerRows(
    `SELECT id, role, removed_at, first_signed_in_at, sessions_valid_after
     FROM public.membership ORDER BY id`,
  );
  const sessions = await asDefinerRows(
    `SELECT id_hash, membership_id, created_at, expires_at, revoked_at
     FROM public.session ORDER BY id_hash`,
  );
  return [...members, ...sessions];
}

/**
 * Ends the member's sessions with one bare call, as a caller that locked nothing first makes
 * it, while another transaction holds the member row FOR SHARE (the shape of the member's own
 * write: a holder that changed the row would make PostgreSQL compute the cut-off again and
 * hide the defect). With `signInDuringWait`, a sign-in authenticated during the wait is sent
 * on a third connection before the row is released, so it is in flight when the revocation
 * gets the row.
 */
async function revokeWhileRowIsHeld(member: Member, signInDuringWait = false): Promise<Race> {
  let duringWait: Date | undefined;
  let inFlight: SignIn | null = null;
  await twoTransactions(clients().pool, org.orgId, async (holder, revoker) => {
    await holder.query('SELECT 1 FROM membership WHERE id = $1 FOR SHARE', [member.id]);
    const revoking = revoker.query('SELECT sec.session_revoke_membership($1)', [member.id]);
    let signing: Promise<SignIn> | undefined;
    try {
      expect(await stillWaiting(revoking)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      const clock = await holder.query<{ at: Date }>('SELECT clock_timestamp() AS at');
      duringWait = clock.rows[0]?.at;
      if (duringWait === undefined) throw new Error('no clock');
      if (signInDuringWait) {
        signing = signIn(member.oidcSub, wholeSecond(duringWait));
        // It needs the same row (sec.session_create, FOR NO KEY UPDATE), so it waits too.
        expect(await stillWaiting(signing)).toBe(true);
      }
      await holder.query('ROLLBACK');
      await revoking;
      await revoker.query('COMMIT');
      if (signing !== undefined) inFlight = await signing;
    } finally {
      // Ending the holder releases the row, so neither waiter outlives the test.
      await holder.query('ROLLBACK').catch(() => undefined);
      await revoking.catch(() => undefined);
      await revoker.query('ROLLBACK').catch(() => undefined);
      await signing?.catch(() => undefined);
    }
  });
  const [row] = await asDefinerRows<{ at: Date | null }>(
    'SELECT sessions_valid_after AS at FROM public.membership WHERE id = $1',
    [member.id],
  );
  const cutOff = row?.at ?? null;
  if (duringWait === undefined || cutOff === null) throw new Error('the revocation set no cut-off');
  return { duringWait, cutOff, inFlight };
}

beforeAll(async () => {
  const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort();
  expect(names).toContain(TARGET);
  expect(names.filter((n) => n < TARGET)).toHaveLength(14);
  level = await atLevel('0014', { seed: true });

  migrator = await level.migrator();
  pool = appPool('tries the revocation as the runtime role', 6, level.appUrl);
  db = poolAsTx(databaseOn(pool));

  // A member whose sessions were ended once and who signed in again, and one never cut off.
  const cutOffOnce = await addMember(org.orgId);
  await signIn(cutOffOnce.oidcSub);
  await withOrg(pool, org.orgId, (tx) => sessionRevokeMembership(tx, cutOffOnce.id));
  await signIn(cutOffOnce.oidcSub, new Date(Date.now() + 60_000));
  await signIn((await addMember(org.orgId)).oidcSub);

  const raced = await addMember(org.orgId);
  const race = await revokeWhileRowIsHeld(raced);
  before = { race, lateSignIn: await signIn(raced.oidcSub, wholeSecond(race.duringWait)) };

  rowsBefore = await everyMemberAndSession();
  upgrade = await level.upgrade();
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await migrator?.end();
  await level?.drop();
});

describe('migration 0015 on a database that already holds members and sessions', () => {
  it('is applied on top of 0014, once', async () => {
    const later = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n > TARGET);
    expect(upgrade.alreadyApplied).toHaveLength(14);
    expect(upgrade.applied).toEqual([TARGET, ...later.sort()]);
    const again = await clients().level.upgrade();
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain(TARGET);
  });

  it('changes no member and no session: cut-offs and live sessions stay as they were', async () => {
    expect(rowsBefore.length).toBeGreaterThanOrEqual(9);
    expect(await everyMemberAndSession()).toEqual(rowsBefore);
  });

  it('keeps the function as 0013 created it: owner, pinned search_path, EXECUTE for tinnox_app only', async () => {
    const { rows } = await clients().migrator.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              pg_get_function_result(p.oid) AS returns,
              has_function_privilege('tinnox_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('tinnox_migrator', p.oid, 'EXECUTE') AS migrator,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'sec' AND p.proname = 'session_revoke_membership'`,
    );
    expect(rows).toEqual([
      {
        owner: 'tinnox_definer',
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
        returns: 'integer',
        app: true,
        migrator: false,
        everyone: false,
      },
    ]);
  });
});

describe('the cut-off of a call that waited for the member row (RCX-02)', () => {
  it('before 0015 a bare call stamped the start of its wait and let a sign-in from the wait in', () => {
    // The defect this migration closes, recorded at 0014 in beforeAll: if this ever fails, the
    // race below no longer reaches the window and proves nothing.
    expect(before.race.cutOff.getTime()).toBeLessThan(before.race.duringWait.getTime() - 1000);
    expect(before.lateSignIn.outcome).toBe('created');
  });

  it('the cut-off is taken after the wait, and a sign-in authenticated during it is refused', async () => {
    const member = await addMember(org.orgId);
    const earlier = await signIn(member.oidcSub);

    const race = await revokeWhileRowIsHeld(member);

    expect(race.cutOff.getTime()).toBeGreaterThanOrEqual(race.duringWait.getTime());
    expect(await works(earlier)).toBe(false);
    const late = await signIn(member.oidcSub, wholeSecond(race.duringWait));
    expect(late).toEqual({
      outcome: 'reauth',
      membershipId: member.id,
      orgId: org.orgId,
      idHash: late.idHash,
    });
    // Authenticated after the cut-off, the member signs in as usual.
    expect(await works(await signIn(member.oidcSub, new Date(Date.now() + 60_000)))).toBe(true);
  });

  it('a sign-in in flight on another connection during the wait has no working session after the revocation commits', async () => {
    const member = await addMember(org.orgId);

    const race = await revokeWhileRowIsHeld(member, true);

    // Whichever got the row first. The revocation first: the sign-in reads the cut-off and is
    // sent back (`reauth`). The sign-in first: its session committed before the revocation held
    // the row, so the revocation ended it.
    if (race.inFlight === null) throw new Error('no sign-in was sent');
    expect(await works(race.inFlight)).toBe(false);
    expect(['reauth', 'created']).toContain(race.inFlight.outcome);
    expect(race.cutOff.getTime()).toBeGreaterThanOrEqual(race.duringWait.getTime());
  });

  it("refuses another organisation's member at once, without waiting for that row", async () => {
    await twoTransactions(clients().pool, other.orgId, async (holder) => {
      await holder.query('SELECT 1 FROM membership WHERE id = $1 FOR SHARE', [other.membershipId]);
      // A call that tried to lock the row would wait here and end as 55P03 after lock_timeout.
      expect(
        await pgCode(
          withOrg(clients().pool, org.orgId, (tx) =>
            sessionRevokeMembership(tx, other.membershipId),
          ),
        ),
      ).toBe(PG.insufficientPrivilege);
    });
    const [row] = await asDefinerRows<{ at: Date | null }>(
      'SELECT sessions_valid_after AS at FROM public.membership WHERE id = $1',
      [other.membershipId],
    );
    expect(row?.at).toBeNull();
  });
});
