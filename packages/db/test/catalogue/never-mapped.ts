/**
 * Register of the constraint names that product code deliberately never maps to an answer, read
 * by catalogue.integration.test.ts (adoption plan section 3.6, step 25, U-9). Every foreign key,
 * unique or primary key, exclusion constraint, unique index and named guard of the migrated
 * schema is either in the registry `CONSTRAINTS` (packages/db/src/constraints.ts), which a route
 * may map, or here with the reason no write of ours can trip it, or none should be answered as
 * anything but a 500. A violation of one of these is `unmapped_constraint` (classifyDbError)
 * and is logged by name.
 *
 * Keyed by the name PostgreSQL reports in the error's `constraint` field. The reasons are shared
 * where many names have the same one; each name is still listed, so a new constraint fails the
 * test until someone decides.
 *
 * CHECK constraints are not enumerated here: tests/integration/twins.test.ts owns them (plan
 * step 31), each compared with its contract rule or registered with why it has none in
 * CHECK_TWINS (tests/integration/twins-registers.ts), so a violation is a bug. One that a caller maps is in the registry
 * (media_default_duration_images_only), which the test checks exists.
 */

const ORG_ONLY =
  "A key on org_id alone into organization: a tenant write sets org_id to its own transaction's organisation (app_org_id(), which row-level security checks), and no organisation is ever deleted: tinnox_app holds no DELETE on organization (grants.json).";
const ACTOR =
  'Points at a member: the acting member of the session, or the member provisioning names. Membership rows are never deleted (removal is a status, 0013; tinnox_app holds no DELETE on membership), so the row exists.';
const DISPLAY =
  'Points at a display that the same transaction has read or locked. Displays are never deleted: tinnox_app holds no DELETE on display (grants.json).';
const SITE =
  'Points at a site of the organisation, which the display was created under. Sites are never deleted: tinnox_app holds no DELETE on site (grants.json).';
const PUBLICATION =
  'Points at a publication that the same transaction inserted, or found for this display before the write (the heartbeat, routes/player.ts). Publications are never deleted: tinnox_app holds no DELETE on publication, and publication_immutable refuses a change.';
const REGISTRATION =
  'Points at the player registration of the verified device credential. Registrations are never deleted (a revocation is a status): tinnox_app holds no DELETE on player_registration.';
const CASCADE_CHILD =
  'A child row written in the transaction that writes or locks its parent; deleting the parent cascades to it (ON DELETE CASCADE), so neither direction is refused.';
const PLAYLIST_KEPT =
  'Points at a playlist the publish has just read. A deleted playlist keeps its row (deleted_at, routes/playlists.ts): no product code deletes a playlist row, so a publication never loses it.';
const COMPOSITE_TARGET =
  'Exists only as the target of composite foreign keys that carry the organisation (AG-2.6); its id is already the primary key, which fails first.';
const GENERATED_ID =
  'A primary key over an id the database generates (gen_random_uuid() or an identity column); no write of ours supplies one.';
const SERVER_UUID =
  'The server supplies a fresh random UUID (node:crypto randomUUID()), so a collision is a bug, a 500.';
const UPSERT =
  'Written with ON CONFLICT on this key (apps/api/src/tags.ts, alerts.ts, publishing.ts, routes/player.ts), so a repeat is absorbed, not refused.';
const POSITIONS =
  'Positions numbered by the server (WITH ORDINALITY) in the transaction that replaces every child of a locked or new parent row, so no two collide.';
const RANDOM =
  'A hash of random bytes, or a key built from a random UUID by the server (media_storage_key_in_own_org): a collision is a bug or an attack, a 500.';

export const NEVER_MAPPED: Readonly<Record<string, string>> = {
  // Foreign keys on the organisation alone.
  alert_recipient_org_id_fkey: ORG_ONLY,
  app_org_id_fkey: ORG_ONLY,
  audit_event_org_id_fkey: ORG_ONLY,
  display_delivery_org_id_fkey: ORG_ONLY,
  display_org_id_fkey: ORG_ONLY,
  display_tag_org_id_fkey: ORG_ONLY,
  folder_org_id_fkey: ORG_ONLY,
  heartbeat_log_org_id_fkey: ORG_ONLY,
  layout_org_id_fkey: ORG_ONLY,
  layout_zone_org_id_fkey: ORG_ONLY,
  media_org_id_fkey: ORG_ONLY,
  media_tag_org_id_fkey: ORG_ONLY,
  member_invite_org_id_fkey: ORG_ONLY,
  membership_org_id_fkey: ORG_ONLY,
  player_registration_org_id_fkey: ORG_ONLY,
  playlist_item_org_id_fkey: ORG_ONLY,
  playlist_org_id_fkey: ORG_ONLY,
  publication_asset_org_id_fkey: ORG_ONLY,
  publication_org_id_fkey: ORG_ONLY,
  schedule_event_org_id_fkey: ORG_ONLY,
  schedule_org_id_fkey: ORG_ONLY,
  site_org_id_fkey: ORG_ONLY,
  tag_org_id_fkey: ORG_ONLY,

  // Foreign keys to a member.
  alert_recipient_created_by_fk: ACTOR,
  media_created_by_org_id_fkey: ACTOR,
  member_invite_closed_by_fk: ACTOR,
  member_invite_fulfilled_fk:
    'Set by provisioning (scripts/lib/provision.ts) to the membership it has just created or reactivated in the same transaction. Membership rows are never deleted.',
  member_invite_invited_by_fk: ACTOR,
  membership_removed_by_fk: ACTOR,
  publication_created_by_org_id_fkey: ACTOR,
  pairing_claim_failure_membership_id_fkey:
    'Written only by sec.pairing_claim, for the member it has just checked belongs to the current organisation; membership rows are never deleted, and this key cascades if one were.',
  session_membership_id_org_id_fkey:
    'Written only by sec.session_create, for the membership the sign-in has just read; membership rows are never deleted, and this key cascades if one were.',

  // Foreign keys to a display, a site, a publication or a registration.
  display_alert_display_fk: DISPLAY,
  display_delivery_display_id_org_id_fkey: DISPLAY,
  heartbeat_log_display_id_org_id_fkey: DISPLAY,
  pairing_session_display_id_org_id_fkey:
    'Written only by sec.pairing_claim, after it has found the display in the current organisation. Displays are never deleted.',
  player_registration_display_id_org_id_fkey:
    'Written only by sec.pairing_complete, for the display its claim named. Displays are never deleted.',
  publication_display_id_org_id_fkey: DISPLAY,
  display_site_id_org_id_fkey: SITE,
  display_delivery_active_publication_id_org_id_display_id_fkey: PUBLICATION,
  display_delivery_desired_publication_id_org_id_display_id_fkey: PUBLICATION,
  display_delivery_downloaded_publication_id_org_id_display__fkey: PUBLICATION,
  publication_asset_publication_id_org_id_fkey: PUBLICATION,
  display_delivery_reporting_registration_id_org_id_fkey: REGISTRATION,
  heartbeat_log_registration_id_org_id_fkey: REGISTRATION,

  // Children of a parent row the same transaction holds.
  layout_zone_layout_fk: CASCADE_CHILD,
  playlist_item_playlist_id_org_id_fkey: CASCADE_CHILD,
  schedule_event_schedule_fk: CASCADE_CHILD,
  publication_playlist_id_org_id_fkey: PLAYLIST_KEPT,

  // (id, org_id) and (id, org_id, ...) keys that composite foreign keys point at.
  alert_recipient_id_org_id_key: COMPOSITE_TARGET,
  app_id_org_id_key: COMPOSITE_TARGET,
  display_id_org_id_key: COMPOSITE_TARGET,
  folder_id_org_id_key: COMPOSITE_TARGET,
  layout_id_org_id_key: COMPOSITE_TARGET,
  media_id_org_id_key: COMPOSITE_TARGET,
  member_invite_id_org_id_key: COMPOSITE_TARGET,
  membership_id_org_id_key: COMPOSITE_TARGET,
  player_registration_id_org_id_key: COMPOSITE_TARGET,
  playlist_id_org_id_key: COMPOSITE_TARGET,
  publication_id_org_id_display_id_key: COMPOSITE_TARGET,
  publication_id_org_id_key: COMPOSITE_TARGET,
  schedule_id_org_id_key: COMPOSITE_TARGET,
  site_id_org_id_key: COMPOSITE_TARGET,
  tag_id_org_id_key: COMPOSITE_TARGET,
  tag_id_org_id_scope_key: COMPOSITE_TARGET,

  // Primary keys.
  alert_recipient_pkey: GENERATED_ID,
  app_pkey: GENERATED_ID,
  audit_event_pkey: GENERATED_ID,
  display_pkey: GENERATED_ID,
  folder_pkey: GENERATED_ID,
  heartbeat_log_pkey: GENERATED_ID,
  layout_pkey: GENERATED_ID,
  media_pkey: `${SERVER_UUID} It is the upload's job id (media/pipeline.ts), inserted by routes/media.ts.`,
  member_invite_pkey: GENERATED_ID,
  membership_pkey: GENERATED_ID,
  organization_pkey:
    "Provisioning's org-create supplies the id: a fresh random UUID from newOrgId() (scripts/lib/provision.ts), so a collision is a bug, a 500. The development seed's fixed ids are written with ON CONFLICT DO NOTHING. tinnox_app creates no organisation.",
  pairing_claim_failure_pkey: GENERATED_ID,
  pairing_session_pkey: GENERATED_ID,
  player_registration_pkey: GENERATED_ID,
  playlist_item_pkey: GENERATED_ID,
  playlist_pkey: GENERATED_ID,
  publication_pkey: `${SERVER_UUID} createPublication (publishing.ts) draws it before it builds the manifest.`,
  schedule_pkey: GENERATED_ID,
  site_pkey:
    'The database generates the id (gen_random_uuid()) for every write of the API and provisioning; only the development seed supplies fixed site ids, with ON CONFLICT DO NOTHING.',
  tag_pkey: GENERATED_ID,
  display_alert_pkey: UPSERT,
  display_delivery_pkey: UPSERT,
  display_tag_pkey: UPSERT,
  media_tag_pkey: UPSERT,
  layout_zone_pkey: POSITIONS,
  publication_asset_pkey: POSITIONS,
  schedule_event_pkey: POSITIONS,
  login_state_pkey: RANDOM,
  session_pkey: RANDOM,

  // Other unique keys and unique indexes.
  playlist_item_playlist_id_position_key: `${POSITIONS} Deferred to COMMIT, where its refusal rolls the transaction back (the real refusal at COMMIT of packages/db/test/commit-outcome.integration.test.ts).`,
  alert_recipient_org_id_email_key:
    'POST /api/alert-recipients checks for the address under the per-organisation lock of withCountedLimit before it inserts, and answers 409 itself (routes/alert-recipients.ts).',
  alert_recipient_token_key: RANDOM,
  media_storage_key_key: RANDOM,
  media_thumb_storage_key_key: RANDOM,
  pairing_session_polling_token_hash_key: RANDOM,
  player_registration_token_hash_key: RANDOM,
  pairing_session_pending_code:
    'Written only by sec.pairing_create, which catches the unique violation and answers code_collision itself.',
  player_registration_one_active_per_display:
    'Written only by sec.pairing_complete, which revokes the active registration of the display (replaced) under the pairing lock of the display before it inserts the new one.',
};

/**
 * Functions that raise an integrity violation (class 23) and name no constraint, so a caller
 * cannot tell their refusal from any other: each is a bug if reached, answered with a 500. Keyed
 * by the function as regprocedure prints it.
 */
export const UNNAMED_GUARDS: Readonly<Record<string, string>> = {
  'public.reject_change()':
    'Refuses every change to rows that never change (audit_event, publication, publication_asset); no product code updates or deletes them.',
  'public.player_registration_guard()':
    "Refuses a change to a revoked registration or to a registration's identity; the API and sec.pairing_complete only ever revoke a registration that is still active.",
  'public.publication_asset_guard()':
    'Refuses an asset added outside the transaction of its publication, or one that differs from the manifest; publishing.ts inserts the assets with their publication, from the same manifest.',
};
