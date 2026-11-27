/**
 * Register of the functions in schema `sec`, read by catalogue.integration.test.ts, which fails
 * when it differs from the migrated schema (AG-1.16). A new or changed function is added here
 * with its result type and one line saying why it must run as tinnox_definer; whether the reason
 * is good stays with the reviewer (a new cross-organisation read is High until justified).
 */
export interface SecFunction {
  /**
   * `pg_get_function_result`: what the function hands back to tinnox_app. Pinned so that a wider
   * result is a visible diff here, not only a line in a migration (AG-1.14, AG-1.20, EAX-11).
   */
  readonly returns: string;
  /**
   * True when it reads or writes rows that `app.org_id` does not select: rows of any
   * organisation, or of a table that has no organisation. False when it refuses to run without
   * an organisation context and stays inside it.
   */
  readonly crossOrg: boolean;
  /** Why it runs as tinnox_definer, and what keeps it narrow. */
  readonly why: string;
}

const DEVICE = 'TABLE(registration_id uuid, org_id uuid, display_id uuid)';

/** Keyed by `regprocedure`: schema, name and argument types. */
export const SEC_FUNCTIONS: Readonly<Record<string, SecFunction>> = {
  'sec.alert_recipient_by_token_hash(bytea)': {
    returns: 'TABLE(org_id uuid, recipient_id uuid)',
    crossOrg: true,
    why: 'A confirmation link is opened by someone with no session, so the organisation is unknown until the token is found. Returns the organisation and id of an unexpired, unconfirmed address, never the address.',
  },
  'sec.audit_unscoped(text,text,text,text,text,text,jsonb)': {
    returns: 'void',
    crossOrg: true,
    why: 'An event before the organisation is known (a sign-in with no membership, a rejected device token) has no org_id, and the tenant policy refuses such a row to tinnox_app. Inserts one row and returns nothing.',
  },
  'sec.device_by_registration_id(uuid)': {
    returns: DEVICE,
    crossOrg: true,
    why: 'A signed player media URL names a registration and carries no credential; the API calls this after it has verified the signature. Returns the ids of an active registration only.',
  },
  'sec.device_by_token_hash(bytea)': {
    returns: DEVICE,
    crossOrg: true,
    why: 'A player request carries only its device token: the organisation comes from the registration the hash finds. Returns the ids of an active registration only.',
  },
  'sec.display_alert_orgs()': {
    returns: 'TABLE(org_id uuid)',
    crossOrg: true,
    why: 'The alert check runs with no session and visits every organisation; organization is under the tenant policy. Returns ids only; every read of tenant data then runs inside withOrg.',
  },
  'sec.heartbeat_log_purge(integer)': {
    returns: 'integer',
    crossOrg: true,
    why: 'Housekeeping removes heartbeat history of every organisation by age (at least one hour). Returns a count.',
  },
  'sec.login_state_put(bytea,text,text,text,integer)': {
    returns: 'void',
    crossOrg: true,
    why: 'A sign-in that has not finished has no organisation, and tinnox_app has no rights on login_state. Stores one state under its hash.',
  },
  'sec.login_state_take(bytea)': {
    returns: 'TABLE(code_verifier text, nonce text, return_to text)',
    crossOrg: true,
    why: 'The sign-in callback redeems its state before the subject, and so the organisation, is known. Returns and deletes the one unexpired row with this hash.',
  },
  'sec.media_processing_jobs(integer)': {
    returns: 'TABLE(media_id uuid, org_id uuid, created_at timestamp with time zone)',
    crossOrg: true,
    why: 'After a restart the API must find the media still waiting for the worker in every organisation. Returns ids and the upload time; every change to a row then runs inside withOrg.',
  },
  'sec.membership_by_oidc_sub(text)': {
    returns: 'TABLE(membership_id uuid, org_id uuid, role text, org_name text)',
    crossOrg: true,
    why: 'The organisation of a verified subject is the thing being looked up. Returns that one active member, or no row.',
  },
  'sec.pairing_cancel_claims(uuid)': {
    returns: 'uuid[]',
    crossOrg: false,
    why: 'Refuses to run without an organisation context and touches only claims of a display of that organisation. A sec function because tinnox_app has no rights on pairing_session.',
  },
  'sec.pairing_claim(text,uuid,uuid,integer,integer)': {
    returns:
      'TABLE(outcome text, pairing_id uuid, replaced_registration_id uuid, cancelled_pairing_ids uuid[])',
    crossOrg: false,
    why: 'Refuses to run without an organisation context; the member and the display must belong to it, and the display must not be deleted. A sec function because a pending code belongs to no organisation yet and tinnox_app has no rights on pairing_session or pairing_claim_failure.',
  },
  'sec.pairing_complete(uuid,bytea,bytea)': {
    returns: 'TABLE(outcome text, registration_id uuid, org_id uuid, display_id uuid)',
    crossOrg: true,
    why: 'The player has no credential yet: the organisation comes from the claimed pairing session, found by its id and polling-token hash. Creates the one registration of that claim.',
  },
  'sec.pairing_create(text,bytea,text,integer,integer,integer)': {
    returns: 'TABLE(outcome text, pairing_id uuid, expires_at timestamp with time zone)',
    crossOrg: true,
    why: 'An unpaired player asks for a code before any organisation is involved. Inserts one pending session, rate-limited per client key.',
  },
  'sec.pairing_poll(uuid,bytea,integer)': {
    returns: 'TABLE(outcome text, expires_at timestamp with time zone)',
    crossOrg: true,
    why: 'The waiting player polls with its polling token only. Returns the state of its own session and nothing of the organisation that claimed it.',
  },
  'sec.pairing_purge(integer)': {
    returns: 'integer',
    crossOrg: true,
    why: 'Housekeeping removes pairing sessions of every organisation, and of none, by age (at least one hour). Returns a count.',
  },
  'sec.session_by_id_hash(bytea,integer)': {
    returns:
      'TABLE(membership_id uuid, org_id uuid, oidc_sub text, role text, org_name text, csrf_token text, created_at timestamp with time zone, expires_at timestamp with time zone)',
    crossOrg: true,
    why: 'Every operator request arrives with a session cookie only: the organisation comes from the session row. Returns the one live session with this hash.',
  },
  'sec.session_create(bytea,text,text,integer,text,timestamp with time zone)': {
    returns:
      'TABLE(outcome text, membership_id uuid, org_id uuid, role text, expires_at timestamp with time zone)',
    crossOrg: true,
    why: 'Sign-in: the organisation comes from the member row of the verified subject and from nowhere else. Creates one session for that member.',
  },
  'sec.session_purge_expired()': {
    returns: 'integer',
    crossOrg: true,
    why: 'Housekeeping clears the ID token of ended sessions and removes old ones in every organisation. Returns a count.',
  },
  'sec.session_revoke(bytea)': {
    returns: 'TABLE(membership_id uuid, org_id uuid, id_token text)',
    crossOrg: true,
    why: "Sign-out ends the session named by the caller's own cookie hash, and tinnox_app has no rights on session. Returns that session's member, organisation and, once, its ID token for the identity provider's logout.",
  },
  'sec.session_revoke_membership(uuid)': {
    returns: 'integer',
    crossOrg: false,
    why: 'Refuses to run without an organisation context and changes only a member of that organisation. A sec function because tinnox_app has no rights on session and no UPDATE on sessions_valid_after.',
  },
};
