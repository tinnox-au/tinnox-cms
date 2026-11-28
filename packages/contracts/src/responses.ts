/**
 * What every route answers, in one table: the schema its JSON answers parse with (UTX-01,
 * adoption plan sections 2.5 and 4.8). The portal and the player parse every answer they read
 * with these schemas; the API itself parses none of its own. The integration harness does
 * (apps/api/test/response-contract.ts): it parses every JSON answer of every test against this
 * table and fails the test on a mismatch, and refuses to start when a registered route has no
 * row here, so a field the server builds past a contract limit fails in the suite instead of in
 * the browser as `invalid_response`.
 *
 * Imported as '@tinnox/contracts/responses', never through the index: only the tests read this
 * table, and through the index the portal's bundle carried it (a top-level freeze over every
 * schema, which the bundler keeps).
 */
import { z } from 'zod';
import { AlertRecipientDtoSchema, AlertRecipientListResponseSchema } from './alerts.ts';
import { AppDtoSchema, AppListResponseSchema } from './app.ts';
import { AuditListResponseSchema } from './audit.ts';
import {
  DisplayDtoSchema,
  DisplayListResponseSchema,
  RevokePlayerResponseSchema,
  SiteListResponseSchema,
} from './display.ts';
import { ApiErrorSchema } from './errors.ts';
import { FolderDtoSchema, FolderListResponseSchema } from './folder.ts';
import { LayoutDtoSchema, LayoutListResponseSchema } from './layout.ts';
import {
  MediaDtoSchema,
  MediaListResponseSchema,
  MediaUploadResponseSchema,
  MediaUsageResponseSchema,
} from './media.ts';
import {
  InviteDtoSchema,
  InviteListResponseSchema,
  MemberChangeResponseSchema,
  MemberListResponseSchema,
  MemberNameListResponseSchema,
  MemberSignOutResponseSchema,
} from './members.ts';
import { OverviewResponseSchema } from './overview.ts';
import {
  PairingClaimResponseSchema,
  PairingCreateResponseSchema,
  PairingPollResponseSchema,
} from './pairing.ts';
import {
  HeartbeatResponseSchema,
  ManifestResponseSchema,
  MediaUrlsResponseSchema,
} from './player.ts';
import {
  PlaylistDtoSchema,
  PlaylistDuplicateResponseSchema,
  PlaylistListResponseSchema,
  PublishResponseSchema,
} from './playlist.ts';
import { PushPlanResponseSchema, PushResponseSchema } from './push.ts';
import { PLAYER_PREFIX, ROUTES } from './routes.ts';
import { ScheduleDtoSchema, ScheduleListResponseSchema } from './schedule.ts';
import { LogoutResponseSchema, SessionResponseSchema } from './session.ts';
import { DeliveryStatusListResponseSchema, DeliveryStatusViewSchema } from './status.ts';
import { TagDtoSchema, TagListResponseSchema } from './tag.ts';

/** `GET /healthz`: the process is up. */
export const HealthResponseSchema = z.object({ status: z.literal('ok') }).strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * `GET /readyz`: 200 when the database, the storage and the job folders answer, else 503 with
 * the same body. The identity provider and the worker are reported but never make it 503.
 */
export const ReadinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z
      .object({
        database: z.boolean(),
        storage: z.boolean(),
        mediaJobs: z.boolean(),
        identityProvider: z.boolean(),
        mediaWorker: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

/** What a route may answer. */
export interface ResponseContract {
  /** What every JSON answer below 400 parses with; null when the route sends no JSON below 400. */
  readonly success: z.ZodType | null;
  /** What every JSON answer of 400 or more parses with: the error envelope, unless the route has its own. */
  readonly error: z.ZodType;
  /** The statuses below 400 at which the route sends no JSON: an empty answer, a redirect or bytes. */
  readonly withoutJson: readonly number[];
}

const responseContract = (
  success: z.ZodType | null,
  withoutJson: readonly number[] = [],
  error: z.ZodType = ApiErrorSchema,
): ResponseContract => Object.freeze({ success, error, withoutJson: Object.freeze(withoutJson) });

/** Answers JSON that parses with `schema`, or no body at the statuses `withoutJson` names. */
const json = (schema: z.ZodType, withoutJson: readonly number[] = []): ResponseContract =>
  responseContract(schema, withoutJson);
/** 204 with no body. */
const noContent: ResponseContract = responseContract(null, [204]);
/** 303 to the portal or the identity provider. */
const redirect: ResponseContract = responseContract(null, [303]);
/** The bytes of a stored object: the whole of it, a range of it, or 304 for a cached copy. */
const bytes: ResponseContract = responseContract(null, [200, 206, 304]);

/**
 * Every route the API registers, keyed like ROUTE_PERMISSIONS and OTHER_ROUTE_AUDIT
 * (`${METHOD} ${pattern}`, HEAD read as GET). Each schema is the one the client parses that
 * answer with (apps/portal/src/api/endpoints.ts, apps/portal/src/api/upload.ts,
 * apps/player-web/src/platform/api.ts), or a stricter one: `POST /api/playlists` sends the full
 * playlist, which the portal's union also takes.
 */
export const ROUTE_RESPONSE_SCHEMAS: Readonly<Record<string, ResponseContract>> = Object.freeze({
  [`GET ${ROUTES.healthz}`]: json(HealthResponseSchema),
  [`GET ${ROUTES.readyz}`]: responseContract(
    ReadinessResponseSchema,
    [],
    z.union([ReadinessResponseSchema, ApiErrorSchema]),
  ),

  [`GET ${ROUTES.authLogin}`]: redirect,
  [`GET ${ROUTES.authCallback}`]: redirect,
  [`GET ${ROUTES.session}`]: json(SessionResponseSchema),
  [`POST ${ROUTES.authLogout}`]: json(LogoutResponseSchema),

  [`GET ${ROUTES.sites}`]: json(SiteListResponseSchema),
  [`GET ${ROUTES.displays}`]: json(DisplayListResponseSchema),
  [`POST ${ROUTES.displays}`]: json(DisplayDtoSchema),
  [`GET ${ROUTES.displaysStatus}`]: json(DeliveryStatusListResponseSchema),
  [`GET ${ROUTES.displayPattern}`]: json(DisplayDtoSchema),
  [`PATCH ${ROUTES.displayPattern}`]: json(DisplayDtoSchema),
  [`DELETE ${ROUTES.displayPattern}`]: noContent,
  [`POST ${ROUTES.displayClaimPattern}`]: json(PairingClaimResponseSchema),
  [`POST ${ROUTES.displayRevokePlayerPattern}`]: json(RevokePlayerResponseSchema),
  [`GET ${ROUTES.displayStatusPattern}`]: json(DeliveryStatusViewSchema),

  [`GET ${ROUTES.media}`]: json(MediaListResponseSchema),
  [`POST ${ROUTES.media}`]: json(MediaUploadResponseSchema),
  [`GET ${ROUTES.mediaItemPattern}`]: json(MediaDtoSchema),
  [`PATCH ${ROUTES.mediaItemPattern}`]: json(MediaDtoSchema),
  [`DELETE ${ROUTES.mediaItemPattern}`]: noContent,
  [`GET ${ROUTES.mediaPreviewPattern}`]: bytes,
  [`GET ${ROUTES.mediaThumbnailPattern}`]: bytes,
  [`GET ${ROUTES.mediaUsagePattern}`]: json(MediaUsageResponseSchema),

  [`GET ${ROUTES.apps}`]: json(AppListResponseSchema),
  [`POST ${ROUTES.apps}`]: json(AppDtoSchema),
  [`GET ${ROUTES.appPattern}`]: json(AppDtoSchema),
  [`PATCH ${ROUTES.appPattern}`]: json(AppDtoSchema),
  [`DELETE ${ROUTES.appPattern}`]: noContent,

  [`GET ${ROUTES.schedules}`]: json(ScheduleListResponseSchema),
  [`POST ${ROUTES.schedules}`]: json(ScheduleDtoSchema),
  [`GET ${ROUTES.schedulePattern}`]: json(ScheduleDtoSchema),
  [`PUT ${ROUTES.schedulePattern}`]: json(ScheduleDtoSchema),
  [`DELETE ${ROUTES.schedulePattern}`]: noContent,

  [`GET ${ROUTES.layouts}`]: json(LayoutListResponseSchema),
  [`POST ${ROUTES.layouts}`]: json(LayoutDtoSchema),
  [`GET ${ROUTES.layoutPattern}`]: json(LayoutDtoSchema),
  [`PUT ${ROUTES.layoutPattern}`]: json(LayoutDtoSchema),
  [`DELETE ${ROUTES.layoutPattern}`]: noContent,

  [`GET ${ROUTES.tags}`]: json(TagListResponseSchema),
  [`POST ${ROUTES.tags}`]: json(TagDtoSchema),
  [`PATCH ${ROUTES.tagPattern}`]: json(TagDtoSchema),
  [`DELETE ${ROUTES.tagPattern}`]: noContent,

  [`GET ${ROUTES.folders}`]: json(FolderListResponseSchema),
  [`POST ${ROUTES.folders}`]: json(FolderDtoSchema),
  [`PATCH ${ROUTES.folderPattern}`]: json(FolderDtoSchema),
  [`DELETE ${ROUTES.folderPattern}`]: noContent,

  [`GET ${ROUTES.playlists}`]: json(PlaylistListResponseSchema),
  [`POST ${ROUTES.playlists}`]: json(PlaylistDtoSchema),
  [`GET ${ROUTES.playlistPattern}`]: json(PlaylistDtoSchema),
  [`PUT ${ROUTES.playlistPattern}`]: json(PlaylistDtoSchema),
  [`DELETE ${ROUTES.playlistPattern}`]: noContent,
  [`POST ${ROUTES.playlistDuplicatePattern}`]: json(PlaylistDuplicateResponseSchema),
  [`POST ${ROUTES.playlistPublishPattern}`]: json(PublishResponseSchema),

  [`GET ${ROUTES.push}`]: json(PushPlanResponseSchema),
  [`POST ${ROUTES.push}`]: json(PushResponseSchema),
  [`GET ${ROUTES.overview}`]: json(OverviewResponseSchema),
  [`GET ${ROUTES.audit}`]: json(AuditListResponseSchema),

  [`GET ${ROUTES.members}`]: json(MemberListResponseSchema),
  [`GET ${ROUTES.memberNames}`]: json(MemberNameListResponseSchema),
  [`PATCH ${ROUTES.memberPattern}`]: json(MemberChangeResponseSchema),
  [`POST ${ROUTES.memberRemovePattern}`]: json(MemberChangeResponseSchema),
  [`POST ${ROUTES.memberSignOutPattern}`]: json(MemberSignOutResponseSchema),
  [`GET ${ROUTES.invites}`]: json(InviteListResponseSchema),
  [`POST ${ROUTES.invites}`]: json(InviteDtoSchema),
  [`POST ${ROUTES.inviteCancelPattern}`]: noContent,

  [`GET ${ROUTES.alertRecipients}`]: json(AlertRecipientListResponseSchema),
  [`POST ${ROUTES.alertRecipients}`]: json(AlertRecipientDtoSchema),
  [`DELETE ${ROUTES.alertRecipientPattern}`]: noContent,
  [`POST ${ROUTES.alertRecipientConfirm}`]: noContent,

  [`POST ${ROUTES.playerPairing}`]: json(PairingCreateResponseSchema),
  [`GET ${ROUTES.playerPairingPollPattern}`]: json(PairingPollResponseSchema),
  // Not in ROUTES: the player gives up its own credential (docs/player-protocol-v1.md).
  [`DELETE ${PLAYER_PREFIX}/registration`]: noContent,
  // 204 while nothing is published to the display, 304 when the player has the current one.
  [`GET ${ROUTES.playerManifest}`]: json(ManifestResponseSchema, [204, 304]),
  [`POST ${ROUTES.playerMediaUrls}`]: json(MediaUrlsResponseSchema),
  [`GET ${ROUTES.playerMediaPattern}`]: bytes,
  [`POST ${ROUTES.playerHeartbeat}`]: json(HeartbeatResponseSchema),
});

/** An answer as the server is about to send it. */
export interface SentAnswer {
  readonly status: number;
  /** The `content-type` header, if any. */
  readonly contentType: string | undefined;
  /** The body as text, or undefined when it is not held as text (a stream of bytes, or none). */
  readonly body: string | undefined;
}

/** The contract of an answer no route produced (an unknown path): the error envelope only. */
export const UNROUTED_RESPONSE: ResponseContract = responseContract(null);

/**
 * The contract of every OPTIONS route: a CORS preflight (the player routes), answered from the
 * CORS configuration with 204 and no body. Like the route tables of the API, the table above
 * leaves these routes out.
 */
export const PREFLIGHT_RESPONSE: ResponseContract = responseContract(null, [204]);

const JSON_TYPE = /^application\/json\s*(;|$)/i;

/**
 * Why `answer` breaks `contract`, or null when it keeps it. The reason names the status and the
 * schema's issues (path and message), never the values.
 */
export function responseContractProblem(
  contract: ResponseContract,
  answer: SentAnswer,
): string | null {
  const { status, contentType } = answer;
  if (contentType === undefined || !JSON_TYPE.test(contentType)) {
    const sent = contentType === undefined ? 'no content type' : `content type ${contentType}`;
    if (status >= 400) {
      return `answered ${String(status)} with ${sent}: every error answer is the JSON envelope of ApiErrorSchema (apps/api/src/errors.ts)`;
    }
    if (contract.withoutJson.includes(status)) return null;
    return `answered ${String(status)} with ${sent}, a status at which its contract expects JSON: send the body its schema describes, or list the status in withoutJson of its row of ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts)`;
  }
  const schema = status >= 400 ? contract.error : contract.success;
  if (schema === null) {
    return `answered ${String(status)} with JSON, which its row of ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts) says it never sends below 400`;
  }
  let value: unknown;
  try {
    value = JSON.parse(answer.body ?? '');
  } catch {
    return `answered ${String(status)} with a JSON content type and a body that is not JSON`;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map(
      (issue) => `${issue.path.length === 0 ? '(body)' : issue.path.join('.')}: ${issue.message}`,
    );
  const more =
    parsed.error.issues.length > 5 ? `; and ${String(parsed.error.issues.length - 5)} more` : '';
  return `answered ${String(status)} with JSON that its client's schema refuses (${issues.join('; ')}${more}). Fix what the server builds, or, when the contract is what is wrong, the schema in packages/contracts`;
}

/**
 * The differences between the routes the application registers and the rows of
 * ROUTE_RESPONSE_SCHEMAS, one message each; empty when they match.
 */
export function responseContractGaps(
  registered: readonly string[],
  table: Readonly<Record<string, ResponseContract>> = ROUTE_RESPONSE_SCHEMAS,
): string[] {
  const routes = new Set(registered);
  const missing = [...routes]
    .filter((route) => !Object.hasOwn(table, route))
    .map(
      (route) =>
        `${route} has no row in ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts): add one with the schema its client parses the answer with (json(...)), or noContent, redirect or bytes`,
    );
  const stale = Object.keys(table)
    .filter((route) => !routes.has(route))
    .map(
      (route) =>
        `${route} has a row in ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts) but no route is registered for it: remove the row, or correct its method or pattern`,
    );
  return [...missing, ...stale];
}
