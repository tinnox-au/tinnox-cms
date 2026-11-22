/**
 * The app row as the app and playlist routes read it, and its DTO. Outside routes/ because
 * both route files share it (decision D6).
 */
import { AppContentSchema, type AppDto } from '@tinnox/contracts';
import { bigintToNumber, iso } from './db-helpers.ts';

export interface AppRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  settings: unknown;
  created_at: Date;
  updated_at: Date;
  usage_count: string;
}

/** Select list for `app a`; the usage count is the number of live playlists containing it. */
export const APP_COLUMNS = `a.id, a.type, a.name, a.description, a.settings, a.created_at, a.updated_at,
  (SELECT count(DISTINCT i.playlist_id) FROM playlist_item i
   JOIN playlist p ON p.id = i.playlist_id AND p.org_id = i.org_id
   WHERE i.app_id = a.id AND i.org_id = a.org_id AND p.deleted_at IS NULL) AS usage_count`;

/** Stored settings were validated on write, so a failure here is a server fault and throws. */
export function toAppDto(row: AppRow): AppDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: AppContentSchema.parse({ type: row.type, settings: row.settings }),
    usageCount: bigintToNumber(row.usage_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
