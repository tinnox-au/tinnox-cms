/**
 * The tags of one media item or one display, written by the media and display routes
 * inside their own transaction. Outside routes/ because both route files share it
 * (decision D6); the tag routes themselves are in routes/tags.ts.
 */
import type { TagScope } from '@tinnox/contracts';
import { sql, type OrgTx } from '@tinnox/db';
import type { ConstraintAnswers } from './auth/permissions.ts';
import { bigintToNumber } from './db-helpers.ts';
import { notFound } from './errors.ts';

/** The join table of each scope. Fixed text: nothing here comes from a request. */
const TAG_JOIN = {
  media: { table: sql`media_tag`, target: sql`media_id` },
  display: { table: sql`display_tag`, target: sql`display_id` },
} as const satisfies Record<TagScope, unknown>;

/**
 * For the constraints option of the change that calls replaceTags: a tag put on something that
 * no longer exists in this organisation and scope (it was deleted after the check below) answers
 * as an unknown tag. Both scopes' keys, as the one check both routes shared did before step 26.
 */
export const UNKNOWN_TAG = {
  media_tag_tag_fk: () => notFound('The tag'),
  display_tag_tag_fk: () => notFound('The tag'),
} as const satisfies ConstraintAnswers;

/**
 * Makes `tagIds` the complete set of tags of one media item or one display, in
 * the caller's transaction. The caller has locked the item. A tag that does not
 * exist in this organisation, or belongs to the other scope, answers 404, the
 * same as an id that was never issued.
 */
export async function replaceTags(
  tx: OrgTx,
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
