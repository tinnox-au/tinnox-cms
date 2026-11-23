/**
 * What every route audits (adoption plan section 2.1, step 17; decision D3).
 *
 * A route says which audit actions its own work writes, or that it writes none and why, from a
 * closed list of reasons. An operator route says it in its row of ROUTE_PERMISSIONS
 * (auth/permissions.ts, the `audit` field); every other route says it in OTHER_ROUTE_AUDIT
 * below. The start-up check compares both tables with the routes the application registers and
 * refuses to start on a route that says nothing, so a route cannot be added without the
 * decision.
 *
 * The statement is checked two ways. tests/integration/audit-failure.test.ts has a case for
 * every audit action: it goes through a route named here, makes that action's row fail, and
 * shows the change rolled back. route-audit.test.ts holds the list as a whole: every action of
 * AUDIT_ACTIONS has a writer (a route, a guard, or one of OFF_ROUTE_AUDIT), so an action nothing
 * writes cannot stay in the list.
 *
 * Whether a new kind of event must be audited at all is the reviewer's call (D3): every
 * successful change to tenant or security state; every attempt at sign-in, pairing, revocation,
 * upload and publishing; and authentication and authorisation refusals, thresholded.
 */
import { PLAYER_PREFIX, ROUTES, type AuditAction } from '@tinnox/contracts';
import type { RouteOptions } from 'fastify';

/** Why a route writes no audit row (D3). Closed: a new reason is a decision, recorded here. */
export const NO_AUDIT_REASONS = {
  read_only:
    'the route only reads. The session activity or the device lookup behind it is not audited (D3)',
  telemetry:
    'what the route stores is telemetry: a heartbeat and the delivery state it reports (D3)',
  login_state:
    'the route stores pre-sign-in login state, which grants nothing; the outcome of the sign-in it belongs to is audited at the callback (D3)',
} as const;
export type NoAuditReason = keyof typeof NO_AUDIT_REASONS;

/** What a route's own work audits: at least one action, or none with a reason. */
export type RouteAudit =
  { readonly actions: readonly [AuditAction, ...AuditAction[]] } | { readonly none: NoAuditReason };

/** The actions the route's handler writes, on the transaction of the change they record. */
export const audits = (...actions: [AuditAction, ...AuditAction[]]): RouteAudit =>
  Object.freeze({ actions: Object.freeze(actions) });
/** The route writes no audit row, for a reason of NO_AUDIT_REASONS. */
export const noAudit = (none: NoAuditReason): RouteAudit => Object.freeze({ none });

/** A route outside the operator table: its own audit, and the refusals its guard records. */
export interface OtherRouteAudit {
  readonly audit: RouteAudit;
  /** Refusals recorded before the handler runs, thresholded; nothing has changed then. */
  readonly guard: readonly AuditAction[];
}

/**
 * What the guards of every state-changing operator route record when they refuse the request
 * (requireOperator and permissionGuard, the role re-check inside the write, and the people
 * routes' rank, self and grant rules): refusals only, in a transaction of their own (SCR-32,
 * D2).
 */
export const OPERATOR_GUARD_AUDIT: readonly AuditAction[] = Object.freeze([
  'security.csrf_rejected',
  'security.permission_denied',
]);

/** What a rejected device credential records (routes/player.ts, `authenticate`). */
const DEVICE_GUARD: readonly AuditAction[] = Object.freeze(['player.auth_rejected']);
const NO_GUARD: readonly AuditAction[] = Object.freeze([]);

const other = (audit: RouteAudit, guard: readonly AuditAction[] = NO_GUARD): OtherRouteAudit =>
  Object.freeze({ audit, guard });

/**
 * Every route that is not an operator route: operations, sign-in and sign-out, the public
 * alert confirmation, and the player protocol. Keyed like ROUTE_PERMISSIONS, by
 * `${METHOD} ${pattern}` as registered.
 */
export const OTHER_ROUTE_AUDIT: Readonly<Record<string, OtherRouteAudit>> = Object.freeze({
  [`GET ${ROUTES.healthz}`]: other(noAudit('read_only')),
  [`GET ${ROUTES.readyz}`]: other(noAudit('read_only')),

  [`GET ${ROUTES.authLogin}`]: other(noAudit('login_state')),
  // Every outcome after the login state was found, a refusal included (D2).
  [`GET ${ROUTES.authCallback}`]: other(audits('auth.login')),
  [`GET ${ROUTES.session}`]: other(noAudit('read_only')),
  // Signing out needs the session, the Origin and the token, as an operator write does.
  [`POST ${ROUTES.authLogout}`]: other(audits('auth.logout'), ['security.csrf_rejected']),

  [`POST ${ROUTES.alertRecipientConfirm}`]: other(audits('alert_recipient.confirm')),

  [`POST ${ROUTES.playerPairing}`]: other(audits('pairing.create')),
  // A GET that changes state: the poll that collects the credential completes the pairing, and
  // the wrong polling token that reaches the limit locks the session.
  [`GET ${ROUTES.playerPairingPollPattern}`]: other(audits('pairing.complete', 'pairing.lock')),
  // Not in ROUTES: the player gives up its own credential (docs/player-protocol-v1.md).
  [`DELETE ${PLAYER_PREFIX}/registration`]: other(audits('player.revoke'), DEVICE_GUARD),
  [`GET ${ROUTES.playerManifest}`]: other(noAudit('read_only'), DEVICE_GUARD),
  // A POST that only reads: it signs addresses for the assets of the current publication.
  [`POST ${ROUTES.playerMediaUrls}`]: other(noAudit('read_only'), DEVICE_GUARD),
  // Authorised by the signed address alone, so no device credential is judged here.
  [`GET ${ROUTES.playerMediaPattern}`]: other(noAudit('read_only')),
  [`POST ${ROUTES.playerHeartbeat}`]: other(noAudit('telemetry'), DEVICE_GUARD),
});

/**
 * The audit actions no route writes, each with what writes it. With the routes' own actions and
 * their guards', these are all of AUDIT_ACTIONS (route-audit.test.ts).
 *
 * Writers outside TypeScript that add to an action a route already writes are not listed: the
 * incident scripts scripts/revoke-all-sessions.sql and scripts/revoke-subject-sessions.sql write
 * `auth.logout` and `membership.sessions_end` by hand, in a shape their entries in
 * AuditEventShapes describe.
 */
export const OFF_ROUTE_AUDIT: Readonly<Partial<Record<AuditAction, string>>> = Object.freeze({
  'display.offline_alert': 'the alert check, when it opens an episode (apps/api/src/alerts.ts)',
  'display.online_alert':
    'the alert check, when it closes an episode with an e-mail (apps/api/src/alerts.ts)',
  'media.validate':
    "the media pipeline, when the worker's verdict arrives or a job times out (apps/api/src/media/pipeline.ts)",
  'membership.create':
    'provision-member org-create, fulfil and restore-owner (scripts/lib/provision.ts); the API adds no member',
  'membership.mfa_reset': 'provision-member mfa-reset (scripts/lib/provision.ts)',
  'pairing.cancel':
    'migration 0012 alone, once, for claims accepted before migration 0010; it stays in the list because databases that ran it hold the rows',
});

/** A row of the operator table, as far as this module reads it. */
export interface AuditedRule {
  readonly audit: RouteAudit;
}
export type OperatorAuditTable = Readonly<Record<string, AuditedRule>>;

/** What a request to a route can record: its own audit, and its guards' refusals. */
export interface DeclaredRouteAudit {
  readonly audit: RouteAudit;
  readonly guard: readonly AuditAction[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** `${METHOD} ${pattern}`, with HEAD read as GET (Fastify registers a HEAD twin of every GET). */
function auditKey(method: string, pattern: string): string {
  const upper = method.toUpperCase();
  return `${upper === 'HEAD' ? 'GET' : upper} ${pattern}`;
}

/**
 * What the route `${METHOD} ${pattern}` says it audits, or undefined when it says nothing.
 * An operator route's guards record refusals of state-changing requests only.
 */
export function declaredRouteAudit(
  route: string,
  operator: OperatorAuditTable,
  others: Readonly<Record<string, OtherRouteAudit>> = OTHER_ROUTE_AUDIT,
): DeclaredRouteAudit | undefined {
  const space = route.indexOf(' ');
  const method = space < 0 ? '' : route.slice(0, space);
  const key = space < 0 ? route : auditKey(method, route.slice(space + 1));
  const rule = own(operator, key);
  if (rule !== undefined) {
    return {
      audit: rule.audit,
      guard: SAFE_METHODS.has(method.toUpperCase()) ? NO_GUARD : OPERATOR_GUARD_AUDIT,
    };
  }
  return own(others, key);
}

/** The actions of a statement; none for a route that writes no audit row. */
export const actionsOf = (audit: RouteAudit): readonly AuditAction[] =>
  'actions' in audit ? audit.actions : [];

/**
 * Problems with the two tables against the registered routes (empty = fine). Pure. OPTIONS
 * routes are left out: a preflight answers from the CORS configuration and reaches no handler.
 */
export function checkRouteAudit(
  registered: ReadonlySet<string>,
  operator: OperatorAuditTable,
  others: Readonly<Record<string, OtherRouteAudit>> = OTHER_ROUTE_AUDIT,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const route of registered) {
    const space = route.indexOf(' ');
    const method = space < 0 ? '' : route.slice(0, space).toUpperCase();
    if (method === 'OPTIONS') continue;
    const key = space < 0 ? route : auditKey(method, route.slice(space + 1));
    seen.add(key);
    const inOperator = own(operator, key) !== undefined;
    const inOthers = own(others, key) !== undefined;
    if (inOperator && inOthers) {
      problems.push(
        `${key} states what it audits twice: keep its row in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts) and remove the one in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts)`,
      );
    }
    if (!inOperator && !inOthers) {
      problems.push(
        `no audit statement for ${route}: say what the route audits. An operator route gets a row in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts) built with write(rule, ...actions) or read(rule); any other route gets an entry in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts) with audits(...actions), or noAudit(reason) with a reason of NO_AUDIT_REASONS (D3). Then give each new action a case in tests/integration/audit-failure.test.ts`,
      );
    }
  }
  for (const key of Object.keys(others)) {
    if (!seen.has(key)) {
      problems.push(
        `audit statement ${key} in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts) matches no registered route: remove it, or correct its method and pattern`,
      );
    }
  }
  return problems;
}

/** Collects every route as it is registered and checks that each says what it audits. */
export function createRouteAuditCheck(operator: OperatorAuditTable): {
  readonly onRoute: (route: RouteOptions) => void;
  readonly assertComplete: () => void;
} {
  const registered = new Set<string>();
  return {
    onRoute: (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.add(`${String(method)} ${route.url}`);
    },
    assertComplete: () => {
      const problems = checkRouteAudit(registered, operator);
      if (problems.length > 0) {
        throw new Error(
          `the audit statements of the routes are incomplete: ${problems.join('; ')}`,
        );
      }
    },
  };
}
