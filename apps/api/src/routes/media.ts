/**
 * Private media: streamed upload into quarantine, listing, authorised preview
 * and deletion. Files reach the library only after the isolated worker accepts
 * them (media/pipeline.ts).
 * Every read runs inside readOrg with the organisation of the verified session; every write
 * runs inside changeAsOperator, which checks the member's role again first and writes the audit
 * rows the change returns on its transaction (auth/permissions.ts). An upload refused before
 * any row is written leaves only its audit row, through recordRefusal (auth/refusal.ts).
 */
import {
  ABSOLUTE,
  IdParamSchema,
  MEDIA_KIND_BY_MIME,
  MEDIA_UPLOAD_FIELD,
  MediaMimeTypeSchema,
  MediaPatchSchema,
  ROUTES,
  type AuditEventShapes,
  type MediaDto,
  type MediaListResponse,
  type MediaUploadResponse,
  type MediaUsageResponse,
} from '@tinnox/contracts';
import { readOrg, settle, withCountedLimit, type Change, type OrgReadTx } from '@tinnox/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { abandonBody, changeAsOperator, type ConstraintAnswers } from '../auth/permissions.ts';
import { recordRefusal } from '../auth/refusal.ts';
import { operatorOf, type OperatorSession } from '../auth/session.ts';
import { perMinute, type AppContext } from '../context.ts';
import { accept, refuse, type Decision } from '../db-helpers.ts';
import { found, HttpError, notFound, parseInput } from '../errors.ts';
import { MEDIA_COLUMNS, toMediaDto, usedBytes, type MediaRow } from '../media/rows.ts';
import { serveObject } from '../media/serve.ts';
import { sniffMediaType } from '../media/sniff.ts';
import { displayNameFromUpload } from '../media/upload-name.ts';
import { replaceTags, UNKNOWN_TAG } from '../tags.ts';

/** The folder or a tag of a media change was deleted between the check and the write. */
const FOLDER_OR_TAG_GONE = {
  media_folder_fk: () => notFound('The folder'),
  ...UNKNOWN_TAG,
} as const satisfies ConstraintAnswers;

/**
 * A publish or a playlist edit referenced the media item between the checks of its delete and
 * the DELETE. The two keys that point at a media item and do not cascade.
 */
const usedMeanwhile = (): HttpError =>
  new HttpError('media_in_use', 'This file has just been used elsewhere. Try again.');
const USED_MEANWHILE = {
  playlist_item_media_id_org_id_fkey: usedMeanwhile,
  publication_asset_media_id_org_id_fkey: usedMeanwhile,
} as const satisfies ConstraintAnswers;

/** What a refused upload records: the reason and sizes, never the file or its name. */
type UploadRefusal = Extract<AuditEventShapes['media.upload']['detail'], { reason: unknown }>;

/** One live media item of the caller's organisation, or null. */
async function loadMediaRow(tx: OrgReadTx, id: string): Promise<MediaRow | null> {
  const { rows } = await tx.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media m
     WHERE m.id = $1 AND m.org_id = app_org_id() AND m.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const limits = config.limits;

  /**
   * The audit row of an upload refused before any row was written, in its own transaction. A
   * COMMIT of the row that did not confirm is logged and the caller's refusal stands, as the
   * guards' refusal rows do (auth/permission-audit.ts): nothing of the upload can have been
   * saved, and answering `commit_outcome_unknown` would say it may have been. A rollback is
   * rethrown, as before.
   */
  async function recordUploadRefusal(
    request: FastifyRequest,
    session: OperatorSession,
    result: 'failure' | 'denied',
    detail: UploadRefusal,
  ): Promise<void> {
    const ended = await settle(
      recordRefusal(ctx, request, session, {
        actorType: 'operator',
        actorId: session.membershipId,
        action: 'media.upload',
        objectType: 'media',
        objectId: null,
        result,
        detail,
      }),
    );
    switch (ended.end) {
      case 'committed':
        return;
      case 'rolled_back':
        throw ended.error;
      case 'unknown':
        request.log.error({ err: ended.unconfirmed }, 'failed to record upload refusal');
        return;
    }
  }

  app.get(ROUTES.media, async (request): Promise<MediaListResponse> => {
    const session = operatorOf(request);
    return readOrg(db, session.orgId, async (tx) => {
      const { rows } = await tx.query<MediaRow>(
        `SELECT ${MEDIA_COLUMNS} FROM media m
         WHERE m.org_id = app_org_id() AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC, m.id`,
      );
      return {
        items: rows.map(toMediaDto),
        storage: { usedBytes: await usedBytes(tx), limitBytes: limits.maxOrgStorageBytes },
      };
    });
  });

  app.post(
    ROUTES.media,
    { config: { rateLimit: perMinute(ctx, 60) } },
    async (request, reply): Promise<MediaUploadResponse> => {
      const session = operatorOf(request);
      if (!request.isMultipart()) {
        throw new HttpError(
          'unsupported_media_type',
          `Send the file as multipart/form-data in a field named "${MEDIA_UPLOAD_FIELD}".`,
        );
      }

      const used = await readOrg(db, session.orgId, usedBytes);
      const remaining = limits.maxOrgStorageBytes - used;
      if (remaining <= 0) {
        await recordUploadRefusal(request, session, 'denied', { reason: 'storage_quota_exceeded' });
        abandonBody(request, reply);
        throw new HttpError(
          'storage_quota_exceeded',
          `The organisation's storage is full (${megabytes(limits.maxOrgStorageBytes)}). Delete unused media first.`,
        );
      }
      // The hard limit for this request: the per-file limit, or less when little quota is left.
      const cap = Math.min(limits.maxUploadBytes, remaining);
      const quotaBound = cap < limits.maxUploadBytes;
      const tooLarge = (): HttpError =>
        quotaBound
          ? new HttpError(
              'storage_quota_exceeded',
              `The file does not fit in the remaining storage (${megabytes(remaining)} free).`,
            )
          : new HttpError(
              'payload_too_large',
              `The file is larger than the upload limit of ${megabytes(limits.maxUploadBytes)}.`,
            );

      // A declared length far above the limit is refused before any byte is read.
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > cap + 1024 * 1024) {
        await recordUploadRefusal(request, session, 'denied', {
          reason: 'too_large',
          declaredBytes: declared,
        });
        abandonBody(request, reply);
        throw tooLarge();
      }

      const part = await request.file({
        limits: { fileSize: cap, files: 1, fields: 4, fieldSize: 1024, headerPairs: 50 },
        throwFileSizeLimit: false,
      });
      if (part === undefined || part.fieldname !== MEDIA_UPLOAD_FIELD) {
        part?.file.resume();
        throw new HttpError(
          'bad_request',
          `The upload must contain one file in a field named "${MEDIA_UPLOAD_FIELD}".`,
        );
      }
      const originalName = displayNameFromUpload(part.filename);

      const received = await ctx.media.receive(part.file, cap);
      if (received.truncated) {
        await recordUploadRefusal(request, session, 'denied', {
          reason: quotaBound ? 'storage_quota_exceeded' : 'too_large',
        });
        abandonBody(request, reply);
        throw tooLarge();
      }
      if (received.bytes === 0) {
        await ctx.media.discard(received.jobId);
        await recordUploadRefusal(request, session, 'failure', { reason: 'empty_file' });
        throw new HttpError('bad_request', 'The file is empty.');
      }
      const mimeType = sniffMediaType(received.head);
      if (mimeType === null) {
        await ctx.media.discard(received.jobId);
        await recordUploadRefusal(request, session, 'failure', {
          reason: 'unrecognised_type',
          bytes: received.bytes,
        });
        throw new HttpError(
          'unsupported_media_type',
          'The file content is not a JPEG, PNG or MP4 file. The file name and extension are ignored; only the content counts.',
        );
      }

      // The role is checked again first (a demotion during the upload refuses it), then the
      // quota lock. A quota refusal is a decision, not a throw, so its audit row commits; it
      // is thrown once the transaction has committed, and the stored file is discarded below.
      const change = changeAsOperator<Decision<MediaDto>>(ctx, request, async (tx) => {
        // Serialise uploads per organisation so concurrent requests cannot pass the quota together.
        return withCountedLimit<Change<Decision<MediaDto>>>(
          tx,
          {
            lock: 'media_quota',
            count: usedBytes,
            adding: received.bytes,
            max: limits.maxOrgStorageBytes,
            whenFull: (usedNow) => ({
              value: refuse(
                new HttpError(
                  'storage_quota_exceeded',
                  `The file does not fit in the remaining storage (${megabytes(Math.max(0, limits.maxOrgStorageBytes - usedNow))} free).`,
                ),
              ),
              audit: {
                actorType: 'operator',
                actorId: session.membershipId,
                action: 'media.upload',
                objectType: 'media',
                objectId: null,
                result: 'denied',
                detail: { reason: 'storage_quota_exceeded', bytes: received.bytes },
              },
            }),
          },
          async () => {
            const inserted = await tx.query<MediaRow>(
              `INSERT INTO media AS m
                 (id, org_id, kind, status, mime_type, bytes, sha256, original_name, created_by)
               VALUES ($1, app_org_id(), $2, 'processing', $3, $4, $5, $6, $7)
               RETURNING ${MEDIA_COLUMNS}`,
              [
                received.jobId,
                MEDIA_KIND_BY_MIME[mimeType],
                mimeType,
                received.bytes,
                received.sha256,
                originalName,
                session.membershipId,
              ],
            );
            const row = inserted.rows[0];
            if (row === undefined) throw new Error('media insert returned no row');
            return {
              value: accept(toMediaDto(row)),
              audit: {
                actorType: 'operator',
                actorId: session.membershipId,
                action: 'media.upload',
                objectType: 'media',
                objectId: row.id,
                result: 'success',
                detail: { bytes: received.bytes, sniffedType: mimeType },
              },
            };
          },
        );
      });
      // The received bytes belong to the media row, so they go only when it is known that no
      // row was made (review round 3, SCX-03).
      const ended = await settle(change);
      let media: MediaDto;
      switch (ended.end) {
        case 'committed':
          if (!ended.value.ok) {
            // The refusal committed with its audit row, and no media row.
            await ctx.media.discard(received.jobId).catch(() => undefined);
            throw ended.value.error;
          }
          media = ended.value.value;
          break;
        case 'rolled_back':
          await ctx.media.discard(received.jobId).catch(() => undefined);
          throw ended.error;
        case 'unknown':
          // COMMIT did not confirm, so the row may exist: keep the bytes. The scan queues them
          // if it does (they are still marked in progress for up to an hour), and the sweep
          // removes them if it does not.
          throw ended.unconfirmed;
      }

      try {
        await ctx.media.enqueue(received.jobId);
      } catch (error) {
        // The row is committed as "processing"; the pipeline re-queues or fails it on a later scan.
        request.log.error(
          { err: error, mediaId: media.id },
          'could not queue media for validation',
        );
      }
      void reply.code(201);
      return { media };
    },
  );

  app.get(ROUTES.mediaItemPattern, async (request): Promise<MediaDto> => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    return readOrg(db, session.orgId, async (tx) => {
      const row = found(await loadMediaRow(tx, id), 'The media item');
      return toMediaDto(row);
    });
  });

  /**
   * Changes what an operator may say about a media item: its name, description,
   * default time on screen (images only), folder and tags. The file itself and
   * the worker's verdict are never changed here.
   */
  app.patch(ROUTES.mediaItemPattern, async (request): Promise<MediaDto> => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    const patch = parseInput(MediaPatchSchema, request.body, 'media item');
    return changeAsOperator(
      ctx,
      request,
      async (tx) => {
        const locked = await tx.query<{
          kind: 'image' | 'video';
          name: string | null;
          description: string | null;
          default_duration_ms: number | null;
          folder_id: string | null;
        }>(
          `SELECT kind, name, description, default_duration_ms, folder_id FROM media
           WHERE id = $1 AND org_id = app_org_id() AND deleted_at IS NULL FOR NO KEY UPDATE`,
          [id],
        );
        const current = found(locked.rows[0], 'The media item');

        const duration = patch.defaultDurationMs;
        if (duration !== undefined && duration !== null) {
          if (current.kind !== 'image') {
            throw new HttpError(
              'validation_failed',
              'Only images have a default duration; a video plays for its own length.',
              {
                details: [{ path: 'defaultDurationMs', message: 'must be null for a video' }],
              },
            );
          }
          if (
            duration < limits.minImageItemDurationMs ||
            duration > limits.maxImageItemDurationMs
          ) {
            throw new HttpError(
              'validation_failed',
              'The default duration is outside the allowed range.',
              {
                details: [
                  {
                    path: 'defaultDurationMs',
                    message: `must be between ${limits.minImageItemDurationMs} and ${limits.maxImageItemDurationMs} milliseconds`,
                  },
                ],
              },
            );
          }
        }
        if (patch.folderId !== undefined && patch.folderId !== null) {
          const folder = await tx.query(
            'SELECT 1 FROM folder WHERE id = $1 AND org_id = app_org_id()',
            [patch.folderId],
          );
          if (folder.rowCount !== 1) throw notFound('The folder');
        }

        // A change of tags alone leaves the row, and so its updated_at, as it is.
        if (
          patch.name !== undefined ||
          patch.description !== undefined ||
          patch.defaultDurationMs !== undefined ||
          patch.folderId !== undefined
        ) {
          await tx.query(
            `UPDATE media
             SET name = $2, description = $3, default_duration_ms = $4, folder_id = $5
             WHERE id = $1 AND org_id = app_org_id()`,
            [
              id,
              patch.name === undefined ? current.name : patch.name,
              patch.description === undefined ? current.description : patch.description,
              duration === undefined ? current.default_duration_ms : duration,
              patch.folderId === undefined ? current.folder_id : patch.folderId,
            ],
          );
        }
        // The contract makes both sides arrive together.
        if (patch.availableFrom !== undefined) {
          await tx.query(
            `UPDATE media SET available_from = $2::timestamp, available_until = $3::timestamp
             WHERE id = $1 AND org_id = app_org_id()`,
            [id, patch.availableFrom, patch.availableUntil ?? null],
          );
        }
        if (patch.tagIds !== undefined) await replaceTags(tx, 'media', id, patch.tagIds);

        const row = await loadMediaRow(tx, id);
        if (row === null) throw new Error('updated media item is not visible');
        return {
          value: toMediaDto(row),
          audit: {
            actorType: 'operator',
            actorId: session.membershipId,
            action: 'media.update',
            objectType: 'media',
            objectId: id,
            result: 'success',
            detail: { fields: Object.keys(patch).sort() },
          },
        };
      },
      { constraints: FOLDER_OR_TAG_GONE },
    );
  });

  /**
   * Where a media item is used: the live playlists that contain it, and the
   * displays whose current publication contains it (whatever was edited since).
   */
  app.get(ROUTES.mediaUsagePattern, async (request): Promise<MediaUsageResponse> => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    return readOrg(db, session.orgId, async (tx) => {
      const media = await tx.query(
        'SELECT 1 FROM media WHERE id = $1 AND org_id = app_org_id() AND deleted_at IS NULL',
        [id],
      );
      if (media.rowCount !== 1) throw notFound('The media item');
      const playlists = await tx.query<{ id: string; name: string }>(
        `SELECT p.id, p.name FROM playlist p
         WHERE p.org_id = app_org_id() AND p.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM playlist_item i
                       WHERE i.playlist_id = p.id AND i.org_id = p.org_id AND i.media_id = $1)
         ORDER BY lower(p.name), p.id
         LIMIT $2`,
        [id, ABSOLUTE.maxListItems],
      );
      const displays = await tx.query<{ id: string; name: string }>(
        `SELECT d.id, d.name FROM display d
         JOIN display_delivery dd ON dd.display_id = d.id AND dd.org_id = d.org_id
         WHERE d.org_id = app_org_id()
           AND EXISTS (SELECT 1 FROM publication_asset pa
                       WHERE pa.publication_id = dd.desired_publication_id
                         AND pa.org_id = dd.org_id AND pa.media_id = $1)
         ORDER BY lower(d.name), d.id
         LIMIT $2`,
        [id, ABSOLUTE.maxListItems],
      );
      return {
        playlists: playlists.rows.map((r) => ({ id: r.id, name: r.name })),
        displays: displays.rows.map((r) => ({ id: r.id, name: r.name })),
      };
    });
  });

  /** /preview sends the original; /thumbnail sends the thumbnail when there is one. */
  async function sendPreview(
    request: FastifyRequest,
    reply: FastifyReply,
    thumbnail: boolean,
  ): Promise<FastifyReply> {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    const row = await readOrg(db, session.orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        status: string;
        storage_key: string | null;
        thumb_storage_key: string | null;
        sha256: string | null;
        mime_type: string | null;
      }>(
        `SELECT id, status, storage_key, thumb_storage_key, sha256, mime_type FROM media
         WHERE id = $1 AND org_id = app_org_id() AND deleted_at IS NULL`,
        [id],
      );
      return rows[0];
    });
    if (row === undefined) throw notFound('The media item');
    const mime = MediaMimeTypeSchema.safeParse(row.mime_type);
    if (
      row.status !== 'ready' ||
      row.storage_key === null ||
      row.sha256 === null ||
      !mime.success
    ) {
      throw new HttpError('media_not_ready', 'This file has no preview because it is not ready.');
    }
    // shortcut: no backfill, no video posters; such media serves the original here.
    const thumb = thumbnail ? row.thumb_storage_key : null;
    return serveObject(request, reply, {
      storage: ctx.storage,
      orgId: session.orgId,
      storageKey: thumb ?? row.storage_key,
      mimeType: thumb === null ? mime.data : 'image/jpeg',
      // shortcut: ETag reuses media sha256 (thumbnail is write-once); store a thumb sha if thumbnails are regenerated.
      sha256: row.sha256,
      mediaId: row.id,
      cacheControl: 'private, max-age=300',
    });
  }

  app.get(ROUTES.mediaPreviewPattern, (request, reply) => sendPreview(request, reply, false));
  app.get(ROUTES.mediaThumbnailPattern, (request, reply) => sendPreview(request, reply, true));

  /**
   * Deleting media:
   *  - refused while a playlist still uses it (the operator edits the playlist first);
   *    a deleted playlist uses nothing;
   *  - refused while it is being validated;
   *  - if a publication references it, the row is hidden (deleted_at) but the bytes
   *    stay, because published snapshots are immutable and players may still need them;
   *  - otherwise the row and the stored bytes are removed.
   */
  app.delete(ROUTES.mediaItemPattern, async (request, reply) => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    const keysToRemove = await changeAsOperator(
      ctx,
      request,
      async (tx): Promise<Change<(string | null)[]>> => {
        const { rows } = await tx.query<{
          status: string;
          storage_key: string | null;
          thumb_storage_key: string | null;
        }>(
          `SELECT status, storage_key, thumb_storage_key FROM media
           WHERE id = $1 AND org_id = app_org_id() AND deleted_at IS NULL FOR UPDATE`,
          [id],
        );
        const row = found(rows[0], 'The media item');
        if (row.status === 'processing') {
          throw new HttpError(
            'conflict',
            'This file is still being checked. Delete it once the check has finished.',
          );
        }
        // Only live playlists count. Deleting a playlist removes its items, so a deleted
        // playlist never holds media back (routes/playlists.ts).
        const used = await tx.query<{ name: string }>(
          `SELECT DISTINCT p.name FROM playlist_item i
           JOIN playlist p ON p.id = i.playlist_id AND p.org_id = i.org_id
           WHERE i.media_id = $1 AND i.org_id = app_org_id() AND p.deleted_at IS NULL
           ORDER BY p.name LIMIT 5`,
          [id],
        );
        if (used.rows.length > 0) {
          throw new HttpError(
            'media_in_use',
            'This file is used in a playlist. Remove it from the playlist first.',
            {
              details: used.rows.map((r) => ({ path: 'playlist', message: r.name.slice(0, 200) })),
            },
          );
        }
        const published = await tx.query(
          'SELECT 1 FROM publication_asset WHERE media_id = $1 AND org_id = app_org_id() LIMIT 1',
          [id],
        );
        const retained = published.rows.length > 0;
        if (retained) {
          await tx.query(
            'UPDATE media SET deleted_at = now() WHERE id = $1 AND org_id = app_org_id()',
            [id],
          );
        } else {
          await tx.query('DELETE FROM media WHERE id = $1 AND org_id = app_org_id()', [id]);
        }
        return {
          // shortcut: quota ignores thumbnail bytes (<=512 KiB each).
          value: retained ? [] : [row.storage_key, row.thumb_storage_key],
          audit: {
            actorType: 'operator',
            actorId: session.membershipId,
            action: 'media.delete',
            objectType: 'media',
            objectId: id,
            result: 'success',
            detail: { bytesRetainedForPublications: retained },
          },
        };
      },
      { constraints: USED_MEANWHILE },
    );
    for (const key of keysToRemove) {
      if (key === null) continue;
      try {
        await ctx.storage.delete(key);
      } catch (error) {
        request.log.error({ err: error, mediaId: id }, 'media row deleted but stored bytes remain');
      }
    }
    return reply.code(204).send();
  });
}
