import { describe, expect, it } from 'vitest';
import * as contracts from './index.ts';
import { LOGOUT_REDIRECT_MAX_LENGTH } from './session.ts';
import { PLAYER_PREFIX, ROUTES } from './routes.ts';
import {
  PREFLIGHT_RESPONSE,
  responseContractGaps,
  responseContractProblem,
  ROUTE_RESPONSE_SCHEMAS,
  UNROUTED_RESPONSE,
  type ResponseContract,
} from './responses.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function rowOf(route: string): ResponseContract {
  const row = ROUTE_RESPONSE_SCHEMAS[route];
  if (row === undefined) throw new Error(`no row for ${route}`);
  return row;
}

const logout = rowOf(`POST ${ROUTES.authLogout}`);
const manifest = rowOf(`GET ${ROUTES.playerManifest}`);
const deleteTag = rowOf(`DELETE ${ROUTES.tagPattern}`);
const media = rowOf(`GET ${ROUTES.playerMediaPattern}`);
const readyz = rowOf(`GET ${ROUTES.readyz}`);

const error = (code: string, message = 'Not found.') =>
  JSON.stringify({ error: { code, message, requestId: 'r-1' } });

describe('responseContractProblem (UTX-01)', () => {
  it('takes an answer that parses with its schema', () => {
    const body = JSON.stringify({ redirectTo: 'https://idp.example/logout' });
    expect(responseContractProblem(logout, { status: 200, contentType: JSON_TYPE, body })).toBe(
      null,
    );
  });

  it('refuses a server-built field past the contract limit, naming the field but not the value (UTX-01)', () => {
    const value = `https://idp.example/logout?${'x'.repeat(LOGOUT_REDIRECT_MAX_LENGTH)}`;
    const problem = responseContractProblem(logout, {
      status: 200,
      contentType: JSON_TYPE,
      body: JSON.stringify({ redirectTo: value }),
    });
    expect(problem).toContain('answered 200 with JSON that its client');
    expect(problem).toContain('redirectTo: Too big');
    expect(problem).not.toContain('xxxx');
  });

  it('parses every error answer with the error envelope', () => {
    expect(
      responseContractProblem(logout, {
        status: 404,
        contentType: JSON_TYPE,
        body: error('not_found'),
      }),
    ).toBe(null);
    expect(
      responseContractProblem(logout, {
        status: 400,
        contentType: JSON_TYPE,
        body: error('not_a_code'),
      }),
    ).toContain('error.code');
    expect(
      responseContractProblem(UNROUTED_RESPONSE, {
        status: 404,
        contentType: JSON_TYPE,
        body: error('not_found', 'm'.repeat(501)),
      }),
    ).toContain('error.message');
  });

  it('refuses an error answer that is not the JSON envelope', () => {
    expect(
      responseContractProblem(deleteTag, {
        status: 500,
        contentType: 'text/plain',
        body: 'oops',
      }),
    ).toContain('answered 500 with content type text/plain');
  });

  it('takes no body only at the statuses the row lists', () => {
    const empty = { contentType: undefined, body: undefined };
    expect(responseContractProblem(deleteTag, { status: 204, ...empty })).toBe(null);
    expect(responseContractProblem(manifest, { status: 204, ...empty })).toBe(null);
    expect(responseContractProblem(manifest, { status: 304, ...empty })).toBe(null);
    expect(
      responseContractProblem(media, { status: 206, contentType: 'video/mp4', body: undefined }),
    ).toBe(null);
    expect(responseContractProblem(logout, { status: 200, ...empty })).toContain(
      'a status at which its contract expects JSON',
    );
    expect(responseContractProblem(PREFLIGHT_RESPONSE, { status: 204, ...empty })).toBe(null);
  });

  it('refuses JSON from a route that sends none below 400', () => {
    expect(
      responseContractProblem(deleteTag, { status: 200, contentType: JSON_TYPE, body: '{}' }),
    ).toContain('says it never sends below 400');
  });

  it('refuses a JSON content type whose body is not JSON', () => {
    expect(
      responseContractProblem(logout, { status: 200, contentType: JSON_TYPE, body: '{' }),
    ).toContain('a body that is not JSON');
  });

  it('takes the readiness answer at 503, which is not the error envelope', () => {
    const body = JSON.stringify({
      status: 'not_ready',
      checks: {
        database: false,
        storage: true,
        mediaJobs: true,
        identityProvider: false,
        mediaWorker: false,
      },
    });
    expect(responseContractProblem(readyz, { status: 503, contentType: JSON_TYPE, body })).toBe(
      null,
    );
  });
});

describe('responseContractGaps (UTX-01)', () => {
  const registered = Object.keys(ROUTE_RESPONSE_SCHEMAS);

  it('finds nothing when every registered route has a row and every row a route', () => {
    expect(responseContractGaps(registered)).toEqual([]);
  });

  it('names a registered route with no row', () => {
    expect(responseContractGaps([...registered, 'PATCH /api/widgets/:id'])).toEqual([
      'PATCH /api/widgets/:id has no row in ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts): add one with the schema its client parses the answer with (json(...)), or noContent, redirect or bytes',
    ]);
  });

  it('names a row whose route is not registered', () => {
    const without = registered.filter((route) => route !== `DELETE ${PLAYER_PREFIX}/registration`);
    expect(responseContractGaps(without)).toEqual([
      `DELETE ${PLAYER_PREFIX}/registration has a row in ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts) but no route is registered for it: remove the row, or correct its method or pattern`,
    ]);
  });
});

describe('the entry points of the response contracts (UTX-01)', () => {
  // Only the tests read the table; through the index, the portal's bundle carried it.
  it('keeps the table out of the index, which the portal and the player import', () => {
    expect(Object.keys(contracts)).not.toContain('ROUTE_RESPONSE_SCHEMAS');
    expect(Object.keys(contracts)).not.toContain('responseContractProblem');
  });
});
