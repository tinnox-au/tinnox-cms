/**
 * Typed wrappers for the SECURITY DEFINER functions in schema `sec`
 * (db/migrations/0002_security_functions.sql; sessions and members changed by
 * 0013_roles_and_members.sql). They take hashes, never raw secrets: hash a token
 * with `sha256` before calling.
 */
import { createHash } from 'node:crypto';
import type { Pool } from './pool.ts';
import { poolAsTx, type Autocommit, type Tx } from './tx.ts';

/** SHA-256 digest as a Buffer, the form stored in *_hash columns. */
export function sha256(value: string | Uint8Array): Buffer {
  return createHash('sha256').update(value).digest();
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  throw new Error('expected a timestamp from the database');
}

function only<R>(rows: R[]): R | null {
  return rows[0] ?? null;
}

export interface MembershipLookup {
  readonly membershipId: string;
  readonly orgId: string;
  readonly role: string;
  readonly orgName: string;
}

export async function membershipByOidcSub(
  db: Autocommit,
  oidcSub: string,
): Promise<MembershipLookup | null> {
  const { rows } = await db.query<{
    membership_id: string;
    org_id: string;
    role: string;
    org_name: string;
  }>('SELECT membership_id, org_id, role, org_name FROM sec.membership_by_oidc_sub($1)', [oidcSub]);
  const r = only(rows);
  return r === null
    ? null
    : { membershipId: r.membership_id, orgId: r.org_id, role: r.role, orgName: r.org_name };
}

export interface LoginState {
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: string | null;
}

export async function loginStatePut(
  db: Autocommit,
  input: {
    stateHash: Buffer;
    codeVerifier: string;
    nonce: string;
    returnTo: string | null;
    ttlSeconds: number;
  },
): Promise<void> {
  await db.query('SELECT sec.login_state_put($1, $2, $3, $4, $5)', [
    input.stateHash,
    input.codeVerifier,
    input.nonce,
    input.returnTo,
    input.ttlSeconds,
  ]);
}

/** One-time: a second call with the same hash returns null. */
export async function loginStateTake(
  db: Autocommit,
  stateHash: Buffer,
): Promise<LoginState | null> {
  const { rows } = await db.query<{
    code_verifier: string;
    nonce: string;
    return_to: string | null;
  }>('SELECT code_verifier, nonce, return_to FROM sec.login_state_take($1)', [stateHash]);
  const r = only(rows);
  return r === null
    ? null
    : { codeVerifier: r.code_verifier, nonce: r.nonce, returnTo: r.return_to };
}

/**
 * Outcome of `sec.session_create`. `role` stays a plain string here (this package depends
 * only on `pg`); the API narrows it.
 */
export type SessionCreateResult =
  | {
      readonly outcome: 'created';
      readonly membershipId: string;
      readonly orgId: string;
      readonly role: string;
      readonly expiresAt: string;
    }
  /** The member's sessions were ended after this sign-in was authenticated: sign in again. */
  | { readonly outcome: 'reauth'; readonly membershipId: string; readonly orgId: string }
  /** No member with this subject, or a removed one: the sign-in is refused. */
  | { readonly outcome: 'no_membership' };

/** sec.session_create (0013). authTime: the ID token's auth_time; null when the token has none. */
export async function sessionCreate(
  tx: Tx,
  input: {
    idHash: Buffer;
    oidcSub: string;
    csrfToken: string;
    ttlSeconds: number;
    idToken: string | null;
    authTime: Date | null;
  },
): Promise<SessionCreateResult> {
  const { rows } = await tx.query<{
    outcome: string;
    membership_id: string | null;
    org_id: string | null;
    role: string | null;
    expires_at: Date | null;
  }>(
    'SELECT outcome, membership_id, org_id, role, expires_at FROM sec.session_create($1, $2, $3, $4, $5, $6)',
    [input.idHash, input.oidcSub, input.csrfToken, input.ttlSeconds, input.idToken, input.authTime],
  );
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('sec.session_create did not return exactly one row');
  }
  const r = rows[0];
  if (r.outcome === 'created' && r.membership_id !== null && r.org_id !== null && r.role !== null) {
    return {
      outcome: 'created',
      membershipId: r.membership_id,
      orgId: r.org_id,
      role: r.role,
      expiresAt: iso(r.expires_at),
    };
  }
  if (r.outcome === 'reauth' && r.membership_id !== null && r.org_id !== null) {
    return { outcome: 'reauth', membershipId: r.membership_id, orgId: r.org_id };
  }
  if (r.outcome === 'no_membership') return { outcome: 'no_membership' };
  throw new Error(`unexpected session_create outcome ${r.outcome}`);
}

export interface SessionLookup {
  readonly membershipId: string;
  readonly orgId: string;
  readonly oidcSub: string;
  readonly role: string;
  readonly orgName: string;
  readonly csrfToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Returns the live session and records activity, or null when missing, expired, idle or revoked. */
export async function sessionByIdHash(
  db: Autocommit,
  idHash: Buffer,
  idleTimeoutSeconds: number,
): Promise<SessionLookup | null> {
  const { rows } = await db.query<{
    membership_id: string;
    org_id: string;
    oidc_sub: string;
    role: string;
    org_name: string;
    csrf_token: string;
    created_at: Date;
    expires_at: Date;
  }>(
    'SELECT membership_id, org_id, oidc_sub, role, org_name, csrf_token, created_at, expires_at FROM sec.session_by_id_hash($1, $2)',
    [idHash, idleTimeoutSeconds],
  );
  const r = only(rows);
  return r === null
    ? null
    : {
        membershipId: r.membership_id,
        orgId: r.org_id,
        oidcSub: r.oidc_sub,
        role: r.role,
        orgName: r.org_name,
        csrfToken: r.csrf_token,
        createdAt: iso(r.created_at),
        expiresAt: iso(r.expires_at),
      };
}

/** Ends the session. Returns null when there was no live session. */
export async function sessionRevoke(
  tx: Tx,
  idHash: Buffer,
): Promise<{ membershipId: string; orgId: string; idToken: string | null } | null> {
  const { rows } = await tx.query<{
    membership_id: string;
    org_id: string;
    id_token: string | null;
  }>('SELECT membership_id, org_id, id_token FROM sec.session_revoke($1)', [idHash]);
  const r = only(rows);
  return r === null
    ? null
    : { membershipId: r.membership_id, orgId: r.org_id, idToken: r.id_token };
}

/**
 * Ends the session in a statement of its own, with no audit row. The one accepted exception
 * to "a revocation commits with its audit row" (CX-01 residual): the sign-out fallback, when
 * the audited transaction failed and ending the session is still the safe direction. Every
 * other revocation uses `sessionRevoke` on the `Tx` that also writes the audit row. Returns
 * true when a live session was ended.
 */
export async function sessionRevokeUnaudited(pool: Pool, idHash: Buffer): Promise<boolean> {
  const { rows } = await poolAsTx(pool, {
    opener: 'sessionRevokeUnaudited',
    instead:
      'End the session on the outer tx with sessionRevoke(tx, idHash), and write its audit row on the same tx.',
  }).query('SELECT 1 FROM sec.session_revoke($1)', [idHash]);
  return rows.length > 0;
}

/**
 * sec.session_revoke_membership (0013): ends every live session of the member and sets the
 * member's cut-off, so older sessions and sign-ins authenticated before it are refused. The
 * cut-off is the start of this statement (never earlier than it was), so lock waits before it
 * are covered. Inside `withOrg` only: a member of another organisation, or no organisation
 * context, raises 42501. Returns the number of sessions ended (already expired ones are not).
 */
export async function sessionRevokeMembership(tx: Tx, membershipId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>('SELECT sec.session_revoke_membership($1) AS n', [
    membershipId,
  ]);
  return rows[0]?.n ?? 0;
}

export async function sessionPurgeExpired(db: Autocommit): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT sec.session_purge_expired() AS n');
  return rows[0]?.n ?? 0;
}

export type PairingCreateResult =
  | { readonly outcome: 'created'; readonly pairingId: string; readonly expiresAt: string }
  | { readonly outcome: 'rate_limited' }
  | { readonly outcome: 'code_collision' };

export async function pairingCreate(
  tx: Tx,
  input: {
    code: string;
    pollingTokenHash: Buffer;
    /** Opaque rate-limit key, for example an HMAC of the client address. */
    clientKey: string;
    ttlSeconds: number;
    maxSessionsPerClient: number;
    windowSeconds: number;
  },
): Promise<PairingCreateResult> {
  const { rows } = await tx.query<{
    outcome: string;
    pairing_id: string | null;
    expires_at: Date | null;
  }>('SELECT outcome, pairing_id, expires_at FROM sec.pairing_create($1, $2, $3, $4, $5, $6)', [
    input.code,
    input.pollingTokenHash,
    input.clientKey,
    input.ttlSeconds,
    input.maxSessionsPerClient,
    input.windowSeconds,
  ]);
  const r = only(rows);
  if (r === null) throw new Error('sec.pairing_create returned no row');
  if (r.outcome === 'created' && r.pairing_id !== null) {
    return { outcome: 'created', pairingId: r.pairing_id, expiresAt: iso(r.expires_at) };
  }
  if (r.outcome === 'rate_limited' || r.outcome === 'code_collision') return { outcome: r.outcome };
  throw new Error(`unexpected pairing_create outcome ${r.outcome}`);
}

/**
 * `wrong_token_locked` is the wrong token that locked the session (once per session):
 * audit it in the same transaction as the poll. Later polls answer `locked`.
 */
export const PAIRING_POLL_OUTCOMES = [
  'pending',
  'claimed',
  'completed',
  'expired',
  'locked',
  'not_found',
  'wrong_token',
  'wrong_token_locked',
] as const;
export type PairingPollOutcome = (typeof PAIRING_POLL_OUTCOMES)[number];

export async function pairingPoll(
  tx: Tx,
  input: { pairingId: string; pollingTokenHash: Buffer; maxWrongAttempts: number },
): Promise<{ outcome: PairingPollOutcome; expiresAt: string | null }> {
  const { rows } = await tx.query<{ outcome: string; expires_at: Date | null }>(
    'SELECT outcome, expires_at FROM sec.pairing_poll($1, $2, $3)',
    [input.pairingId, input.pollingTokenHash, input.maxWrongAttempts],
  );
  const r = only(rows);
  if (r === null || !(PAIRING_POLL_OUTCOMES as readonly string[]).includes(r.outcome)) {
    throw new Error('unexpected pairing_poll result');
  }
  return {
    outcome: r.outcome as PairingPollOutcome,
    expiresAt: r.expires_at === null ? null : iso(r.expires_at),
  };
}

export type PairingClaimResult =
  | {
      readonly outcome: 'claimed';
      readonly pairingId: string;
      readonly replacedRegistrationId: string | null;
      /** Older claims of the display, never collected, that this claim cancelled. */
      readonly cancelledPairingIds: readonly string[];
    }
  | { readonly outcome: 'invalid_code' | 'display_not_found' | 'rate_limited' };

/** Must be called with a Tx from `withOrg`; the organisation is taken from the transaction context. */
export async function pairingClaim(
  tx: Tx,
  input: {
    code: string;
    displayId: string;
    membershipId: string;
    maxFailures: number;
    windowSeconds: number;
  },
): Promise<PairingClaimResult> {
  const { rows } = await tx.query<{
    outcome: string;
    pairing_id: string | null;
    replaced_registration_id: string | null;
    cancelled_pairing_ids: string[] | null;
  }>(
    'SELECT outcome, pairing_id, replaced_registration_id, cancelled_pairing_ids FROM sec.pairing_claim($1, $2, $3, $4, $5)',
    [input.code, input.displayId, input.membershipId, input.maxFailures, input.windowSeconds],
  );
  const r = only(rows);
  if (r === null) throw new Error('sec.pairing_claim returned no row');
  if (r.outcome === 'claimed' && r.pairing_id !== null) {
    return {
      outcome: 'claimed',
      pairingId: r.pairing_id,
      replacedRegistrationId: r.replaced_registration_id,
      cancelledPairingIds: r.cancelled_pairing_ids ?? [],
    };
  }
  if (
    r.outcome === 'invalid_code' ||
    r.outcome === 'display_not_found' ||
    r.outcome === 'rate_limited'
  ) {
    return { outcome: r.outcome };
  }
  throw new Error(`unexpected pairing_claim outcome ${r.outcome}`);
}

/**
 * Cancels the display's claims that its player has not collected yet, so none of them
 * can complete. Must be called with a Tx from `withOrg`, before the transaction touches
 * the display or its registrations. Returns the ids of the cancelled pairing sessions.
 */
export async function pairingCancelClaims(tx: Tx, displayId: string): Promise<string[]> {
  const { rows } = await tx.query<{ ids: string[] }>(
    'SELECT sec.pairing_cancel_claims($1) AS ids',
    [displayId],
  );
  return rows[0]?.ids ?? [];
}

export type PairingCompleteResult =
  | {
      readonly outcome: 'completed';
      readonly registrationId: string;
      readonly orgId: string;
      readonly displayId: string;
    }
  | { readonly outcome: 'not_claimable' };

/**
 * Succeeds once per pairing session. Pass the hash of a freshly generated device token.
 * Never replaces an active registration: if the display has one, a newer claim owns it,
 * and this pairing is cancelled and answers `not_claimable`.
 */
export async function pairingComplete(
  tx: Tx,
  input: { pairingId: string; pollingTokenHash: Buffer; deviceTokenHash: Buffer },
): Promise<PairingCompleteResult> {
  const { rows } = await tx.query<{
    outcome: string;
    registration_id: string | null;
    org_id: string | null;
    display_id: string | null;
  }>('SELECT outcome, registration_id, org_id, display_id FROM sec.pairing_complete($1, $2, $3)', [
    input.pairingId,
    input.pollingTokenHash,
    input.deviceTokenHash,
  ]);
  const r = only(rows);
  if (r === null) throw new Error('sec.pairing_complete returned no row');
  if (
    r.outcome === 'completed' &&
    r.registration_id !== null &&
    r.org_id !== null &&
    r.display_id !== null
  ) {
    return {
      outcome: 'completed',
      registrationId: r.registration_id,
      orgId: r.org_id,
      displayId: r.display_id,
    };
  }
  if (r.outcome === 'not_claimable') return { outcome: 'not_claimable' };
  throw new Error(`unexpected pairing_complete outcome ${r.outcome}`);
}

export async function pairingPurge(db: Autocommit, olderThanSeconds: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT sec.pairing_purge($1) AS n', [
    olderThanSeconds,
  ]);
  return rows[0]?.n ?? 0;
}

/** Removes heartbeat history older than `olderThanSeconds` (at least 3600) in every organisation. */
export async function heartbeatLogPurge(db: Autocommit, olderThanSeconds: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT sec.heartbeat_log_purge($1) AS n', [
    olderThanSeconds,
  ]);
  return rows[0]?.n ?? 0;
}

export interface DeviceLookup {
  readonly registrationId: string;
  readonly orgId: string;
  readonly displayId: string;
}

/** Null for an unknown or revoked token. */
export async function deviceByTokenHash(
  db: Autocommit,
  tokenHash: Buffer,
): Promise<DeviceLookup | null> {
  const { rows } = await db.query<{ registration_id: string; org_id: string; display_id: string }>(
    'SELECT registration_id, org_id, display_id FROM sec.device_by_token_hash($1)',
    [tokenHash],
  );
  const r = only(rows);
  return r === null
    ? null
    : { registrationId: r.registration_id, orgId: r.org_id, displayId: r.display_id };
}

/**
 * The organisation and display of an active registration, by the registration id a signed media
 * URL names (0003); null for an unknown or revoked one. The media route verifies the signature
 * first, then enters the organisation with withOrg.
 */
export async function deviceByRegistrationId(
  db: Autocommit,
  registrationId: string,
): Promise<{ orgId: string; displayId: string } | null> {
  const { rows } = await db.query<{ org_id: string; display_id: string }>(
    'SELECT org_id, display_id FROM sec.device_by_registration_id($1)',
    [registrationId],
  );
  const r = only(rows);
  return r === null ? null : { orgId: r.org_id, displayId: r.display_id };
}

export interface MediaProcessingJob {
  readonly mediaId: string;
  readonly orgId: string;
  readonly createdAt: Date;
}

/**
 * The oldest `limit` media rows still waiting for validation, in every organisation (0003): the
 * media pipeline's queue. It then enters each row's organisation with withOrg.
 */
export async function mediaProcessingJobs(
  db: Autocommit,
  limit: number,
): Promise<MediaProcessingJob[]> {
  const { rows } = await db.query<{ media_id: string; org_id: string; created_at: Date }>(
    'SELECT media_id, org_id, created_at FROM sec.media_processing_jobs($1)',
    [limit],
  );
  return rows.map((r) => ({ mediaId: r.media_id, orgId: r.org_id, createdAt: r.created_at }));
}

/** Every organisation's id, for the alert check (0014); it then enters each with withOrg. */
export async function displayAlertOrgs(db: Autocommit): Promise<string[]> {
  const { rows } = await db.query<{ org_id: string }>(
    'SELECT org_id FROM sec.display_alert_orgs()',
  );
  return rows.map((r) => r.org_id);
}

export interface AlertRecipientLookup {
  readonly orgId: string;
  readonly recipientId: string;
}

/** The unconfirmed, unexpired recipient a confirmation link names; null otherwise (0014). */
export async function alertRecipientByTokenHash(
  db: Autocommit,
  tokenHash: Buffer,
): Promise<AlertRecipientLookup | null> {
  const { rows } = await db.query<{ org_id: string; recipient_id: string }>(
    'SELECT org_id, recipient_id FROM sec.alert_recipient_by_token_hash($1)',
    [tokenHash],
  );
  const r = only(rows);
  return r === null ? null : { orgId: r.org_id, recipientId: r.recipient_id };
}

export interface AuditInput {
  readonly actorType: 'operator' | 'player' | 'system' | 'anonymous';
  readonly actorId: string | null;
  readonly action: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly result: 'success' | 'failure' | 'denied';
  /** Small structured context. Never file content, secrets or signed URLs. */
  readonly detail: Record<string, unknown> | null;
}

/** Appends an audit event for the organisation of the current `withOrg` transaction. */
export async function auditScoped(tx: Tx, event: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event (org_id, actor_type, actor_id, action, object_type, object_id, result, detail)
     VALUES (app_org_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      event.actorType,
      event.actorId,
      event.action,
      event.objectType,
      event.objectId,
      event.result,
      event.detail === null ? null : JSON.stringify(event.detail),
    ],
  );
}

function writeUnscoped(handle: Autocommit, event: AuditInput): Promise<unknown> {
  return handle.query('SELECT sec.audit_unscoped($1, $2, $3, $4, $5, $6, $7)', [
    event.actorType,
    event.actorId,
    event.action,
    event.objectType,
    event.objectId,
    event.result,
    event.detail === null ? null : JSON.stringify(event.detail),
  ]);
}

/**
 * Appends an audit event that has no organisation (a sign-in by nobody's member, a pairing
 * attempt), on the transaction of what it records.
 */
export async function auditUnscoped(tx: Tx, event: AuditInput): Promise<void> {
  await writeUnscoped(tx, event);
}

interface NoActorOrObject {
  readonly actorId: null;
  readonly objectType: null;
  readonly objectId: null;
  /** Small structured context. Never file content, secrets or signed URLs. */
  readonly detail: Record<string, unknown> | null;
}

/**
 * What `auditStandalone` may record: a refusal with no change to commit with, so there is no
 * transaction to write it on (D2). A closed list with no `success` member and no actor or
 * object id, so a change can never be recorded this way. A sign-in refused at or after the
 * provider call has already had its one-time login state consumed by `loginStateTake`, in an
 * earlier statement of its own. That is the only change on these paths, and it is not audited
 * by itself (D3).
 *
 * Does a new kind of refusal belong here? Only when it comes before the organisation is
 * known, nothing but the login state was changed and nothing was issued on its path, and no
 * transaction is open to carry the row. A refusal inside an organisation is a scoped
 * audit-only transaction instead (`withOrg` and `auditScoped`, as the permission, CSRF and
 * upload refusals do).
 */
export type StandaloneAuditEvent =
  /** A sign-in that was refused, or that failed, before any session existed. */
  | (NoActorOrObject & {
      readonly action: 'auth.login';
      readonly actorType: 'anonymous';
      readonly result: 'denied' | 'failure';
    })
  /** A device credential the API did not accept. */
  | (NoActorOrObject & {
      readonly action: 'player.auth_rejected';
      readonly actorType: 'player';
      readonly result: 'denied';
    });

/**
 * Appends an unscoped audit event in a statement of its own. For the refusals of
 * `StandaloneAuditEvent` only; everything else is written with `auditScoped` or
 * `auditUnscoped` on the `Tx` of the change.
 */
export async function auditStandalone(pool: Pool, event: StandaloneAuditEvent): Promise<void> {
  await writeUnscoped(
    poolAsTx(pool, {
      opener: 'auditStandalone',
      instead:
        'Write the event on the outer tx with auditUnscoped(tx, event), or with auditScoped(tx, event) when the outer transaction is withOrg.',
    }),
    event,
  );
}
