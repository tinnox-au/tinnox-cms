/**
 * The write of an operator route on changeOrg (SCR-34, DEC-35; adoption plan step 19): the role
 * guard issues the permit, the permit's re-check is the first statement of the transaction, and
 * the permit carries what the route's row of ROUTE_PERMISSIONS says it audits. The statements
 * are read off a fake connection, so this also pins the order changeAsOperator sends them in.
 * The type cases are checked by `npm run typecheck`.
 */
import { ROUTES, type Role } from '@tinnox/contracts';
import {
  changeOrg,
  unaudited,
  type AuditInput,
  type Change,
  type OrgTx,
  type Pool,
  type WritePermit,
} from '@tinnox/db';
import { testOrgId } from '@tinnox/db/testing';
import type { FastifyRequest } from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AppContext } from '../context.ts';
import { refuse, type Decision } from '../db-helpers.ts';
import { changeAsOperator, PermissionDeniedError, type Requirement } from './permissions.ts';
import type { OperatorSession } from './session.ts';

const ORG = testOrgId('00000000-0000-4000-8000-000000000001');
const MEMBER = '00000000-0000-4000-8000-00000000000a';
const SET_ORG = "SELECT set_config('app.org_id', $1, true)";

/**
 * A pool that records what each transaction is sent, one list per connection taken, and answers
 * the in-write role check with `role`.
 */
function fakePool(role: Role = 'editor') {
  const transactions: string[][] = [];
  const pool = {
    connect: () => {
      const statements: string[] = [];
      transactions.push(statements);
      return Promise.resolve({
        on: () => undefined,
        removeListener: () => undefined,
        release: () => undefined,
        query: (text: string, values?: readonly unknown[]) => {
          if (text.includes('FROM membership WHERE id = $1')) {
            statements.push('ROLE RE-CHECK');
            return Promise.resolve({ rows: [{ role, removed_at: null, cut_off: false }] });
          }
          if (text.includes('pg_advisory_xact_lock')) {
            statements.push('MEMBERSHIP LOCK');
            return Promise.resolve({ rows: [{ in_org: true }] });
          }
          statements.push(text.includes('audit_event') ? `AUDIT ${String(values?.[2])}` : text);
          return Promise.resolve({ rows: [] });
        },
      });
    },
  } as unknown as Pool;
  return { pool, transactions };
}

/** A request as it reaches a handler: past requireOperator and permissionGuard. */
function requestTo(
  method: string,
  url: string,
  required: Requirement | null = { all: ['content.write'] },
): FastifyRequest {
  const session = {
    orgId: ORG,
    membershipId: MEMBER,
    createdAt: '2026-11-24T00:00:00.000Z',
  } as unknown as OperatorSession;
  return {
    method,
    routeOptions: { url },
    operator: session,
    permission: required === null ? null : { required },
    log: { warn: () => undefined, error: () => undefined },
  } as unknown as FastifyRequest;
}

const contextOn = (pool: Pool): AppContext =>
  ({ pool, now: () => new Date('2026-11-24T00:00:00.000Z') }) as unknown as AppContext;

const folderEvent = {
  actorType: 'operator',
  actorId: MEMBER,
  objectType: 'folder',
  objectId: 'a-folder-id',
  result: 'success',
} as const;
const CREATED = {
  ...folderEvent,
  action: 'folder.create',
  detail: null,
} as const satisfies AuditInput;
const DELETED = {
  ...folderEvent,
  action: 'folder.delete',
  detail: { movedToRoot: 0 },
} as const satisfies AuditInput;

describe('an operator write on changeOrg (SCR-34)', () => {
  it('sends the role re-check first, then the change, then the audit row it returned, then COMMIT', async () => {
    const { pool, transactions } = fakePool();
    const value = await changeAsOperator(
      contextOn(pool),
      requestTo('POST', ROUTES.folders),
      async (tx, role) => {
        await tx.query('INSERT FOLDER');
        return { value: `made by an ${role}`, audit: CREATED };
      },
    );
    expect(value).toBe('made by an editor');
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'ROLE RE-CHECK', 'INSERT FOLDER', 'AUDIT folder.create', 'COMMIT'],
    ]);
  });

  it('takes the membership lock before the re-check when the write asks for it', async () => {
    const { pool, transactions } = fakePool('owner');
    await changeAsOperator(
      contextOn(pool),
      requestTo('POST', ROUTES.invites, { all: ['member.manage'] }),
      () =>
        Promise.resolve({
          value: undefined,
          audit: {
            actorType: 'operator',
            actorId: MEMBER,
            action: 'invite.create',
            objectType: 'invite',
            objectId: 'an-invite-id',
            result: 'success',
            detail: { role: 'viewer' },
          },
        }),
      { lockMembership: true },
    );
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'MEMBERSHIP LOCK', 'ROLE RE-CHECK', 'AUDIT invite.create', 'COMMIT'],
    ]);
  });

  // Section 2.1 B: a refusal that must leave a trace is returned as the value, with its event,
  // and thrown once the transaction has committed.
  it('commits the trace of a refusal returned as the value, which the route then throws', async () => {
    const { pool, transactions } = fakePool();
    const refusal = new PermissionDeniedError({ keys: [], reason: 'role', always: false });
    const decision = await changeAsOperator<Decision<number>>(
      contextOn(pool),
      requestTo('POST', ROUTES.folders),
      () => Promise.resolve({ value: refuse(refusal), audit: { ...CREATED, result: 'denied' } }),
    );
    expect(decision).toEqual({ ok: false, error: refusal });
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'ROLE RE-CHECK', 'AUDIT folder.create', 'COMMIT'],
    ]);
  });

  it('a role taken away since the guard: nothing of the write runs, and the refusal is recorded on its own (SCR-32)', async () => {
    const { pool, transactions } = fakePool('viewer');
    let ran = false;
    await expect(
      changeAsOperator(contextOn(pool), requestTo('POST', ROUTES.folders), () => {
        ran = true;
        return Promise.resolve({ value: 1, audit: CREATED });
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ran).toBe(false);
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'ROLE RE-CHECK', 'ROLLBACK'],
      ['BEGIN', SET_ORG, 'AUDIT security.permission_denied', 'COMMIT'],
    ]);
  });

  // Step 17's table, held at run time: the permit carries the row's `audit`.
  it('refuses a write that records an action its row of ROUTE_PERMISSIONS does not state', async () => {
    const message =
      'changeOrg: the change recorded folder.delete, which the row of POST /api/folders in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts) does not state: it states folder.create. Name every action the route writes in that statement, and give a new one its case in tests/integration/audit-failure.test.ts; or correct the event. Nothing was committed.';
    const returned = fakePool();
    await expect(
      changeAsOperator(contextOn(returned.pool), requestTo('POST', ROUTES.folders), () =>
        Promise.resolve({ value: 1, audit: DELETED }),
      ),
    ).rejects.toThrow(message);
    expect(returned.transactions[0]?.at(-1)).toBe('ROLLBACK');
  });

  it('fails closed outside the permission guard, and on a route with no row, before any statement', async () => {
    const { pool, transactions } = fakePool();
    const write = (): Promise<Change<number>> => Promise.resolve({ value: 1, audit: CREATED });
    await expect(
      changeAsOperator(contextOn(pool), requestTo('POST', ROUTES.folders, null), write),
    ).rejects.toThrow('a write ran outside the permission guard');
    await expect(
      changeAsOperator(contextOn(pool), requestTo('POST', '/api/no-such-route'), write),
    ).rejects.toThrow('a write ran outside the permission guard');
    // A requirement the handler names does not replace the guard's own decision.
    await expect(
      changeAsOperator(contextOn(pool), requestTo('POST', ROUTES.folders, null), write, {
        required: { all: ['content.write'] },
      }),
    ).rejects.toThrow('a write ran outside the permission guard');
    expect(transactions).toEqual([]);
  });
});

// Never called: these lines are for the type checker.
describe('the permit of a write comes from the role guard only (SCR-34)', () => {
  it('a route cannot run a change without it, nor make one of its own', () => {
    const cases = async (ctx: AppContext, request: FastifyRequest): Promise<void> => {
      const change = (tx: OrgTx): Promise<Change<number>> =>
        tx.query('SELECT 1').then(() => ({ value: 1, audit: unaudited('nothing_changed') }));
      await changeAsOperator(ctx, request, change);
      // @ts-expect-error changeOrg takes the permit, and a route has none to give
      await changeOrg(ctx.pool, ORG, change);
      // @ts-expect-error the requirement the guard resolved is not a permit
      await changeOrg(ctx.pool, ORG, request.permission, change);
      // @ts-expect-error nor is a re-check a route wrote for itself: only issueWritePermit makes one
      await changeOrg(ctx.pool, ORG, { recheck: () => Promise.resolve('owner') }, change);
      // @ts-expect-error a change by an operator returns { value, audit }, not a bare value
      await changeAsOperator(ctx, request, () => Promise.resolve(1));
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<Requirement>().not.toExtend<WritePermit<Role>>();
  });
});
