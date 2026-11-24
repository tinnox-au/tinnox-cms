/**
 * Backend review round 1, CX-01, and security review round 3, SCU-01 and SCX-04: a
 * credential change (or a pairing session, or its lockout) and its audit event have one outcome.
 * Each case makes the audit insert fail (the audit fault of @tinnox/db/testing) and checks the
 * outcome: pairing and sign-in issue no credential; sign-out still ends the session. It then
 * removes the fault and checks that the same action works and is audited exactly once.
 *
 * tests/integration/audit-failure.test.ts holds the same rule for every audit action; the cases
 * here go further into what a credential path must and must not hand out.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentityProvider } from '@tinnox/api/test-support';
import type { AuditAction } from '@tinnox/contracts';
import {
  removeAuditFault,
  waitForLockWaiters,
  whileAuditFails as whileAuditRowsFail,
  whileUnauditedAllowed,
} from '@tinnox/db/testing';
import {
  addMember,
  auditEvents,
  createDisplay,
  createOrg,
  migratorUrl,
  newPairing,
  pollPairing,
  signIn,
  startTestApp,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

async function asMigrator<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env['TEST_DATABASE_MIGRATOR_URL'] });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The backend of `client`, read on that connection. */
async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
}

/**
 * Runs `work` while every audit insert of `action` raises an error, and requires that at least
 * one insert was refused: the path under test really reached its audit row.
 */
async function whileAuditFails(action: AuditAction, work: () => Promise<void>): Promise<void> {
  const { refused } = await whileAuditRowsFail(migratorUrl(), action, work);
  expect(refused, `nothing tried to write a ${action} row`).toBeGreaterThan(0);
}

/** One count as the owner of the security functions (bypasses row-level security). */
function countAsDefiner(text: string, values: readonly unknown[]): Promise<number> {
  return asMigrator(async (client) => {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE tinnox_definer');
    const { rows } = await client.query<{ n: string }>(text, [...values]);
    await client.query('COMMIT');
    return Number(rows[0]?.n);
  });
}

interface UnscopedAuditRow {
  actor_type: string;
  result: string;
  object_type: string | null;
  detail: unknown;
}

/** Audit events with no organisation, which only a database administrator can read. */
async function unscopedAudit(action: string, objectId: string): Promise<UnscopedAuditRow[]> {
  const url = new URL(process.env['TEST_DATABASE_MIGRATOR_URL'] ?? '');
  url.username = 'postgres';
  url.password = encodeURIComponent(process.env['POSTGRES_SUPERUSER_PASSWORD'] ?? '');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<UnscopedAuditRow>(
      `SELECT actor_type, result, object_type, detail FROM public.audit_event
       WHERE org_id IS NULL AND action = $1 AND object_id = $2`,
      [action, objectId],
    );
    return rows;
  } finally {
    await client.end();
  }
}

describe('credential changes and their audit events', () => {
  let t: TestApp;
  let org: TestOrg;
  let alice: Operator;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg('Credential audit');
    alice = await signIn(t, org);
  });
  afterAll(async () => {
    await removeAuditFault(migratorUrl());
    await t.close();
  });

  const actions = async (action: string): Promise<number> =>
    (await auditEvents(alice)).filter((event) => event.action === action).length;

  it('keeps a pairing collectable when its audit event cannot be written', async () => {
    const display = await createDisplay(alice, org);
    const pairing = await newPairing(t);
    const claim = await alice.fetch(`/api/displays/${display.id}/claim`, {
      method: 'POST',
      json: { code: pairing.code },
    });
    expect(claim.status).toBe(200);
    const registrations = (): Promise<number> =>
      countAsDefiner('SELECT count(*) AS n FROM public.player_registration WHERE display_id = $1', [
        display.id,
      ]);

    await whileAuditFails('pairing.complete', async () => {
      expect((await pollPairing(t, pairing)).status).toBe(500);
      expect(await registrations()).toBe(0);
    });
    expect(await actions('pairing.complete')).toBe(0);

    // The pairing was not consumed: the next poll hands over the credential.
    const collected = await pollPairing(t, pairing);
    expect(collected.status).toBe(200);
    const body = (await collected.json()) as { status: string; deviceToken?: string };
    expect(body.status).toBe('claimed');
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await registrations()).toBe(1);
    expect(await actions('pairing.complete')).toBe(1);
  });

  it('audits a refused completion together with the claim it ends, or commits neither (D3)', async () => {
    const display = await createDisplay(alice, org);
    const claimer = await addMember(org, 'editor');
    const pairing = await newPairing(t);
    const claim = await (
      await signIn(t, claimer)
    ).fetch(`/api/displays/${display.id}/claim`, { method: 'POST', json: { code: pairing.code } });
    expect(claim.status).toBe(200);
    // The claimer's sessions are ended after the claim, so it can no longer complete.
    const cutOff = await alice.fetch(`/api/members/${claimer.membershipId}/sign-out`, {
      method: 'POST',
    });
    expect(cutOff.status).toBe(200);
    const stillClaimed = (): Promise<number> =>
      countAsDefiner(
        "SELECT count(*) AS n FROM public.pairing_session WHERE id = $1 AND status = 'claimed'",
        [pairing.pairingId],
      );

    await whileAuditFails('pairing.complete', async () => {
      expect((await pollPairing(t, pairing)).status).toBe(500);
      expect(await stillClaimed()).toBe(1);
    });
    expect(await unscopedAudit('pairing.complete', pairing.pairingId)).toEqual([]);

    const refused = await pollPairing(t, pairing);
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({ status: 'consumed' });
    expect(await stillClaimed()).toBe(0);
    // No organisation and no member: sec.pairing_complete names neither for a refusal.
    expect(await unscopedAudit('pairing.complete', pairing.pairingId)).toEqual([
      {
        actor_type: 'anonymous',
        result: 'denied',
        object_type: 'pairing_session',
        detail: { reason: 'not_claimable' },
      },
    ]);
  });

  it('creates no pairing session when its audit event cannot be written (round 3, SCU-01)', async () => {
    const sessions = (): Promise<number> =>
      countAsDefiner('SELECT count(*) AS n FROM public.pairing_session', []);
    const before = await sessions();
    await whileAuditFails('pairing.create', async () => {
      const failed = await fetch(`${t.url}/player/pairing`, { method: 'POST' });
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toMatch(/pollingToken|pairingId/);
      expect(await sessions()).toBe(before);
    });

    const pairing = await newPairing(t);
    expect(await sessions()).toBe(before + 1);
    expect(await unscopedAudit('pairing.create', pairing.pairingId)).toHaveLength(1);
  });

  it('records a polling-token lockout once, in the same transaction as the lock (round 3, SCX-04)', async () => {
    const pairing = await newPairing(t);
    // Well-formed polling tokens that are not this pairing's.
    const wrong = (i: number): Promise<Response> =>
      fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
        headers: { authorization: `Bearer ${'A'.repeat(42)}${i}` },
      });
    const locked = (): Promise<number> =>
      countAsDefiner(
        "SELECT count(*) AS n FROM public.pairing_session WHERE id = $1 AND status = 'locked'",
        [pairing.pairingId],
      );
    for (let i = 0; i < 4; i += 1) expect((await wrong(i)).status).toBe(404);

    await whileAuditFails('pairing.lock', async () => {
      expect((await wrong(4)).status).toBe(500);
      expect(await locked()).toBe(0);
    });
    // The locking attempt rolled back with its audit event: the session is still pending.
    const still = await pollPairing(t, pairing);
    expect(still.status).toBe(200);
    expect(((await still.json()) as { status: string }).status).toBe('pending');

    expect((await wrong(5)).status).toBe(404);
    expect(await locked()).toBe(1);
    const rows = await unscopedAudit('pairing.lock', pairing.pairingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: 'anonymous',
      result: 'denied',
      object_type: 'pairing_session',
      detail: { reason: 'wrong_polling_token' },
    });
    const text = JSON.stringify(rows[0]);
    for (const secret of [pairing.code, pairing.pollingToken, 'A'.repeat(42)]) {
      expect(text).not.toContain(secret);
    }
    // Later attempts, and the rightful player, find it locked; no further event.
    expect((await wrong(6)).status).toBe(404);
    expect((await pollPairing(t, pairing)).status).toBe(404);
    expect(await unscopedAudit('pairing.lock', pairing.pairingId)).toHaveLength(1);
  });

  it('ends the session at sign-out even when the audit event cannot be written', async () => {
    const leaving = await signIn(t, org);
    await whileAuditFails('auth.logout', async () => {
      // The failure is reported, but ending a session is the safe direction. That fallback
      // commits with no audit row by decision (CX-01), so the audit-debt guard is told to let
      // it pass, for this one call.
      const signOut = await whileUnauditedAllowed(
        migratorUrl(),
        'session',
        'the accepted CX-01 residual: a sign-out whose audit row cannot be written still ends the session, through sessionRevokeUnaudited (adoption plan section 2.1 A)',
        () => leaving.fetch('/api/auth/logout', { method: 'POST' }),
      );
      expect(signOut.status).toBe(500);
      expect((await leaving.fetch('/api/displays')).status).toBe(401);
    });
    expect(await actions('auth.logout')).toBe(0);

    const next = await signIn(t, org);
    expect((await next.fetch('/api/auth/logout', { method: 'POST' })).status).toBe(200);
    expect((await next.fetch('/api/displays')).status).toBe(401);
    expect(await actions('auth.logout')).toBe(1);
  });

  it('audits one sign-out when several end the same session, and the others change nothing', async () => {
    const leaving = await signIn(t, org);
    const before = await actions('auth.logout');
    const requests = 3;
    const answers: Promise<Response>[] = [];
    // A key-share lock on the session row lets each request past requireOperator (its activity
    // stamp is a no-key update) and holds every sign-out at the FOR UPDATE of sec.session_revoke.
    // Once the lock goes, one ends the session and the rest find no live session left: the
    // unaudited('nothing_changed') branch of POST /api/auth/logout, which the audit-debt guard
    // would fail at COMMIT with a 500 if it changed anything.
    const holder = new pg.Client({ connectionString: migratorUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SET LOCAL ROLE tinnox_definer');
      const held = await holder.query(
        'SELECT 1 FROM public.session WHERE csrf_token = $1 FOR KEY SHARE',
        [leaving.csrfToken],
      );
      expect(held.rowCount).toBe(1);
      const holderPid = await backendPid(holder);
      // One at a time, so no request's activity stamp waits on another's. Only waits that lead
      // back to this holder count, so a lock wait elsewhere on the server changes nothing (TST-3).
      for (let i = 1; i <= requests; i += 1) {
        answers.push(leaving.fetch('/api/auth/logout', { method: 'POST' }));
        const waiting = await asMigrator((client) =>
          waitForLockWaiters(
            client,
            holderPid,
            i,
            `sign-out ${String(i)} never waited for the session row`,
          ),
        );
        expect(waiting).toHaveLength(i);
      }
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }

    const responses = await Promise.all(answers);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 401, 401]);
    for (const response of responses.filter((r) => r.status === 401)) {
      // requireOperator refuses with no Set-Cookie; only the handler clears the cookie, so these
      // came from the branch that found the session already ended.
      expect(response.headers.get('set-cookie') ?? '').toMatch(/tinnox_session=;/);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'unauthenticated',
      );
    }
    expect((await leaving.fetch('/api/displays')).status).toBe(401);
    expect(await actions('auth.logout')).toBe(before + 1);
  });

  it('creates no session and keeps the previous one when the sign-in audit event cannot be written', async () => {
    let lastState = '';
    const provider: IdentityProvider = {
      beginLogin: (_options?: { readonly reauthenticate?: boolean }) => {
        lastState = randomUUID();
        return Promise.resolve({
          state: lastState,
          nonce: randomBytes(32).toString('base64url'),
          codeVerifier: randomBytes(32).toString('base64url'),
          url: 'http://localhost:8080/sign-in',
        });
      },
      completeLogin: () =>
        Promise.resolve({ sub: org.oidcSub, acr: null, amr: [], idToken: null, authTime: null }),
      endSessionUrl: () => Promise.resolve(null),
      check: () => Promise.resolve(true),
    };
    (t.ctx as { idp: IdentityProvider }).idp = provider;
    const previous = await signIn(t, org);
    const sessions = (): Promise<number> =>
      countAsDefiner('SELECT count(*) AS n FROM public.session WHERE membership_id = $1', [
        org.membershipId,
      ]);
    const sessionCookie = new RegExp(`${t.config.sessionCookieName}=[A-Za-z0-9_-]{43}`);

    /** Starts a sign-in and returns the callback response, sent with the previous session's cookie. */
    const signInThroughProvider = async (): Promise<Response> => {
      const begin = await fetch(`${t.url}/api/auth/login`, { redirect: 'manual' });
      expect(begin.status).toBe(303);
      const preAuth = new RegExp(`${t.config.loginCookieName}=([^;]+)`).exec(
        begin.headers.get('set-cookie') ?? '',
      )?.[1];
      expect(preAuth).toBeDefined();
      return fetch(`${t.url}/api/auth/callback?code=test&state=${lastState}`, {
        redirect: 'manual',
        headers: { cookie: `${t.config.loginCookieName}=${preAuth}; ${previous.cookie}` },
      });
    };
    const before = await sessions();
    const loginsBefore = await actions('auth.login');
    await whileAuditFails('auth.login', async () => {
      const failed = await signInThroughProvider();
      expect(failed.status).toBe(500);
      expect(failed.headers.get('set-cookie') ?? '').not.toMatch(sessionCookie);
      expect(await sessions()).toBe(before);
      expect((await previous.fetch('/api/displays')).status).toBe(200);
    });
    expect(await actions('auth.login')).toBe(loginsBefore);

    const signedIn = await signInThroughProvider();
    expect(signedIn.status).toBe(303);
    const cookie = sessionCookie.exec(signedIn.headers.get('set-cookie') ?? '')?.[0];
    expect(cookie).toBeDefined();
    // Rotation: the previous session ended in the same transaction that created the new one.
    expect((await previous.fetch('/api/displays')).status).toBe(401);
    const session = await fetch(`${t.url}/api/session`, { headers: { cookie: cookie ?? '' } });
    expect(((await session.json()) as { authenticated: boolean }).authenticated).toBe(true);
    expect(await actions('auth.login')).toBe(loginsBefore + 1);
  });
});
