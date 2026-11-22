/**
 * The media row as the library reads it, its DTO, and the organisation's quota usage.
 * Shared by the media, playlist and dashboard routes and publishing, so it lives outside
 * routes/ (decision D6).
 */
import {
  ABSOLUTE,
  MediaErrorCodeSchema,
  MediaMimeTypeSchema,
  type MediaDto,
} from '@tinnox/contracts';
import type { Tx } from '@tinnox/db';
import { bigintToNumber, iso } from '../db-helpers.ts';

export interface MediaRow {
  id: string;
  kind: 'image' | 'video';
  status: 'processing' | 'ready' | 'failed';
  error_code: string | null;
  error_detail: string | null;
  mime_type: string | null;
  bytes: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  codec: string | null;
  storage_key: string | null;
  original_name: string;
  /** The operator's name for the item, or else the file name supplied at upload. */
  name: string;
  description: string | null;
  default_duration_ms: number | null;
  folder_id: string | null;
  available_from: string | null;
  available_until: string | null;
  tag_ids: string[];
  usage_count: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * The availability window as wall-clock text. The raw `timestamp` is never read:
 * node-postgres would turn it into a Date in the process time zone.
 */
export const MEDIA_WINDOW_COLUMNS = `to_char(m.available_from,'YYYY-MM-DD"T"HH24:MI') AS available_from, to_char(m.available_until,'YYYY-MM-DD"T"HH24:MI') AS available_until`;

/**
 * Select list for `media m` that yields a `MediaRow`. `usage_count` is the
 * number of live playlists that contain the item at least once.
 */
export const MEDIA_COLUMNS = `m.id, m.kind, m.status, m.error_code, m.error_detail, m.mime_type,
  m.bytes, m.sha256, m.width, m.height, m.duration_ms, m.codec, m.storage_key, m.original_name,
  COALESCE(m.name, m.original_name) AS name, m.description, m.default_duration_ms, m.folder_id,
  ${MEDIA_WINDOW_COLUMNS},
  ARRAY(SELECT mt.tag_id FROM media_tag mt
        WHERE mt.media_id = m.id AND mt.org_id = m.org_id
        ORDER BY mt.created_at, mt.tag_id)::text[] AS tag_ids,
  (SELECT count(DISTINCT i.playlist_id) FROM playlist_item i
   JOIN playlist p ON p.id = i.playlist_id AND p.org_id = i.org_id
   WHERE i.media_id = m.id AND i.org_id = m.org_id AND p.deleted_at IS NULL) AS usage_count,
  m.created_at, m.updated_at`;

export function toMediaDto(row: MediaRow): MediaDto {
  const mime = MediaMimeTypeSchema.safeParse(row.mime_type);
  const errorCode = MediaErrorCodeSchema.safeParse(row.error_code);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    name: row.name,
    originalName: row.original_name,
    description: row.description,
    defaultDurationMs: row.default_duration_ms,
    folderId: row.folder_id,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    tagIds: row.tag_ids.slice(0, ABSOLUTE.maxTagsPerItem),
    usageCount: bigintToNumber(row.usage_count),
    mimeType: mime.success ? mime.data : null,
    bytes: row.bytes === null ? null : bigintToNumber(row.bytes),
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    codec: row.codec,
    errorCode:
      row.status !== 'failed' ? null : errorCode.success ? errorCode.data : 'inspection_failed',
    errorDetail: row.status === 'failed' ? row.error_detail : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Bytes that count against the organisation's quota: everything queued or stored. */
export async function usedBytes(tx: Tx): Promise<number> {
  const { rows } = await tx.query<{ used: string }>(
    `SELECT coalesce(sum(bytes), 0)::bigint AS used FROM media
     WHERE org_id = app_org_id() AND status IN ('processing', 'ready')`,
  );
  return bigintToNumber(rows[0]?.used ?? '0');
}
