/**
 * A display's content rectangle and its delivery state: what was published to it and what
 * its player last reported. Shared by the display routes, the player routes, the dashboard
 * and publishing, so it lives outside routes/ (decision D6).
 */
import {
  ABSOLUTE,
  PlayerErrorSchema,
  PlayerStateSchema,
  StagingPhaseSchema,
  type DeliveryStatusView,
  type Rect,
} from '@tinnox/contracts';
import type { OrgReadTx } from '@tinnox/db';
import { buildDeliveryStatusView, type ReportedState } from '@tinnox/domain';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { bigintToNumber, iso, isoOrNull } from './db-helpers.ts';

export function contentRectOf(row: {
  content_x: number | null;
  content_y: number | null;
  content_width: number | null;
  content_height: number | null;
}): Rect | null {
  if (
    row.content_x === null ||
    row.content_y === null ||
    row.content_width === null ||
    row.content_height === null
  ) {
    return null;
  }
  return {
    x: row.content_x,
    y: row.content_y,
    width: row.content_width,
    height: row.content_height,
  };
}

const StoredStagingSchema = z
  .object({
    publicationId: z.uuid(),
    phase: StagingPhaseSchema,
    assetsDone: z.number().int().nonnegative(),
    assetsTotal: z.number().int().nonnegative(),
  })
  .strict();

interface DeliveryRow {
  desired_publication_id: string | null;
  desired_at: Date | null;
  reporting_registration_id: string | null;
  last_seq: string | null;
  downloaded_publication_id: string | null;
  active_publication_id: string | null;
  active_item_index: number | null;
  player_state: string | null;
  staging: unknown;
  last_errors: unknown;
  last_heartbeat_at: Date | null;
}

export const DELIVERY_COLUMNS = `desired_publication_id, desired_at, reporting_registration_id, last_seq,
  downloaded_publication_id, active_publication_id, active_item_index, player_state, staging,
  last_errors, last_heartbeat_at`;

/** Maps a display_delivery row onto the domain's ReportedState, re-validating stored JSON. */
export function reportedStateOf(row: DeliveryRow | undefined): ReportedState {
  if (row === undefined) {
    return {
      registrationId: null,
      lastSeq: null,
      downloadedPublicationId: null,
      activePublicationId: null,
      activeItemIndex: null,
      playerState: null,
      staging: null,
      errors: [],
      lastHeartbeatAt: null,
    };
  }
  const staging = StoredStagingSchema.safeParse(row.staging);
  const errors = z.array(PlayerErrorSchema).safeParse(row.last_errors);
  const state = PlayerStateSchema.safeParse(row.player_state);
  return {
    registrationId: row.reporting_registration_id,
    lastSeq: row.last_seq === null ? null : bigintToNumber(row.last_seq),
    downloadedPublicationId: row.downloaded_publication_id,
    activePublicationId: row.active_publication_id,
    activeItemIndex: row.active_item_index,
    playerState: state.success ? state.data : null,
    staging: staging.success ? staging.data : null,
    errors: errors.success ? errors.data : [],
    lastHeartbeatAt: isoOrNull(row.last_heartbeat_at),
  };
}

export type { DeliveryRow };

type StatusRow = DeliveryRow & { display_id: string; registration_id: string | null };

/**
 * The delivery status view of one display (`displayId`) or of every display of
 * the organisation (null), in the order of the display list. One query either
 * way; a display that never had a publication or a report simply has no
 * delivery columns. At most `ABSOLUTE.maxListItems` displays are returned.
 */
export async function loadStatusViews(
  tx: OrgReadTx,
  ctx: AppContext,
  displayId: string | null,
): Promise<DeliveryStatusView[]> {
  const { rows } = await tx.query<StatusRow>(
    `SELECT d.id AS display_id, pr.id AS registration_id,
            dd.desired_publication_id, dd.desired_at, dd.reporting_registration_id, dd.last_seq,
            dd.downloaded_publication_id, dd.active_publication_id, dd.active_item_index,
            dd.player_state, dd.staging, dd.last_errors, dd.last_heartbeat_at
     FROM display d
     LEFT JOIN player_registration pr
       ON pr.display_id = d.id AND pr.org_id = d.org_id AND pr.revoked_at IS NULL
     LEFT JOIN display_delivery dd ON dd.display_id = d.id AND dd.org_id = d.org_id
     WHERE d.org_id = app_org_id() AND d.deleted_at IS NULL
       AND ($1::uuid IS NULL OR d.id = $1::uuid)
     ORDER BY d.created_at, d.id
     LIMIT $2`,
    [displayId, ABSOLUTE.maxListItems],
  );
  const now = ctx.now();
  return rows.map((row) =>
    buildDeliveryStatusView({
      displayId: row.display_id,
      activeRegistrationId: row.registration_id,
      desired:
        row.desired_publication_id === null || row.desired_at === null
          ? null
          : { publicationId: row.desired_publication_id, publishedAt: iso(row.desired_at) },
      reported: reportedStateOf(row),
      now,
      staleAfterSeconds: ctx.config.limits.heartbeatStaleAfterSeconds,
    }),
  );
}
