// What ends a screen's player and what deletes a screen: the statements of
// POST /api/displays/:id/revoke-player and DELETE /api/displays/:id, in their lock order, kept in
// one place so the two routes cannot drift apart and the race tests run the code the routes run
// (SDC-07). Both take an OrgTx: row-level security limits every statement to the organisation.

import { pairingCancelClaims } from './sec.ts';
import type { OrgTx } from './tx.ts';

/** What ending a screen's player changed. */
export interface RevokedPlayer {
  /** The pairing sessions claimed for the screen that no player had collected, now cancelled. */
  readonly cancelledPairingIds: readonly string[];
  /** The registration revoked, or null when no player held an active one. */
  readonly revokedRegistrationId: string | null;
}

/**
 * Ends the player of a live screen of the organisation. First the screen's claims that no player
 * has collected are cancelled, under the display's pairing lock and before the display row is
 * locked (round 3, SCX-01): a claim or a collection holds that lock or a pairing row and then
 * needs the display row, so the other order can deadlock, and a claim cancelled first cannot
 * bring a player back after the revocation. Then the live row is locked FOR UPDATE until the
 * transaction ends, and the active registration is revoked with reason `operator`, so the player
 * answers to `device_revoked` on its next request.
 *
 * Null, with nothing changed, when the id is not a live screen of this organisation (unknown,
 * another organisation's, or deleted): the caller answers 404. sec.pairing_cancel_claims touches
 * only this organisation's claims, and a deleted screen has none left.
 */
export async function revokeDisplayPlayer(
  tx: OrgTx,
  displayId: string,
): Promise<RevokedPlayer | null> {
  const cancelledPairingIds = await pairingCancelClaims(tx, displayId);
  const live = await tx.query(
    `SELECT 1 FROM display
     WHERE id = $1 AND org_id = app_org_id() AND deleted_at IS NULL FOR UPDATE`,
    [displayId],
  );
  if (live.rowCount !== 1) return null;
  const revoked = await tx.query<{ id: string }>(
    `UPDATE player_registration
     SET revoked_at = now(), revoked_reason = 'operator'
     WHERE display_id = $1 AND org_id = app_org_id() AND revoked_at IS NULL
     RETURNING id`,
    [displayId],
  );
  return { cancelledPairingIds, revokedRegistrationId: revoked.rows[0]?.id ?? null };
}

/** What deleting a screen changed. */
export interface DeletedDisplay extends RevokedPlayer {
  /** The tags taken off it. */
  readonly tagCount: number;
}

/**
 * Deletes a live screen of the organisation (CMS-41). Its player is ended first, as
 * `revokeDisplayPlayer` does, in the same lock order. Then its tags are taken off, and the row is
 * kept with `deleted_at`, since its publications are immutable and refer to it, with its
 * assignments cleared, so tag counts and playlist, schedule and layout deletes no longer see it
 * (display_deleted_guard makes that final). Null, with nothing changed, when the id is not a live
 * screen of this organisation.
 */
export async function softDeleteDisplay(
  tx: OrgTx,
  displayId: string,
): Promise<DeletedDisplay | null> {
  const ended = await revokeDisplayPlayer(tx, displayId);
  if (ended === null) return null;
  const tags = await tx.query(
    'DELETE FROM display_tag WHERE display_id = $1 AND org_id = app_org_id()',
    [displayId],
  );
  await tx.query(
    `UPDATE display
     SET deleted_at = now(), assigned_playlist_id = NULL, assigned_schedule_id = NULL,
         assigned_layout_id = NULL
     WHERE id = $1 AND org_id = app_org_id()`,
    [displayId],
  );
  return { ...ended, tagCount: tags.rowCount ?? 0 };
}
