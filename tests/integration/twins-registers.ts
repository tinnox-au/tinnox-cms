/**
 * Registers of twins.test.ts (adoption plan section 4.4 and step 31, D7, U-13).
 *
 * A twin is a database CHECK and the contract rule that the API applies to the same value first.
 * The test compares the two by data: for generated input, the contract's parsed output against
 * whether an INSERT as tinnox_app succeeds.
 *
 * `TWIN_ALLOW_LIST` holds the mismatches that are kept, each with its reason. Only two kinds may
 * be kept (D7):
 * - cross-row: a rule over several rows (zone overlap, zone count). Rows are replaced as a set,
 *   so a database guard would need EXCLUDE and a deferred trigger; the code holds it (the
 *   planner, step 29, and property 5).
 * - database looser on character class: the database stores a character the contract refuses.
 * Is a newly found twin row-local or cross-row? Row-local (a rule on one row's own columns): fix
 * it with a new migration in the same pull request. Cross-row: add an entry here and a property
 * test. A mismatch the other way, where the contract accepts and the database refuses, is never
 * kept: the API would answer 500. Fix whichever side is wrong.
 *
 * `CHECK_TWINS` names every CHECK constraint of the schema, which the constraint registry rule of
 * packages/db/test/catalogue.integration.test.ts leaves out (step 25): either the pair of the test that compares
 * it, or why it has no pair. A new CHECK fails the test until someone decides which.
 */

export const TWIN_PAIRS = [
  'invite address',
  'alert address',
  'media window',
  'schedule events',
  'layout zones',
  'offline delay',
] as const;
export type TwinPair = (typeof TWIN_PAIRS)[number];

export interface AllowListEntry {
  readonly kind: 'cross-row' | 'database looser on character class';
  readonly pairs: readonly TwinPair[];
  readonly reason: string;
}

/**
 * Keyed by name; the test decides which entry explains a mismatch (twins.test.ts,
 * `allowedBy`) and prints the name.
 */
export const TWIN_ALLOW_LIST = {
  'whitespace only JavaScript calls whitespace': {
    kind: 'database looser on character class',
    pairs: ['invite address', 'alert address'],
    reason:
      "U+00A0, U+1680, U+2007, U+202F and U+FEFF are in JavaScript's \\s, which the contract refuses in an address, and not in PostgreSQL's [:space:] (musl's iswspace, PostgreSQL 17 on Alpine; probed 2026-11-25). U+0085 is the other way round, and the contract refuses it as a control character, so the database is never the stricter side.",
  },
  'control and text-direction characters': {
    kind: 'database looser on character class',
    pairs: ['invite address', 'alert address'],
    reason:
      'The contract refuses C0 and C1 control characters and the text-direction marks in every label an Owner or TINNOX staff read (SINGLE_LINE, NO_DIRECTION_CONTROLS); the address checks of the database name only whitespace. NUL never reaches a CHECK: PostgreSQL text cannot hold it (22021).',
  },
  'zone count below two': {
    kind: 'cross-row',
    pairs: ['layout zones'],
    reason:
      'Two to four zones is a rule over the rows of one layout. layout_zone_position_range bounds each row at position 3, so five never store; zero or one zone does, and the planner refuses it (zone_count_out_of_range, step 29, LYX-03).',
  },
  'overlapping zones': {
    kind: 'cross-row',
    pairs: ['layout zones'],
    reason:
      'Overlap is a rule between two rows of one layout, replaced as a set (0011); the planner refuses it (zone_overlap, step 29, LYX-03).',
  },
} as const satisfies Record<string, AllowListEntry>;
export type AllowListName = keyof typeof TWIN_ALLOW_LIST;

export type CheckTwin = { readonly pair: TwinPair } | { readonly reason: string };

const LABEL =
  'Twin of a label or description rule of packages/contracts (labelSchema, DescriptionInputSchema and the limits of ABSOLUTE), which the API parses before it writes. Not one of the pairs adoption plan section 4.4 names, so not compared here.';
const CLOSED_LIST =
  'Twin of a closed list of packages/contracts (roles, kinds, fits, rotations, transitions, colours, scopes, app types), which the API parses before it writes. Not one of the pairs adoption plan section 4.4 names, so not compared here.';
const BOUND =
  'Twin of a bound of packages/contracts (canvas, content rectangle, working hours, durations, app settings, time zone, the pairing client key, the idempotency key), which the API parses before it writes. Not one of the pairs adoption plan section 4.4 names, so not compared here.';
const SERVER_VALUE =
  'Holds what the server, the media worker or the identity provider produces (a hash, token, code, key, size, status, sequence number, position or manifest), never a request field that a contract parses; a violation is a bug in that code, a 500.';
const ROW_STATE =
  'Ties columns of one row together as the server writes them (a pair set together, a status and the fields it needs); no contract parses that combination.';
const AUDIT =
  'An audit_event field, written by the audit writer from the closed shapes of packages/contracts (AuditEventShapes), never from a request.';

/** Keyed by schema, table and constraint name, as packages/db/test/catalogue.integration.test.ts keys its registers. */
export const CHECK_TWINS: Readonly<Record<string, CheckTwin>> = {
  'public.alert_recipient.alert_recipient_confirmation': { reason: ROW_STATE },
  'public.alert_recipient.alert_recipient_email_length': { pair: 'alert address' },
  'public.alert_recipient.alert_recipient_email_shape': { pair: 'alert address' },
  'public.alert_recipient.alert_recipient_token_length': { reason: SERVER_VALUE },

  'public.app.app_description_length': { reason: LABEL },
  'public.app.app_name_length': { reason: LABEL },
  'public.app.app_name_trimmed': { reason: LABEL },
  'public.app.app_settings_shape': { reason: BOUND },
  'public.app.app_type_known': { reason: CLOSED_LIST },

  'public.audit_event.audit_event_action_check': { reason: AUDIT },
  'public.audit_event.audit_event_actor_id_check': { reason: AUDIT },
  'public.audit_event.audit_event_actor_type_check': { reason: AUDIT },
  'public.audit_event.audit_event_detail_check': { reason: AUDIT },
  'public.audit_event.audit_event_object_id_check': { reason: AUDIT },
  'public.audit_event.audit_event_object_type_check': { reason: AUDIT },
  'public.audit_event.audit_event_result_check': { reason: AUDIT },

  'public.display.display_alert_offline_minutes_range': { pair: 'offline delay' },
  'public.display.display_canvas_height_check': { reason: BOUND },
  'public.display.display_canvas_width_check': { reason: BOUND },
  'public.display.display_content_rect_all_or_none': { reason: ROW_STATE },
  'public.display.display_content_rect_in_canvas': { reason: BOUND },
  'public.display.display_default_fit_check': { reason: CLOSED_LIST },
  'public.display.display_description_length': { reason: LABEL },
  'public.display.display_name_check': { reason: LABEL },
  'public.display.display_one_assignment': { reason: ROW_STATE },
  'public.display.display_rotation_known': { reason: CLOSED_LIST },
  'public.display.display_route_check': { reason: CLOSED_LIST },
  'public.display.display_working_hours_shape': { reason: BOUND },

  // heartbeat body activeItemIndex (nonnegative, max playlist items)
  'public.display_delivery.display_delivery_active_item_index_check': { reason: BOUND },
  'public.display_delivery.display_delivery_active_pair': { reason: ROW_STATE },
  // heartbeat body errors (array, max heartbeat errors)
  'public.display_delivery.display_delivery_last_errors_check': { reason: BOUND },
  'public.display_delivery.display_delivery_last_seq_check': { reason: SERVER_VALUE },
  // heartbeat body playerState (PlayerStateSchema)
  'public.display_delivery.display_delivery_player_state_check': { reason: CLOSED_LIST },
  'public.display_delivery.display_delivery_staging_check': { reason: SERVER_VALUE },
  'public.display_tag.display_tag_scope_fixed': { reason: SERVER_VALUE },

  'public.folder.folder_name_length': { reason: LABEL },
  'public.folder.folder_name_trimmed': { reason: LABEL },

  // heartbeat body size
  'public.heartbeat_log.heartbeat_log_payload_check': { reason: BOUND },
  'public.heartbeat_log.heartbeat_log_seq_check': { reason: SERVER_VALUE },

  'public.layout.layout_description_length': { reason: LABEL },
  'public.layout.layout_name_length': { reason: LABEL },
  'public.layout.layout_name_trimmed': { reason: LABEL },
  'public.layout_zone.layout_zone_in_bounds': { pair: 'layout zones' },
  'public.layout_zone.layout_zone_position_range': { pair: 'layout zones' },

  'public.login_state.login_state_code_verifier_check': { reason: SERVER_VALUE },
  'public.login_state.login_state_nonce_check': { reason: SERVER_VALUE },
  // returnTo query, .max(200)
  'public.login_state.login_state_return_to_check': { reason: BOUND },
  'public.login_state.login_state_state_hash_check': { reason: SERVER_VALUE },

  'public.media.media_availability_order': { pair: 'media window' },
  'public.media.media_availability_year': { pair: 'media window' },
  'public.media.media_bytes_check': { reason: SERVER_VALUE },
  'public.media.media_codec_check': { reason: SERVER_VALUE },
  'public.media.media_default_duration_images_only': { reason: ROW_STATE },
  'public.media.media_default_duration_range': { reason: BOUND },
  'public.media.media_description_length': { reason: LABEL },
  'public.media.media_duration_ms_check': { reason: SERVER_VALUE },
  'public.media.media_error_code_check': { reason: SERVER_VALUE },
  'public.media.media_error_detail_check': { reason: SERVER_VALUE },
  'public.media.media_failed_has_code': { reason: ROW_STATE },
  'public.media.media_height_check': { reason: SERVER_VALUE },
  'public.media.media_kind_check': { reason: SERVER_VALUE },
  'public.media.media_mime_type_check': { reason: SERVER_VALUE },
  'public.media.media_name_length': { reason: LABEL },
  // upload file name, 1 to 255 characters
  'public.media.media_original_name_check': { reason: BOUND },
  'public.media.media_ready_is_complete': { reason: ROW_STATE },
  'public.media.media_sha256_check': { reason: SERVER_VALUE },
  'public.media.media_status_check': { reason: SERVER_VALUE },
  'public.media.media_storage_key_in_own_org': { reason: SERVER_VALUE },
  'public.media.media_thumb_storage_key_in_own_org': { reason: SERVER_VALUE },
  'public.media.media_width_check': { reason: SERVER_VALUE },
  'public.media_tag.media_tag_scope_fixed': { reason: SERVER_VALUE },

  'public.member_invite.member_invite_email_length': { pair: 'invite address' },
  'public.member_invite.member_invite_email_shape': { pair: 'invite address' },
  'public.member_invite.member_invite_fulfilled': { reason: ROW_STATE },
  'public.member_invite.member_invite_name_length': { reason: LABEL },
  'public.member_invite.member_invite_name_trimmed': { reason: LABEL },
  'public.member_invite.member_invite_open': { reason: ROW_STATE },
  'public.member_invite.member_invite_role_known': { reason: CLOSED_LIST },
  'public.member_invite.member_invite_status_known': { reason: SERVER_VALUE },

  'public.membership.membership_display_name_length': { reason: LABEL },
  'public.membership.membership_display_name_trimmed': { reason: LABEL },
  'public.membership.membership_not_removed_by_self': { reason: ROW_STATE },
  'public.membership.membership_oidc_sub_check': { reason: SERVER_VALUE },
  'public.membership.membership_removed_pair': { reason: ROW_STATE },
  'public.membership.membership_role_known': { reason: CLOSED_LIST },

  'public.organization.organization_name_check': { reason: LABEL },

  'public.pairing_session.pairing_session_claim_fields': { reason: ROW_STATE },
  'public.pairing_session.pairing_session_client_key_check': { reason: BOUND },
  'public.pairing_session.pairing_session_code_check': { reason: SERVER_VALUE },
  'public.pairing_session.pairing_session_completed_fields': { reason: ROW_STATE },
  'public.pairing_session.pairing_session_failed_attempts_check': { reason: SERVER_VALUE },
  'public.pairing_session.pairing_session_polling_token_hash_check': { reason: SERVER_VALUE },
  'public.pairing_session.pairing_session_status_check': { reason: SERVER_VALUE },

  'public.player_registration.player_registration_revocation_pair': { reason: ROW_STATE },
  'public.player_registration.player_registration_revoked_reason_check': { reason: SERVER_VALUE },
  'public.player_registration.player_registration_token_hash_check': { reason: SERVER_VALUE },

  'public.playlist.playlist_description_length': { reason: LABEL },
  'public.playlist.playlist_name_check': { reason: LABEL },
  'public.playlist.playlist_transition_known': { reason: CLOSED_LIST },
  'public.playlist_item.playlist_item_app_shape': { reason: ROW_STATE },
  'public.playlist_item.playlist_item_duration_ms_check': { reason: BOUND },
  'public.playlist_item.playlist_item_fit_check': { reason: CLOSED_LIST },
  'public.playlist_item.playlist_item_one_source': { reason: ROW_STATE },
  'public.playlist_item.playlist_item_position_check': { reason: SERVER_VALUE },

  'public.publication.publication_idempotency_key_check': { reason: BOUND },
  'public.publication.publication_manifest_shape': { reason: SERVER_VALUE },
  'public.publication_asset.publication_asset_position_check': { reason: SERVER_VALUE },

  'public.schedule.schedule_description_length': { reason: LABEL },
  'public.schedule.schedule_name_length': { reason: LABEL },
  'public.schedule.schedule_name_trimmed': { reason: LABEL },
  'public.schedule_event.schedule_event_days_shape': { pair: 'schedule events' },
  'public.schedule_event.schedule_event_end_format': { pair: 'schedule events' },
  'public.schedule_event.schedule_event_not_empty': { pair: 'schedule events' },
  'public.schedule_event.schedule_event_position_range': { pair: 'schedule events' },
  'public.schedule_event.schedule_event_start_format': { pair: 'schedule events' },

  'public.session.session_csrf_token_check': { reason: SERVER_VALUE },
  'public.session.session_id_hash_check': { reason: SERVER_VALUE },
  'public.session.session_id_token_check': { reason: SERVER_VALUE },

  'public.site.site_name_check': { reason: LABEL },
  'public.site.site_timezone_check': { reason: BOUND },

  'public.tag.tag_colour_known': { reason: CLOSED_LIST },
  'public.tag.tag_name_length': { reason: LABEL },
  'public.tag.tag_name_trimmed': { reason: LABEL },
  'public.tag.tag_scope_known': { reason: CLOSED_LIST },
};
