/**
 * Register of the CHECK constraints that read a nullable column or a JSON path and are not
 * written `(...) IS TRUE`, read by catalogue.integration.test.ts (CX-02).
 *
 * A CHECK refuses a row only when its expression is false: NULL passes. A completeness rule
 * that compares a value which may be absent therefore accepts the row it was written to refuse
 * (db/migrations/0008_null_safe_checks.sql). The test treats `(...) IS TRUE` as safe by its form
 * and asks for an entry here for every other such CHECK, so whoever adds one says what a missing
 * value does to it.
 *
 * An entry is a judgement about one expression over columns of which some may be NULL, so it
 * carries both. A CHECK that is dropped and added again under the same name, which is how 0008
 * changed the ones it fixed, fails the test until its entry has been read again and updated. So
 * does `ALTER COLUMN ... DROP NOT NULL` on a column it reads: the expression is printed as
 * before, and "never null because org_id is NOT NULL" is no longer true.
 *
 * Where a `why` rests on another CHECK it names that CHECK. The test cannot follow such a
 * reference, so its message for a changed or removed CHECK asks for a search of this file.
 */
export interface NullPassingCheck {
  /**
   * - `passes`: the expression is NULL when the value is absent, and an absent value is meant
   *   to be accepted.
   * - `never null`: the expression is true or false for every row.
   */
  readonly onNull: 'passes' | 'never null';
  /**
   * The CHECK the entry was written for, as `pg_get_constraintdef` prints it with only
   * pg_catalog on the search path. The test's failure message prints the current one to copy.
   */
  readonly definition: string;
  /**
   * The columns the CHECK reads that had no NOT NULL when the entry was written, in any order.
   * Every other column it reads was NOT NULL, which is what a `why` such as "status is NOT NULL"
   * stands on. The test's failure message prints the current list to copy.
   */
  readonly nullable: readonly string[];
  readonly why: string;
}

/** The column is optional and the rule only bounds a value that is there. */
const optional = (
  definition: string,
  nullable: readonly string[],
  why: string,
): NullPassingCheck => ({ onNull: 'passes', definition, nullable, why });
/** The expression cannot come out NULL. */
const total = (definition: string, nullable: readonly string[], why: string): NullPassingCheck => ({
  onNull: 'never null',
  definition,
  nullable,
  why,
});

const NULL_TESTS_ONLY = 'Built from IS NULL and IS NOT NULL tests, which are never NULL.';
const NOT_VALIDATED_YET =
  'NULL until the worker has validated the file; media_ready_is_complete requires it for ready media.';
const NO_DESCRIPTION = 'NULL means no description.';
const INVITE_DETAILS =
  'The name and address are deleted when the invite closes; member_invite_open requires both while it is pending.';
const NO_NAME_YET = 'NULL until TINNOX names the member (provision-member set-name).';

/** Keyed by schema, table and constraint name. */
export const NULL_PASSING_CHECKS: Readonly<Record<string, NullPassingCheck>> = {
  'public.alert_recipient.alert_recipient_confirmation': total(
    'CHECK ((((confirmed_at IS NOT NULL) AND (confirm_token_hash IS NULL) AND (confirm_expires_at IS NULL)) OR ((confirmed_at IS NULL) AND (confirm_token_hash IS NOT NULL) AND (confirm_expires_at IS NOT NULL))))',
    ['confirm_expires_at', 'confirm_token_hash', 'confirmed_at'],
    NULL_TESTS_ONLY,
  ),
  'public.alert_recipient.alert_recipient_token_length': optional(
    'CHECK ((octet_length(confirm_token_hash) = 32))',
    ['confirm_token_hash'],
    'NULL once the address is confirmed; alert_recipient_confirmation requires the hash until then.',
  ),

  'public.app.app_description_length': optional(
    'CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))',
    ['description'],
    NO_DESCRIPTION,
  ),

  'public.audit_event.audit_event_actor_id_check': optional(
    'CHECK ((char_length(actor_id) <= 100))',
    ['actor_id'],
    'System and anonymous events have no actor id.',
  ),
  'public.audit_event.audit_event_detail_check': optional(
    'CHECK ((pg_column_size(detail) <= 4096))',
    ['detail'],
    'An event may carry no detail.',
  ),
  'public.audit_event.audit_event_object_id_check': optional(
    'CHECK ((char_length(object_id) <= 100))',
    ['object_id'],
    'An event may have no object.',
  ),
  'public.audit_event.audit_event_object_type_check': optional(
    'CHECK ((char_length(object_type) <= 40))',
    ['object_type'],
    'An event may have no object.',
  ),

  'public.display.display_alert_offline_minutes_range': total(
    'CHECK (((alert_offline_minutes IS NULL) OR (((alert_offline_minutes >= 30) AND (alert_offline_minutes <= 2880)) AND ((alert_offline_minutes % 30) = 0))))',
    ['alert_offline_minutes'],
    'NULL means alerts are off and is accepted by name (IS NULL OR ...); the range runs on a value only.',
  ),
  'public.display.display_content_rect_all_or_none': total(
    'CHECK ((num_nulls(content_x, content_y, content_width, content_height) = ANY (ARRAY[0, 4])))',
    ['content_height', 'content_width', 'content_x', 'content_y'],
    'num_nulls() is never NULL.',
  ),
  'public.display.display_content_rect_in_canvas': total(
    'CHECK (((content_x IS NULL) OR ((content_x >= 0) AND (content_y >= 0) AND (content_width >= 16) AND (content_height >= 16) AND ((content_x + content_width) <= canvas_width) AND ((content_y + content_height) <= canvas_height))))',
    ['content_height', 'content_width', 'content_x', 'content_y'],
    'NULL content_x means no content rectangle and is accepted by name. With content_x set the other three are set too (display_content_rect_all_or_none), and the canvas columns are NOT NULL, so no comparison is NULL.',
  ),
  'public.display.display_description_length': optional(
    'CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))',
    ['description'],
    NO_DESCRIPTION,
  ),
  'public.display.display_one_assignment': total(
    'CHECK ((num_nonnulls(assigned_playlist_id, assigned_schedule_id, assigned_layout_id) <= 1))',
    ['assigned_layout_id', 'assigned_playlist_id', 'assigned_schedule_id'],
    'num_nonnulls() is never NULL.',
  ),
  'public.display.display_working_hours_shape': total(
    "CHECK (((working_hours IS NULL) OR ((jsonb_typeof(working_hours) = 'array'::text) AND (jsonb_array_length(working_hours) = 7) AND (pg_column_size(working_hours) <= 1024))))",
    ['working_hours'],
    'NULL means no working hours and is accepted by name (IS NULL OR ...); the shape tests run on a value only.',
  ),

  'public.display_delivery.display_delivery_active_item_index_check': optional(
    'CHECK ((active_item_index >= 0))',
    ['active_item_index'],
    'NULL while nothing is playing; display_delivery_active_pair ties it to active_publication_id.',
  ),
  'public.display_delivery.display_delivery_active_pair': total(
    'CHECK (((active_publication_id IS NULL) = (active_item_index IS NULL)))',
    ['active_item_index', 'active_publication_id'],
    'Compares two IS NULL tests, which are never NULL.',
  ),
  'public.display_delivery.display_delivery_last_seq_check': optional(
    'CHECK ((last_seq >= 0))',
    ['last_seq'],
    'NULL until the player has reported.',
  ),
  'public.display_delivery.display_delivery_player_state_check': optional(
    "CHECK ((player_state = ANY (ARRAY['idle'::text, 'playing'::text, 'error'::text])))",
    ['player_state'],
    'NULL until the player has reported.',
  ),
  'public.display_delivery.display_delivery_staging_check': optional(
    'CHECK ((pg_column_size(staging) <= 2048))',
    ['staging'],
    'NULL when the player reported no staging state.',
  ),

  'public.layout.layout_description_length': optional(
    'CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))',
    ['description'],
    NO_DESCRIPTION,
  ),

  'public.login_state.login_state_return_to_check': optional(
    'CHECK ((char_length(return_to) <= 200))',
    ['return_to'],
    'A sign-in may have no page to return to.',
  ),

  'public.media.media_availability_order': total(
    'CHECK (((available_from IS NULL) OR (available_until IS NULL) OR (available_from < available_until)))',
    ['available_from', 'available_until'],
    'Either bound may be absent (no start, no end) and is accepted by name; the comparison runs on two values only.',
  ),
  'public.media.media_bytes_check': optional('CHECK ((bytes >= 0))', ['bytes'], NOT_VALIDATED_YET),
  'public.media.media_codec_check': optional(
    'CHECK ((char_length(codec) <= 40))',
    ['codec'],
    'NULL for images and until the worker has validated the file; media_ready_is_complete requires it for ready video.',
  ),
  'public.media.media_default_duration_images_only': total(
    "CHECK (((default_duration_ms IS NULL) OR (kind = 'image'::text)))",
    ['default_duration_ms'],
    'NULL means no default duration and is accepted by name; kind is NOT NULL.',
  ),
  'public.media.media_default_duration_range': optional(
    'CHECK (((default_duration_ms >= 1) AND (default_duration_ms <= 86400000)))',
    ['default_duration_ms'],
    'NULL means no default duration.',
  ),
  'public.media.media_description_length': optional(
    'CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))',
    ['description'],
    NO_DESCRIPTION,
  ),
  'public.media.media_duration_ms_check': optional(
    'CHECK ((duration_ms > 0))',
    ['duration_ms'],
    'NULL for images and until the worker has validated the file; media_ready_is_complete requires it for ready video.',
  ),
  'public.media.media_error_code_check': optional(
    'CHECK ((char_length(error_code) <= 60))',
    ['error_code'],
    'NULL unless validation failed; media_failed_has_code requires it for failed media.',
  ),
  'public.media.media_error_detail_check': optional(
    'CHECK ((char_length(error_detail) <= 500))',
    ['error_detail'],
    'NULL unless validation failed.',
  ),
  'public.media.media_failed_has_code': total(
    "CHECK (((status <> 'failed'::text) OR (error_code IS NOT NULL)))",
    ['error_code'],
    'status is NOT NULL and the other term is an IS NOT NULL test.',
  ),
  'public.media.media_height_check': optional(
    'CHECK ((height > 0))',
    ['height'],
    NOT_VALIDATED_YET,
  ),
  'public.media.media_mime_type_check': optional(
    "CHECK ((mime_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'video/mp4'::text])))",
    ['mime_type'],
    NOT_VALIDATED_YET,
  ),
  'public.media.media_name_length': optional(
    'CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))',
    ['name'],
    'NULL means no name was given: the original file name is shown.',
  ),
  'public.media.media_ready_is_complete': total(
    "CHECK (((status <> 'ready'::text) OR ((mime_type IS NOT NULL) AND (bytes IS NOT NULL) AND (bytes > 0) AND (sha256 IS NOT NULL) AND (width IS NOT NULL) AND (height IS NOT NULL) AND (storage_key IS NOT NULL) AND (error_code IS NULL) AND ((kind <> 'video'::text) OR ((duration_ms IS NOT NULL) AND (codec IS NOT NULL))))))",
    [
      'bytes',
      'codec',
      'duration_ms',
      'error_code',
      'height',
      'mime_type',
      'sha256',
      'storage_key',
      'width',
    ],
    'status and kind are NOT NULL; every other term is an IS NULL or IS NOT NULL test, and bytes > 0 stands behind bytes IS NOT NULL, which makes the conjunction false first (0008, CX-02).',
  ),
  'public.media.media_sha256_check': optional(
    "CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))",
    ['sha256'],
    NOT_VALIDATED_YET,
  ),
  'public.media.media_storage_key_in_own_org': total(
    "CHECK (((storage_key IS NULL) OR (storage_key ~ (('^'::text || (org_id)::text) || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))))",
    ['storage_key'],
    'NULL means nothing is stored yet and is accepted by name; org_id is NOT NULL, so the match runs on two values.',
  ),
  'public.media.media_thumb_storage_key_in_own_org': total(
    "CHECK (((thumb_storage_key IS NULL) OR (thumb_storage_key ~ (('^'::text || (org_id)::text) || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))))",
    ['thumb_storage_key'],
    'NULL means no thumbnail and is accepted by name; org_id is NOT NULL, so the match runs on two values.',
  ),
  'public.media.media_width_check': optional('CHECK ((width > 0))', ['width'], NOT_VALIDATED_YET),

  'public.member_invite.member_invite_email_length': optional(
    'CHECK (((char_length(email) >= 3) AND (char_length(email) <= 254)))',
    ['email'],
    INVITE_DETAILS,
  ),
  'public.member_invite.member_invite_email_shape': optional(
    "CHECK ((email ~~ '%_@_%'::text))",
    ['email'],
    INVITE_DETAILS,
  ),
  'public.member_invite.member_invite_fulfilled': total(
    "CHECK (((status = 'fulfilled'::text) = (fulfilled_membership_id IS NOT NULL)))",
    ['fulfilled_membership_id'],
    'status is NOT NULL and the other side is an IS NOT NULL test.',
  ),
  'public.member_invite.member_invite_name_length': optional(
    'CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))',
    ['name'],
    INVITE_DETAILS,
  ),
  'public.member_invite.member_invite_name_trimmed': optional(
    'CHECK ((name = btrim(name)))',
    ['name'],
    INVITE_DETAILS,
  ),
  'public.member_invite.member_invite_open': total(
    "CHECK ((((status = 'pending'::text) AND (name IS NOT NULL) AND (email IS NOT NULL) AND (closed_at IS NULL)) OR ((status <> 'pending'::text) AND (name IS NULL) AND (email IS NULL) AND (closed_at IS NOT NULL))))",
    ['closed_at', 'email', 'name'],
    'status is NOT NULL and every other term is an IS NULL or IS NOT NULL test (0013).',
  ),

  'public.membership.membership_display_name_length': optional(
    'CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)))',
    ['display_name'],
    NO_NAME_YET,
  ),
  'public.membership.membership_display_name_trimmed': optional(
    'CHECK ((display_name = btrim(display_name)))',
    ['display_name'],
    NO_NAME_YET,
  ),
  'public.membership.membership_not_removed_by_self': total(
    'CHECK ((removed_by IS DISTINCT FROM id))',
    ['removed_by'],
    'IS DISTINCT FROM is never NULL.',
  ),
  'public.membership.membership_removed_pair': total(
    'CHECK (((removed_by IS NULL) OR (removed_at IS NOT NULL)))',
    ['removed_at', 'removed_by'],
    NULL_TESTS_ONLY,
  ),

  'public.pairing_session.pairing_session_claim_fields': total(
    "CHECK (((status = ANY (ARRAY['expired'::text, 'locked'::text])) OR ((status = ANY (ARRAY['claimed'::text, 'completed'::text])) = ((org_id IS NOT NULL) AND (display_id IS NOT NULL) AND (claimed_at IS NOT NULL)))))",
    ['claimed_at', 'display_id', 'org_id'],
    'status is NOT NULL and every other term is an IS NOT NULL test.',
  ),
  'public.pairing_session.pairing_session_completed_fields': total(
    "CHECK (((status = 'completed'::text) = ((registration_id IS NOT NULL) AND (completed_at IS NOT NULL))))",
    ['completed_at', 'registration_id'],
    'status is NOT NULL and every other term is an IS NOT NULL test.',
  ),

  'public.player_registration.player_registration_revocation_pair': total(
    'CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL)))',
    ['revoked_at', 'revoked_reason'],
    'Compares two IS NULL tests, which are never NULL.',
  ),
  'public.player_registration.player_registration_revoked_reason_check': optional(
    "CHECK ((revoked_reason = ANY (ARRAY['operator'::text, 'replaced'::text, 'player_reset'::text])))",
    ['revoked_reason'],
    'NULL while the registration is active; player_registration_revocation_pair requires a reason once it is revoked.',
  ),

  'public.playlist.playlist_description_length': optional(
    'CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))',
    ['description'],
    NO_DESCRIPTION,
  ),

  'public.playlist_item.playlist_item_app_shape': total(
    'CHECK (((app_id IS NULL) OR ((duration_ms IS NOT NULL) AND (fit IS NULL))))',
    ['app_id', 'duration_ms', 'fit'],
    NULL_TESTS_ONLY,
  ),
  'public.playlist_item.playlist_item_duration_ms_check': optional(
    'CHECK (((duration_ms >= 1) AND (duration_ms <= 86400000)))',
    ['duration_ms'],
    'NULL for a video, which plays its own length; playlist_item_app_shape requires it for an app.',
  ),
  'public.playlist_item.playlist_item_fit_check': optional(
    "CHECK ((fit = ANY (ARRAY['contain'::text, 'cover'::text])))",
    ['fit'],
    "NULL means the display's default fit at publish time.",
  ),
  'public.playlist_item.playlist_item_one_source': total(
    'CHECK ((num_nonnulls(media_id, app_id) = 1))',
    ['app_id', 'media_id'],
    'num_nonnulls() is never NULL.',
  ),

  'public.schedule.schedule_description_length': optional(
    'CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))',
    ['description'],
    NO_DESCRIPTION,
  ),

  'public.session.session_id_token_check': optional(
    'CHECK ((char_length(id_token) <= 8192))',
    ['id_token'],
    'NULL when the identity provider sent none, and cleared when the session ends.',
  ),
};
