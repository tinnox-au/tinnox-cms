/**
 * Every operator route under every role (CMS-13, DEC-35). The oracle, `allowed` in routes.ts
 * (shared with the Editor pass of cross-org.test.ts), is written from the decision and not read
 * from the API's route table: a wrong table would otherwise test itself
 * (docs/portal-v2/stage-c.md 15, choice 17).
 *
 * - A Viewer may only read, except the people list, the invites and the alert addresses.
 * - An Editor may do everything except the people, invite and alert address routes; the names
 *   of people (activity) are the one people route it may read. Its screens' alert settings are
 *   a field of the display PATCH (CMS-15).
 * - An Admin and an Owner may do everything; the rank rule is tested in
 *   apps/api/test/members.integration.test.ts.
 *
 * A refusal by role is decided before any lookup, so it is the same 403 for an unknown id, for
 * the caller's own objects and for another organisation's (DEC-35, D1).
 */
import { randomUUID } from 'node:crypto';
import { ROLES, type Role } from '@tinnox/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowed, OPERATOR_ROUTE_PATTERNS } from './routes.ts';
import {
  addMember,
  createDisplay,
  createOrg,
  createPlaylist,
  ERROR_STATUS,
  signIn,
  startTestApp,
  type AnsweredErrorCode,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

/** The parts of a refusal that must not depend on the id: everything but the request id. */
async function refusal(
  response: Response,
): Promise<{ status: number; code: string; message: string; details: unknown }> {
  const body = (await response.json()) as ErrorBody;
  return {
    status: response.status,
    code: body.error.code,
    message: body.error.message,
    details: body.error.details,
  };
}

/**
 * What an allowed probe (empty body, random id) may answer: the handler ran, past the role
 * guard. Each refusal is the exact pair of status and code (RCX-03; plan section 1.7): the
 * status alone would also take a 400 or 404 from somewhere else. A 429 is answered in onRequest,
 * before the guard, and a 5xx is a failure: neither proves access.
 */
const ALLOWED_REFUSALS: readonly AnsweredErrorCode[] = [
  'validation_failed',
  'not_found',
  'unsupported_media_type',
];

/** `200`, or `<status> <code>` of the error the answer carries. */
async function allowedAnswer(response: Response): Promise<string> {
  if (response.status === 200) {
    await response.body?.cancel();
    return '200';
  }
  const text = await response.text();
  try {
    return `${String(response.status)} ${(JSON.parse(text) as ErrorBody).error.code}`;
  } catch {
    return `${String(response.status)} ${text.slice(0, 100)}`;
  }
}
const ALLOWED_ANSWERS = new Set([
  '200',
  ...ALLOWED_REFUSALS.map((code) => `${String(ERROR_STATUS[code])} ${code}`),
]);

const FORBIDDEN = {
  status: 403,
  code: 'forbidden',
  message: "Your role doesn't allow this.",
  details: undefined,
};

describe('the role-by-route matrix', () => {
  let t: TestApp;
  let org: TestOrg;
  const operators = new Map<Role, Operator>();
  let ownDisplayId: string;
  let ownPlaylistId: string;
  let foreignDisplayId: string;
  let foreignPlaylistId: string;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg('Roles matrix');
    const owner = await signIn(t, org);
    operators.set('owner', owner);
    for (const role of ROLES.filter((r) => r !== 'owner')) {
      operators.set(role, await signIn(t, await addMember(org, role)));
    }
    ownDisplayId = (await createDisplay(owner, org, 'Matrix screen')).id;
    ownPlaylistId = await createPlaylist(owner, 'Matrix playlist');
    const other = await createOrg('Roles matrix, another organisation');
    const otherOwner = await signIn(t, other);
    foreignDisplayId = (await createDisplay(otherOwner, other, 'Foreign screen')).id;
    foreignPlaylistId = await createPlaylist(otherOwner, 'Foreign playlist');
  });
  afterAll(async () => {
    await t.close();
  });

  const operator = (role: Role): Operator => {
    const found = operators.get(role);
    if (found === undefined) throw new Error(`no ${role}`);
    return found;
  };

  it('checks all 63 routes', () => {
    expect(OPERATOR_ROUTE_PATTERNS).toHaveLength(63);
  });

  it.each(ROLES)('answers every route as the oracle says for an %s', async (role) => {
    const id = randomUUID();
    const wrong: string[] = [];
    for (const [method, pattern] of OPERATOR_ROUTE_PATTERNS) {
      const what = `${method} ${pattern}`;
      const response = await operator(role).fetch(pattern.replace(':id', id), { method });
      if (allowed(role, method, pattern)) {
        const answer = await allowedAnswer(response);
        if (!ALLOWED_ANSWERS.has(answer)) {
          wrong.push(`${what}: ${answer}, expected to be allowed`);
        }
      } else {
        const answer = await refusal(response);
        if (JSON.stringify(answer) !== JSON.stringify(FORBIDDEN)) {
          wrong.push(`${what}: ${JSON.stringify(answer)}, expected the role refusal`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('refuses a write with the same 403 for an unknown id, the caller’s own objects and another organisation’s (D1)', async () => {
    for (const role of ROLES) {
      for (const [method, pattern] of OPERATOR_ROUTE_PATTERNS) {
        if (!pattern.includes(':id') || allowed(role, method, pattern)) continue;
        for (const id of [
          randomUUID(),
          ownDisplayId,
          ownPlaylistId,
          foreignDisplayId,
          foreignPlaylistId,
        ]) {
          const response = await operator(role).fetch(pattern.replace(':id', id), { method });
          expect(await refusal(response), `${role} ${method} ${pattern} ${id}`).toEqual(FORBIDDEN);
        }
      }
    }
  });

  it('answers HEAD like GET for a Viewer', async () => {
    for (const path of ['/api/displays', `/api/displays/${ownDisplayId}`, '/api/playlists']) {
      const response = await operator('viewer').fetch(path, { method: 'HEAD' });
      expect(response.status, path).toBe(200);
    }
  });

  it('changed nothing through a refused request', async () => {
    const display = (await (
      await operator('owner').fetch(`/api/displays/${ownDisplayId}`)
    ).json()) as {
      name: string;
    };
    expect(display.name).toBe('Matrix screen');
    expect((await operator('owner').fetch(`/api/playlists/${ownPlaylistId}`)).status).toBe(200);
  });
});
