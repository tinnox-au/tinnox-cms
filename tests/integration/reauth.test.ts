/**
 * Signing in again after a member's sessions were ended (CMS-13; docs/portal-v2/stage-c.md
 * 6.5). A removal, demotion or "sign out everywhere" sets the member's cut-off; a sign-in the
 * identity provider authenticated before it is refused, and the browser is sent back to the
 * provider once with `prompt=login`. A provider that still answers with the old
 * authentication ends at `reauth_failed`, never in a loop.
 *
 * The provider is a fake with a settable `auth_time`, as in credential-audit.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sessionRevokeMembership } from '@tinnox/db';
import { withOrg, type Pool } from '@tinnox/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IdentityProvider } from '@tinnox/api/test-support';
import {
  addMember,
  arrangeAsDefiner,
  asMigratorIn,
  auditEvents,
  createOrg,
  PORTAL_ORIGIN,
  reachedBefore,
  signIn,
  startTestApp,
  statementHolds,
  waitForLockWaiters,
  withoutWaitingFor,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

const IDP_URL = 'http://localhost:8080/sign-in';

/** One query as the owner of the security functions (bypasses row-level security). */
async function queryAsDefiner<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[],
): Promise<R[]> {
  const client = new pg.Client({ connectionString: process.env['TEST_DATABASE_MIGRATOR_URL'] });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE tinnox_definer');
    const { rows } = await client.query<R>(text, [...values]);
    await client.query('COMMIT');
    return rows;
  } finally {
    await client.end();
  }
}

/** How many sign-ins with no organisation were recorded with `reason` (database administrator only). */
async function unscopedLoginFailures(reason: string): Promise<number> {
  const url = new URL(process.env['TEST_DATABASE_MIGRATOR_URL'] ?? '');
  url.username = 'postgres';
  url.password = encodeURIComponent(process.env['POSTGRES_SUPERUSER_PASSWORD'] ?? '');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.audit_event
       WHERE org_id IS NULL AND action = 'auth.login' AND actor_type = 'anonymous'
         AND result = 'failure' AND detail->>'reason' = $1`,
      [reason],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

/** The value of a cookie the response sets, or null ('' when it is cleared). */
function setCookie(response: Response, name: string): string | null {
  for (const line of response.headers.getSetCookie()) {
    const [pair = ''] = line.split(';');
    const at = pair.indexOf('=');
    if (pair.slice(0, at) === name) return pair.slice(at + 1);
  }
  return null;
}

/**
 * A pool wrapper that has the server refuse the next statement matching `matches` with
 * `sqlstate`: the statement is replaced by one that raises it, in the same transaction, so the
 * route sees the server's own error and the transaction is really aborted.
 */
function statementRefusals() {
  let armed: { matches: (text: string) => boolean; sqlstate: string } | null = null;
  const bound = <T extends object>(target: T, key: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };
  return {
    wrapPool: <P extends object>(pool: P): P =>
      new Proxy(pool, {
        get(target, key) {
          if (key !== 'connect') return bound(target, key);
          return async () => {
            const client = await (target as unknown as pg.Pool).connect();
            return new Proxy(client, {
              get(real, name) {
                if (name !== 'query') return bound(real, name);
                return (text: string, values?: unknown[]) => {
                  const refusal = armed;
                  if (refusal !== null && typeof text === 'string' && refusal.matches(text)) {
                    armed = null;
                    return real.query(
                      `DO $$ BEGIN RAISE EXCEPTION 'refused by the test' USING ERRCODE = '${refusal.sqlstate}'; END $$`,
                    );
                  }
                  return real.query(text, values);
                };
              },
            });
          };
        },
      }),
    refuseNext(matches: (text: string) => boolean, sqlstate: string): void {
      armed = { matches, sqlstate };
    },
    /** Drops a refusal no statement took, so a failed case does not fail the next sign-in. */
    disarm(): void {
      armed = null;
    },
  };
}

describe('signing in again after the sessions were ended', () => {
  const holds = statementHolds();
  const refusals = statementRefusals();
  let t: TestApp;
  let org: TestOrg;
  let owner: Operator;
  let member: TestOrg;
  /** The test's own reads of pg_locks, pg_stat_activity and the database clock. */
  let sql: Pool;

  /** What the fake provider answers. */
  const idp = {
    sub: '',
    authTime: null as number | null,
    state: '',
    begins: [] as ({ readonly reauthenticate?: boolean } | undefined)[],
  };

  beforeAll(async () => {
    t = await startTestApp({}, 1000, {
      wrapPool: (pool) => refusals.wrapPool(holds.wrapPool(pool)),
    });
    const provider: IdentityProvider = {
      beginLogin: (options) => {
        idp.begins.push(options);
        idp.state = randomUUID();
        return Promise.resolve({
          state: idp.state,
          nonce: randomBytes(32).toString('base64url'),
          codeVerifier: randomBytes(32).toString('base64url'),
          url: `${IDP_URL}?state=${idp.state}`,
        });
      },
      completeLogin: () =>
        Promise.resolve({
          sub: idp.sub,
          acr: null,
          amr: [],
          idToken: null,
          authTime: idp.authTime,
        }),
      endSessionUrl: () => Promise.resolve(null),
      check: () => Promise.resolve(true),
    };
    (t.ctx as { idp: IdentityProvider }).idp = provider;
    sql = t.testSql('reading pg_locks, pg_stat_activity and the database clock for the races');
    org = await createOrg('Re-authentication');
    owner = await signIn(t, org);
    member = await addMember(org);
    idp.sub = member.oidcSub;
  });
  afterEach(() => {
    holds.disarmAll();
  });
  afterAll(async () => {
    await t.close();
  });

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  /** GET /api/auth/login: the pre-auth cookie and the state the provider was given. */
  async function startLogin(): Promise<{ preAuth: string; state: string }> {
    const begin = await fetch(`${t.url}/api/auth/login`, { redirect: 'manual' });
    expect(begin.status).toBe(303);
    const preAuth = setCookie(begin, t.config.loginCookieName);
    expect(preAuth).toBeTruthy();
    return { preAuth: preAuth ?? '', state: idp.state };
  }

  /** The provider's redirect back to the callback, with the browser's cookies. */
  function callback(
    login: { preAuth: string; state: string },
    session?: string,
  ): Promise<Response> {
    const cookies = [`${t.config.loginCookieName}=${login.preAuth}`];
    if (session !== undefined) cookies.push(`${t.config.sessionCookieName}=${session}`);
    return fetch(`${t.url}/api/auth/callback?code=test&state=${login.state}`, {
      redirect: 'manual',
      headers: { cookie: cookies.join('; ') },
    });
  }

  async function sessionOf(
    cookie: string,
  ): Promise<{ authenticated: boolean; user?: { role: string } }> {
    const response = await fetch(`${t.url}/api/session`, {
      headers: { cookie: `${t.config.sessionCookieName}=${cookie}` },
    });
    return (await response.json()) as { authenticated: boolean; user?: { role: string } };
  }

  const liveSessions = async (membershipId: string): Promise<number> =>
    Number(
      (
        await queryAsDefiner<{ n: string }>(
          'SELECT count(*) AS n FROM public.session WHERE membership_id = $1 AND revoked_at IS NULL',
          [membershipId],
        )
      )[0]?.n,
    );

  const loginDenials = async (reason: string): Promise<number> =>
    (await auditEvents(owner, '&category=auth')).filter(
      (row) =>
        row.action === 'auth.login' &&
        row.result === 'denied' &&
        row.actorId === member.membershipId &&
        row.objectType === 'membership' &&
        row.detail?.['reason'] === reason,
    ).length;

  let cutOff: Date;
  let firstSession = '';
  let forced: { preAuth: string; state: string };

  it('signs a member in normally', async () => {
    idp.authTime = nowSeconds();
    const response = await callback(await startLogin());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${PORTAL_ORIGIN}/`);
    firstSession = setCookie(response, t.config.sessionCookieName) ?? '';
    expect(firstSession).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session = await sessionOf(firstSession);
    expect(session).toMatchObject({ authenticated: true, user: { role: 'owner' } });
    expect(idp.begins.at(-1)).toBeUndefined();
  });

  it('sends a sign-in authenticated before the cut-off back to the provider once', async () => {
    // A cut-off on a whole second, so the test knows the boundary exactly.
    cutOff = new Date(nowSeconds() * 1000);
    await arrangeAsDefiner('UPDATE public.membership SET sessions_valid_after = $2 WHERE id = $1', [
      member.membershipId,
      cutOff,
    ]);
    expect(await liveSessions(member.membershipId)).toBe(1);
    idp.authTime = nowSeconds() - 3600;
    const begins = idp.begins.length;

    const response = await callback(await startLogin(), firstSession);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${IDP_URL}?state=${idp.state}`);
    expect(idp.begins).toHaveLength(begins + 2);
    expect(idp.begins.at(-1)).toEqual({ reauthenticate: true });
    // A new pre-auth cookie for the forced sign-in; no session; the old one cleared and revoked.
    const preAuth = setCookie(response, t.config.loginCookieName);
    expect(preAuth).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    expect(await liveSessions(member.membershipId)).toBe(0);
    expect(await loginDenials('reauth_required')).toBe(1);
    forced = { preAuth: preAuth ?? '', state: idp.state };
  });

  it('refuses the forced sign-in when the provider answers with the old authentication', async () => {
    const begins = idp.begins.length;
    const response = await callback(forced);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${PORTAL_ORIGIN}/?authError=reauth_failed`);
    expect(idp.begins).toHaveLength(begins);
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    expect(await loginDenials('reauth_failed')).toBe(1);
    expect(await liveSessions(member.membershipId)).toBe(0);
  });

  it('signs the member in once the provider authenticated them after the cut-off', async () => {
    const reauth = await callback(await startLogin());
    expect(reauth.headers.get('location')).toBe(`${IDP_URL}?state=${idp.state}`);
    const login = {
      preAuth: setCookie(reauth, t.config.loginCookieName) ?? '',
      state: idp.state,
    };
    // auth_time has whole seconds: the second of the cut-off itself is still refused.
    idp.authTime = cutOff.getTime() / 1000 + 2;
    const response = await callback(login);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${PORTAL_ORIGIN}/`);
    const cookie = setCookie(response, t.config.sessionCookieName) ?? '';
    expect(await sessionOf(cookie)).toMatchObject({ authenticated: true });
    expect(await liveSessions(member.membershipId)).toBe(1);
  });

  it('asks again when the provider reports no auth_time and a cut-off exists', async () => {
    idp.authTime = null;
    const begins = idp.begins.length;
    const response = await callback(await startLogin());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${IDP_URL}?state=${idp.state}`);
    expect(idp.begins.slice(begins)).toEqual([undefined, { reauthenticate: true }]);
  });

  it('refuses a removed member', async () => {
    const removed = await addMember(org, 'editor');
    await asMigratorIn(org.orgId, (c) =>
      c.query('UPDATE membership SET removed_at = now() WHERE id = $1', [removed.membershipId]),
    );
    const sub = idp.sub;
    idp.sub = removed.oidcSub;
    idp.authTime = nowSeconds();
    try {
      const response = await callback(await startLogin());
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`${PORTAL_ORIGIN}/?authError=no_membership`);
      expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    } finally {
      idp.sub = sub;
    }
  });

  it('records a sign-in that waited past lock_timeout for the member row', async () => {
    const locked = await addMember(org, 'editor');
    const sub = idp.sub;
    idp.sub = locked.oidcSub;
    idp.authTime = nowSeconds();
    const before = await unscopedLoginFailures('member_locked');
    // A member change that holds the member row longer than tinnox_app's 5 s lock_timeout.
    const change = new pg.Client({ connectionString: process.env['TEST_DATABASE_MIGRATOR_URL'] });
    await change.connect();
    try {
      const login = await startLogin();
      await change.query('BEGIN');
      await change.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await change.query('UPDATE membership SET role = role WHERE id = $1', [locked.membershipId]);
      const response = await callback(login);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        `${PORTAL_ORIGIN}/?authError=provider_unavailable`,
      );
      expect(setCookie(response, t.config.sessionCookieName) ?? '').toBe('');
    } finally {
      await change.query('ROLLBACK');
      await change.end();
      idp.sub = sub;
    }
    expect(await unscopedLoginFailures('member_locked')).toBe(before + 1);
    expect(await liveSessions(locked.membershipId)).toBe(0);
  });

  // Step 26 of the poteto adoption plan: the callback asks the classifier for a transient
  // failure, so a deadlock, a serialization failure and a statement timeout take the lock
  // timeout's path (they answered a 500 with no audit row before).
  it.each([
    ['a deadlock', '40P01'],
    ['a serialization failure', '40001'],
    ['a statement timeout', '57014'],
  ])(
    'records a sign-in ended by %s (%s) as member_locked and redirects with provider_unavailable',
    async (_, sqlstate) => {
      const ended = await addMember(org, 'editor');
      const sub = idp.sub;
      idp.sub = ended.oidcSub;
      idp.authTime = nowSeconds();
      const before = await unscopedLoginFailures('member_locked');
      try {
        const login = await startLogin();
        refusals.refuseNext((text) => text.includes('sec.session_create'), sqlstate);
        const response = await callback(login);
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(
          `${PORTAL_ORIGIN}/?authError=provider_unavailable`,
        );
        expect(setCookie(response, t.config.sessionCookieName) ?? '').toBe('');
      } finally {
        idp.sub = sub;
        // TST-4 of the group C review.
        refusals.disarm();
      }
      expect(await unscopedLoginFailures('member_locked')).toBe(before + 1);
      expect(await liveSessions(ended.membershipId)).toBe(0);
    },
  );

  /** The whole second the database's clock shows now: what a provider's auth_time would be. */
  async function databaseSecond(): Promise<number> {
    const { rows } = await sql.query<{ at: Date }>('SELECT clock_timestamp() AS at');
    const at = rows[0]?.at;
    if (at === undefined) throw new Error('no clock');
    return Math.floor(at.getTime() / 1000);
  }

  it('locks the member row before the old session, so a revocation meanwhile cannot deadlock', async () => {
    // The member's browser still sends a live session cookie.
    const signedIn = await addMember(org, 'editor');
    const browser = await signIn(t, signedIn);
    const cookie = browser.cookie.slice(browser.cookie.indexOf('=') + 1);
    const sub = idp.sub;
    idp.sub = signedIn.oidcSub;
    idp.authTime = nowSeconds();
    try {
      const login = await startLogin();
      const held = holds.hold((text) => text.includes('sec.session_create('));
      const signingIn = callback(login, cookie);
      const pid = await reachedBefore(held, signingIn, 'the sign-in');
      // "Sign out everywhere" for the member while the sign-in is stopped before its first
      // lock. It must finish without waiting for the sign-in: with the old order (rotation
      // first) it would wait for the session row the sign-in holds, which the server shows.
      const ended = await withoutWaitingFor(
        sql,
        pid,
        withOrg(
          t.testSql('the test’s own sign-out of the member, racing a sign-in in flight'),
          org.orgId,
          (tx) => sessionRevokeMembership(tx, signedIn.membershipId),
        ),
        'the revocation waits for a lock the sign-in holds, and the two would deadlock',
      );
      held.release();
      const response = await signingIn;
      expect(response.status).toBe(303);
      // The revocation committed first: the sign-in authenticated before it is sent back.
      expect(response.headers.get('location')).toBe(`${IDP_URL}?state=${idp.state}`);
      expect(ended).toBe(1);
      expect((await browser.fetch('/api/displays')).status).toBe(401);
    } finally {
      idp.sub = sub;
    }
  });

  // TST-6 (adoption plan step 33; RCX-02; docs/portal-v2/stage-c.md 1.6 and 6.8; D22): a
  // sign-in that meets a people route at the member row, with the meeting read from the server.
  // Each side really waits for the row lock the other holds (waitForLockWaiters), in both
  // orders, for the three routes that end a member's sessions. What must hold in every case: a
  // session of the member does not outlive the change, and an authentication from before the
  // change cannot start one.
  const PEOPLE_ROUTES = [
    {
      name: 'sign out everywhere',
      change: (id: string) => owner.fetch(`/api/members/${id}/sign-out`, { method: 'POST' }),
      // The sign-in is sent back to the provider once.
      refusal: 'reauth',
      // The whole answer: the one session the first sign-in made.
      ended: (body: unknown): void => {
        expect(body).toEqual({ sessionsEnded: 1 });
      },
    },
    {
      name: 'a demotion',
      change: (id: string) =>
        owner.fetch(`/api/members/${id}`, { method: 'PATCH', json: { role: 'viewer' } }),
      refusal: 'reauth',
      // The answer also carries the member as changed.
      ended: (body: unknown): void => {
        expect(body).toMatchObject({ sessionsEnded: 1, invitesCancelled: 0 });
      },
    },
    {
      name: 'a removal',
      change: (id: string) => owner.fetch(`/api/members/${id}/remove`, { method: 'POST' }),
      refusal: 'no_membership',
      ended: (body: unknown): void => {
        expect(body).toMatchObject({ sessionsEnded: 1, invitesCancelled: 0 });
      },
    },
  ] as const;

  /** That the sign-in was refused as `refusal` says, with no session. */
  function expectRefused(
    response: Response,
    refusal: 'reauth' | 'no_membership',
    state: string,
  ): void {
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      refusal === 'reauth'
        ? `${IDP_URL}?state=${state}`
        : `${PORTAL_ORIGIN}/?authError=no_membership`,
    );
    expect(setCookie(response, t.config.sessionCookieName) ?? '').toBe('');
  }

  describe.each(PEOPLE_ROUTES)(
    'a sign-in that meets $name at the member row (TST-6)',
    ({ change, refusal, ended }) => {
      it('the route holds the row: the sign-in waits for it, and is refused once the change has committed', async () => {
        const target = await addMember(org, 'editor');
        const sub = idp.sub;
        idp.sub = target.oidcSub;
        // Stopped after lockTarget has the member row, before the sessions are ended and the
        // cut-off is taken.
        const held = holds.hold((text) => text.includes('sec.session_revoke_membership('));
        try {
          const changing = change(target.membershipId);
          const route = await reachedBefore(held, changing, 'the people route');
          // The member signs in now: authenticated after the route took the row, before the
          // change has committed.
          idp.authTime = await databaseSecond();
          const login = await startLogin();
          const begins = idp.begins.length;
          const signingIn = callback(login);
          await waitForLockWaiters(
            sql,
            route,
            1,
            'the sign-in never waited for the member row the people route holds',
            { waiter: signingIn },
          );
          held.release();
          expect((await changing).status).toBe(200);
          const response = await signingIn;
          expectRefused(response, refusal, idp.state);
          if (refusal === 'reauth') {
            expect(idp.begins.slice(begins)).toEqual([{ reauthenticate: true }]);
          }
          expect(await liveSessions(target.membershipId)).toBe(0);
        } finally {
          held.release();
          idp.sub = sub;
        }
      });

      it('the sign-in holds the row: the route waits for it at lockTarget, then ends the session it made; a second sign-in authenticated during that wait is refused, and so is that authentication afterwards', async () => {
        const target = await addMember(org, 'editor');
        const sub = idp.sub;
        idp.sub = target.oidcSub;
        // The first sign-in is stopped at its audit row: sec.session_create has the member row
        // and has inserted the session.
        const held = holds.hold((text) => text.includes('INSERT INTO audit_event'));
        try {
          idp.authTime = await databaseSecond();
          const first = callback(await startLogin());
          const signIn1 = await reachedBefore(held, first, 'the first sign-in');

          // The people route waits for the member row, in lockTarget: sent, not held before it.
          const changing = change(target.membershipId);
          const [route] = await waitForLockWaiters(
            sql,
            signIn1,
            1,
            'the people route never waited for the member row the sign-in holds',
            { waiter: changing },
          );
          if (route === undefined) throw new Error('no waiter');
          const waiting = await sql.query<{ query: string; began: number }>(
            `SELECT query, floor(extract(epoch FROM xact_start))::int AS began
               FROM pg_stat_activity WHERE pid = $1`,
            [route],
          );
          expect(waiting.rows[0]?.query).toContain('FOR NO KEY UPDATE');
          const began = waiting.rows[0]?.began ?? Number.NaN;

          // A second sign-in, authenticated while the route waits and in a later whole second
          // than the start of the route's transaction (auth_time has whole seconds): a cut-off
          // taken before the wait, at the start of the transaction or of a statement sent
          // before it, would be earlier than this authentication and let it through (RCX-02).
          // The database's clock is read until it shows that second; nothing is guessed.
          let second = await databaseSecond();
          while (second <= began) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            second = await databaseSecond();
          }
          idp.authTime = second;
          const login = await startLogin();
          const begins = idp.begins.length;
          const again = callback(login);
          // It queues for the same row, behind the route.
          await waitForLockWaiters(
            sql,
            signIn1,
            2,
            'the second sign-in never waited for the member row',
            { waiter: again },
          );

          held.release();
          // The first sign-in committed its session before the change.
          const signedIn = await first;
          expect(signedIn.headers.get('location')).toBe(`${PORTAL_ORIGIN}/`);
          const cookie = setCookie(signedIn, t.config.sessionCookieName) ?? '';
          expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
          // The route got the row next and ended that session.
          const changed = await changing;
          expect(changed.status).toBe(200);
          ended(await changed.json());
          // The second sign-in got the row after the change: refused, though it was
          // authenticated after the route's transaction began.
          expectRefused(await again, refusal, idp.state);
          if (refusal === 'reauth') {
            expect(idp.begins.slice(begins)).toEqual([{ reauthenticate: true }]);
          }

          // No session of the member outlived the change, and that authentication is spent.
          expect(await sessionOf(cookie)).toMatchObject({ authenticated: false });
          expect(await liveSessions(target.membershipId)).toBe(0);
          const beginsAfter = idp.begins.length;
          const third = await callback(await startLogin());
          expectRefused(third, refusal, idp.state);
          if (refusal === 'reauth') {
            expect(idp.begins.slice(beginsAfter)).toEqual([undefined, { reauthenticate: true }]);
          }
          expect(await liveSessions(target.membershipId)).toBe(0);
        } finally {
          held.release();
          idp.sub = sub;
        }
      });
    },
  );
});
