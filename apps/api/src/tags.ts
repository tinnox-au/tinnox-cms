/**
 * The tags of one media item or one display, written by the media and display routes
 * inside their own transaction. Outside routes/ because both route files share it
 * (decision D6); the tag routes themselves are in routes/tags.ts.
 */
import type { TagScope } from '@tinnox/contracts';
import { STAGE_A_CONSTRAINTS, violatedConstraint, type Tx } from '@tinnox/db';
import { bigintToNumber } from './db-helpers.ts';
import { notFound, pgErrorCode } from './errors.ts';

/** The join table of each scope. Fixed text: nothing here comes from a request. */
const TAG_JOIN = {
  media: { table: 'media_tag', target: 'media_id', tagForeignKey: STAGE_A_CONSTRAINTS.mediaTagTag },
  display: {
    table: 'display_tag',
    target: 'display_id',
    tagForeignKey: STAGE_A_CONSTRAINTS.displayTagTag,
  },
} as const satisfies Record<TagScope, unknown>;

/** True when the error says a tag put on something does not exist in this organisation and scope. */
export function isUnknownTag(error: unknown): boolean {
  if (pgErrorCode(error) !== '23503') return false;
  const constraint = violatedConstraint(error);
  return (
    constraint === TAG_JOIN.media.tagForeignKey || constraint === TAG_JOIN.display.tagForeignKey
  );
}

/**
 * Makes `tagIds` the complete set of tags of one media item or one display, in
 * the caller's transaction. The caller has locked the item. A tag that does not
 * exist in this organisation, or belongs to the other scope, answers 404, the
 * same as an id that was never issued.
 */
export async function replaceTags(
  tx: Tx,
  scope: TagScope,
  targetId: string,
  tagIds: readonly string[],
): Promise<void> {
  const join = TAG_JOIN[scope];
  if (tagIds.length > 0) {
    const known = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM tag
       WHERE org_id = app_org_id() AND scope = $1 AND id = ANY($2::uuid[])`,
      [scope, tagIds],
    );
    if (bigintToNumber(known.rows[0]?.n ?? 0) !== tagIds.length) throw notFound('The tag');
  }
  await tx.query(
    `DELETE FROM ${join.table}
     WHERE ${join.target} = $1 AND org_id = app_org_id() AND NOT (tag_id = ANY($2::uuid[]))`,
    [targetId, tagIds],
  );
  if (tagIds.length > 0) {
    await tx.query(
      `INSERT INTO ${join.table} (${join.target}, tag_id, org_id)
       SELECT $1, t.tag_id, app_org_id() FROM unnest($2::uuid[]) AS t(tag_id)
       ON CONFLICT DO NOTHING`,
      [targetId, tagIds],
    );
  }
}
