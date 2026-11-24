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
 * An operator route is also held to its statement on every request: the permit of its write
 * carries the row's `audit` (auth/permissions.ts), and changeOrg of @tinnox/db rolls the write
 * back when it recorded an action the row does not name (adoption plan step 19). The other
 * way round, an action a row names and its route never writes, is what the case per action
 * above finds. The same holds for a change with no operator behind it, once it runs on the new
 * API (adoption plan step 20): a route outside the operator table gives `routeStatement` to
 * changePreOrg or to the device's permit (auth/device.ts), a refusal recorded on its own is
 * held to `refusalStatement` (auth/refusal.ts), and a job to its row of JOB_AUDIT (jobs.ts).
 *
 * Whether a new kind of event must be audited at all is the reviewer's call (D3): every
 * successful change to tenant or security state; every attempt at sign-in, pairing, revocation,
 * upload and publishing; and authentication and authorisation refusals, thresholded.
 */
import {
  NO_AUDIT_REASONS,
  PLAYER_PREFIX,
  ROUTES,
  type AuditAction,
  type GrantedUnauditedReason,
  type NoAuditReason,
} from '@tinnox/contracts';
import { issueAuditStatement, type AuditStatement } from '@tinnox/db';
import type { RouteOptions } from 'fastify';

// Why a route writes no audit row (D3): the closed list is in packages/contracts/src/audit.ts,
// beside the audit actions and beside UNAUDITED_REASONS, the reasons `unaudited` of @tinnox/db
// takes for one run of a change (adoption plan steps 19 and 20). Exported from here as before,
// for the tables below.
export { NO_AUDIT_REASONS, type NoAuditReason };

/** What a route's own work audits: at least one action, or none with a reason. */
export type RouteAudit =
  { readonly actions: readonly [AuditAction, ...AuditAction[]] } | { readonly none: NoAuditReason };

/** The actions the route's handler writes, on the transaction of the change they record. */
export const audits = (...actions: [AuditAction, ...AuditAction[]]): RouteAudit =>
  Object.freeze({ actions: Object.freeze(actions) });
/** The route writes no audit row, for a reason of NO_AUDIT_REASONS. */
export const noAudit = (none: NoAuditReason): RouteAudit => Object.freeze({ none });

/**
 * The reasons of GRANTED_UNAUDITED_REASONS (packages/contracts/src/audit.ts) a route outside the
 * operator table may grant: what the pairing routes count or mark. The others are a job's
 * (JobGrant) or the seed's, which only the offline permit grants (changeOrgAsMigrator of
 * @tinnox/db/migrate), so no route can name them. route-audit.test.ts pins who grants what.
 */
export type RouteGrant = Extract<
  GrantedUnauditedReason,
  'counter_under_threshold' | 'pairing_expired_by_time'
>;
/** The reasons of GRANTED_UNAUDITED_REASONS a job may grant: the alert check's silent close. */
export type JobGrant = Extract<GrantedUnauditedReason, 'alert_closed_silently'>;

/** A route outside the operator table: its own audit, and the refusals its guard records. */
export interface OtherRouteAudit {
  readonly audit: RouteAudit;
  /** Refusals recorded before the handler runs, thresholded; nothing has changed then. */
  readonly guard: readonly AuditAction[];
  /**
   * The writes this route leaves unaudited on purpose, by a reason of GRANTED_UNAUDITED_REASONS
   * (packages/contracts/src/audit.ts): a change of this route may return unaudited(reason) for
   * these, and a change of any other route may not (D3).
   */
  readonly grants?: readonly RouteGrant[];
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

/**
 * The operator actions whose refused or failed attempt may be recorded in a transaction of its
 * own (`refusalStatement`): the upload refusals D2 names beside the guards' (SCR-32), which
 * happen before any row of the upload is written. D3 audits every attempt at pairing,
 * revocation and publishing too, but those routes record a refused or failed attempt on the
 * transaction of their own change (routes/displays.ts, auditRejectedPublication of
 * publishing.ts), so their actions are not here: a new one is a question for D2. Any other
 * business-rule refusal writes no row (D3).
 */
export const ATTEMPT_AUDITED_ACTIONS: readonly AuditAction[] = Object.freeze(['media.upload']);

/** What a rejected device credential records (routes/player.ts, `authenticate`). */
const DEVICE_GUARD: readonly AuditAction[] = Object.freeze(['player.auth_rejected']);
const NO_GUARD: readonly AuditAction[] = Object.freeze([]);

const other = (
  audit: RouteAudit,
  guard: readonly AuditAction[] = NO_GUARD,
  grants?: readonly RouteGrant[],
): OtherRouteAudit =>
  Object.freeze(grants === undefined ? { audit, guard } : { audit, guard, grants });

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

  // sec.pairing_create first marks expired every pending session whose time has passed, also
  // when this request is then rate-limited and creates none: that mark is not audited, as
  // today (pairing_expired_by_time; the step 20 ruling, CMS-36).
  [`POST ${ROUTES.playerPairing}`]: other(
    audits('pairing.create'),
    NO_GUARD,
    Object.freeze(['pairing_expired_by_time'] as const),
  ),
  // A GET that changes state: the poll that collects the credential completes the pairing, and
  // the wrong polling token that reaches the limit locks the session. A wrong token under the
  // limit is only counted, and that count is not audited (D3). A poll of a session whose time
  // has passed marks it expired, unaudited as today (the step 20 ruling, CMS-36).
  [`GET ${ROUTES.playerPairingPollPattern}`]: other(
    audits('pairing.complete', 'pairing.lock'),
    NO_GUARD,
    Object.freeze(['counter_under_threshold', 'pairing_expired_by_time'] as const),
  ),
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

/** A row of JOB_AUDIT. */
interface JobAudit {
  readonly file: string;
  readonly audit: RouteAudit;
  /** As the `grants` of OtherRouteAudit: the writes this job leaves unaudited on purpose. */
  readonly grants?: readonly JobGrant[];
}

/**
 * What each job that runs with no request audits: the alert check and the media pipeline. Its
 * actions are the ones OFF_ROUTE_AUDIT gives to the job's file (route-audit.test.ts), and the
 * permit of the job's changes carries the row (jobs.ts), so a job is held to it at run time as
 * a route is to its own.
 */
export const JOB_AUDIT = Object.freeze({
  display_alerts: Object.freeze({
    file: 'apps/api/src/alerts.ts',
    audit: audits('display.offline_alert', 'display.online_alert'),
    // An episode closed without an e-mail is not audited, as today (alert_closed_silently; the
    // step 20 ruling, CMS-36; docs/portal-v2/stage-c-alerts.md section 9 rows 7 and 22).
    grants: Object.freeze(['alert_closed_silently'] as const),
  }),
  media_pipeline: Object.freeze({
    file: 'apps/api/src/media/pipeline.ts',
    audit: audits('media.validate'),
  }),
} satisfies Record<string, JobAudit>);
export type JobName = keyof typeof JOB_AUDIT;

/** The statement a change of the job `name` is held to. */
export function jobStatement(name: JobName): AuditStatement {
  // A name the type checker did not read reaches no row.
  const row = own<JobAudit>(JOB_AUDIT, name);
  if (row === undefined) {
    throw new Error(
      `no job is called ${String(name)}: a job that changes an organisation gets a row in JOB_AUDIT (apps/api/src/route-audit.ts) with the audit actions it writes, and each action its case in tests/integration/audit-failure.test.ts`,
    );
  }
  const statedIn = `the row of ${name} in JOB_AUDIT (apps/api/src/route-audit.ts)`;
  return issueAuditStatement(
    row.grants === undefined
      ? { stated: row.audit, statedIn }
      : { stated: row.audit, statedIn, grants: row.grants },
  );
}

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

/** The route a request reached, as far as this module reads the request. */
export interface RoutedRequest {
  readonly method: string;
  readonly routeOptions: { readonly url?: string };
}

/**
 * The statement of the route a request reached, for a route outside the operator table: what
 * changePreOrg of @tinnox/db and the device's permit (auth/device.ts) hold its change to. An
 * operator route's change goes through changeAsOperator, which holds it to its row of
 * ROUTE_PERMISSIONS, so this refuses one.
 */
export function routeStatement(
  request: RoutedRequest,
  others: Readonly<Record<string, OtherRouteAudit>> = OTHER_ROUTE_AUDIT,
): AuditStatement {
  const key = auditKey(request.method, request.routeOptions.url ?? '');
  const entry = own(others, key);
  if (entry === undefined) {
    throw new Error(
      `a change ran on ${key}, which has no entry in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts), so nothing says what it audits. A route outside the operator table gets its entry there, with audits(...actions) or noAudit(reason). The change of an operator route goes through changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which holds it to its row of ROUTE_PERMISSIONS`,
    );
  }
  const statedIn = `the entry of ${key} in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts)`;
  return issueAuditStatement(
    entry.grants === undefined
      ? { stated: entry.audit, statedIn }
      : { stated: entry.audit, statedIn, grants: entry.grants },
  );
}

/**
 * What a refusal of a request may record in a transaction of its own (SCR-32, D2): the refusals
 * of the route's guards and, once the role guard has let the request through, a refused or
 * failed attempt at those of the route's own actions (`attempted`, its row of
 * ROUTE_PERMISSIONS) that D2 lets a refusal record on its own (ATTEMPT_AUDITED_ACTIONS: an
 * upload). A refused folder.create writes no row at all (D3). A route outside the operator table
 * records its own actions on the transaction of its change, so only its guard's refusals are
 * stated here.
 */
export function refusalStatement(
  request: RoutedRequest,
  attempted: RouteAudit | null,
  others: Readonly<Record<string, OtherRouteAudit>> = OTHER_ROUTE_AUDIT,
): AuditStatement {
  const key = auditKey(request.method, request.routeOptions.url ?? '');
  const other = own(others, key);
  if (other !== undefined) {
    return issueAuditStatement({
      stated: { actions: other.guard },
      statedIn: `the guard of ${key} in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts)`,
    });
  }
  const guard = SAFE_METHODS.has(request.method.toUpperCase()) ? NO_GUARD : OPERATOR_GUARD_AUDIT;
  const tried = attempted === null ? [] : actionsOf(attempted);
  return issueAuditStatement({
    stated: {
      actions: [...guard, ...tried.filter((action) => ATTEMPT_AUDITED_ACTIONS.includes(action))],
    },
    statedIn: `the refusal statement of ${key} (OPERATOR_GUARD_AUDIT in apps/api/src/route-audit.ts, and, once the role guard has let the request through, those actions of its row of ROUTE_PERMISSIONS in apps/api/src/auth/permissions.ts that ATTEMPT_AUDITED_ACTIONS lets a refusal record on its own)`,
  });
}

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
