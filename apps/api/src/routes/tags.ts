/**
 * Tags for media and for displays (portal v2, stage A). A tag belongs to one
 * scope for life; the database refuses a display tag on media and the reverse.
 * Media tags are content (content.write, content.delete); screen tags are screen set-up
 * (screen.setup). A new tag needs its scope's key; a change or deletion needs the content key and
 * screen.setup together, which the role guard decides before the handler runs (ROUTE_PERMISSIONS,
 * adoption plan D20), so no handler here refuses by role.
 */
import {
  ABSOLUTE,
  IdParamSchema,
  ROUTES,
  TagColourSchema,
  TagCreateSchema,
  TagListQuerySchema,
  TagPatchSchema,
  TagScopeSchema,
  type TagDto,
  type TagListResponse,
} from '@tinnox/contracts';
import { readOrg, withCountedLimit, type OrgReadTx } from '@tinnox/db';
import type { FastifyInstance } from 'fastify';
import { changeAsOperator, type ConstraintAnswers } from '../auth/permissions.ts';
import { operatorOf } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { bigintToNumber } from '../db-helpers.ts';
import { found, HttpError, notFound, parseInput } from '../errors.ts';

interface TagRow {
  id: string;
  scope: string;
  name: string;
  colour: string;
  usage_count: string;
}

/**
 * Select list for `tag t`. A media tag counts the media items that carry it and
 * are not deleted; a display tag counts the displays that carry it.
 */
const TAG_COLUMNS = `t.id, t.scope, t.name, t.colour,
  CASE t.scope
    WHEN 'media' THEN (
      SELECT count(*) FROM media_tag mt
      JOIN media m ON m.id = mt.media_id AND m.org_id = mt.org_id
      WHERE mt.tag_id = t.id AND mt.org_id = t.org_id AND m.deleted_at IS NULL)
    ELSE (
      SELECT count(*) FROM display_tag dt
      WHERE dt.tag_id = t.id AND dt.org_id = t.org_id)
  END AS usage_count`;

function toTagDto(row: TagRow): TagDto {
  return {
    id: row.id,
    scope: TagScopeSchema.parse(row.scope),
    name: row.name,
    colour: TagColourSchema.parse(row.colour),
    usageCount: bigintToNumber(row.usage_count),
  };
}

async function loadTag(tx: OrgReadTx, id: string): Promise<TagDto | null> {
  const { rows } = await tx.query<TagRow>(
    `SELECT ${TAG_COLUMNS} FROM tag t WHERE t.id = $1 AND t.org_id = app_org_id()`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : toTagDto(row);
}

const nameTaken = (): HttpError =>
  new HttpError('conflict', 'Another tag of this kind already has that name.');

/** Another tag of the organisation and scope has the name, ignoring case: its unique key refuses. */
const NAME_TAKEN = { tag_org_scope_name_key: nameTaken } as const satisfies ConstraintAnswers;

export function registerTagRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get(ROUTES.tags, async (request): Promise<TagListResponse> => {
    const session = operatorOf(request);
    const query = parseInput(TagListQuerySchema, request.query, 'query');
    return readOrg(db, session.orgId, async (tx) => {
      const { rows } = await tx.query<TagRow>(
        `SELECT ${TAG_COLUMNS} FROM tag t
         WHERE t.org_id = app_org_id() AND ($1::text IS NULL OR t.scope = $1)
         ORDER BY t.scope, lower(t.name), t.id
         LIMIT $2`,
        [query.scope ?? null, ABSOLUTE.maxListItems],
      );
      return { items: rows.map(toTagDto) };
    });
  });

  app.post(ROUTES.tags, async (request, reply): Promise<TagDto> => {
    const session = operatorOf(request);
    const input = parseInput(TagCreateSchema, request.body, 'tag');
    const created = await changeAsOperator(
      ctx,
      request,
      async (tx) => {
        // One at a time per organisation, so the ceiling cannot be passed by a burst.
        const id = await withCountedLimit(
          tx,
          {
            lock: 'tag_count',
            count: async (counting) => {
              const existing = await counting.query<{ n: string }>(
                'SELECT count(*) AS n FROM tag WHERE org_id = app_org_id()',
              );
              return bigintToNumber(existing.rows[0]?.n ?? 0);
            },
            max: ABSOLUTE.maxListItems,
            whenFull: () => {
              throw new HttpError(
                'conflict',
                `The organisation already has ${ABSOLUTE.maxListItems} tags, which is the most it can have. Delete tags that are no longer used.`,
              );
            },
          },
          async () => {
            const inserted = await tx.query<{ id: string }>(
              `INSERT INTO tag (org_id, scope, name, colour) VALUES (app_org_id(), $1, $2, $3)
               RETURNING id`,
              [input.scope, input.name, input.colour],
            );
            const row = inserted.rows[0];
            if (row === undefined) throw new Error('tag insert returned no row');
            return row.id;
          },
        );
        const dto = await loadTag(tx, id);
        if (dto === null) throw new Error('created tag is not visible');
        return {
          value: dto,
          audit: {
            actorType: 'operator',
            actorId: session.membershipId,
            action: 'tag.create',
            objectType: 'tag',
            objectId: id,
            result: 'success',
            detail: { scope: input.scope, colour: input.colour },
          },
        };
      },
      { constraints: NAME_TAKEN },
    );
    void reply.code(201);
    return created;
  });

  app.patch(ROUTES.tagPattern, async (request): Promise<TagDto> => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    const patch = parseInput(TagPatchSchema, request.body, 'tag');
    return changeAsOperator(
      ctx,
      request,
      async (tx) => {
        const updated = await tx.query(
          `UPDATE tag SET name = COALESCE($2, name), colour = COALESCE($3, colour)
           WHERE id = $1 AND org_id = app_org_id()`,
          [id, patch.name ?? null, patch.colour ?? null],
        );
        if (updated.rowCount !== 1) throw notFound('The tag');
        const dto = await loadTag(tx, id);
        if (dto === null) throw new Error('updated tag is not visible');
        return {
          value: dto,
          audit: {
            actorType: 'operator',
            actorId: session.membershipId,
            action: 'tag.update',
            objectType: 'tag',
            objectId: id,
            result: 'success',
            detail: { fields: Object.keys(patch).sort() },
          },
        };
      },
      { constraints: NAME_TAKEN },
    );
  });

  // Removes the tag from everything that carried it (the join rows cascade).
  app.delete(ROUTES.tagPattern, async (request, reply) => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    await changeAsOperator(ctx, request, async (tx) => {
      const current = await tx.query<TagRow>(
        `SELECT ${TAG_COLUMNS} FROM tag t
         WHERE t.id = $1 AND t.org_id = app_org_id() FOR UPDATE OF t`,
        [id],
      );
      const row = found(current.rows[0], 'The tag');
      await tx.query('DELETE FROM tag WHERE id = $1 AND org_id = app_org_id()', [id]);
      return {
        value: undefined,
        audit: {
          actorType: 'operator',
          actorId: session.membershipId,
          action: 'tag.delete',
          objectType: 'tag',
          objectId: id,
          result: 'success',
          detail: { scope: row.scope, removedFrom: bigintToNumber(row.usage_count) },
        },
      };
    });
    return reply.code(204).send();
  });
}
