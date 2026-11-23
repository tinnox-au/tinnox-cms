/**
 * The refusal-only transaction (SCR-32, D2; adoption plan step 20): a refusal that changed
 * nothing leaves its audit row in a transaction of its own, with a permit that reads no role
 * again, takes no callback and no success, and is held to what the route's guards and the
 * route itself may record. The statements are read off a fake connection; the type cases are
 * checked by `npm run typecheck`.
 */
import { ROUTES } from '@tinnox/contracts';
import { changeOrg, type AuditInput, type Change, type OrgTx } from '@tinnox/db';
import type { FastifyRequest } from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  contextOn,
  fakePool,
  MEMBER,
  ORG,
  requestTo,
  SESSION,
  SET_ORG,
} from '../change.test-support.ts';
import type { AppContext } from '../context.ts';
import { changeAsOperator, ROUTE_PERMISSIONS } from './permissions.ts';
import { recordRefusal, type RefusalEvent } from './refusal.ts';

const BY_THE_MEMBER = { actorType: 'operator', actorId: MEMBER } as const;
const CSRF_REJECTED = {
  ...BY_THE_MEMBER,
  action: 'security.csrf_rejected',
  objectType: null,
  objectId: null,
  result: 'denied',
  detail: { reason: 'token', method: 'POST', route: ROUTES.folders },
} as const satisfies RefusalEvent;
const PERMISSION_DENIED = {
  ...BY_THE_MEMBER,
  action: 'security.permission_denied',
  objectType: 'route',
  objectId: `POST ${ROUTES.folders}`,
  result: 'denied',
  detail: { permission: ['content.write'], method: 'POST', route: ROUTES.folders, reason: 'role' },
} as const satisfies RefusalEvent;
const UPLOAD_REFUSED = {
  ...BY_THE_MEMBER,
  action: 'media.upload',
  objectType: 'media',
  objectId: null,
  result: 'denied',
  detail: { reason: 'storage_quota_exceeded' },
} as const satisfies RefusalEvent;
const UPLOAD_FAILED = {
  ...UPLOAD_REFUSED,
  result: 'failure',
  detail: { reason: 'empty_file' },
} as const satisfies RefusalEvent;
const FOLDER_CREATED = {
  ...BY_THE_MEMBER,
  action: 'folder.create',
  objectType: 'folder',
  objectId: 'a-folder-id',
  result: 'success',
  detail: null,
} as const satisfies AuditInput;

/** A POST as the role guard leaves it: the row's requirement and its statement. */
const letThrough = (url: string): FastifyRequest => {
  const rule = ROUTE_PERMISSIONS[`POST ${url}`];
  if (rule === undefined) throw new Error(`POST ${url} has no row`);
  return requestTo('POST', url, {
    required: { all: ['content.write'] },
    audit: rule.audit,
  });
};
const uploadRequest = (): FastifyRequest => letThrough(ROUTES.media);

describe('a refusal recorded on its own (SCR-32, D2)', () => {
  it('writes the one audit row and nothing else: no role is read again', async () => {
    // Before the role guard ran, as requireOperator refuses a request without the CSRF token.
    const { pool, transactions } = fakePool();
    await recordRefusal(contextOn(pool), requestTo('POST', ROUTES.folders), SESSION, CSRF_REJECTED);
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'AUDIT security.csrf_rejected denied', 'COMMIT'],
    ]);
  });

  it('records a refusal by role, which the permit of the write itself could not', async () => {
    const { pool, transactions } = fakePool();
    await recordRefusal(
      contextOn(pool),
      requestTo('POST', ROUTES.folders),
      SESSION,
      PERMISSION_DENIED,
    );
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'AUDIT security.permission_denied denied', 'COMMIT'],
    ]);
  });

  it('records a refused and a failed attempt at the action of the route the guard let through (D3)', async () => {
    const { pool, transactions } = fakePool();
    await recordRefusal(contextOn(pool), uploadRequest(), SESSION, UPLOAD_REFUSED);
    await recordRefusal(contextOn(pool), uploadRequest(), SESSION, UPLOAD_FAILED);
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'AUDIT media.upload denied', 'COMMIT'],
      ['BEGIN', SET_ORG, 'AUDIT media.upload failure', 'COMMIT'],
    ]);
  });

  it('refuses an action that neither the guards nor the route state, and commits nothing', async () => {
    const { pool, transactions } = fakePool();
    // The role guard has not let this request through, so no row of the route is known.
    await expect(
      recordRefusal(contextOn(pool), requestTo('POST', ROUTES.media), SESSION, UPLOAD_REFUSED),
    ).rejects.toThrow(
      'changeOrg: the change recorded media.upload, which the refusal statement of POST /api/media (OPERATOR_GUARD_AUDIT in apps/api/src/route-audit.ts, and, once the role guard has let the request through, those actions of its row of ROUTE_PERMISSIONS in apps/api/src/auth/permissions.ts that ATTEMPT_AUDITED_ACTIONS lets a refusal record on its own) does not state: it states security.csrf_rejected, security.permission_denied.',
    );
    // Another route's action, on a route the guard did let through.
    await expect(
      recordRefusal(contextOn(pool), uploadRequest(), SESSION, {
        ...FOLDER_CREATED,
        result: 'denied',
      }),
    ).rejects.toThrow(/^changeOrg: the change recorded folder\.create, which .* does not state/);
    for (const statements of transactions) expect(statements.at(-1)).toBe('ROLLBACK');
    expect(transactions).toHaveLength(2);
  });

  it("refuses a denied attempt at the route's own action when D3 does not audit every attempt at it (step 20 review)", async () => {
    // POST /api/folders states folder.create, but a refused folder.create is a business-rule
    // refusal, which writes no row (D3): only the guards' refusals may be recorded on their own.
    const { pool, transactions } = fakePool();
    await expect(
      recordRefusal(contextOn(pool), letThrough(ROUTES.folders), SESSION, {
        ...FOLDER_CREATED,
        result: 'denied',
      }),
    ).rejects.toThrow(
      /^changeOrg: the change recorded folder\.create, which the refusal statement of POST \/api\/folders .* does not state: it states security\.csrf_rejected, security\.permission_denied\./,
    );
    // The guards' refusals still are.
    await recordRefusal(contextOn(pool), letThrough(ROUTES.folders), SESSION, PERMISSION_DENIED);
    expect(transactions.map((statements) => statements.at(-1))).toEqual(['ROLLBACK', 'COMMIT']);
  });

  it('holds a route outside the operator table to its own guard, and a read to none', async () => {
    const { pool, transactions } = fakePool();
    // Signing out needs the Origin and the token, and has no role to refuse by.
    await recordRefusal(contextOn(pool), requestTo('POST', ROUTES.authLogout), SESSION, {
      ...CSRF_REJECTED,
      detail: { ...CSRF_REJECTED.detail, route: ROUTES.authLogout },
    });
    expect(transactions.at(-1)?.at(-1)).toBe('COMMIT');
    await expect(
      recordRefusal(
        contextOn(pool),
        requestTo('POST', ROUTES.authLogout),
        SESSION,
        PERMISSION_DENIED,
      ),
    ).rejects.toThrow(
      /^changeOrg: the change recorded security\.permission_denied, which the guard of POST \/api\/auth\/logout in OTHER_ROUTE_AUDIT \(apps\/api\/src\/route-audit\.ts\) does not state: it states security\.csrf_rejected\./,
    );
    // The guards of a read record nothing (OPERATOR_GUARD_AUDIT is for state-changing requests).
    await expect(
      recordRefusal(contextOn(pool), requestTo('GET', ROUTES.folders), SESSION, PERMISSION_DENIED),
    ).rejects.toThrow(/does not state: it states no action at all\. /);
    expect(transactions.filter((statements) => statements.at(-1) === 'COMMIT')).toHaveLength(1);
  });

  it('refuses at run time an event that was cast to a refusal, before any statement', async () => {
    const { pool, transactions } = fakePool();
    await expect(
      recordRefusal(
        contextOn(pool),
        requestTo('POST', ROUTES.folders),
        SESSION,
        FOLDER_CREATED as never,
      ),
    ).rejects.toThrow(
      'recordRefusal writes the audit row of a refusal, and was given an event whose result is success. A change and its audit row commit together: return the event from the change, as { value, audit } in changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts)',
    );
    expect(transactions).toEqual([]);
  });
});

// Never called: these lines are for the type checker.
describe('the permit of a refusal allows the audit row of a refusal and nothing else (SCR-32)', () => {
  it('takes no success, no callback and no handle, and is not a way around the role guard', () => {
    const cases = async (ctx: AppContext, request: FastifyRequest): Promise<void> => {
      await recordRefusal(ctx, request, SESSION, CSRF_REJECTED);
      // @ts-expect-error a success is the audit row of a change: it commits with that change
      await recordRefusal(ctx, request, SESSION, FOLDER_CREATED);
      // @ts-expect-error nor an event whose result is not known to be a refusal
      await recordRefusal(ctx, request, SESSION, { ...CSRF_REJECTED, result: 'success' });
      const change = (tx: OrgTx): Promise<Change<number>> =>
        tx.query('INSERT FOLDER').then(() => ({ value: 1, audit: CSRF_REJECTED }));
      // @ts-expect-error there is no callback to change anything in: the event is all it takes
      await recordRefusal(ctx, request, SESSION, change);
      // @ts-expect-error and no fifth argument either
      await recordRefusal(ctx, request, SESSION, CSRF_REJECTED, change);
      // @ts-expect-error the refusal's permit never leaves recordRefusal: changeOrg still wants one
      await changeOrg(ctx.pool, ORG, change);
      // @ts-expect-error a session is not a permit
      await changeOrg(ctx.pool, ORG, SESSION, change);
      // A write goes through the role guard, which reads the role again first.
      await changeAsOperator(ctx, request, change);
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<RefusalEvent['result']>().toEqualTypeOf<'denied' | 'failure'>();
    expectTypeOf(recordRefusal).returns.toEqualTypeOf<Promise<void>>();
  });
});
