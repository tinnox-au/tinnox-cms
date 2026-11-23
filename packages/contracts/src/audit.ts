import { z } from 'zod';
import type { AppType } from './app.ts';
import { UtcTimestampSchema } from './ids.ts';
import type { Transition } from './manifest.ts';
import type { MediaErrorCode } from './media.ts';
import type { PermissionKey, Role } from './session.ts';
import type { TagScope } from './tag.ts';

/**
 * Actions recorded in `audit_event.action`: the one closed list. `AuditAction` types the audit
 * writers of `@tinnox/db` (D19), `AuditEventShapes` below says what each action records, and
 * tests/integration/audit-failure.test.ts needs a case for every member that shows the change
 * rolling back when the audit row cannot be written, so an action nothing writes cannot stay
 * here (D3).
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'display.create',
  'display.update',
  'display.offline_alert',
  'display.online_alert',
  'pairing.create',
  'pairing.claim',
  'pairing.complete',
  'pairing.lock',
  'pairing.cancel',
  'player.revoke',
  'player.auth_rejected',
  'media.upload',
  'media.validate',
  'media.update',
  'media.delete',
  'tag.create',
  'tag.update',
  'tag.delete',
  'folder.create',
  'folder.update',
  'folder.delete',
  'app.create',
  'app.update',
  'app.delete',
  'playlist.create',
  'playlist.update',
  'playlist.delete',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
  'layout.create',
  'layout.update',
  'layout.delete',
  'publication.create',
  'invite.create',
  'invite.cancel',
  'membership.create',
  'membership.role_change',
  'membership.update',
  'membership.remove',
  'membership.sessions_end',
  'membership.mfa_reset',
  'alert_recipient.add',
  'alert_recipient.remove',
  'alert_recipient.confirm',
  'security.csrf_rejected',
  'security.permission_denied',
] as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/**
 * Why a route writes no audit row at all (D3). Closed: a new reason is a decision, recorded
 * here. A route gives one in the tables of apps/api/src/route-audit.ts: it is the route's
 * statement, true of every request. What one run of a change says when it records nothing is
 * the other list, `UNAUDITED_REASONS` below, which also says how the two relate.
 */
export const NO_AUDIT_REASONS = {
  read_only:
    'the route only reads. The session activity or the device lookup behind it is not audited (D3)',
  telemetry:
    'what the route stores is telemetry: a heartbeat and the delivery state it reports (D3)',
  login_state:
    'the route stores pre-sign-in login state, which grants nothing; the outcome of the sign-in it belongs to is audited at the callback (D3)',
} as const;
export type NoAuditReason = keyof typeof NO_AUDIT_REASONS;

/**
 * Why one run of a change commits with no audit row (D3; adoption plan section 2.1 B). Closed: a
 * new reason is a decision, recorded here. A change gives one to `unaudited` of `@tinnox/db`,
 * which takes this type (D19: types only).
 *
 * How this list and `NO_AUDIT_REASONS` relate, which `changeOrg` and `changePreOrg` hold when
 * the change runs:
 *  - a reason in both lists (`telemetry`) says what the route stores on every request. A change
 *    may give it only when its route, job or tool states the same reason;
 *  - a reason in this list alone is what one run found. A change may give `nothing_changed` or
 *    `idempotent_replay` whatever its route states, because a route that audits its changes
 *    still has runs that change nothing;
 *  - a reason of GRANTED_UNAUDITED_REASONS is a run that did change something and is
 *    deliberately not audited, so a change may give it only where it is granted: the `grants`
 *    of a route's entry in OTHER_ROUTE_AUDIT or of a job's row in JOB_AUDIT
 *    (apps/api/src/route-audit.ts), or, for `development_seed`, the permit of an offline tool
 *    whose statement names no action (`changeOrgAsMigrator` of @tinnox/db/migrate);
 *  - a reason in `NO_AUDIT_REASONS` alone (`read_only`, `login_state`) is never given by a
 *    change, and `unaudited` does not take it: a route that only reads opens `readOrg`, whose
 *    transaction refuses a write, and the login state is stored through the sec.* wrappers
 *    that take an `Autocommit`, outside any change (D2).
 *
 * Two reasons say "this was changed and deliberately not audited" because D3 says so
 * (telemetry, a counter under its threshold). Three more record what three writes do today,
 * by the ruling of adoption plan step 20 (made under the plan's delegation, DEC-38) that the
 * refactor does not change what is audited: `alert_closed_silently`, `pairing_expired_by_time`
 * and `development_seed`. They are not a judgement that the writes need no audit row; that is
 * still open (status card CMS-36 for the first two). A decision to audit one deletes its
 * reason here, and its job or route states the action instead. Any other path like that has
 * no reason to give until it is decided: it is audited, or this list gains its reason.
 */
export const UNAUDITED_REASONS = {
  nothing_changed:
    'this run found nothing to change, so no row was written, updated or deleted: the conditional statement matched no row, the values were the ones already stored, or a refusal that is not audited was decided without a write (D3, SCR-14)',
  idempotent_replay:
    'this run repeated a request that an earlier one already carried out under the same Idempotency-Key: it returns what that one made and writes nothing; the earlier run wrote the audit row',
  telemetry: NO_AUDIT_REASONS.telemetry,
  counter_under_threshold:
    'this run only counted a refused attempt that is still under its threshold: the wrong polling token of a pairing poll. The attempt that reaches the threshold locks the session and is audited as pairing.lock (D3)',
  // Today's behaviour, kept by the step 20 ruling; CMS-36 decides whether it is audited instead.
  // One reason per write, not one for "ended by time or by no one", so a search for either
  // finds that write alone and a decision on one deletes only its own reason.
  alert_closed_silently:
    'this run of the alert check closed an offline episode without an e-mail (the screen reports again with the back-online e-mail off, alerts were switched off, or the screen was unpaired or re-paired): the DELETE on display_alert, with no actor. Recorded as today (docs/portal-v2/stage-c-alerts.md section 9 rows 7 and 22); whether it is audited is open (CMS-36)',
  // Today's behaviour, kept by the step 20 ruling; CMS-36 decides whether it is audited instead.
  pairing_expired_by_time:
    'this run marked expired a pairing session whose time had passed: sec.pairing_create does it for every pending session, sec.pairing_poll for the one it polls. Only the status changes, by the passing of time and with no actor. Recorded as today; whether it is audited is open (CMS-36)',
  // Today's behaviour, kept by the step 20 ruling; a later decision may audit the seed instead.
  development_seed:
    'this run of the development seed (scripts/seed.ts) wrote synthetic development data: its organisations, sites and members, under fixed ids. It runs as tinnox_migrator against a development or test database, never production. Recorded as today; a later decision may audit it',
} as const;
export type UnauditedReason = keyof typeof UNAUDITED_REASONS;

/**
 * The reasons of both lists: a change gives one only under a statement that gives the same.
 * `satisfies` refuses a key the two tables do not share, and ./audit.test.ts a shared one that
 * is missing.
 */
export const STATED_UNAUDITED_REASONS = ['telemetry'] as const satisfies readonly (UnauditedReason &
  NoAuditReason)[];
export type StatedUnauditedReason = UnauditedReason & NoAuditReason;

/**
 * The reasons of this list alone that are still a write left unaudited: a change gives one only
 * where it is granted (see `UNAUDITED_REASONS`), so a route, job or tool that does not make
 * that write cannot use it to skip an audit row. ./audit.test.ts pins it, and
 * apps/api/src/route-audit.test.ts which statement grants which.
 */
export const GRANTED_UNAUDITED_REASONS = [
  'counter_under_threshold',
  'alert_closed_silently',
  'pairing_expired_by_time',
  'development_seed',
] as const satisfies readonly Exclude<UnauditedReason, NoAuditReason>[];
export type GrantedUnauditedReason = (typeof GRANTED_UNAUDITED_REASONS)[number];

/** The references and staff ids a provisioning run records: never a name or an address. */
interface ProvisioningRun {
  readonly requestRef?: string;
  readonly executedBy?: string;
  readonly approvedBy?: string;
  readonly confirmedWith?: string;
}

/**
 * What each action records: who its actor may be, the kind of object it names, and the closed
 * shape of its `detail` (AG-3.3, AG-3.4). The audit writers of `@tinnox/db` take exactly this
 * (`AuditInput`), so a new action, object kind or detail field is added here first, where a
 * reviewer judges it. Whether the actor and the object must be named by id follows from their
 * kinds (`AuditEventOf`); an entry with its own `actorId` or `objectId` says why it differs.
 *
 * These are the shapes of the TypeScript writers. SQL that writes audit rows itself (migration
 * 0012 and the incident scripts scripts/revoke-*-sessions.sql, which ESLint does not read, D25)
 * is held by review; where it writes another shape, the entry says so.
 *
 * A `detail` holds ids, counts, flags, field names and codes from closed lists. Never content
 * (a name, a file, the text of a setting), a secret, a token, a signed URL or a query string:
 * the types cannot see what a `string` holds, so that judgment stays with the reviewer, and the
 * integration suite scans every row its tests write (scripts/lib/audit-row-scan.ts).
 */
export interface AuditEventShapes {
  'auth.login': {
    readonly actorType: 'anonymous' | 'operator';
    readonly objectType: 'membership' | null;
    readonly detail:
      | {
          readonly reason:
            | 'unknown_or_expired_state'
            | 'provider_unavailable'
            | 'provider_rejected'
            | 'no_membership'
            | 'member_locked'
            | 'reauth_failed'
            | 'reauth_required';
        }
      | {
          readonly reason: 'mfa_evidence_missing';
          readonly acr: string | null;
          readonly amr: readonly string[];
        }
      | {
          readonly acr: string | null;
          readonly amr: readonly string[];
          readonly mfaVerifiedFromClaims: boolean;
        };
  };
  /**
   * As the API writes it. The incident scripts write it too, in SQL, in another shape: actor
   * `system` with no id, object `session` with no id (scripts/revoke-all-sessions.sql) or the
   * `membership`, and detail `{ reason: 'global_revocation' | 'incident_revocation', sessions }`
   * (scripts/revoke-subject-sessions.sql). A reader of stored rows must expect both.
   */
  'auth.logout': {
    readonly actorType: 'operator';
    readonly objectType: 'membership';
    readonly detail: null;
  };
  'display.create': {
    readonly actorType: 'operator';
    readonly objectType: 'display';
    readonly detail: {
      readonly canvas: { readonly width: number; readonly height: number };
      readonly contentRect?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      } | null;
    };
  };
  'display.update': {
    readonly actorType: 'operator';
    readonly objectType: 'display';
    readonly detail: {
      readonly fields: readonly string[];
      readonly assignedPlaylistId?: string | null;
      readonly assignedScheduleId?: string | null;
      readonly assignedLayoutId?: string | null;
    };
  };
  'display.offline_alert': {
    readonly actorType: 'system';
    readonly objectType: 'display';
    readonly detail: { readonly recipients: number };
  };
  'display.online_alert': {
    readonly actorType: 'system';
    readonly objectType: 'display';
    readonly detail: { readonly recipients: number };
  };
  'pairing.create': {
    readonly actorType: 'anonymous';
    readonly objectType: 'pairing_session';
    readonly detail: null;
  };
  'pairing.claim': {
    readonly actorType: 'operator';
    readonly objectType: 'display';
    readonly detail:
      | { readonly pairingId: string; readonly cancelledPairingIds: readonly string[] }
      | { readonly reason: 'invalid_code' | 'display_not_found' | 'rate_limited' };
  };
  'pairing.complete': {
    readonly actorType: 'anonymous' | 'player';
    readonly objectType: 'pairing_session' | 'player_registration';
    readonly detail:
      | { readonly reason: 'not_claimable' }
      | { readonly displayId: string; readonly pairingId: string };
  };
  'pairing.lock': {
    readonly actorType: 'anonymous';
    readonly objectType: 'pairing_session';
    /** `client` is a keyed fingerprint of the address, never the address. */
    readonly detail: { readonly reason: 'wrong_polling_token'; readonly client: string };
  };
  /** Written once, by migration 0012, for claims from before migration 0010; no code writes it. */
  'pairing.cancel': {
    readonly actorType: 'system';
    readonly objectType: 'display';
    readonly detail: {
      readonly reason: 'upgrade';
      readonly cancelledPairingIds: readonly string[];
    };
  };
  'player.revoke': {
    readonly actorType: 'operator' | 'player';
    readonly objectType: 'player_registration' | 'display';
    readonly detail:
      | { readonly reason: 'replaced' | 'player_reset'; readonly displayId: string }
      | {
          readonly reason: 'operator';
          readonly displayId: string;
          readonly hadActiveRegistration: boolean;
          readonly cancelledPairingIds: readonly string[];
        };
  };
  'player.auth_rejected': {
    readonly actorType: 'player';
    /** The credential was not accepted, so no registration is known to name. */
    readonly actorId: null;
    readonly objectType: null;
    /** `route` is the route pattern; `client` a keyed fingerprint of the address. */
    readonly detail: {
      readonly route: string;
      readonly client: string;
      readonly failuresInWindow: number;
      readonly throttled: boolean;
    };
  };
  'media.upload': {
    readonly actorType: 'operator';
    readonly objectType: 'media';
    /** A refused upload made no media row, so it has no id to name. */
    readonly objectId: string | null;
    readonly detail:
      | { readonly bytes: number; readonly sniffedType: string }
      | {
          readonly reason:
            'storage_quota_exceeded' | 'too_large' | 'empty_file' | 'unrecognised_type';
          readonly bytes?: number;
          readonly declaredBytes?: number;
        };
  };
  'media.validate': {
    readonly actorType: 'system';
    readonly objectType: 'media';
    readonly detail:
      | {
          readonly mimeType: string;
          readonly bytes: number;
          readonly width: number | null;
          readonly height: number | null;
          readonly durationMs: number | null;
          readonly codec: string | null;
        }
      | { readonly errorCode: MediaErrorCode };
  };
  'media.update': {
    readonly actorType: 'operator';
    readonly objectType: 'media';
    readonly detail: { readonly fields: readonly string[] };
  };
  'media.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'media';
    /** True when a publication still needs the file, so its bytes stay in storage. */
    readonly detail: { readonly bytesRetainedForPublications: boolean };
  };
  'tag.create': {
    readonly actorType: 'operator';
    readonly objectType: 'tag';
    readonly detail: { readonly scope: TagScope; readonly colour: string };
  };
  'tag.update': {
    readonly actorType: 'operator';
    readonly objectType: 'tag';
    readonly detail: { readonly fields: readonly string[] };
  };
  'tag.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'tag';
    readonly detail: { readonly scope: string; readonly removedFrom: number };
  };
  'folder.create': {
    readonly actorType: 'operator';
    readonly objectType: 'folder';
    readonly detail: null;
  };
  'folder.update': {
    readonly actorType: 'operator';
    readonly objectType: 'folder';
    readonly detail: { readonly fields: readonly string[] };
  };
  'folder.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'folder';
    readonly detail: { readonly movedToRoot: number };
  };
  'app.create': {
    readonly actorType: 'operator';
    readonly objectType: 'app';
    readonly detail: { readonly type: AppType };
  };
  'app.update': {
    readonly actorType: 'operator';
    readonly objectType: 'app';
    readonly detail: { readonly fields: readonly string[] };
  };
  'app.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'app';
    readonly detail: { readonly type: string };
  };
  'playlist.create': {
    readonly actorType: 'operator';
    readonly objectType: 'playlist';
    readonly detail: { readonly duplicatedFrom: string; readonly itemCount: number } | null;
  };
  'playlist.update': {
    readonly actorType: 'operator';
    readonly objectType: 'playlist';
    readonly detail: {
      readonly itemCount: number;
      readonly transition?: Transition;
      readonly shuffle?: boolean;
    };
  };
  'playlist.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'playlist';
    readonly detail: { readonly itemCount: number };
  };
  'schedule.create': {
    readonly actorType: 'operator';
    readonly objectType: 'schedule';
    readonly detail: { readonly defaultPlaylistId: string; readonly eventCount: number };
  };
  'schedule.update': {
    readonly actorType: 'operator';
    readonly objectType: 'schedule';
    readonly detail: { readonly defaultPlaylistId: string; readonly eventCount: number };
  };
  'schedule.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'schedule';
    readonly detail: { readonly eventCount: number };
  };
  'layout.create': {
    readonly actorType: 'operator';
    readonly objectType: 'layout';
    readonly detail: { readonly mainPlaylistId: string | null; readonly zoneCount: number };
  };
  'layout.update': {
    readonly actorType: 'operator';
    readonly objectType: 'layout';
    readonly detail: { readonly mainPlaylistId: string | null; readonly zoneCount: number };
  };
  'layout.delete': {
    readonly actorType: 'operator';
    readonly objectType: 'layout';
    readonly detail: { readonly zoneCount: number };
  };
  'publication.create': {
    readonly actorType: 'operator';
    /** A refused push names what was pushed: the layout, the schedule or the playlist. */
    readonly objectType: 'publication' | 'layout' | 'schedule' | 'playlist';
    readonly detail:
      | {
          readonly displayId: string;
          readonly playlistId: string;
          readonly scheduleId?: string;
          readonly layoutId?: string;
          readonly assignedScheduleId?: null;
          readonly assignedLayoutId?: null;
          readonly items: number;
          readonly route: string;
          readonly via: 'publish' | 'push';
        }
      | {
          readonly displayId: string;
          /** Rejection codes of the domain's publish check, never its sentences. */
          readonly reasons: readonly string[];
          readonly via: 'publish' | 'push';
        };
  };
  'invite.create': {
    readonly actorType: 'operator';
    readonly objectType: 'invite';
    readonly detail: { readonly role: Role };
  };
  'invite.cancel': {
    readonly actorType: 'operator' | 'system';
    readonly objectType: 'invite';
    readonly detail: {
      readonly role: string;
      readonly reason: 'cancelled' | 'expired' | 'inviter_demoted' | 'inviter_removed';
      readonly executedBy?: string;
    };
  };
  /** Written by provisioning only (scripts/lib/provision.ts): the API adds no member. */
  'membership.create': {
    readonly actorType: 'system';
    readonly objectType: 'membership';
    readonly detail: ProvisioningRun & {
      readonly role: Role;
      readonly inviteId: string | null;
      readonly reactivated: boolean;
      readonly reason?: 'org_create' | 'owner_recovery';
    };
  };
  'membership.role_change': {
    readonly actorType: 'operator' | 'system';
    readonly objectType: 'membership';
    readonly detail: ProvisioningRun & {
      readonly from: Role;
      readonly to: Role;
      readonly sessionsEnded: number;
      readonly invitesCancelled: number;
      readonly reason?: 'owner_recovery';
    };
  };
  'membership.update': {
    readonly actorType: 'operator' | 'system';
    readonly objectType: 'membership';
    readonly detail: ProvisioningRun & { readonly fields: readonly string[] };
  };
  'membership.remove': {
    readonly actorType: 'operator' | 'system';
    readonly objectType: 'membership';
    readonly detail: ProvisioningRun & {
      readonly previousRole: Role;
      readonly sessionsEnded: number;
      readonly invitesCancelled: number;
      readonly reason?: 'owner_recovery';
    };
  };
  /**
   * As the API writes it. scripts/revoke-subject-sessions.sql writes it too, in SQL, with actor
   * `system` and no actor id, and detail `{ reason: 'incident_revocation' }`. A reader of stored
   * rows must expect both.
   */
  'membership.sessions_end': {
    readonly actorType: 'operator';
    readonly objectType: 'membership';
    readonly detail: { readonly sessions: number };
  };
  /** Written by provisioning only. */
  'membership.mfa_reset': {
    readonly actorType: 'system';
    readonly objectType: 'membership';
    readonly detail: ProvisioningRun & { readonly sessionsEnded: number };
  };
  'alert_recipient.add': {
    readonly actorType: 'operator';
    readonly objectType: 'alert_recipient';
    readonly detail: null;
  };
  'alert_recipient.remove': {
    readonly actorType: 'operator';
    readonly objectType: 'alert_recipient';
    readonly detail: null;
  };
  'alert_recipient.confirm': {
    readonly actorType: 'anonymous';
    readonly objectType: 'alert_recipient';
    readonly detail: null;
  };
  'security.csrf_rejected': {
    readonly actorType: 'operator';
    readonly objectType: null;
    /** `route` is the route pattern, never the address that was asked for. */
    readonly detail: {
      readonly reason: string;
      readonly method: string;
      readonly route: string | null;
    };
  };
  'security.permission_denied': {
    readonly actorType: 'operator';
    readonly objectType: 'route' | 'membership' | 'invite';
    readonly detail: {
      readonly permission: readonly PermissionKey[];
      readonly method: string;
      readonly route: string;
      readonly reason:
        'role' | 'role_changed' | 'rank' | 'self' | 'grant' | 'last_owner' | 'not_signed_in';
      readonly refusalsInWindow?: number;
      readonly throttled?: boolean;
    };
  };
}

type Shaped<A extends keyof AuditEventShapes> = A;
type Listed<A extends AuditAction> = A;
/**
 * The actions and the shapes are the same list. A compile error on the first line names an
 * action of AUDIT_ACTIONS that has no entry in AuditEventShapes: add the entry. One on the
 * second names an entry whose action is not in AUDIT_ACTIONS: remove it, or add the action.
 */
export type ShapedAuditAction = Shaped<AuditAction>;
export type ListedAuditShape = Listed<keyof AuditEventShapes>;

/**
 * The actor of a row and its id (AG-3.3): an operator is named by the membership id and a player
 * by its registration id, so neither may be left out; the system and an anonymous caller have no
 * id. An action whose actor may be unknown says so with its own `actorId` in AuditEventShapes.
 */
type ActorOf<T> = T extends 'operator' | 'player'
  ? { readonly actorType: T; readonly actorId: string }
  : { readonly actorType: T; readonly actorId: null };

/**
 * The object of a row and its id (AG-3.3): an action that names a kind of object names the
 * object too, and one that names no kind names nothing. An action whose object may not exist yet
 * (a refused upload) says so with its own `objectId` in AuditEventShapes.
 */
type ObjectOf<T> = T extends null
  ? { readonly objectType: null; readonly objectId: null }
  : { readonly objectType: T; readonly objectId: string };

type ActorFieldsOf<S extends { readonly actorType: AuditActorType }> = S extends {
  readonly actorId: infer I;
}
  ? { readonly actorType: S['actorType']; readonly actorId: I }
  : ActorOf<S['actorType']>;

type ObjectFieldsOf<S extends { readonly objectType: string | null }> = S extends {
  readonly objectId: infer I;
}
  ? { readonly objectType: S['objectType']; readonly objectId: I }
  : ObjectOf<S['objectType']>;

/**
 * One audit event as the writers take it: the action picks the actor, the object kind and the
 * detail it may carry, and the actor and object kinds pick whether an id must be given. Ids are
 * membership, registration and row ids: never a name, an e-mail address or a token. No time:
 * the database stamps `occurred_at`. The organisation is not a field either: the database takes
 * it from the transaction.
 */
export type AuditEventOf<A extends AuditAction> = {
  readonly [K in A & keyof AuditEventShapes]: {
    readonly action: K;
    readonly result: AuditResult;
    readonly detail: AuditEventShapes[K]['detail'];
  } & ActorFieldsOf<AuditEventShapes[K]> &
    ObjectFieldsOf<AuditEventShapes[K]>;
}[A & keyof AuditEventShapes];

/** The part of an action before its first dot; what the audit log can be filtered by. */
export const AUDIT_CATEGORIES = [
  'auth',
  'display',
  'pairing',
  'player',
  'media',
  'tag',
  'folder',
  'app',
  'playlist',
  'schedule',
  'layout',
  'publication',
  'invite',
  'membership',
  'alert_recipient',
  'security',
] as const;
export const AuditCategorySchema = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

/** Category of a stored action: everything before the first dot. */
export function auditCategoryOf(action: string): string {
  const dot = action.indexOf('.');
  return dot === -1 ? action : action.slice(0, dot);
}

export const AUDIT_ACTOR_TYPES = ['operator', 'player', 'system', 'anonymous'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AUDIT_RESULTS = ['success', 'failure', 'denied'] as const;
export const AuditResultSchema = z.enum(AUDIT_RESULTS);
export type AuditResult = z.infer<typeof AuditResultSchema>;

export const AuditEventDtoSchema = z
  .object({
    id: z.string().regex(/^[0-9]+$/),
    occurredAt: UtcTimestampSchema,
    actorType: AuditActorTypeSchema,
    /** Membership id, registration id, or null. Never a name, email or token. */
    actorId: z.string().max(100).nullable(),
    action: z.string().max(80),
    objectType: z.string().max(40).nullable(),
    objectId: z.string().max(100).nullable(),
    result: AuditResultSchema,
    /** Small structured context. Never file content, secrets or signed URLs. */
    detail: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

/** Query of `GET /api/audit`. The filters combine; paging with `before` keeps them. */
export const AuditListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Return events with id lower than this (newest first paging). */
    before: z
      .string()
      .regex(/^[0-9]{1,18}$/)
      .optional(),
    /** Only events whose action starts with this category, for example `media`. */
    category: AuditCategorySchema.optional(),
    /** Only events with this result. */
    result: AuditResultSchema.optional(),
  })
  .strict();
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditListResponseSchema = z
  .object({
    items: z.array(AuditEventDtoSchema),
    nextBefore: z.string().nullable(),
  })
  .strict();
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
