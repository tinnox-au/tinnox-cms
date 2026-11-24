/**
 * Roles enforced (CMS-13, DEC-35; docs/portal-v2/stage-c.md sections 6.1 to 6.3).
 *
 * - Every operator route has an entry in ROUTE_PERMISSIONS (default deny). A start-up check
 *   compares the table with the registered routes and refuses to start on any difference.
 *   The entry also says what the route audits (`audit`, D3; ../route-audit.ts).
 * - `permissionGuard` decides each request from the session's role before the handler runs:
 *   a refusal is the same 403 for every id (own, unknown, another organisation's), because it
 *   is decided before any lookup.
 * - Every write transaction re-reads the member row FOR SHARE as its first statement, so no
 *   write commits under a role, or a session, that was taken away while the request was on its
 *   way. `changeOrg` of @tinnox/db runs no change without a `WritePermit`, and this module is
 *   the only one that issues an operator's (`changeAsOperator`): the permit's re-check is that
 *   first statement (SCR-34, adoption plan step 19). A refusal recorded on its own has the
 *   permit of ./refusal.ts, which changes nothing. `changePreOrg` enters an organisation with
 *   no permit, so lint keeps it to the files of PRE_ORG_CHANGE_FILES (eslint.config.js), whose
 *   transactions start before the organisation is known.
 *
 * Who holds which key: ROLE_PERMISSIONS in packages/domain/src/permissions.ts.
 */
import {
  PERMISSION_KEYS,
  RoleSchema,
  ROUTES,
  type AuditAction,
  type DisplayPatch,
  type PermissionKey,
  type Role,
  type TagScope,
} from '@tinnox/contracts';
import {
  changeOrg,
  classifyDbError,
  isLockTimeout,
  issueWritePermit,
  lockOrgMembership,
  membershipForCheck,
  settle,
  type Change,
  type ConstraintName,
  type OrgTx,
  type TxEnd,
  type WritePermit,
} from '@tinnox/db';
import { permissionsOf } from '@tinnox/domain';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { AppContext } from '../context.ts';
import { HttpError } from '../errors.ts';
import { audits, noAudit, type RouteAudit } from '../route-audit.ts';
import {
  recordPermissionDenied,
  type DenialReason,
  type DenialRecord,
} from './permission-audit.ts';
import { operatorOf, type OperatorSession } from './session.ts';

export type RefineName = 'displayPatchFields' | 'tagScopeFromBody' | 'tagScopeFromRow';
/** The keys a route needs. */
export type KeyRule =
  | { readonly all: readonly PermissionKey[] }
  | { readonly any: readonly PermissionKey[]; readonly refine: RefineName };
/** A row of the table: the keys, and what the route's own work audits (D3). */
export type RouteRule = KeyRule & { readonly audit: RouteAudit };
export type Requirement =
  { readonly all: readonly PermissionKey[] } | { readonly any: readonly PermissionKey[] };

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by `permissionGuard`: what the route needs from this request's role, and what the
     * route's row says it audits (for a refused attempt recorded on its own, ./refusal.ts).
     */
    permission: { readonly required: Requirement; readonly audit: RouteAudit } | null;
  }
}

// ------------------------------------------------------------------ route-to-key table

const all = (...keys: PermissionKey[]): KeyRule => Object.freeze({ all: Object.freeze(keys) });
const any = (refine: RefineName, ...keys: PermissionKey[]): KeyRule =>
  Object.freeze({ any: Object.freeze(keys), refine });
/** A route that only reads: it writes no audit row. */
const read = (keys: KeyRule): RouteRule => Object.freeze({ ...keys, audit: noAudit('read_only') });
/**
 * A route that changes state, and every audit action its handler writes for it, on the
 * transaction of the change. A refusal by its guards is recorded on its own
 * (OPERATOR_GUARD_AUDIT in ../route-audit.ts).
 */
const write = (keys: KeyRule, ...actions: [AuditAction, ...AuditAction[]]): RouteRule =>
  Object.freeze({ ...keys, audit: audits(...actions) });

/**
 * Every operator route, the keys it needs (section 6.1) and what it audits (D3): 62 entries, 27
 * GET and 35 writes. Keyed by `${METHOD} ${pattern}` with the contract constants, so a renamed
 * path breaks the build. HEAD is read as GET (`routeKey`). A row is made with read() or
 * write(), so a route cannot be added without saying what it audits.
 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, RouteRule>> = Object.freeze({
  [`GET ${ROUTES.sites}`]: read(all('org.read')),
  [`GET ${ROUTES.displays}`]: read(all('org.read')),
  [`POST ${ROUTES.displays}`]: write(all('screen.setup'), 'display.create'),
  [`GET ${ROUTES.displaysStatus}`]: read(all('org.read')),
  [`GET ${ROUTES.displayPattern}`]: read(all('org.read')),
  [`PATCH ${ROUTES.displayPattern}`]: write(
    any(
      'displayPatchFields',
      'screen.alerts',
      'screen.assign',
      'screen.details',
      'screen.hours',
      'screen.setup',
    ),
    'display.update',
  ),
  [`POST ${ROUTES.displayClaimPattern}`]: write(
    all('screen.pair'),
    'pairing.claim',
    'player.revoke',
  ),
  [`POST ${ROUTES.displayRevokePlayerPattern}`]: write(all('screen.pair'), 'player.revoke'),
  [`GET ${ROUTES.displayStatusPattern}`]: read(all('org.read')),

  [`GET ${ROUTES.media}`]: read(all('org.read')),
  [`POST ${ROUTES.media}`]: write(all('content.write'), 'media.upload'),
  [`GET ${ROUTES.mediaItemPattern}`]: read(all('org.read')),
  [`PATCH ${ROUTES.mediaItemPattern}`]: write(all('content.write'), 'media.update'),
  [`DELETE ${ROUTES.mediaItemPattern}`]: write(all('media.delete'), 'media.delete'),
  [`GET ${ROUTES.mediaPreviewPattern}`]: read(all('org.read')),
  [`GET ${ROUTES.mediaThumbnailPattern}`]: read(all('org.read')),
  [`GET ${ROUTES.mediaUsagePattern}`]: read(all('org.read')),

  [`GET ${ROUTES.apps}`]: read(all('org.read')),
  [`POST ${ROUTES.apps}`]: write(all('content.write'), 'app.create'),
  [`GET ${ROUTES.appPattern}`]: read(all('org.read')),
  [`PATCH ${ROUTES.appPattern}`]: write(all('content.write'), 'app.update'),
  [`DELETE ${ROUTES.appPattern}`]: write(all('content.delete'), 'app.delete'),

  [`GET ${ROUTES.schedules}`]: read(all('org.read')),
  [`POST ${ROUTES.schedules}`]: write(all('content.write'), 'schedule.create'),
  [`GET ${ROUTES.schedulePattern}`]: read(all('org.read')),
  [`PUT ${ROUTES.schedulePattern}`]: write(all('content.write'), 'schedule.update'),
  [`DELETE ${ROUTES.schedulePattern}`]: write(all('content.delete'), 'schedule.delete'),

  [`GET ${ROUTES.layouts}`]: read(all('org.read')),
  [`POST ${ROUTES.layouts}`]: write(all('content.write'), 'layout.create'),
  [`GET ${ROUTES.layoutPattern}`]: read(all('org.read')),
  [`PUT ${ROUTES.layoutPattern}`]: write(all('content.write'), 'layout.update'),
  [`DELETE ${ROUTES.layoutPattern}`]: write(all('content.delete'), 'layout.delete'),

  [`GET ${ROUTES.tags}`]: read(all('org.read')),
  [`POST ${ROUTES.tags}`]: write(
    any('tagScopeFromBody', 'content.write', 'screen.setup'),
    'tag.create',
  ),
  [`PATCH ${ROUTES.tagPattern}`]: write(
    any('tagScopeFromRow', 'content.write', 'screen.setup'),
    'tag.update',
  ),
  [`DELETE ${ROUTES.tagPattern}`]: write(
    any('tagScopeFromRow', 'content.delete', 'screen.setup'),
    'tag.delete',
  ),

  [`GET ${ROUTES.folders}`]: read(all('org.read')),
  [`POST ${ROUTES.folders}`]: write(all('content.write'), 'folder.create'),
  [`PATCH ${ROUTES.folderPattern}`]: write(all('content.write'), 'folder.update'),
  [`DELETE ${ROUTES.folderPattern}`]: write(all('content.delete'), 'folder.delete'),

  [`GET ${ROUTES.playlists}`]: read(all('org.read')),
  [`POST ${ROUTES.playlists}`]: write(all('content.write'), 'playlist.create'),
  [`GET ${ROUTES.playlistPattern}`]: read(all('org.read')),
  [`PUT ${ROUTES.playlistPattern}`]: write(all('content.write'), 'playlist.update'),
  [`DELETE ${ROUTES.playlistPattern}`]: write(all('content.delete'), 'playlist.delete'),
  [`POST ${ROUTES.playlistDuplicatePattern}`]: write(all('content.write'), 'playlist.create'),
  // Kept for scripts and tests; no portal caller. A cleanup card retires it.
  [`POST ${ROUTES.playlistPublishPattern}`]: write(
    all('push.publish', 'screen.assign'),
    'publication.create',
  ),

  [`GET ${ROUTES.push}`]: read(all('org.read')),
  [`POST ${ROUTES.push}`]: write(all('push.publish'), 'publication.create'),
  [`GET ${ROUTES.overview}`]: read(all('org.read')),
  // The handler narrows the log to the activity categories without audit.read; it never refuses.
  [`GET ${ROUTES.audit}`]: read(all('activity.read')),

  [`GET ${ROUTES.members}`]: read(all('member.read')),
  [`GET ${ROUTES.memberNames}`]: read(all('activity.read')),
  // The people routes then apply the rank rule (routes/members.ts).
  [`PATCH ${ROUTES.memberPattern}`]: write(
    all('member.manage'),
    'membership.role_change',
    'membership.update',
    'invite.cancel',
  ),
  [`POST ${ROUTES.memberRemovePattern}`]: write(
    all('member.manage'),
    'membership.remove',
    'invite.cancel',
  ),
  [`POST ${ROUTES.memberSignOutPattern}`]: write(all('member.manage'), 'membership.sessions_end'),
  [`GET ${ROUTES.invites}`]: read(all('member.read')),
  [`POST ${ROUTES.invites}`]: write(all('member.manage'), 'invite.create'),
  [`POST ${ROUTES.inviteCancelPattern}`]: write(all('member.manage'), 'invite.cancel'),

  [`GET ${ROUTES.alertRecipients}`]: read(all('alerts.manage')),
  [`POST ${ROUTES.alertRecipients}`]: write(all('alerts.manage'), 'alert_recipient.add'),
  [`DELETE ${ROUTES.alertRecipientPattern}`]: write(all('alerts.manage'), 'alert_recipient.remove'),
} satisfies Record<string, RouteRule>);

/** `${METHOD} ${pattern}`, with HEAD read as GET (Fastify registers a HEAD twin of every GET). */
export function routeKey(method: string, pattern: string): string {
  const upper = method.toUpperCase();
  return `${upper === 'HEAD' ? 'GET' : upper} ${pattern}`;
}

function ruleOf(key: string, table: Readonly<Record<string, RouteRule>>): RouteRule | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// ---------------------------------------------------------------------------- refines

/**
 * PATCH /api/displays/:id field → key. `satisfies` makes a new DisplayPatch field a compile
 * error until it is mapped.
 */
export const DISPLAY_PATCH_KEYS = Object.freeze({
  name: 'screen.details',
  description: 'screen.details',
  tagIds: 'screen.details',
  workingHours: 'screen.hours',
  alertOfflineMinutes: 'screen.alerts',
  alertBackOnline: 'screen.alerts',
  canvas: 'screen.setup',
  contentRect: 'screen.setup',
  defaultFit: 'screen.setup',
  rotation: 'screen.setup',
  assignedPlaylistId: 'screen.assign',
  assignedScheduleId: 'screen.assign',
  assignedLayoutId: 'screen.assign',
} as const satisfies { readonly [K in keyof DisplayPatch]-?: PermissionKey });

/** The keys the named fields need, unique and in PERMISSION_KEYS order; unknown fields need none. */
export function displayPatchKeys(fields: Iterable<string>): PermissionKey[] {
  const needed = new Set<PermissionKey>();
  for (const field of fields) {
    if (Object.hasOwn(DISPLAY_PATCH_KEYS, field)) {
      needed.add(DISPLAY_PATCH_KEYS[field as keyof typeof DISPLAY_PATCH_KEYS]);
    }
  }
  return PERMISSION_KEYS.filter((key) => needed.has(key));
}

/** media: write → content.write, delete → content.delete; display: both → screen.setup. */
export function tagScopeKey(scope: TagScope, action: 'write' | 'delete'): PermissionKey {
  if (scope === 'display') return 'screen.setup';
  return action === 'write' ? 'content.write' : 'content.delete';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow an any-of rule from the parsed (not yet validated) body. Null keeps the any-of
 * requirement; validation then answers 400, or the handler checks the stored row.
 */
export const REFINES: {
  readonly [N in RefineName]: (body: unknown) => readonly PermissionKey[] | null;
} = Object.freeze({
  // Unknown fields map to nothing (.strict() answers 400); {} gives [] (400 follows).
  displayPatchFields: (body: unknown) =>
    isPlainObject(body) ? displayPatchKeys(Object.keys(body)) : null,
  tagScopeFromBody: (body: unknown) => {
    if (!isPlainObject(body)) return null;
    const scope = body['scope'];
    return scope === 'media' || scope === 'display' ? [tagScopeKey(scope, 'write')] : null;
  },
  // The scope is known only after the handler reads the tag (routes/tags.ts).
  tagScopeFromRow: () => null,
});

// ------------------------------------------------------------------------ the test

export function parseRole(value: string): Role | null {
  const parsed = RoleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The test of a requirement against a key set; `meets` calls it with the role's keys. */
export function meetsKeys(held: ReadonlySet<PermissionKey>, required: Requirement): boolean {
  return 'all' in required
    ? required.all.every((key) => held.has(key))
    : required.any.some((key) => held.has(key));
}

export function meets(role: Role, required: Requirement): boolean {
  return meetsKeys(new Set(permissionsOf(role)), required);
}

function keysOf(required: Requirement | RouteRule): readonly PermissionKey[] {
  return 'all' in required ? required.all : required.any;
}

// ------------------------------------------------------------------- start-up check

/** Problems with the table against the registered routes (empty = fine). Pure. */
export function checkRouteTable(
  registered: ReadonlySet<string>,
  table: Readonly<Record<string, RouteRule>> = ROUTE_PERMISSIONS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const route of registered) {
    const space = route.indexOf(' ');
    const key = space < 0 ? route : routeKey(route.slice(0, space), route.slice(space + 1));
    seen.add(key);
    if (ruleOf(key, table) === undefined) problems.push(`no permission entry for ${route}`);
  }
  for (const [key, rule] of Object.entries(table)) {
    if (!seen.has(key)) problems.push(`permission entry ${key} matches no registered route`);
    if ('refine' in rule && !Object.hasOwn(REFINES, rule.refine)) {
      problems.push(`permission entry ${key} names an unknown refine ${String(rule.refine)}`);
    }
  }
  return problems;
}

/** Collects the operator routes as they are registered and checks them against the table. */
export function createRouteCheck(): {
  readonly onRoute: (route: RouteOptions) => void;
  readonly assertComplete: () => void;
} {
  const registered = new Set<string>();
  return {
    // Called once per method: the 62 routes and the HEAD twin of every GET.
    onRoute: (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.add(`${String(method)} ${route.url}`);
    },
    assertComplete: () => {
      const problems = checkRouteTable(registered);
      if (problems.length > 0) {
        throw new Error(`the operator route table is incomplete: ${problems.join('; ')}`);
      }
    },
  };
}

// --------------------------------------------------------------------------- refusals

export const forbidden = (): HttpError =>
  new HttpError(403, 'forbidden', "Your role doesn't allow this.");

/** A refusal by role found inside a transaction or by a people-route rule. Carries what the audit row needs. */
export class PermissionDeniedError extends HttpError {
  readonly record: DenialRecord;
  constructor(record: DenialRecord) {
    super(403, 'forbidden', "Your role doesn't allow this.");
    this.name = 'PermissionDeniedError';
    this.record = record;
  }
}

/**
 * Throws PermissionDeniedError unless the role meets the requirement. `reason` defaults to
 * `role`; refusals by role and by a changed role are throttled, the people routes' are not.
 */
export function requirePermission(
  role: Role,
  required: Requirement,
  reason: DenialReason = 'role',
): void {
  if (meets(role, required)) return;
  throw new PermissionDeniedError({
    keys: keysOf(required),
    reason,
    always: reason !== 'role' && reason !== 'role_changed',
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Ends a request whose body is still arriving: the client may still be sending. The rest of
 * the body is discarded (never stored) for a short time so the client can read the error,
 * then the connection is closed.
 */
export function abandonBody(request: FastifyRequest, reply: FastifyReply): void {
  void reply.header('connection', 'close');
  request.raw.resume();
  const timer = setTimeout(() => request.raw.destroy(), 2_000);
  timer.unref();
  request.raw.once('end', () => clearTimeout(timer));
}

/**
 * preHandler after `requireOperator`: refuses a request whose role lacks the route's keys
 * (403, decided before any lookup) and records what the write must check again.
 */
export function permissionGuard(
  ctx: AppContext,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function permissionGuardHook(request, reply): Promise<void> {
    const session = operatorOf(request);
    const key = routeKey(request.method, request.routeOptions.url ?? '');
    const rule = ruleOf(key, ROUTE_PERMISSIONS);
    const role = parseRole(session.role);
    let required: Requirement | null = null;
    let failed: readonly PermissionKey[] = [];
    if (rule === undefined) {
      // The start-up check makes this unreachable; fail closed if it ever is not.
      request.log.error({ route: key }, 'operator route without a permission entry');
    } else if (role === null) {
      request.log.error('session with an unknown role');
      failed = keysOf(rule);
    } else if ('all' in rule) {
      if (meets(role, rule)) required = { all: rule.all };
      else failed = rule.all;
    } else if (!meets(role, { any: rule.any })) {
      failed = rule.any;
    } else {
      const keys = REFINES[rule.refine](request.body);
      const candidate: Requirement = keys === null ? { any: rule.any } : { all: keys };
      if (meets(role, candidate)) required = candidate;
      else failed = keysOf(candidate);
    }

    // A requirement was resolved only from a row, so the row is there.
    if (required !== null && rule !== undefined) {
      request.permission = { required, audit: rule.audit };
      return;
    }
    try {
      if (!SAFE_METHODS.has(request.method)) {
        await recordPermissionDenied(ctx, request, session, {
          keys: failed,
          reason: 'role',
          always: false,
        });
      }
    } finally {
      // A Viewer's upload is refused before any byte reaches storage, also when its refusal row
      // fails the request (AUD-9). After the row, since abandonBody starts its 2 s cut-off.
      if (key === `POST ${ROUTES.media}`) abandonBody(request, reply);
    }
    throw forbidden();
  };
}

// --------------------------------------------------------------- the check in a write

/**
 * First statement of every write transaction: re-reads the member row FOR SHARE (it waits for
 * a member change that is committing) and checks the role against the requirement the guard
 * resolved. Returns the role it read. Removed, gone or cut off (the session's sessions were
 * ended): 401. Role lacks the keys: 403 (reason `role_changed`).
 */
export async function assertStillAllowed(
  tx: OrgTx,
  session: OperatorSession,
  required: Requirement,
): Promise<Role> {
  const row = await membershipForCheck(tx, session.membershipId, session.createdAt);
  if (row === null || row.removedAt !== null || row.cutOff) {
    throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
  }
  const role = parseRole(row.role);
  if (role === null || !meets(role, required)) {
    throw new PermissionDeniedError({
      keys: keysOf(required),
      reason: 'role_changed',
      always: false,
    });
  }
  return role;
}

// SEC-5: the re-check is always the requirement the guard resolved. A handler could once name its
// own, which could only loosen the one check the permit exists to run.
function requirementOf(request: FastifyRequest): Requirement {
  const required = request.permission?.required;
  if (required === undefined) {
    throw new Error('a write ran outside the permission guard');
  }
  return required;
}

/**
 * A lock timeout (`lock_timeout`, 5 s for tinnox_app, ran out; isLockTimeout of @tinnox/db) as
 * 503 service_unavailable with retry-after 2; anything else unchanged. For a write outside
 * changeAsOperator that waits for a row lock, such as the public alert confirmation (review
 * findings SEC-3, BEH-3), so it answers as every other write does.
 */
export function lockTimeoutAsUnavailable(request: FastifyRequest, error: unknown): unknown {
  const failure = classifyDbError(error);
  if (!isLockTimeout(failure)) return error;
  request.log.warn({ pgCode: failure.sqlstate }, 'a write waited too long for a lock');
  return new HttpError(
    503,
    'service_unavailable',
    'Another change is being saved. Try again in a moment.',
    { headers: { 'retry-after': '2' } },
  );
}

/**
 * What a change answers when the database refuses it with a constraint of the registry
 * (CONSTRAINTS, packages/db/src/constraints.ts): each name the route maps, with the error to
 * throw in place of the database's. A name the route does not map stays the database's error,
 * a 500 logged by its name. A route maps names to answers only, usually an HttpError. The one
 * change that runs again after a refusal is a keyed publish: changeOncePerKey
 * (apps/api/src/publishing.ts) maps publication_idempotency to its own private error and runs
 * once more, and its KeyedPublish.constraints leaves that name out of what a route may map.
 */
export type ConstraintAnswers = { readonly [Name in ConstraintName]?: () => Error };

/**
 * What to throw for a change that rolled back (the `rolled_back` end of settle(), @tinnox/db):
 * records a role refusal, answers a registered constraint the route maps, and maps a lock
 * timeout; anything else passes unchanged. Until step 27 this was a private `settle` that every
 * failure went through; a COMMIT that did not confirm no longer comes here.
 */
async function rolledBackAnswer(
  ctx: AppContext,
  request: FastifyRequest,
  session: OperatorSession,
  rolledBack: Extract<TxEnd<unknown>, { end: 'rolled_back' }>,
  constraints: ConstraintAnswers | undefined,
): Promise<unknown> {
  const { error, failure } = rolledBack;
  if (error instanceof PermissionDeniedError) {
    await recordPermissionDenied(ctx, request, session, error.record);
    return error;
  }
  if (failure?.kind === 'constraint') {
    const answer = constraints?.[failure.name];
    if (answer !== undefined) return answer();
  }
  return lockTimeoutAsUnavailable(request, error);
}

/** What a write may ask of the role guard beyond the route's own row. */
export interface WriteOptions {
  /** Take the organisation's membership lock before the role is read again. */
  readonly lockMembership?: boolean;
  /**
   * The registered constraints the route answers, and with what (step 26): a route names them
   * here and reads no SQLSTATE code or constraint name itself.
   */
  readonly constraints?: ConstraintAnswers;
}

/**
 * The permit of this request's write, from what `permissionGuard` resolved for it: the one place
 * a `WritePermit` is issued (SCR-34). Its re-check is [lockOrgMembership when lockMembership] →
 * assertStillAllowed, and hands the change the role it read. It also carries what the route's
 * row says it audits, which `changeOrg` holds the change to.
 */
function writePermit(
  request: FastifyRequest,
  session: OperatorSession,
  options: WriteOptions | undefined,
): WritePermit<Role> {
  const required = requirementOf(request);
  const key = routeKey(request.method, request.routeOptions.url ?? '');
  const rule = ruleOf(key, ROUTE_PERMISSIONS);
  // The guard marks every request it lets through, and lets none through without a row. A
  // requirement the handler brought itself does not stand in for that.
  if (request.permission === null || rule === undefined) {
    throw new Error('a write ran outside the permission guard');
  }
  return issueWritePermit({
    recheck: async (tx) => {
      if (options?.lockMembership === true) await lockOrgMembership(tx);
      return assertStillAllowed(tx, session, required);
    },
    stated: rule.audit,
    statedIn: `the row of ${key} in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts)`,
  });
}

/**
 * A change by the signed-in operator, on `changeOrg`: [lockOrgMembership when lockMembership] →
 * assertStillAllowed → fn(tx, role) → the audit rows `fn` returned → COMMIT. `fn` returns
 * `{ value, audit }` and writes no audit row itself.
 * A PermissionDeniedError thrown anywhere inside rolls back, is recorded with
 * recordPermissionDenied in its own transaction, and is rethrown. A violation of a registered
 * constraint that `options.constraints` maps is thrown as the route's answer instead (step 26).
 * A lock timeout (55P03) raised anywhere inside (membership lock, actor row, target row, any
 * other lock) becomes 503 service_unavailable with retry-after 2.
 * A COMMIT that did not confirm is thrown as it came (CommitOutcomeUnknownError): the change may
 * be saved, so it is neither recorded as a refusal nor mapped to an answer of the route. A
 * caller that does anything outside the database afterwards wraps this call in settle().
 */
export async function changeAsOperator<T>(
  ctx: AppContext,
  request: FastifyRequest,
  fn: (tx: OrgTx, role: Role) => Promise<Change<T>>,
  options?: WriteOptions,
): Promise<T> {
  const session = operatorOf(request);
  const permit = writePermit(request, session, options);
  const ended = await settle(changeOrg(ctx.db, session.orgId, permit, fn));
  switch (ended.end) {
    case 'committed':
      return ended.value;
    case 'rolled_back':
      throw await rolledBackAnswer(ctx, request, session, ended, options?.constraints);
    case 'unknown':
      throw ended.unconfirmed;
  }
}
