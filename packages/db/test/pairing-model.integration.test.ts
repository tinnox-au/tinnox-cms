/**
 * The pairing protocol, model-based (adoption plan section 4.7 and step 32): random sequences of
 * the protocol's commands run against the real sec.* functions, as the runtime role, and against
 * the small model of pairing-model.test-support.ts; after every command the answer and the
 * stored state of both are compared. The model is written from the protocol's rules and calls
 * nothing of the package, so a rule the functions lose shows as a difference:
 *
 * - with the cancellation of older claims taken out (migration 0010), the run finds the
 *   SCX-01 trace: claim, claim again, and the first claim is still collectable;
 * - with the cut-off condition taken out of sec.pairing_complete (0013), it finds the RCX-01
 *   trace: claim, remove the claimer, bring them back, collect.
 *
 * Both traces are also below as plain examples, as every counterexample is (D11). The member
 * changes and the revocations are made as the routes make them (apps/api/src/routes/members.ts,
 * displays.ts, player.ts), with the statements written out here; `Expire` moves a session's
 * expiry into the past, which only time does in the product.
 *
 * D11: every run draws a fresh seed, and a failure prints the seed, the shrunk commands as one
 * short line each, and the first command whose answer or state differed.
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deviceByTokenHash,
  errorField,
  pairingCancelClaims,
  pairingClaim,
  pairingComplete,
  pairingCreate,
  pairingPoll,
  poolAsTx,
  sessionRevokeMembership,
  type Autocommit,
  type OrgId,
} from '../src/index.ts';
import { databaseOn, withOrg, type Pool } from '../src/testing.ts';
import {
  commandsArb,
  describeCommand,
  DISPLAYS,
  MAX_CLAIM_FAILURES,
  MAX_WRONG_POLLS,
  MEMBERS,
  PairingModel,
  sessionOf,
  type Command,
  type Observed,
} from './pairing-model.test-support.ts';
import { appPool, hash, inTx, migratorClient, pairingCode, PG, testOrgId } from './support.ts';

let pool: Pool;
let db: Autocommit;
let migrator: pg.Client;

beforeAll(async () => {
  pool = appPool('runs the pairing commands of a model-based test, as the runtime role', 2);
  db = poolAsTx(databaseOn(pool));
  migrator = await migratorClient();
});
afterAll(async () => {
  await pool.end();
  await migrator.end();
});

interface RealSession {
  readonly id: string;
  readonly code: string;
  readonly pollingTokenHash: Buffer;
}
interface RealRegistration {
  readonly id: string;
  readonly session: number;
  readonly display: number;
  readonly tokenHash: Buffer;
}

/** The real side of one run: an organisation of its own, and the ids the commands made. */
class RealPairing {
  readonly sessions: RealSession[] = [];
  readonly registrations: RealRegistration[] = [];
  readonly #org: OrgId;
  readonly #owner: string;
  readonly #displays: readonly string[];
  readonly #members: readonly string[];

  private constructor(org: OrgId, owner: string, displays: string[], members: string[]) {
    this.#org = org;
    this.#owner = owner;
    this.#displays = displays;
    this.#members = members;
  }

  /** An organisation with an Owner, who makes the member changes, two Editors and two displays. */
  static async arrange(): Promise<RealPairing> {
    const org = testOrgId(randomUUID());
    const site = randomUUID();
    const owner = randomUUID();
    const displays = Array.from({ length: DISPLAYS }, () => randomUUID());
    const members = Array.from({ length: MEMBERS }, () => randomUUID());
    await migrator.query('BEGIN');
    try {
      await migrator.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await migrator.query("INSERT INTO organization (id, name) VALUES ($1, 'Pairing model')", [
        org,
      ]);
      await migrator.query(
        "INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, 'Model site', 'Australia/Melbourne')",
        [site, org],
      );
      await migrator.query(
        `INSERT INTO membership (id, org_id, oidc_sub, role)
         SELECT m.id, $1, 'pairing-model-' || m.id, m.role
         FROM unnest($2::uuid[], $3::text[]) AS m (id, role)`,
        [org, [owner, ...members], ['owner', ...members.map(() => 'editor')]],
      );
      await migrator.query(
        `INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height)
         SELECT d, $1, $2, 'Model display', 640, 360 FROM unnest($3::uuid[]) AS d`,
        [org, site, displays],
      );
      await migrator.query('COMMIT');
    } catch (error) {
      await migrator.query('ROLLBACK');
      throw error;
    }
    return new RealPairing(org, owner, displays, members);
  }

  #display(d: number): string {
    const id = this.#displays[d];
    if (id === undefined) throw new Error(`no display d${String(d)}`);
    return id;
  }
  #member(m: number): string {
    const id = this.#members[m];
    if (id === undefined) throw new Error(`no member m${String(m)}`);
    return id;
  }
  #sessionOf(pairingId: string): number {
    const at = this.sessions.findIndex((s) => s.id === pairingId);
    if (at === -1) throw new Error(`a pairing session of another run was touched: ${pairingId}`);
    return at;
  }
  #labels(pairingIds: readonly string[]): string {
    const indexes = pairingIds.map((id) => this.#sessionOf(id)).sort((x, y) => x - y);
    return `[${indexes.map((i) => `s${String(i)}`).join(',')}]`;
  }
  #sessionOfRegistration(registrationId: string | null): string {
    if (registrationId === null) return 'none';
    const registration = this.registrations.find((r) => r.id === registrationId);
    if (registration === undefined) throw new Error('a registration of another run was revoked');
    return `s${String(registration.session)}`;
  }

  async #claim(code: string, d: number, m: number): Promise<string> {
    let result;
    try {
      result = await withOrg(pool, this.#org, (tx) =>
        pairingClaim(tx, {
          code,
          displayId: this.#display(d),
          membershipId: this.#member(m),
          maxFailures: MAX_CLAIM_FAILURES,
          windowSeconds: 600,
        }),
      );
    } catch (error) {
      // A removed member is no member: the function raises, as for another organisation's.
      if (errorField(error, 'code') === PG.insufficientPrivilege) return 'refused';
      throw error;
    }
    if (result.outcome !== 'claimed') return result.outcome;
    const others = result.cancelledPairingIds;
    return `claimed replaced=${this.#sessionOfRegistration(result.replacedRegistrationId)} cancelled=${this.#labels(others)}`;
  }

  async run(command: Command): Promise<string> {
    const landed = sessionOf(command, this.sessions.length);
    if ('s' in command && landed === null) return 'skipped';
    const c = 's' in command && landed !== null ? { ...command, s: landed } : command;
    const s = ('s' in c ? this.sessions[c.s] : undefined) as RealSession;
    switch (c.kind) {
      case 'Create': {
        const code = pairingCode();
        const pollingTokenHash = hash();
        const created = await inTx(pool, (tx) =>
          pairingCreate(tx, {
            code,
            pollingTokenHash,
            clientKey: `model-${randomUUID()}`,
            ttlSeconds: 600,
            maxSessionsPerClient: 10,
            windowSeconds: 600,
          }),
        );
        if (created.outcome !== 'created') return created.outcome;
        this.sessions.push({ id: created.pairingId, code, pollingTokenHash });
        return 'created';
      }
      case 'Claim':
        return this.#claim(s.code, c.d, c.m);
      case 'WrongCode':
        // A code nobody was given: well-formed, and not one of this run's.
        return this.#claim(pairingCode(), c.d, c.m);
      case 'Poll':
      case 'WrongPoll': {
        const pollingTokenHash = c.kind === 'Poll' ? s.pollingTokenHash : hash();
        const polled = await inTx(pool, (tx) =>
          pairingPoll(tx, { pairingId: s.id, pollingTokenHash, maxWrongAttempts: MAX_WRONG_POLLS }),
        );
        return polled.outcome;
      }
      case 'Complete': {
        const tokenHash = hash();
        const done = await inTx(pool, (tx) =>
          pairingComplete(tx, {
            pairingId: s.id,
            pollingTokenHash: s.pollingTokenHash,
            deviceTokenHash: tokenHash,
          }),
        );
        if (done.outcome !== 'completed') return done.outcome;
        const display = this.#displays.indexOf(done.displayId);
        this.registrations.push({ id: done.registrationId, session: c.s, display, tokenHash });
        return 'completed';
      }
      case 'Revoke': {
        // As POST /api/displays/:id/revoke-player: the claims first, then the registration.
        const result = await withOrg(pool, this.#org, async (tx) => {
          const cancelled = await pairingCancelClaims(tx, this.#display(c.d));
          const revoked = await tx.query<{ id: string }>(
            `UPDATE player_registration SET revoked_at = now(), revoked_reason = 'operator'
             WHERE display_id = $1 AND org_id = app_org_id() AND revoked_at IS NULL RETURNING id`,
            [this.#display(c.d)],
          );
          return { cancelled, revoked: revoked.rows[0]?.id ?? null };
        });
        return `revoked=${this.#sessionOfRegistration(result.revoked)} cancelled=${this.#labels(result.cancelled)}`;
      }
      case 'Reset': {
        // As DELETE /player/registration, by the display's newest player, which may hold a
        // credential that is revoked already.
        const newest = this.registrations.findLast((r) => r.display === c.d);
        if (newest === undefined) return 'nothing';
        const revoked = await withOrg(pool, this.#org, (tx) =>
          tx.query(
            `UPDATE player_registration SET revoked_at = now(), revoked_reason = 'player_reset'
             WHERE id = $1 AND org_id = app_org_id() AND revoked_at IS NULL`,
            [newest.id],
          ),
        );
        return revoked.rowCount === 1 ? 'reset' : 'nothing';
      }
      case 'Expire':
        await this.#asDefiner(async () => {
          await migrator.query(
            "UPDATE public.pairing_session SET expires_at = now() - interval '1 second' WHERE id = $1",
            [s.id],
          );
        });
        return 'expired_by_time';
      case 'RemoveMember': {
        // As POST /api/members/:id/remove: the removal and the cut-off in one transaction.
        const removed = await withOrg(pool, this.#org, async (tx) => {
          const updated = await tx.query(
            'UPDATE membership SET removed_at = now(), removed_by = $2 WHERE id = $1 AND removed_at IS NULL',
            [this.#member(c.m), this.#owner],
          );
          if (updated.rowCount !== 1) return false;
          await sessionRevokeMembership(tx, this.#member(c.m));
          return true;
        });
        return removed ? 'removed' : 'skipped';
      }
      case 'Reinstate': {
        // As provision-member reactivates: the same row, by the migrator, the cut-off kept.
        await migrator.query('BEGIN');
        try {
          await migrator.query("SELECT set_config('app.org_id', $1, true)", [this.#org]);
          const updated = await migrator.query(
            'UPDATE membership SET removed_at = NULL, removed_by = NULL WHERE id = $1 AND removed_at IS NOT NULL',
            [this.#member(c.m)],
          );
          await migrator.query('COMMIT');
          return updated.rowCount === 1 ? 'reinstated' : 'skipped';
        } catch (error) {
          await migrator.query('ROLLBACK');
          throw error;
        }
      }
      case 'EndSessions':
        // As a demotion or a sign out everywhere: the cut-off alone.
        await withOrg(pool, this.#org, (tx) => sessionRevokeMembership(tx, this.#member(c.m)));
        return 'sessions_ended';
    }
  }

  async #asDefiner<T>(work: () => Promise<T>): Promise<T> {
    await migrator.query('BEGIN');
    try {
      await migrator.query('SET LOCAL ROLE tinnox_definer');
      const result = await work();
      await migrator.query('COMMIT');
      return result;
    } catch (error) {
      await migrator.query('ROLLBACK');
      throw error;
    }
  }

  /** What the database holds of this run, read past row-level security, and what each credential is answered. */
  async observed(): Promise<Observed & { readonly credentials: readonly string[] }> {
    const { sessions, registrations } = await this.#asDefiner(async () => ({
      sessions: (
        await migrator.query<{
          id: string;
          status: string;
          failed_attempts: number;
          display_id: string | null;
          registration_id: string | null;
        }>(
          `SELECT id, status, failed_attempts, display_id, registration_id
           FROM public.pairing_session WHERE id = ANY($1::uuid[])`,
          [this.sessions.map((s) => s.id)],
        )
      ).rows,
      registrations: (
        await migrator.query<{ id: string; display_id: string; revoked_reason: string | null }>(
          'SELECT id, display_id, revoked_reason FROM public.player_registration WHERE org_id = $1',
          [this.#org],
        )
      ).rows,
    }));
    // Held whatever the model says: a display never has two players.
    for (const display of this.#displays) {
      const active = registrations.filter(
        (r) => r.display_id === display && r.revoked_reason === null,
      );
      expect(active.length, 'active registrations of one display').toBeLessThanOrEqual(1);
    }
    expect(registrations.map((r) => r.id).sort()).toEqual(
      this.registrations.map((r) => r.id).sort(),
    );
    const credentials: string[] = [];
    for (const r of this.registrations) {
      const device = await deviceByTokenHash(db, r.tokenHash);
      credentials.push(`s${String(r.session)} ${device === null ? 'refused' : 'accepted'}`);
    }
    return {
      sessions: this.sessions.map((s, i) => {
        const row = sessions.find((r) => r.id === s.id);
        if (row === undefined) throw new Error(`pairing session s${String(i)} is gone`);
        const display = row.display_id === null ? -1 : this.#displays.indexOf(row.display_id);
        return `s${String(i)} ${row.status} wrongPolls=${String(row.failed_attempts)} display=${display === -1 ? 'none' : `d${String(display)}`} registered=${String(row.registration_id !== null)}`;
      }),
      registrations: this.registrations.map((r) => {
        const row = registrations.find((x) => x.id === r.id);
        const display = row === undefined ? -1 : this.#displays.indexOf(row.display_id);
        return `s${String(r.session)} d${String(display)} ${row?.revoked_reason ?? 'active'}`;
      }),
      credentials,
    };
  }
}

/**
 * Runs the commands against the functions and the model, and fails at the first difference.
 * Answers the run as one line per command: the command with the session it landed on, its
 * answer, and in brackets the reasons the model gave for a collection, so an example can hold
 * that it reached the rule its title names.
 */
async function runAgainstModel(commands: readonly Command[]): Promise<string[]> {
  const real = await RealPairing.arrange();
  const model = new PairingModel();
  const trace: string[] = [];
  const answers: string[] = [];
  for (const [i, command] of commands.entries()) {
    const landed = describeCommand(command, model.sessionCount);
    const line = `${String(i + 1).padStart(2)}. ${landed}`;
    const expected = model.apply(command);
    const answered = await real.run(command);
    if (answered !== expected) {
      throw new Error(
        [...trace, `${line} -> answered "${answered}", the model says "${expected}"`].join('\n'),
      );
    }
    trace.push(`${line} -> ${answered}`);
    const reasons = model.takeReached();
    answers.push(
      `${landed} -> ${answered}${reasons.length === 0 ? '' : ` (${reasons.join('; ')})`}`,
    );
    const wanted = model.observed();
    const stored = await real.observed();
    const wantedState = {
      ...wanted,
      // A credential is accepted exactly while its registration is the active one.
      credentials: wanted.registrations.map(
        (r) => `${r.split(' ')[0] ?? ''} ${r.endsWith(' active') ? 'accepted' : 'refused'}`,
      ),
    };
    try {
      expect(stored).toEqual(wantedState);
    } catch (error) {
      throw new Error(
        `${trace.join('\n')}\n    after it, the database (received) differs from the model (expected):\n${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return answers;
}

// A command names its session counted back from the newest (sessionOf): 0 is the newest, 1 the
// one before. Each example pins the whole run, in which every session reads as the one it landed
// on (s0 is the first made), so an index that lands elsewhere fails the example.
const cmd = {
  create: { kind: 'Create' } satisfies Command,
  claim: (back: number, d = 0, m = 0): Command => ({ kind: 'Claim', s: back, d, m }),
  complete: (back: number): Command => ({ kind: 'Complete', s: back }),
  poll: (back: number): Command => ({ kind: 'Poll', s: back }),
  wrongPoll: (back: number): Command => ({ kind: 'WrongPoll', s: back }),
  expire: (back: number): Command => ({ kind: 'Expire', s: back }),
  wrongCode: (m = 0): Command => ({ kind: 'WrongCode', d: 0, m }),
};
const CLAIMED = 'claimed replaced=none cancelled=[]';
const CANCELLED = 'not_claimable (collection refused: the claim was cancelled or never made)';

describe('pairing model: generator self-checks', () => {
  it('reaches every answer and every boundary of the protocol within a sample, on the model alone', () => {
    const answers = new Map<string, number>();
    for (const commands of fc.sample(commandsArb, 3000)) {
      const model = new PairingModel();
      for (const command of commands) {
        const answer = model
          .apply(command)
          .replace(/s\d+/g, 's')
          .replace(/\[s(,s)+\]/, '[s]');
        answers.set(
          `${command.kind}: ${answer}`,
          (answers.get(`${command.kind}: ${answer}`) ?? 0) + 1,
        );
        for (const tag of model.takeReached()) answers.set(tag, (answers.get(tag) ?? 0) + 1);
      }
    }
    for (const wanted of [
      'Create: created',
      'Claim: claimed replaced=none cancelled=[]',
      // A claim that replaces the display's player, and one that cancels an older claim.
      'Claim: claimed replaced=s cancelled=[]',
      'Claim: claimed replaced=none cancelled=[s]',
      'Claim: invalid_code',
      // On the limit: the claim after the last wrong code that still counted.
      'Claim: rate_limited',
      'Claim: refused',
      'WrongCode: invalid_code',
      'WrongCode: rate_limited',
      'Poll: pending',
      'Poll: claimed',
      'Poll: completed',
      'Poll: expired',
      'WrongPoll: wrong_token',
      'WrongPoll: wrong_token_locked',
      'Complete: completed',
      'Complete: not_claimable',
      'Revoke: revoked=s cancelled=[]',
      'Revoke: revoked=none cancelled=[s]',
      'Reset: reset',
      'Reset: nothing',
      'RemoveMember: removed',
      'Reinstate: reinstated',
      'EndSessions: sessions_ended',
      // The reasons a collection is refused, each of which is a rule of its own.
      'collection refused: the claim was cancelled or never made',
      'collection refused: past its expiry',
      'collection refused: the claimer was removed',
      'collection refused: the claimer was removed and brought back',
      'collection refused: the claimer’s sessions were ended after the claim',
      'collection allowed: claimed after the claimer’s cut-off',
    ]) {
      expect(answers.get(wanted) ?? 0, wanted).toBeGreaterThan(0);
    }
    // One rule no sequence reaches: a claim revokes the display's player and cancels its older
    // claims, so a claim that is still collectable never meets a player. sec.pairing_complete
    // checks it all the same (0010), for a claim from before that migration; the orders of two
    // transactions that come nearest are in pairing-races.integration.test.ts.
    expect(answers.get('collection refused: the display has a player of a newer claim') ?? 0).toBe(
      0,
    );
  });
});

describe('pairing: the functions against the model', () => {
  it(
    'answers and stores what the model says, command by command, for any sequence of commands',
    { timeout: 240_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(commandsArb, async (commands) => {
          await runAgainstModel(commands);
        }),
      );
    },
  );

  // The traces the model must find when a fix is taken out (the step's acceptance), as examples.
  it('SCX-01: an older claim of a display cannot be collected once a newer one was made, in either order of collection', async () => {
    const claims = [cmd.create, cmd.create, cmd.claim(0), cmd.claim(1)];
    const made = [
      'Create -> created',
      'Create -> created',
      `Claim s1 d0 m0 -> ${CLAIMED}`,
      'Claim s0 d0 m0 -> claimed replaced=none cancelled=[s1]',
    ];
    expect(await runAgainstModel([...claims, cmd.complete(1), cmd.complete(0)])).toEqual([
      ...made,
      'Complete s0 -> completed',
      `Complete s1 -> ${CANCELLED}`,
    ]);
    expect(await runAgainstModel([...claims, cmd.complete(0), cmd.complete(1)])).toEqual([
      ...made,
      `Complete s1 -> ${CANCELLED}`,
      'Complete s0 -> completed',
    ]);
  });

  it('RCX-01: a claim made before its claimer was removed stays dead after the claimer is brought back', async () => {
    expect(
      await runAgainstModel([
        cmd.create,
        cmd.claim(0),
        { kind: 'RemoveMember', m: 0 },
        { kind: 'Reinstate', m: 0 },
        cmd.complete(0),
        // The same member's next claim, made after the cut-off, completes.
        cmd.create,
        cmd.claim(0),
        cmd.complete(0),
      ]),
    ).toEqual([
      'Create -> created',
      `Claim s0 d0 m0 -> ${CLAIMED}`,
      'RemoveMember m0 -> removed',
      'Reinstate m0 -> reinstated',
      'Complete s0 -> not_claimable (collection refused: the claimer was removed and brought back)',
      'Create -> created',
      `Claim s1 d0 m0 -> ${CLAIMED}`,
      'Complete s1 -> completed (collection allowed: claimed after the claimer’s cut-off)',
    ]);
  });

  it('a claim made before a sign out everywhere is dead, and the next one is not', async () => {
    expect(
      await runAgainstModel([
        cmd.create,
        cmd.claim(0, 1, 1),
        { kind: 'EndSessions', m: 1 },
        cmd.complete(0),
        cmd.create,
        cmd.claim(0, 1, 1),
        cmd.complete(0),
      ]),
    ).toEqual([
      'Create -> created',
      `Claim s0 d1 m1 -> ${CLAIMED}`,
      'EndSessions m1 -> sessions_ended',
      'Complete s0 -> not_claimable (collection refused: the claimer’s sessions were ended after the claim)',
      'Create -> created',
      `Claim s1 d1 m1 -> ${CLAIMED}`,
      'Complete s1 -> completed (collection allowed: claimed after the claimer’s cut-off)',
    ]);
  });

  it('counts wrong codes to the limit, where a right code is refused too, and a removed member is refused before the count', async () => {
    expect(
      await runAgainstModel([
        cmd.create,
        cmd.wrongCode(),
        cmd.wrongCode(),
        cmd.wrongCode(),
        cmd.claim(0),
        cmd.wrongCode(),
        { kind: 'RemoveMember', m: 0 },
        cmd.claim(0),
        // The other member is not limited, and claims the code that is still waiting.
        cmd.claim(0, 0, 1),
      ]),
    ).toEqual([
      'Create -> created',
      'WrongCode d0 m0 -> invalid_code',
      'WrongCode d0 m0 -> invalid_code',
      'WrongCode d0 m0 -> invalid_code',
      'Claim s0 d0 m0 -> rate_limited',
      'WrongCode d0 m0 -> rate_limited',
      'RemoveMember m0 -> removed',
      'Claim s0 d0 m0 -> refused',
      `Claim s0 d0 m1 -> ${CLAIMED}`,
    ]);
  });

  it('a revoke or a reset ends the player; only the revoke also ends an uncollected claim', async () => {
    expect(
      await runAgainstModel([
        cmd.create,
        cmd.claim(0),
        cmd.complete(0),
        { kind: 'Reset', d: 0 },
        // A claim revokes the display's player, so an uncollected claim never meets one: the
        // reset after it finds no player, and leaves the claim to be collected.
        cmd.create,
        cmd.claim(0),
        { kind: 'Reset', d: 0 },
        cmd.complete(0),
        { kind: 'Revoke', d: 0 },
        cmd.create,
        cmd.claim(0),
        { kind: 'Revoke', d: 0 },
        cmd.complete(0),
      ]),
    ).toEqual([
      'Create -> created',
      `Claim s0 d0 m0 -> ${CLAIMED}`,
      'Complete s0 -> completed',
      'Reset d0 -> reset',
      'Create -> created',
      `Claim s1 d0 m0 -> ${CLAIMED}`,
      'Reset d0 -> nothing',
      'Complete s1 -> completed',
      'Revoke d0 -> revoked=s1 cancelled=[]',
      'Create -> created',
      `Claim s2 d0 m0 -> ${CLAIMED}`,
      'Revoke d0 -> revoked=none cancelled=[s2]',
      `Complete s2 -> ${CANCELLED}`,
    ]);
  });

  it('a code past its time is not claimable, a claim past its time not collectable, and a lock holds', async () => {
    expect(
      await runAgainstModel([
        cmd.create,
        cmd.expire(0),
        cmd.claim(0),
        // Asking for a new code marks the old one.
        cmd.create,
        cmd.poll(1),
        cmd.claim(0),
        cmd.expire(0),
        cmd.complete(0),
        cmd.poll(0),
        cmd.create,
        cmd.claim(0),
        cmd.wrongPoll(0),
        cmd.wrongPoll(0),
        cmd.wrongPoll(0),
        cmd.poll(0),
        cmd.complete(0),
      ]),
    ).toEqual([
      'Create -> created',
      'Expire s0 -> expired_by_time',
      'Claim s0 d0 m0 -> invalid_code',
      'Create -> created',
      'Poll s0 -> expired',
      `Claim s1 d0 m0 -> ${CLAIMED}`,
      'Expire s1 -> expired_by_time',
      'Complete s1 -> not_claimable (collection refused: past its expiry)',
      'Poll s1 -> expired',
      'Create -> created',
      `Claim s2 d0 m0 -> ${CLAIMED}`,
      'WrongPoll s2 -> wrong_token',
      'WrongPoll s2 -> wrong_token',
      'WrongPoll s2 -> wrong_token_locked',
      'Poll s2 -> locked',
      `Complete s2 -> ${CANCELLED}`,
    ]);
  });
});
