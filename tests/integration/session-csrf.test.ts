/**
 * Cookie-session boundary: unauthenticated access, CSRF token, Origin allowlist,
 * session expiry and sign-out, and the CORS rules of the two route groups.
 *
 * The routes probed come from the application itself (OTH-14, adoption plan step 33):
 * `registeredRoutes` gives every route it registers, read from the two route tables that the
 * start-up checks on Fastify's app-level `onRoute` hook hold equal to what is registered, so a
 * route added with a literal path or outside the operator scope is in the list too. Every /api
 * route is an operator route and is probed for its session, and every state-changing one for
 * its CSRF token and its Origin, unless NOT_OPERATOR below gives it another class and the
 * reason; any other route must be classified there, or the inventory test fails.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, ROUTES } from '@tinnox/contracts';
import { OPERATOR_ROUTE_PATTERNS } from './routes.ts';
import {
  addMember,
  arrangeAsDefiner,
  CLOCK,
  createApp,
  createDisplay,
  createLayout,
  createOrg,
  createPlaylist,
  createSchedule,
  layoutZones,
  PLAYER_ORIGIN,
  PORTAL_ORIGIN,
  readyImage,
  registeredRoutes,
  signIn,
  startTestApp,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

const HERE = 'NOT_OPERATOR in tests/integration/session-csrf.test.ts';

/**
 * Why a route takes no operator session, by class. Neither a device credential nor a polling
 * token nor a signed address is sent by a browser on its own, so a cross-site request cannot
 * carry one, and none of these routes reads the session cookie.
 */
const CLASSES = {
  public:
    'opened by someone who has no session (yet), so there is no session or CSRF token to ask for',
  device:
    'authorised by the device credential in the Authorization header, never by the session cookie; probed below: a session cookie with its token and the portal Origin does not stand in for it',
  pairing:
    'the pairing of a player that has no credential yet: creating a session needs nothing, and collecting it needs the polling token in the Authorization header',
  signedUrl: 'authorised by the signature in its query string alone',
} as const;
type RouteClass = keyof typeof CLASSES;

/** Every registered route that is not an operator route: its class, and what it is. */
const NOT_OPERATOR: Readonly<Record<string, { readonly class: RouteClass; readonly is: string }>> =
  {
    [`GET ${ROUTES.healthz}`]: { class: 'public', is: 'the liveness probe; reads nothing' },
    [`GET ${ROUTES.readyz}`]: { class: 'public', is: 'the readiness probe; reads no tenant data' },
    [`GET ${ROUTES.authLogin}`]: { class: 'public', is: 'starts a sign-in' },
    [`GET ${ROUTES.authCallback}`]: {
      class: 'public',
      is: "the identity provider's redirect, held by the login state cookie, the state and PKCE",
    },
    [`GET ${ROUTES.session}`]: {
      class: 'public',
      is: 'says whether the browser has a session; changes nothing',
    },
    [`POST ${ROUTES.alertRecipientConfirm}`]: {
      class: 'public',
      is: "the confirmation link of an alert address, posted by the address's owner with the token from the e-mail (CMS-15)",
    },
    [`POST ${ROUTES.playerPairing}`]: { class: 'pairing', is: 'a player asks for a pairing code' },
    [`GET ${ROUTES.playerPairingPollPattern}`]: {
      class: 'pairing',
      is: 'the player polls for, and collects, its credential',
    },
    [`GET ${ROUTES.playerMediaPattern}`]: { class: 'signedUrl', is: 'the media download' },
    [`GET ${ROUTES.playerManifest}`]: { class: 'device', is: 'the manifest' },
    [`POST ${ROUTES.playerMediaUrls}`]: { class: 'device', is: 'signs media addresses' },
    [`POST ${ROUTES.playerHeartbeat}`]: { class: 'device', is: 'the heartbeat' },
    // Not in ROUTES: the player gives up its own credential (docs/player-protocol-v1.md).
    ['DELETE /player/registration']: { class: 'device', is: 'the player resets itself' },
  };

const methodOf = (route: string): string => route.slice(0, route.indexOf(' '));
const patternOf = (route: string): string => route.slice(route.indexOf(' ') + 1);
/** A pattern with every parameter replaced by `id`. */
const pathOf = (route: string, id: string): string => patternOf(route).replace(/:\w+/g, id);

/**
 * A refusal as the client sees it: the status and the error, with no request id. An answer that
 * is not an error (a 204 with no body, when a check let the request through) keeps its body as
 * text, so the probe's message names the route and the requirement that let it pass.
 */
async function refusalOf(
  response: Response,
): Promise<{ readonly status: number; readonly error: Readonly<Record<string, unknown>> }> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: response.status, error: { body: text } };
  }
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'object' && error !== null
    ? { status: response.status, error: { ...(error as Record<string, unknown>), requestId: null } }
    : { status: response.status, error: { body: text } };
}

describe('operator session, CSRF and origin checks', () => {
  let t: TestApp;
  let org: TestOrg;
  let operator: Operator;
  let displayId: string;
  /** An id of this organisation's own row for each kind of /api/<kind>/:id route. */
  let ownIds: Readonly<Record<string, string>>;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg('Session checks');
    operator = await signIn(t, org);
    displayId = (await createDisplay(operator, org)).id;
    const created = async (path: string, json: unknown): Promise<string> => {
      const response = await operator.fetch(path, { method: 'POST', json });
      if (response.status !== 201) throw new Error(`arranging ${path}: ${response.status}`);
      return ((await response.json()) as { id: string }).id;
    };
    const [main, band] = [
      await createPlaylist(operator, 'Main loop'),
      await createPlaylist(operator, 'Band loop'),
    ];
    ownIds = {
      displays: displayId,
      media: (await readyImage(t, operator)).id,
      apps: (await createApp(operator, CLOCK, 'Own clock')).id,
      schedules: (await createSchedule(operator, 'Own hours', main)).id,
      layouts: (await createLayout(operator, 'Own layout', layoutZones(main, band))).id,
      tags: await created('/api/tags', { scope: 'media', name: 'own-tag' }),
      folders: await created('/api/folders', { name: 'Own folder' }),
      playlists: main,
      members: (await addMember(org, 'viewer', 'Own Member')).membershipId,
      invites: await created('/api/invites', {
        name: 'Own Invitee',
        email: 'own-invitee@example.com',
        role: 'viewer',
      }),
      'alert-recipients': await created('/api/alert-recipients', {
        email: 'own-alerts@example.com',
      }),
    };
  });
  afterAll(async () => {
    await t.close();
  });

  /** The operator routes, as the application registers them: every /api route not classified. */
  const operatorRoutes = (): string[] =>
    registeredRoutes(t.app).filter(
      (route) =>
        !Object.hasOwn(NOT_OPERATOR, route) && patternOf(route).startsWith(`${API_PREFIX}/`),
    );

  it('classifies every route the application registers (OTH-14)', () => {
    const routes = registeredRoutes(t.app);
    const unclassified = routes
      .filter(
        (route) =>
          !Object.hasOwn(NOT_OPERATOR, route) && !patternOf(route).startsWith(`${API_PREFIX}/`),
      )
      .map(
        (route) =>
          `${route} is neither an /api route, which is probed as an operator route, nor classified: give it a class and say what it is in ${HERE}`,
      );
    const stale = Object.keys(NOT_OPERATOR)
      .filter((route) => !routes.includes(route))
      .map((route) => `${route} is classified in ${HERE} but not registered: remove it`);
    expect([...unclassified, ...stale]).toEqual([]);
    // Every operator route but sign-out is in the role oracle of roles-matrix.test.ts and
    // cross-org.test.ts, which is written out by hand on purpose.
    expect(
      operatorRoutes()
        .filter((route) => route !== `POST ${ROUTES.authLogout}`)
        .sort(),
    ).toEqual(OPERATOR_ROUTE_PATTERNS.map(([method, pattern]) => `${method} ${pattern}`).sort());
  });

  it('refuses every operator route without a session, its token or the portal Origin, whatever the id (OTH-14, DEC-35)', async () => {
    const other = await signIn(t, org);
    const unknown = randomUUID();
    const routes = operatorRoutes();
    // Sign-out, the 36 operator writes and the 27 operator reads, at least.
    expect(routes.length).toBeGreaterThan(60);
    const wrong: string[] = [];
    for (const route of routes) {
      const method = methodOf(route);
      const changes = method !== 'GET';
      const kind = patternOf(route).split('/')[2] ?? '';
      const takesId = /\/:\w+/.test(patternOf(route));
      const own = Object.hasOwn(ownIds, kind) ? ownIds[kind] : undefined;
      if (takesId && own === undefined) {
        wrong.push(`${route}: no own row to probe with: add one for "${kind}" to ownIds`);
        continue;
      }
      const send = (id: string, headers: Record<string, string>): Promise<Response> =>
        fetch(`${t.url}${pathOf(route, id)}`, { method, headers });

      // Each refusal, with a never-issued id and, for a route that takes one, the id of an own
      // row: decided before any lookup, so the two answers are the same (AGENTS.md section 2).
      const probes: [string, Record<string, string>, number, string][] = [
        ...[
          undefined,
          `tinnox_session=${randomBytes(32).toString('base64url')}`,
          'tinnox_session=x',
        ].map((cookie): [string, Record<string, string>, number, string] => [
          `no session (${cookie === undefined ? 'no cookie' : 'a made-up cookie'})`,
          {
            origin: PORTAL_ORIGIN,
            'x-csrf-token': randomBytes(32).toString('base64url'),
            ...(cookie === undefined ? {} : { cookie }),
          },
          401,
          'unauthenticated',
        ]),
        ...(changes
          ? [
              ...[undefined, other.csrfToken].map(
                (token): [string, Record<string, string>, number, string] => [
                  `without this session's token (${token === undefined ? 'none' : "another session's"})`,
                  {
                    cookie: operator.cookie,
                    origin: PORTAL_ORIGIN,
                    ...(token === undefined ? {} : { 'x-csrf-token': token }),
                  },
                  403,
                  'csrf_failed',
                ],
              ),
              ...[undefined, PLAYER_ORIGIN, 'https://attacker.example'].map(
                (origin): [string, Record<string, string>, number, string] => [
                  `from ${origin ?? 'no Origin'}`,
                  {
                    cookie: operator.cookie,
                    'x-csrf-token': operator.csrfToken,
                    ...(origin === undefined ? {} : { origin }),
                  },
                  403,
                  'origin_not_allowed',
                ],
              ),
            ]
          : []),
      ];
      for (const [what, headers, status, code] of probes) {
        const answer = await refusalOf(await send(unknown, headers));
        if (answer.status !== status || answer.error['code'] !== code) {
          wrong.push(
            `${route} ${what}: answered ${JSON.stringify(answer)}, not ${String(status)} ${code}`,
          );
        }
        if (own !== undefined && takesId) {
          const ownAnswer = await refusalOf(await send(own, headers));
          if (JSON.stringify(ownAnswer) !== JSON.stringify(answer)) {
            wrong.push(
              `${route} ${what}: an own id answered ${JSON.stringify(ownAnswer)}, a never-issued one ${JSON.stringify(answer)}; the refusal must be decided before the id is looked up`,
            );
          }
        }
      }

      // With all three, the request gets past the checks to the handler, which refuses the
      // empty request on its own terms: no valid body, no such id, or not multipart. Named
      // exactly, so a crash or a rate limit fails here too (RCX-03; CHK-4 of the group C
      // review). Not for sign-out, which would end the session the probes use.
      if (changes && route !== `POST ${ROUTES.authLogout}`) {
        const passed = await send(unknown, {
          cookie: operator.cookie,
          origin: PORTAL_ORIGIN,
          'x-csrf-token': operator.csrfToken,
        });
        const { code } = ((await passed.json()) as { error: { code: string } }).error;
        const reached = `${String(passed.status)} ${code}`;
        if (
          !['400 validation_failed', '404 not_found', '415 unsupported_media_type'].includes(
            reached,
          )
        ) {
          wrong.push(`${route} with session, token and Origin: answered ${reached}`);
        }
      }
    }
    expect(wrong).toEqual([]);

    // Nothing a refused request named was changed: every own row is still there.
    for (const [kind, id] of Object.entries(ownIds)) {
      expect(await (await operator.fetch(`/api/${kind}`)).text(), `${kind} ${id}`).toContain(id);
    }
    // The session survived every refused request, the refused sign-outs included.
    expect((await operator.fetch('/api/displays')).status).toBe(200);
    const session = await fetch(`${t.url}/api/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: false });
  });

  // Every route held by a device credential, with a session cookie, its token and the portal
  // Origin in place of the credential.
  it('refuses a device credential on operator routes and a session cookie on player routes', async () => {
    const device = Object.entries(NOT_OPERATOR).filter(([, c]) => c.class === 'device');
    expect(device.length).toBeGreaterThan(3);
    for (const [route] of device) {
      const response = await fetch(`${t.url}${pathOf(route, randomUUID())}`, {
        method: methodOf(route),
        headers: {
          cookie: operator.cookie,
          origin: PORTAL_ORIGIN,
          'x-csrf-token': operator.csrfToken,
        },
      });
      expect(response.status, `${route}: ${CLASSES.device}`).toBe(401);
    }
    const asBearer = await fetch(`${t.url}/api/displays`, {
      headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
    });
    expect(asBearer.status).toBe(401);
  });

  it('requires the CSRF token of this session on every state-changing request', async () => {
    const other = await signIn(t, org);
    const body = JSON.stringify({ name: 'Renamed without token' });
    const base = {
      cookie: operator.cookie,
      origin: PORTAL_ORIGIN,
      'content-type': 'application/json',
    };
    const cases: [string, Record<string, string>][] = [
      ['no token', {}],
      ['empty token', { 'x-csrf-token': '' }],
      ['random token', { 'x-csrf-token': randomBytes(32).toString('base64url') }],
      ['token of another session of the same user', { 'x-csrf-token': other.csrfToken }],
    ];
    for (const [what, extra] of cases) {
      const response = await fetch(`${t.url}/api/displays/${displayId}`, {
        method: 'PATCH',
        headers: { ...base, ...extra },
        body,
      });
      expect(response.status, what).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'csrf_failed',
      );
    }
    // A token in the query string or the body is not accepted in place of the header.
    const inQuery = await fetch(
      `${t.url}/api/displays/${displayId}?x-csrf-token=${operator.csrfToken}`,
      {
        method: 'PATCH',
        headers: base,
        body,
      },
    );
    expect(inQuery.status).toBe(403);
    const display = (await (await operator.fetch(`/api/displays/${displayId}`)).json()) as {
      name: string;
    };
    expect(display.name).toBe('Test display');
  });

  it('requires the exact portal Origin on every state-changing request, even with a valid token', async () => {
    const send = (headers: Record<string, string>): Promise<Response> =>
      fetch(`${t.url}/api/displays/${displayId}`, {
        method: 'PATCH',
        headers: {
          cookie: operator.cookie,
          'x-csrf-token': operator.csrfToken,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ name: 'Renamed from elsewhere' }),
      });
    const refused: [string, Record<string, string>][] = [
      ['no Origin', {}],
      ['the player origin', { origin: PLAYER_ORIGIN }],
      ['another site', { origin: 'https://attacker.example' }],
      ['same host, other port', { origin: 'http://localhost:5175' }],
      ['same host, other scheme', { origin: 'https://localhost:5173' }],
      ['look-alike host', { origin: 'http://localhost:5173.attacker.example' }],
      ['null', { origin: 'null' }],
      [
        'right Origin but a cross-site fetch',
        { origin: PORTAL_ORIGIN, 'sec-fetch-site': 'cross-site' },
      ],
    ];
    for (const [what, headers] of refused) {
      const response = await send(headers);
      expect(response.status, what).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'origin_not_allowed',
      );
    }
    const display = (await (await operator.fetch(`/api/displays/${displayId}`)).json()) as {
      name: string;
    };
    expect(display.name).toBe('Test display');
    // The same request from the portal, with its token, works.
    expect((await send({ origin: PORTAL_ORIGIN, 'sec-fetch-site': 'same-origin' })).status).toBe(
      200,
    );

    const audit = (await (await operator.fetch('/api/audit?limit=200')).json()) as {
      items: { action: string; result: string }[];
    };
    expect(
      audit.items.filter(
        (event) => event.action === 'security.csrf_rejected' && event.result === 'denied',
      ).length,
    ).toBeGreaterThanOrEqual(refused.length);
  });

  it('never grants cross-origin access to the operator API', async () => {
    for (const origin of ['https://attacker.example', PLAYER_ORIGIN, PORTAL_ORIGIN]) {
      const preflight = await fetch(`${t.url}/api/displays`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-csrf-token,content-type',
        },
      });
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
      const read = await fetch(`${t.url}/api/displays`, {
        headers: { origin, cookie: operator.cookie },
      });
      expect(read.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('allows CORS on player routes for the player origin only, never with credentials', async () => {
    const allowed = await fetch(`${t.url}/player/manifest`, {
      method: 'OPTIONS',
      headers: {
        origin: PLAYER_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,if-none-match',
      },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(PLAYER_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    for (const origin of [
      'https://attacker.example',
      PORTAL_ORIGIN,
      'http://localhost:5174.attacker.example',
      'null',
    ]) {
      const preflight = await fetch(`${t.url}/player/manifest`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });
      expect(preflight.headers.get('access-control-allow-origin'), origin).toBeNull();
      const post = await fetch(`${t.url}/player/pairing`, { method: 'POST', headers: { origin } });
      expect(post.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('sends hardening headers and never caches API answers', async () => {
    const response = await operator.fetch('/api/displays');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // A text/plain or form body is not parsed as JSON by accident (CSRF through simple requests).
    const form = await fetch(`${t.url}/api/playlists`, {
      method: 'POST',
      headers: {
        cookie: operator.cookie,
        origin: PORTAL_ORIGIN,
        'x-csrf-token': operator.csrfToken,
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ name: 'smuggled' }),
    });
    expect(form.status).toBe(415);
  });

  it('ends a session at sign-out, at its absolute expiry and after the idle timeout', async () => {
    const signedOut = await signIn(t, org);
    expect((await signedOut.fetch('/api/displays')).status).toBe(200);
    // Sign-out itself is CSRF-protected.
    const withoutToken = await fetch(`${t.url}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: signedOut.cookie, origin: PORTAL_ORIGIN },
    });
    expect(withoutToken.status).toBe(403);
    expect((await signedOut.fetch('/api/displays')).status).toBe(200);
    const logout = await signedOut.fetch('/api/auth/logout', { method: 'POST' });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie') ?? '').toMatch(/tinnox_session=;/);
    expect((await signedOut.fetch('/api/displays')).status).toBe(401);

    const expired = await signIn(t, org);
    const idle = await signIn(t, org);
    await arrangeAsDefiner(
      "UPDATE public.session SET expires_at = now() - interval '1 second' WHERE csrf_token = $1",
      [expired.csrfToken],
    );
    await arrangeAsDefiner(
      "UPDATE public.session SET last_seen_at = now() - interval '31 minutes' WHERE csrf_token = $1",
      [idle.csrfToken],
    );
    expect((await expired.fetch('/api/displays')).status).toBe(401);
    expect((await idle.fetch('/api/displays')).status).toBe(401);
    expect(await (await expired.fetch('/api/session')).json()).toEqual({ authenticated: false });
    // The first session is unaffected.
    expect((await operator.fetch('/api/displays')).status).toBe(200);
  });

  it('refuses sign-in callbacks that do not belong to a sign-in this server started', async () => {
    for (const query of [
      '',
      '?code=abc&state=' + randomBytes(32).toString('base64url'),
      '?error=access_denied&state=x',
    ]) {
      const response = await fetch(`${t.url}/api/auth/callback${query}`, { redirect: 'manual' });
      expect(response.headers.get('set-cookie') ?? '').not.toMatch(
        /tinnox_session=[A-Za-z0-9_-]{20,}/,
      );
      // Every refusal sends the browser back to the portal with the reason (failureRedirect in
      // apps/api/src/routes/auth.ts): none of these started here, so the reason is the state.
      expect(response.status, query).toBe(303);
      expect(response.headers.get('location')).toBe(`${PORTAL_ORIGIN}/?authError=state`);
    }
    // The return path cannot send the browser to another site.
    const open = await fetch(`${t.url}/api/auth/login?returnTo=//attacker.example`, {
      redirect: 'manual',
    });
    expect(open.status).toBe(400);
  });
});
