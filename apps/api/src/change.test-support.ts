/**
 * What the unit tests of the changes with no operator behind them share (adoption plan step 20:
 * auth/refusal.test.ts, auth/device.test.ts, jobs.test.ts): a pool that records what each
 * transaction is sent, and a request as a handler sees it. No database.
 */
import { testOrgId, type Pool, databaseOn } from '@tinnox/db/testing';
import type { FastifyRequest } from 'fastify';
import type { Requirement } from './auth/permissions.ts';
import type { OperatorSession } from './auth/session.ts';
import type { AppContext } from './context.ts';
import type { RouteAudit } from './route-audit.ts';

export const ORG = testOrgId('00000000-0000-4000-8000-000000000001');
export const MEMBER = '00000000-0000-4000-8000-00000000000a';
export const REGISTRATION = '00000000-0000-4000-8000-00000000000b';
export const DISPLAY = '00000000-0000-4000-8000-00000000000c';
export const SET_ORG = "SELECT set_config('app.org_id', $1, true)";

/** What `sec.device_by_token_hash` answers for a credential the database knows. */
const DEVICE_ROW = { registration_id: REGISTRATION, org_id: ORG, display_id: DISPLAY };

/**
 * A pool that records what each transaction is sent, one list per connection taken, and what
 * is sent with no transaction (`unscoped`). An audit row is named by its action and result.
 * `knownDevice` is what the device lookup answers.
 */
export function fakePool(knownDevice = true): {
  pool: Pool;
  transactions: string[][];
  unscoped: string[];
} {
  const transactions: string[][] = [];
  const unscoped: string[] = [];
  const answer = (
    statements: string[],
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[] }> => {
    if (text.includes('sec.device_by_token_hash')) {
      statements.push('DEVICE LOOKUP');
      return Promise.resolve({ rows: knownDevice ? [DEVICE_ROW] : [] });
    }
    statements.push(
      text.includes('audit_event') ? `AUDIT ${String(values?.[2])} ${String(values?.[5])}` : text,
    );
    return Promise.resolve({ rows: [] });
  };
  const pool = {
    query: (text: string, values?: readonly unknown[]) => answer(unscoped, text, values),
    connect: () => {
      const statements: string[] = [];
      transactions.push(statements);
      return Promise.resolve({
        on: () => undefined,
        removeListener: () => undefined,
        release: () => undefined,
        query: (text: string, values?: readonly unknown[]) => answer(statements, text, values),
      });
    },
  } as unknown as Pool;
  return { pool, transactions, unscoped };
}

export const SESSION = {
  orgId: ORG,
  membershipId: MEMBER,
  createdAt: '2026-11-24T00:00:00.000Z',
} as unknown as OperatorSession;

/**
 * A request as it reaches a handler. `guarded` is what permissionGuard left on it when it let
 * the request through: null before the guard ran, and on a route outside the operator table.
 */
export function requestTo(
  method: string,
  url: string,
  guarded: { readonly required: Requirement; readonly audit: RouteAudit } | null = null,
): FastifyRequest {
  return {
    method,
    routeOptions: { url },
    operator: SESSION,
    permission: guarded,
    log: { warn: () => undefined, error: () => undefined },
  } as unknown as FastifyRequest;
}

export const contextOn = (pool: Pool): AppContext =>
  ({
    db: databaseOn(pool),
    now: () => new Date('2026-11-24T00:00:00.000Z'),
  }) as unknown as AppContext;
