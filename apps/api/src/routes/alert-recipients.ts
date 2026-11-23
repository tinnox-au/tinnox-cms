/**
 * The organisation's alert addresses (CMS-15, docs/portal-v2/stage-c-alerts.md section 4). The
 * list routes need `alerts.manage` (Admin and up): the list holds personal data. The confirm
 * route is public: the link is opened by the address's owner, who has no session.
 * Audit rows carry the recipient id, never the address. The list runs inside readOrg and the
 * two writes inside changeAsOperator, which checks the member's role again first; the
 * confirmation learns its organisation from the token, inside changePreOrg. Each change returns
 * its audit event, and the wrapper writes it on the change's transaction.
 */
import {
  ALERT_CONFIRM_TTL_DAYS,
  AlertRecipientConfirmSchema,
  AlertRecipientCreateSchema,
  AlertRecipientStatusSchema,
  IdParamSchema,
  MAX_ALERT_RECIPIENTS,
  ROUTES,
  type AlertRecipientDto,
  type AlertRecipientListResponse,
} from '@tinnox/contracts';
import { alertRecipientByTokenHash, changePreOrg, readOrg, sha256, unaudited } from '@tinnox/db';
import type { FastifyInstance } from 'fastify';
import { confirmationEmail, mailErrorCode } from '../alerts.ts';
import { changeAsOperator, lockTimeoutAsUnavailable } from '../auth/permissions.ts';
import { operatorOf } from '../auth/session.ts';
import { perMinute, type AppContext } from '../context.ts';
import { iso } from '../db-helpers.ts';
import { HttpError, notFound, parseInput } from '../errors.ts';
import { routeStatement } from '../route-audit.ts';
import { randomToken } from '../security.ts';

interface RecipientRow {
  id: string;
  email: string;
  status: string;
  created_at: Date;
}

/**
 * D22 (the RCX-01 rule for alert addresses): a pending address dies with the access of the
 * member who added it. True while that member is still in the organisation and the address is
 * newer than their cut-off, which removal, demotion, sign out everywhere, mfa-reset, owner
 * recovery and the incident script all set and a reactivation keeps. No recorded adder: dead.
 * Both are database times and a cut-off is stamped after the member row is locked, so an
 * address added first is earlier; a tie is dead.
 *
 * Written once, over `alert_recipient`: the confirmation and the list's status both read it,
 * so a link that would be refused never shows as waiting. A confirmed address is not asked.
 */
const ADDER_STILL_HAS_ACCESS = `EXISTS (
    SELECT 1 FROM membership adder
    WHERE adder.id = alert_recipient.created_by AND adder.org_id = alert_recipient.org_id
      AND adder.removed_at IS NULL
      AND (adder.sessions_valid_after IS NULL
           OR alert_recipient.created_at > adder.sessions_valid_after))`;

// The status by the database clock, the one the expiry was set with.
const RECIPIENT_COLUMNS = `id, email, created_at,
  CASE WHEN confirmed_at IS NOT NULL THEN 'confirmed'
       WHEN confirm_expires_at > now() AND ${ADDER_STILL_HAS_ACCESS} THEN 'waiting'
       ELSE 'expired' END AS status`;

function toDto(row: RecipientRow): AlertRecipientDto {
  return {
    id: row.id,
    email: row.email,
    status: AlertRecipientStatusSchema.parse(row.status),
    createdAt: iso(row.created_at),
  };
}

export function registerAlertRecipientRoutes(app: FastifyInstance, ctx: AppContext): void {
  const writeLimit = { config: { rateLimit: perMinute(ctx, 30) } };

  app.get(ROUTES.alertRecipients, async (request): Promise<AlertRecipientListResponse> => {
    const session = operatorOf(request);
    return readOrg(ctx.pool, session.orgId, async (tx) => {
      const { rows } = await tx.query<RecipientRow>(
        `SELECT ${RECIPIENT_COLUMNS} FROM alert_recipient
         WHERE org_id = app_org_id() ORDER BY created_at, id LIMIT $1`,
        [MAX_ALERT_RECIPIENTS],
      );
      return { items: rows.map(toDto) };
    });
  });

  app.post(
    ROUTES.alertRecipients,
    writeLimit,
    async (request, reply): Promise<AlertRecipientDto> => {
      const session = operatorOf(request);
      const { email: address } = parseInput(AlertRecipientCreateSchema, request.body, 'address');
      const mail = ctx.mail;
      if (mail === null) {
        throw new HttpError(
          503,
          'mail_not_configured',
          'E-mail is not set up on this server yet, so alert addresses cannot be added.',
        );
      }
      const token = randomToken();
      const { recipient, orgName } = await changeAsOperator(ctx, request, async (tx) => {
        // Serialises additions per organisation, so the count and the duplicate check hold.
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('tinnox.alert_recipient_count:' || app_org_id()::text, 0))",
        );
        const listed = await tx.query<{ n: number; taken: boolean }>(
          `SELECT count(*)::int AS n, coalesce(bool_or(email = $1), false) AS taken
         FROM alert_recipient WHERE org_id = app_org_id()`,
          [address],
        );
        if (listed.rows[0]?.taken === true) {
          throw new HttpError(409, 'conflict', 'This address is already on the alert list.', {
            details: [{ path: 'email', message: 'This address is already on the alert list.' }],
          });
        }
        if ((listed.rows[0]?.n ?? 0) >= MAX_ALERT_RECIPIENTS) {
          throw new HttpError(
            409,
            'conflict',
            `The alert list already has ${MAX_ALERT_RECIPIENTS} addresses. Remove one first.`,
          );
        }
        const inserted = await tx.query<RecipientRow>(
          `INSERT INTO alert_recipient (org_id, email, created_by, confirm_token_hash, confirm_expires_at)
         VALUES (app_org_id(), $1, $2, $3, now() + make_interval(days => $4))
         RETURNING ${RECIPIENT_COLUMNS}`,
          [address, session.membershipId, sha256(token), ALERT_CONFIRM_TTL_DAYS],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('alert recipient insert returned no row');
        const org = await tx.query<{ name: string }>(
          'SELECT name FROM organization WHERE id = app_org_id()',
        );
        return {
          value: { recipient: toDto(row), orgName: org.rows[0]?.name ?? '' },
          audit: {
            actorType: 'operator',
            actorId: session.membershipId,
            action: 'alert_recipient.add',
            objectType: 'alert_recipient',
            objectId: row.id,
            result: 'success',
            detail: null,
          },
        };
      });
      try {
        await mail.send({
          to: address,
          ...confirmationEmail(orgName, ctx.config.portalOrigin, token, ALERT_CONFIRM_TTL_DAYS),
        });
      } catch (error) {
        request.log.error(mailErrorCode(error), 'alert confirmation e-mail was not sent');
        throw new HttpError(
          503,
          'confirmation_not_sent',
          'The address was added, but the confirmation e-mail could not be sent. Remove the address and add it again later.',
        );
      }
      void reply.code(201);
      return recipient;
    },
  );

  app.delete(ROUTES.alertRecipientPattern, writeLimit, async (request, reply) => {
    const session = operatorOf(request);
    const { id } = parseInput(IdParamSchema, request.params, 'address');
    await changeAsOperator(ctx, request, async (tx) => {
      const deleted = await tx.query(
        'DELETE FROM alert_recipient WHERE id = $1 AND org_id = app_org_id() RETURNING id',
        [id],
      );
      if (deleted.rowCount !== 1) throw notFound('The address');
      return {
        value: undefined,
        audit: {
          actorType: 'operator',
          actorId: session.membershipId,
          action: 'alert_recipient.remove',
          objectType: 'alert_recipient',
          objectId: id,
          result: 'success',
          detail: null,
        },
      };
    });
    return reply.code(204).send();
  });
}

/**
 * Public: the confirmation link's page posts the token from its fragment. Unknown, used and
 * expired tokens, and the token of an address whose adder has lost access since (D22), all get
 * the same 404. A wait for a row lock past the pool's lock timeout answers 503 with
 * Retry-After. Rate-limited per client address.
 */
export function registerAlertConfirmRoute(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    ROUTES.alertRecipientConfirm,
    { config: { rateLimit: perMinute(ctx, 10) } },
    async (request, reply) => {
      const { token } = parseInput(AlertRecipientConfirmSchema, request.body, 'link');
      const tokenHash = sha256(token);
      // A member change that holds the adder's member row past lock_timeout answers 503, as
      // every write does; nothing was confirmed or audited (SEC-3, BEH-3). The change is held
      // to the route's entry in OTHER_ROUTE_AUDIT: alert_recipient.confirm, or nothing.
      const statement = routeStatement(request);
      const confirmed = await changePreOrg(ctx.pool, statement, async (pre, enterOrg) => {
        const found = await alertRecipientByTokenHash(pre, tokenHash);
        // A link that matched nothing changed nothing, and answers the same 404 below.
        if (found === null) return { value: false, audit: unaudited('nothing_changed') };
        const tx = await enterOrg(found.orgId);
        // The recipient row, then the adder's member row: a member change never locks a
        // recipient row, so the order has no cycle. FOR SHARE waits for a removal or a cut-off
        // that is committing, and the UPDATE, a later statement, then reads it and refuses
        // (READ COMMITTED); one that starts later waits for this transaction, so the address
        // was confirmed first.
        const pending = await tx.query<{ created_by: string | null }>(
          'SELECT created_by FROM alert_recipient WHERE id = $1 AND org_id = app_org_id() FOR UPDATE',
          [found.recipientId],
        );
        await tx.query(
          'SELECT 1 FROM membership WHERE org_id = app_org_id() AND id = $1 FOR SHARE',
          [pending.rows[0]?.created_by ?? null],
        );
        // Conditional, so two clicks at once confirm (and audit) once.
        const updated = await tx.query(
          `UPDATE alert_recipient
           SET confirmed_at = now(), confirm_token_hash = NULL, confirm_expires_at = NULL
           WHERE id = $1 AND org_id = app_org_id() AND confirm_token_hash = $2
             AND confirm_expires_at > now() AND ${ADDER_STILL_HAS_ACCESS}
           RETURNING id`,
          [found.recipientId, tokenHash],
        );
        if (updated.rowCount !== 1) return { value: false, audit: unaudited('nothing_changed') };
        return {
          value: true,
          audit: {
            actorType: 'anonymous',
            actorId: null,
            action: 'alert_recipient.confirm',
            objectType: 'alert_recipient',
            objectId: found.recipientId,
            result: 'success',
            detail: null,
          },
        };
      }).catch((error: unknown) => {
        throw lockTimeoutAsUnavailable(request, error);
      });
      if (!confirmed) throw new HttpError(404, 'not_found', 'This link is not valid any more.');
      return reply.code(204).send();
    },
  );
}
