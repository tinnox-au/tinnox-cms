/**
 * Operator session plumbing (D5, D6).
 *
 * - The browser holds only an opaque random cookie. The database stores its
 *   SHA-256, never the value. Tokens from the identity provider never reach the browser.
 * - The organisation of a request comes from the session's membership row and
 *   from nowhere else; no route reads an organisation id from input.
 * - Every state-changing request needs an allowed Origin and the per-session
 *   CSRF token in X-CSRF-Token.
 */
import { HEADERS, OpaqueTokenSchema } from '@tinnox/contracts';
import { poolAsTx, sessionByIdHash, settle, sha256, type SessionLookup } from '@tinnox/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { HttpError } from '../errors.ts';
import { safeEqual } from '../security.ts';
import { recordRefusal } from './refusal.ts';

export interface OperatorSession extends SessionLookup {
  /** SHA-256 of the cookie value; identifies the session row. */
  readonly idHash: Buffer;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireOperator`. */
    operator: OperatorSession | null;
  }
}

export function sessionCookieOptions(
  ctx: AppContext,
  maxAgeSeconds: number,
): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  void reply.clearCookie(ctx.config.sessionCookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    path: '/',
  });
}

/** Looks up the live session for the request's cookie, recording activity. Null when there is none. */
export async function readSession(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<OperatorSession | null> {
  const raw = request.cookies[ctx.config.sessionCookieName];
  if (typeof raw !== 'string' || !OpaqueTokenSchema.safeParse(raw).success) return null;
  const idHash = sha256(raw);
  const session = await sessionByIdHash(
    poolAsTx(ctx.db),
    idHash,
    ctx.config.sessionIdleTimeoutSeconds,
  );
  return session === null ? null : { ...session, idHash };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes the `security.csrf_rejected` row of a refused request. Nothing changed, so it is a
 * transaction of its own (`recordRefusal`, ./refusal.ts; SCR-32, D2). An error the database
 * raised while writing it, or a COMMIT of the row that did not confirm, is logged and swallowed:
 * the refusal stands whether or not it could be recorded, and answering `commit_outcome_unknown`
 * would say the refused change may have been saved. Anything else is rethrown (AUD-9, step 26):
 * `changeOrg` refusing the row because the route's refusal statement does not state it is a
 * programming error, and fails the request loudly instead of losing the row.
 */
async function recordCsrfRejection(
  ctx: AppContext,
  request: FastifyRequest,
  session: OperatorSession,
  reason: string,
): Promise<void> {
  const ended = await settle(
    recordRefusal(ctx, request, session, {
      actorType: 'operator',
      actorId: session.membershipId,
      action: 'security.csrf_rejected',
      objectType: null,
      objectId: null,
      result: 'denied',
      detail: { reason, method: request.method, route: request.routeOptions.url ?? null },
    }),
  );
  switch (ended.end) {
    case 'committed':
      return;
    case 'rolled_back':
      // AUD-9: only what the database raised is logged and dropped.
      if (ended.failure === null) throw ended.error;
      request.log.error({ err: ended.error }, 'failed to record csrf rejection');
      return;
    case 'unknown':
      request.log.error({ err: ended.unconfirmed }, 'failed to record csrf rejection');
      return;
  }
}

/**
 * preHandler for every /api route except sign-in. Requires a live session and,
 * for state-changing methods, an allowed Origin plus the session's CSRF token.
 */
export function requireOperator(ctx: AppContext) {
  return async function requireOperatorHook(request: FastifyRequest): Promise<void> {
    const session = await readSession(ctx, request);
    if (session === null) {
      throw new HttpError('unauthenticated', 'Sign in to continue.');
    }
    if (!SAFE_METHODS.has(request.method)) {
      const originHeader = request.headers.origin;
      if (typeof originHeader !== 'string' || originHeader !== ctx.config.portalOrigin) {
        await recordCsrfRejection(ctx, request, session, 'origin');
        throw new HttpError(
          'origin_not_allowed',
          'This request did not come from the TINNOX portal.',
        );
      }
      const fetchSite = request.headers['sec-fetch-site'];
      if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        await recordCsrfRejection(ctx, request, session, 'fetch_site');
        throw new HttpError(
          'origin_not_allowed',
          'This request did not come from the TINNOX portal.',
        );
      }
      const token = request.headers[HEADERS.csrf];
      if (typeof token !== 'string' || !safeEqual(token, session.csrfToken)) {
        await recordCsrfRejection(ctx, request, session, 'token');
        throw new HttpError(
          'csrf_failed',
          'The security token is missing or out of date. Reload the page and try again.',
        );
      }
    }
    request.operator = session;
  };
}

/** The verified session of a request that passed `requireOperator`. */
export function operatorOf(request: FastifyRequest): OperatorSession {
  if (request.operator === null) {
    // A route was registered without the hook: fail closed.
    throw new HttpError('unauthenticated', 'Sign in to continue.');
  }
  return request.operator;
}
