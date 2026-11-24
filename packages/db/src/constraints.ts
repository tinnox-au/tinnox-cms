import { errorField } from './error-field.ts';

/** The SQLSTATE PostgreSQL reports a violation of each kind of named constraint with. */
export type ConstraintSqlstate =
  | '23001' // restrict_violation: a guard trigger's RAISE ... USING CONSTRAINT
  | '23503' // foreign_key_violation
  | '23505' // unique_violation: a unique constraint, a primary key or a unique index
  | '23514' // check_violation
  | '23P01'; // exclusion_violation

export interface ConstraintEntry {
  readonly sqlstate: ConstraintSqlstate;
  /** The table whose constraint, index or guard trigger it is, with its schema. */
  readonly table: string;
  /** What a caller may take the violation to mean, in the words of an answer. */
  readonly means: string;
}

/**
 * The registry (adoption plan section 2.3, step 25, U-9): every constraint, unique index and
 * guard-trigger name that product code may map to an answer, keyed by the name PostgreSQL
 * reports in the `constraint` field of the error. classifyDbError (./outcome.ts) reports a
 * violation as `constraint` only for a name here raised with its SQLSTATE; any other is
 * `unmapped_constraint`, which stays a 500.
 *
 * packages/db/test/catalogue.integration.test.ts compares it with the migrated schema: every
 * name here exists on its table with its SQLSTATE, and every foreign key, unique or primary key,
 * exclusion constraint, unique index and named guard of the schema is either here or in
 * packages/db/test/catalogue/never-mapped.ts with the reason no caller maps it. A new
 * constraint therefore fails that test until someone decides which.
 */
export const CONSTRAINTS = {
  display_assigned_layout_fk: {
    sqlstate: '23503',
    table: 'public.display',
    means:
      'On a display, the layout does not exist in this organisation; on a layout, a delete was attempted while a display has it assigned.',
  },
  display_assigned_playlist_fk: {
    sqlstate: '23503',
    table: 'public.display',
    means:
      'On a display, the playlist does not exist in this organisation; on a playlist, a hard delete was attempted while a display has it assigned.',
  },
  display_assigned_playlist_guard: {
    sqlstate: '23001',
    table: 'public.display',
    means: 'The playlist being assigned to a display is deleted.',
  },
  display_assigned_schedule_fk: {
    sqlstate: '23503',
    table: 'public.display',
    means:
      'On a display, the schedule does not exist in this organisation; on a schedule, a delete was attempted while a display has it assigned.',
  },
  display_tag_display_fk: {
    sqlstate: '23503',
    table: 'public.display_tag',
    means: 'The display being tagged does not exist in this organisation.',
  },
  display_tag_tag_fk: {
    sqlstate: '23503',
    table: 'public.display_tag',
    means: 'The tag does not exist in this organisation, or is not a display tag.',
  },
  folder_org_name_key: {
    sqlstate: '23505',
    table: 'public.folder',
    means: 'Another folder of the organisation has this name, ignoring case.',
  },
  layout_zone_playlist_fk: {
    sqlstate: '23503',
    table: 'public.layout_zone',
    means: "A zone's playlist does not exist in this organisation.",
  },
  layout_zone_playlist_guard: {
    sqlstate: '23001',
    table: 'public.layout_zone',
    means: 'A zone names a deleted playlist.',
  },
  media_default_duration_images_only: {
    sqlstate: '23514',
    table: 'public.media',
    means: 'A default duration was set on a media item that is not an image.',
  },
  media_folder_fk: {
    sqlstate: '23503',
    table: 'public.media',
    means: 'The folder does not exist in this organisation.',
  },
  media_tag_media_fk: {
    sqlstate: '23503',
    table: 'public.media_tag',
    means: 'The media item being tagged does not exist in this organisation.',
  },
  media_tag_tag_fk: {
    sqlstate: '23503',
    table: 'public.media_tag',
    means: 'The tag does not exist in this organisation, or is not a media tag.',
  },
  member_invite_guard: {
    sqlstate: '23001',
    table: 'public.member_invite',
    means:
      'An invite change the guard refuses: the invite is closed, its request changed, or the status is not one the role may set.',
  },
  member_invite_pending_email_key: {
    sqlstate: '23505',
    table: 'public.member_invite',
    means: 'A pending invite of the organisation has this e-mail address, ignoring case.',
  },
  member_invite_pending_name_key: {
    sqlstate: '23505',
    table: 'public.member_invite',
    means: 'A pending invite of the organisation has this name, ignoring case.',
  },
  membership_last_owner: {
    sqlstate: '23001',
    table: 'public.membership',
    means: 'The change would leave the organisation without an active Owner.',
  },
  membership_oidc_sub_key: {
    sqlstate: '23505',
    table: 'public.membership',
    means:
      'The account already has a membership, removed or not: one organisation per person (scripts/lib/provision.ts).',
  },
  membership_org_display_name_key: {
    sqlstate: '23505',
    table: 'public.membership',
    means: 'Another member of the organisation has, or had, this name, ignoring case.',
  },
  membership_removed_final: {
    sqlstate: '23001',
    table: 'public.membership',
    means:
      "A removed member's removal or role was changed; only TINNOX's scripts reactivate a member.",
  },
  playlist_delete_guard: {
    sqlstate: '23001',
    table: 'public.playlist',
    means: 'The playlist being deleted is assigned to a display or used by a schedule or a layout.',
  },
  playlist_item_app_fk: {
    sqlstate: '23503',
    table: 'public.playlist_item',
    means:
      'On a playlist item, the app does not exist in this organisation; on an app, a delete was attempted while a playlist uses it.',
  },
  playlist_item_media_id_org_id_fkey: {
    sqlstate: '23503',
    table: 'public.playlist_item',
    means:
      'On a playlist item, the media item does not exist in this organisation; on a media item, a delete was attempted while a playlist uses it.',
  },
  publication_asset_media_id_org_id_fkey: {
    sqlstate: '23503',
    table: 'public.publication_asset',
    means:
      'On a publication, a media item it holds no longer exists; on a media item, a delete was attempted while a publication holds it.',
  },
  publication_idempotency: {
    sqlstate: '23505',
    table: 'public.publication',
    means:
      'A publication for this display with this Idempotency-Key exists: a concurrent request with the same key won.',
  },
  schedule_default_playlist_fk: {
    sqlstate: '23503',
    table: 'public.schedule',
    means: "The schedule's default playlist does not exist in this organisation.",
  },
  schedule_default_playlist_guard: {
    sqlstate: '23001',
    table: 'public.schedule',
    means: "The schedule's default playlist is deleted.",
  },
  schedule_event_playlist_fk: {
    sqlstate: '23503',
    table: 'public.schedule_event',
    means: "An event's playlist does not exist in this organisation.",
  },
  schedule_event_playlist_guard: {
    sqlstate: '23001',
    table: 'public.schedule_event',
    means: "An event's playlist is deleted.",
  },
  tag_org_scope_name_key: {
    sqlstate: '23505',
    table: 'public.tag',
    means: 'Another tag of the same organisation and scope has this name, ignoring case.',
  },
} as const satisfies Readonly<Record<string, ConstraintEntry>>;

/**
 * A name of the registry: a closed union, so a caller that maps a constraint to an answer can
 * name only a registered one, and a typo does not compile.
 */
export type ConstraintName = keyof typeof CONSTRAINTS;

/** True when `name` is in the registry. */
export function isConstraintName(name: string): name is ConstraintName {
  return Object.hasOwn(CONSTRAINTS, name);
}

/**
 * Names of the constraints, unique indexes and guard triggers of
 * db/migrations/0005_portal_v2_stage_a.sql that a caller has to tell apart to
 * answer correctly (a taken name is a conflict; an unknown folder is not found).
 * PostgreSQL reports the name in the `constraint` field of the error. Each is a name of the
 * registry above, which says what it means.
 */
export const STAGE_A_CONSTRAINTS = Object.freeze({
  /** 23505: another tag of the same organisation and scope has this name, ignoring case. */
  tagNameTaken: 'tag_org_scope_name_key',
  /** 23505: another folder of the same organisation has this name, ignoring case. */
  folderNameTaken: 'folder_org_name_key',
  /** 23503: the folder does not exist in this organisation. */
  mediaFolder: 'media_folder_fk',
  /** 23503: the media item does not exist in this organisation. */
  mediaTagMedia: 'media_tag_media_fk',
  /** 23503: the tag does not exist in this organisation, or is not a media tag. */
  mediaTagTag: 'media_tag_tag_fk',
  /** 23503: the display does not exist in this organisation. */
  displayTagDisplay: 'display_tag_display_fk',
  /** 23503: the tag does not exist in this organisation, or is not a display tag. */
  displayTagTag: 'display_tag_tag_fk',
  /**
   * 23503: on a display, the playlist does not exist in this organisation; on a
   * playlist, a hard delete was attempted while a display has it assigned.
   */
  displayAssignedPlaylist: 'display_assigned_playlist_fk',
  /** 23001: the playlist being assigned to a display is deleted. */
  assignedPlaylistDeleted: 'display_assigned_playlist_guard',
  /** 23001: the playlist being deleted is assigned to a display. */
  playlistStillAssigned: 'playlist_delete_guard',
  /** 23514: a default duration was set on a media item that is not an image. */
  defaultDurationImagesOnly: 'media_default_duration_images_only',
}) satisfies Readonly<Record<string, ConstraintName>>;

export type StageAConstraint = (typeof STAGE_A_CONSTRAINTS)[keyof typeof STAGE_A_CONSTRAINTS];

/**
 * The names of db/migrations/0009_stage_b_schedules.sql and 0011_stage_b_layouts.sql
 * that a caller has to tell apart. Deleted playlists keep their stage A names:
 * `playlist_delete_guard` now also refuses while a schedule or a layout uses the playlist.
 */
export const STAGE_B_CONSTRAINTS = Object.freeze({
  /**
   * 23503: on a display, the schedule does not exist in this organisation; on a
   * schedule, a delete was attempted while a display has it assigned.
   */
  displayAssignedSchedule: 'display_assigned_schedule_fk',
  /**
   * 23503: on a display, the layout does not exist in this organisation; on a layout, a
   * delete was attempted while a display has it assigned.
   */
  displayAssignedLayout: 'display_assigned_layout_fk',
}) satisfies Readonly<Record<string, ConstraintName>>;

/** The names of db/migrations/0013_roles_and_members.sql that a caller has to tell apart. */
export const STAGE_C_CONSTRAINTS = Object.freeze({
  /** 23001: the change would leave the organisation without an active Owner. */
  lastOwner: 'membership_last_owner',
  /** 23001: a removed member's removal or role was changed (only TINNOX's scripts reactivate). */
  removedFinal: 'membership_removed_final',
  /** 23505: another member of the organisation has, or had, this name, ignoring case. */
  memberNameTaken: 'membership_org_display_name_key',
  /** 23505: a pending invite of the organisation has this e-mail address, ignoring case. */
  inviteEmailTaken: 'member_invite_pending_email_key',
  /** 23505: a pending invite of the organisation has this name, ignoring case. */
  inviteNameTaken: 'member_invite_pending_name_key',
  /** 23001: an invite change the guard refuses (closed, request changed, wrong status for the role). */
  inviteGuard: 'member_invite_guard',
}) satisfies Readonly<Record<string, ConstraintName>>;

/** The constraint a PostgreSQL error names, or null when it names none. */
export function violatedConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const constraint = errorField(error, 'constraint');
  return typeof constraint === 'string' && constraint !== '' ? constraint : null;
}
