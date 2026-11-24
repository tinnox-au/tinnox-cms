/**
 * The response-contract check of the harness (UTX-01, adoption plan step 23a): startTestApp parses
 * every answer with the schema of its route in ROUTE_RESPONSE_SCHEMAS (packages/contracts), the
 * one the portal or the player parses it with, and a test that received an answer its client
 * would refuse fails (apps/api/test/response-contract.ts). These cases show the check reaches
 * every route group, catches an answer over a contract limit, and refuses a route with no row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOGOUT_REDIRECT_MAX_LENGTH, ROUTES } from '@tinnox/contracts';
import {
  createOrg,
  installResponseContractCheck,
  registeredRoutes,
  routesCheckedForContract,
  signIn,
  startTestApp,
  takeResponseContractMismatches,
  type IdentityProvider,
  type TestApp,
} from './support.ts';

describe('response contracts (UTX-01)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('checks the answers of the operations, operator and player routes alike', async () => {
    const operator = await signIn(t, await createOrg('Response contracts'));
    expect((await fetch(`${t.url}${ROUTES.healthz}`)).status).toBe(200);
    expect((await operator.fetch(ROUTES.displays)).status).toBe(200);
    // No device credential: the error envelope, from inside the player group.
    expect((await fetch(`${t.url}${ROUTES.playerManifest}`)).status).toBe(401);
    const checked = routesCheckedForContract();
    expect(checked.has(`GET ${ROUTES.healthz}`)).toBe(true);
    expect(checked.has(`GET ${ROUTES.displays}`)).toBe(true);
    expect(checked.has(`GET ${ROUTES.playerManifest}`)).toBe(true);
    expect(takeResponseContractMismatches()).toEqual([]);
  });

  it('holds the answer to an unknown path, which no route produced, to the error envelope', async () => {
    const before = [...routesCheckedForContract()];
    for (const path of ['/no-such-path', '/api/no-such-path', '/player/no-such-path']) {
      const response = await fetch(`${t.url}${path}`);
      expect(response.status, path).toBe(404);
    }
    // Fastify's not-found answer runs the root hooks with no route pattern: checked as
    // UNROUTED_RESPONSE, and counted under no route.
    expect([...routesCheckedForContract()]).toEqual(before);
    expect(takeResponseContractMismatches()).toEqual([]);
  });

  it('refuses to check an application with a route that has no row', () => {
    expect(() =>
      installResponseContractCheck(t.app, [...registeredRoutes(t.app), 'PATCH /api/widgets/:id']),
    ).toThrow(
      'PATCH /api/widgets/:id has no row in ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts)',
    );
  });
});

describe('an answer over a contract limit (UTX-01)', () => {
  let t: TestApp;
  // What UTX-01 was: an end-session address longer than LogoutResponseSchema allows. The real
  // provider now leaves the hint out or answers null (apps/api/src/auth/oidc.ts); this one does not.
  const tooLong = `https://idp.invalid/logout?pad=${'p'.repeat(LOGOUT_REDIRECT_MAX_LENGTH)}`;
  const identityProvider: IdentityProvider = {
    beginLogin: () => Promise.reject(new Error('not used here')),
    completeLogin: () => Promise.reject(new Error('not used here')),
    endSessionUrl: () => Promise.resolve(tooLong),
    check: () => Promise.resolve(false),
  };

  beforeAll(async () => {
    t = await startTestApp({}, 1000, { identityProvider });
  });
  afterAll(async () => {
    await t.close();
  });

  it('fails the test that received it, naming the route and the field', async () => {
    const operator = await signIn(t, await createOrg('Response contract breach'));
    const response = await operator.fetch(ROUTES.authLogout, { method: 'POST' });
    // The API sends it; the portal would refuse it as invalid_response.
    expect(response.status).toBe(200);
    const mismatches = takeResponseContractMismatches();
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain(`POST ${ROUTES.authLogout} answered 200`);
    expect(mismatches[0]).toContain('redirectTo: Too big');
    // Taken above, so this test passes; left in place, the harness's afterEach fails it.
  });
});
