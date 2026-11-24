/**
 * The two refusal recorders, recordPermissionDenied and the CSRF check of requireOperator, when
 * their audit row cannot be written (review finding AUD-9 of 2026-11-24, adoption plan step 26).
 * An error the database raised is logged and the refusal stands; anything else, `changeOrg`
 * refusing a row the route's refusal statement does not state above all, fails the request
 * instead of being logged and dropped. A COMMIT of the row that did not confirm is kept too: the
 * request was refused, and only its row is in doubt. The statements are read off a fake
 * connection.
 */
import { ROUTES } from '@tinnox/contracts';
import { databaseOn, testOrgId, type Pool } from '@tinnox/db/testing';
import type { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../context.ts';
import { HttpError } from '../errors.ts';
import { recordPermissionDenied, type DenialRecord } from './permission-audit.ts';
import { permissionGuard } from './permissions.ts';
import { requireOperator, type OperatorSession } from './session.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-00000000000a';
const COOKIE = 'tinnox_session';
const PORTAL = 'https://portal.example.test';
// A placeholder of the session token's shape (43 characters), not a credential.
const TOKEN = 'a'.repeat(43);

const SESSION = {
  orgId: testOrgId(ORG),
  membershipId: MEMBER,
  createdAt: '2026-11-24T00:00:00.000Z',
} as unknown as OperatorSession;

/**
 * A pool that knows one session and fails the audit row's INSERT with `failure` (or writes it,
 * when `failure` is null), and its COMMIT with `commitFailure`. Returns what each transaction
 * was sent.
 */
function failingAudit(failure: Error | null, commitFailure: Error | null = null) {
  const transactions: string[][] = [];
  const pool = {
    // The session lookup of requireOperator, with no transaction.
    query: () =>
      Promise.resolve({
        rows: [
          {
            membership_id: MEMBER,
            org_id: ORG,
            oidc_sub: 'a-subject',
            role: 'viewer',
            org_name: 'An organisation',
            csrf_token: 'b'.repeat(43),
            created_at: new Date('2026-11-24T00:00:00.000Z'),
            expires_at: new Date('2026-11-25T00:00:00.000Z'),
          },
        ],
      }),
    connect: () => {
      const statements: string[] = [];
      transactions.push(statements);
      return Promise.resolve({
        on: () => undefined,
        removeListener: () => undefined,
        release: () => undefined,
        query: (text: string) => {
          const audit = text.includes('audit_event');
          statements.push(audit ? 'AUDIT' : text);
          if (audit && failure !== null) return Promise.reject(failure);
          if (text === 'COMMIT' && commitFailure !== null) return Promise.reject(commitFailure);
          return Promise.resolve({ rows: [] });
        },
      });
    },
  } as unknown as Pool;
  const ctx = {
    db: databaseOn(pool),
    now: () => new Date('2026-11-24T00:00:00.000Z'),
    config: { sessionCookieName: COOKIE, portalOrigin: PORTAL, sessionIdleTimeoutSeconds: 3600 },
  } as unknown as AppContext;
  return { ctx, transactions };
}

function requestTo(url: string, headers: Record<string, string> = {}) {
  const logged: string[] = [];
  const request = {
    method: 'POST',
    routeOptions: { url },
    headers,
    cookies: { [COOKIE]: TOKEN },
    operator: null,
    permission: null,
    log: { warn: () => undefined, error: (_: unknown, message: string) => logged.push(message) },
  } as unknown as FastifyRequest;
  return { request, logged };
}

/** What the server sends when it refuses a statement, as the pg driver parses it. */
function serverError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`server refused (${code})`, 0, 'error');
  error.code = code;
  return error;
}

const ALWAYS: DenialRecord = { keys: ['member.manage'], reason: 'self', always: true };

describe('a refusal whose audit row cannot be written (AUD-9, step 26)', () => {
  it('keeps a permission refusal when the database refuses its row, and logs it', async () => {
    const { ctx, transactions } = failingAudit(serverError('42501'));
    const { request, logged } = requestTo(ROUTES.folders);
    await recordPermissionDenied(ctx, request, SESSION, ALWAYS);
    expect(transactions.map((statements) => statements.at(-1))).toEqual(['ROLLBACK']);
    expect(logged).toEqual(['failed to record permission refusal']);
  });

  it('fails loudly when changeOrg refuses the row: the route does not state it (AUD-9)', async () => {
    // Signing out has no role to refuse by: its guard states security.csrf_rejected only.
    const { ctx, transactions } = failingAudit(null);
    const { request, logged } = requestTo(ROUTES.authLogout);
    await expect(recordPermissionDenied(ctx, request, SESSION, ALWAYS)).rejects.toThrow(
      /^changeOrg: the change recorded security\.permission_denied, which .* does not state/,
    );
    expect(transactions.map((statements) => statements.at(-1))).toEqual(['ROLLBACK']);
    expect(logged).toEqual([]);
  });

  it('fails loudly on an error the database did not raise, such as a lost connection', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const { ctx } = failingAudit(lost);
    const { request, logged } = requestTo(ROUTES.folders);
    await expect(recordPermissionDenied(ctx, request, SESSION, ALWAYS)).rejects.toBe(lost);
    expect(logged).toEqual([]);
  });

  it('keeps a CSRF refusal when the database refuses its row, and logs it', async () => {
    const { ctx, transactions } = failingAudit(serverError('23514'));
    const { request, logged } = requestTo(ROUTES.folders, { origin: 'https://elsewhere.test' });
    const refused = requireOperator(ctx)(request);
    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({ statusCode: 403, code: 'origin_not_allowed' });
    expect(transactions.map((statements) => statements.at(-1))).toEqual(['ROLLBACK']);
    expect(logged).toEqual(['failed to record csrf rejection']);
  });

  it('fails a CSRF refusal loudly on an error the database did not raise (AUD-9)', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const { ctx } = failingAudit(lost);
    const { request, logged } = requestTo(ROUTES.folders, { origin: 'https://elsewhere.test' });
    await expect(requireOperator(ctx)(request)).rejects.toBe(lost);
    expect(logged).toEqual([]);
  });

  // Rethrown, CommitOutcomeUnknownError would answer 500 commit_outcome_unknown: "the change may
  // have been saved", of a request that was refused and changed nothing.
  it('keeps a permission refusal when the COMMIT of its row does not confirm (AUD-9)', async () => {
    const { ctx, transactions } = failingAudit(
      null,
      new Error('Connection terminated unexpectedly'),
    );
    const { request, logged } = requestTo(ROUTES.folders);
    await recordPermissionDenied(ctx, request, SESSION, ALWAYS);
    expect(transactions[0]).toContain('COMMIT');
    expect(logged).toEqual(['failed to record permission refusal']);
  });

  it('keeps a CSRF refusal when the COMMIT of its row does not confirm (AUD-9)', async () => {
    const { ctx } = failingAudit(null, new Error('Connection terminated unexpectedly'));
    const { request, logged } = requestTo(ROUTES.folders, { origin: 'https://elsewhere.test' });
    await expect(requireOperator(ctx)(request)).rejects.toMatchObject({
      statusCode: 403,
      code: 'origin_not_allowed',
    });
    expect(logged).toEqual(['failed to record csrf rejection']);
  });

  // abandonBody closes the connection 2 s later unless the body ends first. The fake request
  // never ends, so the clock is faked and moved on: the close is asserted, and no timer outlives
  // the case to call a missing destroy() in a later file (TST-3 of the group C review).
  it("abandons a Viewer's upload body when its refusal row fails the request (AUD-9)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lost = new Error('Connection terminated unexpectedly');
      const { ctx } = failingAudit(lost);
      const { request } = requestTo(ROUTES.media);
      const abandoned: string[] = [];
      const listeners: string[] = [];
      Object.assign(request, {
        operator: { ...SESSION, role: 'viewer' },
        raw: {
          resume: () => abandoned.push('resume'),
          destroy: () => abandoned.push('destroy'),
          once: (event: string) => listeners.push(event),
        },
      });
      const reply = {
        header: (name: string, value: string) => abandoned.push(`${name}: ${value}`),
      } as unknown as FastifyReply;
      await expect(permissionGuard(ctx)(request, reply)).rejects.toBe(lost);
      expect(abandoned).toEqual(['connection: close', 'resume']);
      expect(listeners).toEqual(['end']);
      vi.advanceTimersByTime(2_000);
      expect(abandoned).toEqual(['connection: close', 'resume', 'destroy']);
    } finally {
      vi.useRealTimers();
    }
  });
});
