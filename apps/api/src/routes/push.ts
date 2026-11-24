/**
 * Push to displays (portal v2 decision P2-05: assign, then push).
 *
 * Editing a playlist, a schedule or a layout, or assigning one, changes nothing on a
 * display. A push builds one immutable publication per chosen display, through the
 * same code as `POST /api/playlists/:id/publish` (../publishing.ts), and only where the
 * publication that would be built differs from the one the display already has.
 */
import {
  PushRequestSchema,
  ROUTES,
  type PushPlanResponse,
  type PushPlanRow,
  type PushResponse,
  type PushResult,
} from '@tinnox/contracts';
import { readOrg, unaudited } from '@tinnox/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ConstraintAnswers } from '../auth/permissions.ts';
import { operatorOf, type OperatorSession } from '../auth/session.ts';
import { perMinute, type AppContext } from '../context.ts';
import { iso } from '../db-helpers.ts';
import { HttpError, notFound, parseInput } from '../errors.ts';
import {
  assessDisplays,
  auditRejectedPublication,
  changeOncePerKey,
  createPublication,
  idempotencyKeyOf,
  issueDetails,
  lockDisplayForPublish,
  loadPushPlan,
  pendingCount,
  type DisplayAssessment,
} from '../publishing.ts';

/**
 * A push to one display: a file of the screen's content was deleted between the plan and the
 * write. Displays pushed so far keep their publications; a repeat with the same Idempotency-Key
 * returns them and carries on with the rest. A concurrent request with the same key that won is
 * answered by `changeOncePerKey`, which runs the push of that display again and returns the
 * winner's publication.
 */
const PUSH_RACES = {
  publication_asset_media_id_org_id_fkey: () =>
    new HttpError(
      409,
      'conflict',
      "Something used by a screen's assigned content changed meanwhile. Nothing is lost: try again.",
    ),
} as const satisfies ConstraintAnswers;

function toPlanRow(assessment: DisplayAssessment): PushPlanRow {
  return {
    display: { id: assessment.display.id, name: assessment.display.name },
    playlist: assessment.playlist,
    schedule: assessment.schedule,
    layout: assessment.layout,
    state: assessment.state,
    issues: issueDetails(assessment.issues),
    lastPushedAt: assessment.current === null ? null : iso(assessment.current.createdAt),
  };
}

export function registerPushRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get(ROUTES.push, async (request): Promise<PushPlanResponse> => {
    const session = operatorOf(request);
    return readOrg(db, session.orgId, async (tx) => {
      const assessments = await loadPushPlan(tx, ctx);
      return { items: assessments.map(toPlanRow), pendingCount: pendingCount(assessments) };
    });
  });

  /**
   * Pushes to one display, in its own transaction. The Idempotency-Key of the
   * request is reused per display under the same lock as publishing, so a
   * repeat of the request finds the publication it made and creates nothing
   * (`changeOncePerKey`, ../publishing.ts).
   * The member's role is checked again first in each transaction, before the key lock, so a
   * demoted member's replay of the same key is refused too. The audit row of a publication, or
   * of a rejected one, is returned with the result and commits with it.
   */
  function pushDisplay(
    request: FastifyRequest,
    session: OperatorSession,
    displayId: string,
    key: string,
  ): Promise<PushResult> {
    return changeOncePerKey<PushResult>(ctx, request, {
      displayId,
      key,
      constraints: PUSH_RACES,
      // The key is looked up before anything else, so a repeat answers as the first call did
      // even when the display would by now count as up to date.
      replay: (previous) => ({
        value: { displayId, outcome: 'published', publicationId: previous.id, issues: [] },
        audit: unaudited('idempotent_replay'),
      }),
      publish: async (tx) => {
        const display = await lockDisplayForPublish(tx, displayId);
        if (display === null) throw notFound('The screen');
        const [assessment] = await assessDisplays(tx, ctx, [display], {
          lock: true,
          keepDraft: true,
        });
        if (assessment === undefined) throw new Error('a display was not assessed');

        // Still "nothing is assigned": a display with a schedule or a layout carries its
        // default or main-zone playlist here.
        if (assessment.playlist === null) {
          return {
            value: { displayId, outcome: 'skipped', publicationId: null, issues: [] },
            audit: unaudited('nothing_changed'),
          };
        }
        if (assessment.state === 'blocked') {
          // Nothing is written but the audit event: the display keeps the
          // publication it has, and what it is playing is not interrupted.
          return {
            value: {
              displayId,
              outcome: 'rejected',
              publicationId: null,
              issues: issueDetails(assessment.issues),
            },
            audit: auditRejectedPublication({
              membershipId: session.membershipId,
              playlistId: assessment.playlist.id,
              scheduleId: assessment.schedule?.id ?? null,
              layoutId: assessment.layout?.id ?? null,
              displayId,
              issues: assessment.issues,
              via: 'push',
            }),
          };
        }
        if (assessment.state === 'up_to_date' && assessment.current !== null) {
          return {
            value: {
              displayId,
              outcome: 'unchanged',
              publicationId: assessment.current.publicationId,
              issues: [],
            },
            audit: unaudited('nothing_changed'),
          };
        }
        // Asked for above (`keepDraft`); without it nothing may be published.
        if (assessment.draft === null) throw new Error('a display was assessed without its draft');
        const made = await createPublication(tx, ctx, {
          display,
          playlistId: assessment.playlist.id,
          scheduleId: assessment.schedule?.id ?? null,
          layoutId: assessment.layout?.id ?? null,
          draft: assessment.draft,
          idempotencyKey: key,
          membershipId: session.membershipId,
          via: 'push',
        });
        return {
          value: { displayId, outcome: 'published', publicationId: made.value.id, issues: [] },
          audit: made.audit,
        };
      },
    });
  }

  app.post(
    ROUTES.push,
    { config: { rateLimit: perMinute(ctx, 30) } },
    async (request): Promise<PushResponse> => {
      const session = operatorOf(request);
      const body = parseInput(PushRequestSchema, request.body, 'push request');
      const key = idempotencyKeyOf(request, 'push');
      // Identifiers compare without regard to letter case; the database returns lower case.
      const displayIds = body.displayIds.map((id) => id.toLowerCase());

      // Every id must be a display of this organisation before anything is written.
      // Another organisation's display is invisible here, so it answers like an unknown id.
      const known = await readOrg(db, session.orgId, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM display WHERE org_id = app_org_id() AND id = ANY($1::uuid[])',
          [displayIds],
        );
        return rows.length;
      });
      if (known !== displayIds.length) throw notFound('The screen');

      // One display after another: each is its own transaction on one connection, so a
      // large push cannot take the whole pool, and a rejection does not undo the others.
      // shortcut: a push refused part-way (the role was lowered, or the member's sessions were
      // ended, during this loop) answers 403 or 401 without the results so far: screens
      // already pushed stay pushed and their publication.create rows record it. Return
      // per-screen results with a 'refused' outcome if people ask what happened.
      const results: PushResult[] = [];
      for (const displayId of displayIds) {
        results.push(await pushDisplay(request, session, displayId, key));
      }
      return { results };
    },
  );
}
