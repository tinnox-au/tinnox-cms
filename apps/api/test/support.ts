/**
 * Test harness: the real application (buildApp) on a real listener, against the
 * integration-test PostgreSQL database as the runtime role tinnox_app.
 *
 * Two things are substituted, and only here in test code:
 *  - Sign-in. Tests do not drive the identity provider; `signIn` creates a session
 *    row through the same sec.session_create function the callback uses. The real
 *    OIDC flow is exercised by scripts/live-check.mjs against Keycloak.
 *  - The validation worker. `actAsWorker` writes a verdict file into the outbox the
 *    way the worker container does; the API's ingestion code is the real one.
 *  - E-mail. `ctx.mail` records each message in `sentMail` instead of sending it
 *    (Mailpit is for local manual checks and the e2e run).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppDtoSchema,
  LAYOUT_UNITS,
  LayoutDtoSchema,
  ScheduleDtoSchema,
  type AppContent,
  type ApiError,
  type ApiErrorCode,
  type AuditAction,
  type AppDto,
  type LayoutDto,
  type LayoutZoneInput,
  type MediaJobResult,
  type PlaylistItemInput,
  type Role,
  type ScheduleDto,
  type ScheduleEventInput,
} from '@tinnox/contracts';
import {
  anyOf,
  MEDIA_PROCESSING_JOBS_CAP,
  mediaProcessingJobs,
  poolAsTx,
  sessionCreate,
  sha256,
  type OrgId,
} from '@tinnox/db';
import {
  testOrgId,
  unjudgedSql,
  withOrg,
  withoutOrg,
  createPool,
  type Pool,
  databaseOn,
} from '@tinnox/db/testing';
import { createDeliveryRegistry } from '@tinnox/delivery';
import { LocalObjectStorage } from '@tinnox/storage';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import sharp from 'sharp';
import { expect } from 'vitest';
import { runDisplayAlerts, type DisplayAlertDeps, type DisplayAlertResult } from '../src/alerts.ts';
import { buildApp } from '../src/app.ts';
import { IdentityProviderError, type IdentityProvider } from '../src/auth/oidc.ts';
import { ROUTE_PERMISSIONS } from '../src/auth/permissions.ts';
import { loadConfig, RUNTIME_ENV_NAMES, type AppConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import type { MailMessage, Mailer } from '../src/mail.ts';
import { MediaPipeline } from '../src/media/pipeline.ts';
import { buildMediaUrl } from '../src/security.ts';
import {
  actionsOf,
  declaredRouteAudit,
  OFF_ROUTE_AUDIT,
  OTHER_ROUTE_AUDIT,
} from '../src/route-audit.ts';
import { installResponseContractCheck } from './response-contract.ts';

// Tests outside apps/api reach this harness only as '@tinnox/api/test-support', so the types they
// need are re-exported here. RUNTIME_ENV_NAMES is deliberately not: the e2e stack takes it from
// the light entry '@tinnox/api/test-support/runtime-env' (./runtime-env.ts), so that the
// stackless layout checks never load this file (CHK-9).
export type { IdentityProvider };
// The fault harness and the race helpers (adoption plan step 33): faultHarness, faultyPool and
// statementHolds; waitForLockWaiters, waitForLockWait, twoTransactions and backendPid.
export * from './support/faults.ts';
export * from './support/race.ts';

export {
  installResponseContractCheck,
  routesCheckedForContract,
  takeResponseContractMismatches,
} from './response-contract.ts';

/**
 * What the route `${METHOD} ${pattern}` says a request to it can audit (src/route-audit.ts and
 * the `audit` field of ROUTE_PERMISSIONS): the actions of its own work, and the refusals its
 * guards record. Undefined for a route that says nothing, which the application refuses to
 * start with.
 */
export function declaredAudit(
  route: string,
): { readonly own: readonly AuditAction[]; readonly guard: readonly AuditAction[] } | undefined {
  const declared = declaredRouteAudit(route, ROUTE_PERMISSIONS);
  return declared === undefined
    ? undefined
    : { own: actionsOf(declared.audit), guard: declared.guard };
}

/** Every route with an audit statement, each with what `declaredAudit` gives for it. */
export function declaredAudits(): {
  readonly route: string;
  readonly own: readonly AuditAction[];
  readonly guard: readonly AuditAction[];
}[] {
  return [...Object.keys(ROUTE_PERMISSIONS), ...Object.keys(OTHER_ROUTE_AUDIT)].flatMap((route) => {
    const declared = declaredAudit(route);
    return declared === undefined ? [] : [{ route, ...declared }];
  });
}

/** What writes `action` outside the routes (a job, provisioning, a migration), or undefined. */
export function offRouteWriter(action: AuditAction): string | undefined {
  return OFF_ROUTE_AUDIT[action];
}

/**
 * Every route the application registers, as `${METHOD} ${pattern}` (HEAD read as GET, OPTIONS
 * left out): the keys of ROUTE_PERMISSIONS and OTHER_ROUTE_AUDIT. The start-up checks on Fastify's
 * onRoute hook (createRouteCheck, createRouteAuditCheck) refuse to start when a registered route
 * is missing from them or a key matches no route, so these are the registered routes; `app`
 * confirms each one is served.
 */
export function registeredRoutes(app: FastifyInstance): string[] {
  const routes = [...Object.keys(ROUTE_PERMISSIONS), ...Object.keys(OTHER_ROUTE_AUDIT)];
  for (const route of routes) {
    const [method = '', url = ''] = route.split(' ');
    if (!app.hasRoute({ method, url })) {
      throw new Error(`${route} has a row in the route tables but is not served`);
    }
  }
  return routes;
}

/**
 * The status each error code is answered with, written out here as the tests' own oracle. Since
 * step 28 of the adoption plan the API takes the status of an HttpError from STATUS_OF
 * (packages/contracts/src/errors.ts); this copy stays separate so that a wrong entry there fails
 * the tests that use expectError instead of moving them with it, for the codes those tests assert.
 * The unit test in packages/contracts/src/contracts.test.ts holds the whole of STATUS_OF to a
 * literal table, every code included. No route answers
 * `pairing_expired`: a poll of an expired pairing answers 200 with `{ status: 'expired' }`.
 */
export const ERROR_STATUS = Object.freeze({
  bad_request: 400,
  validation_failed: 400,
  pairing_code_invalid: 400,
  unauthenticated: 401,
  device_revoked: 401,
  forbidden: 403,
  csrf_failed: 403,
  origin_not_allowed: 403,
  url_expired: 403,
  url_signature_invalid: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  media_not_ready: 409,
  media_in_use: 409,
  playlist_in_use: 409,
  app_in_use: 409,
  schedule_in_use: 409,
  layout_in_use: 409,
  last_owner: 409,
  payload_too_large: 413,
  storage_quota_exceeded: 413,
  unsupported_media_type: 415,
  range_not_satisfiable: 416,
  publication_rejected: 422,
  rate_limited: 429,
  pairing_locked: 429,
  internal_error: 500,
  commit_outcome_unknown: 500,
  service_unavailable: 503,
  mail_not_configured: 503,
  confirmation_not_sent: 503,
} satisfies Record<Exclude<ApiErrorCode, 'pairing_expired'>, number>);
export type AnsweredErrorCode = keyof typeof ERROR_STATUS;

/**
 * Asserts that `response` is the error `code`, with the status that code is answered with, and
 * returns the error envelope. A test asserts the exact answer, never a range or "not 401": those
 * pass on a crash or a rate limit (RCX-03; the lint is NO_RANGE_STATUS in eslint.config.js).
 */
export async function expectError(
  response: Response,
  code: AnsweredErrorCode,
): Promise<ApiError['error']> {
  const text = await response.text();
  const what = `${response.status} ${text.slice(0, 300)}`;
  expect(response.status, what).toBe(ERROR_STATUS[code]);
  const body = JSON.parse(text) as ApiError;
  expect(body.error.code, what).toBe(code);
  return body.error;
}

/**
 * A media address signed with the application's own secret, on its own listener: what
 * POST /player/media-urls would hand out for these claims, valid for a minute from now.
 */
export function signedMediaUrl(
  t: TestApp,
  claims: {
    readonly registrationId: string;
    readonly publicationId: string;
    readonly assetId: string;
  },
): string {
  const expiresAtSeconds = Math.floor(t.ctx.now().getTime() / 1000) + 60;
  const url = new URL(
    buildMediaUrl(t.config.apiPublicOrigin, t.config.mediaUrlHmacSecret, {
      ...claims,
      expiresAtSeconds,
    }),
  );
  return `${t.url}${url.pathname}${url.search}`;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; run "npm run setup" and "npm run infra:up"`);
  }
  return value;
}

/**
 * The names of `env` that the API reads (RUNTIME_ENV_NAMES in src/config.ts). A test that starts
 * a real entry point gives it this, never the whole root .env: that file also holds the
 * administrator credentials, which loadConfig refuses in the process environment (D5).
 */
export function apiEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => RUNTIME_ENV_NAMES.includes(name)),
  );
}

export const PORTAL_ORIGIN = 'http://localhost:5173';
export const PLAYER_ORIGIN = 'http://localhost:5174';

/** Sign-in is not under test here; any attempt to use the provider fails loudly. */
const noIdentityProvider: IdentityProvider = {
  beginLogin: (_options?: { readonly reauthenticate?: boolean }) =>
    Promise.reject(new IdentityProviderError('unavailable', 'not available in tests')),
  completeLogin: () =>
    Promise.reject(new IdentityProviderError('unavailable', 'not available in tests')),
  endSessionUrl: () => Promise.resolve(null),
  check: () => Promise.resolve(false),
};

export interface TestApp {
  readonly app: FastifyInstance;
  readonly ctx: AppContext;
  readonly config: AppConfig;
  /**
   * The application's own pool: every route, the media pipeline and the alert check use it,
   * through `ctx.db`, the handle `databaseOn(pool)` of @tinnox/db/testing gave it.
   */
  readonly pool: Pool;
  /**
   * A second pool as tinnox_app, for SQL a test writes itself: arranging rows no route makes,
   * ending a member's sessions under a route's feet, a sign-in without the provider. The
   * audit-debt guard of the test database judges every write on `pool`, which is product code,
   * and none on this one (packages/db/src/audit-debt-guard.ts), so each use says why: `why` is
   * what the SQL is, and never a route's or a job's own call. Reading on `pool` is fine.
   */
  testSql(why: string): Pool;
  readonly url: string;
  readonly jobsDir: string;
  readonly mediaRoot: string;
  /** Every message given to `ctx.mail`, in order (the default recording mailer). */
  readonly sentMail: MailMessage[];
  /** Moves the application clock forward (signed URL expiry, staleness, job deadlines). */
  advanceClock(ms: number): void;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Wraps the app's database pool, for example to inject a fault (used by every route and the pipeline). */
  readonly wrapPool?: (pool: Pool) => Pool;
  /** Replaces the recording mailer; null is a server without SMTP. */
  readonly mail?: Mailer | null;
  /** Replaces the identity provider, which otherwise refuses every sign-in and has no sign-out address. */
  readonly identityProvider?: IdentityProvider;
}

export async function startTestApp(
  limitOverrides: Record<string, string> = {},
  rateLimitScale = 1000,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const scratch = await mkdtemp(join(tmpdir(), 'tinnox-api-test-'));
  const jobsDir = join(scratch, 'jobs');
  const mediaRoot = join(scratch, 'media');
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: need('TEST_DATABASE_URL'),
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    API_PUBLIC_ORIGIN: 'http://localhost:4000',
    PORTAL_ORIGIN,
    PLAYER_ORIGIN,
    // Random per run: tests never depend on the development secrets.
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    MEDIA_URL_HMAC_SECRET: randomBytes(32).toString('base64url'),
    PAIRING_CLIENT_KEY_SECRET: randomBytes(32).toString('base64url'),
    OIDC_ISSUER: 'http://localhost:8080/realms/tinnox-dev',
    OIDC_CLIENT_ID: 'tinnox-portal-bff',
    OIDC_CLIENT_SECRET: randomBytes(24).toString('base64url'),
    OIDC_REDIRECT_URI: `${PORTAL_ORIGIN}/api/auth/callback`,
    OIDC_POST_LOGOUT_REDIRECT_URI: `${PORTAL_ORIGIN}/`,
    MEDIA_ROOT: mediaRoot,
    MEDIA_JOBS_DIR: jobsDir,
    LIMIT_PAIRING_MAX_SESSIONS_PER_IP: '100000',
    ...limitOverrides,
  });
  let offsetMs = 0;
  const now = (): Date => new Date(Date.now() + offsetMs);
  const created = createPool({
    connectionString: config.databaseUrl,
    applicationName: 'tinnox-api-test',
    max: 12,
  });
  const pool = options.wrapPool?.(created) ?? created;
  // What the API holds in place of the pool (AppContext.db), as createDatabase gives main.ts.
  const db = databaseOn(pool);
  const testSqlPool = createPool({
    connectionString: config.databaseUrl,
    applicationName: unjudgedSql(
      'the API harness pool for SQL a test writes itself; each use of testSql() gives its own reason',
    ),
    max: 4,
  });
  const storage = await LocalObjectStorage.create({ root: mediaRoot });
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const media = new MediaPipeline({
    jobsDir,
    db,
    storage,
    limits: config.limits,
    logger: silent,
    now,
  });
  await media.prepare();
  const sentMail: MailMessage[] = [];
  const recording: Mailer = {
    send: (message) => {
      sentMail.push(message);
      return Promise.resolve();
    },
  };
  const ctx: AppContext = {
    config,
    db,
    storage,
    delivery: createDeliveryRegistry({
      browser: {
        maxAssetBytes: config.limits.maxUploadBytes,
        maxItems: config.limits.maxPlaylistItems,
        maxVideoWidthPx: config.limits.maxVideoWidthPx,
        maxVideoHeightPx: config.limits.maxVideoHeightPx,
      },
    }),
    idp: options.identityProvider ?? noIdentityProvider,
    media,
    mail: options.mail === undefined ? recording : options.mail,
    now,
    rateLimitScale,
  };
  const app = await buildApp(ctx, { logger: false });
  // Every answer of every test is parsed with the schema its client parses it with (UTX-01).
  installResponseContractCheck(app, registeredRoutes(app));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    app,
    ctx,
    config,
    pool,
    testSql(why: string): Pool {
      unjudgedSql(why); // refuses a use with no reason
      return testSqlPool;
    },
    url: `http://127.0.0.1:${address.port}`,
    jobsDir,
    mediaRoot,
    sentMail,
    advanceClock(ms: number): void {
      offsetMs += ms;
    },
    async close(): Promise<void> {
      await app.close();
      await media.stop();
      await created.end();
      await testSqlPool.end();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

export interface TestOrg {
  readonly orgId: OrgId;
  readonly siteId: string;
  readonly membershipId: string;
  readonly oidcSub: string;
}

/**
 * Creates an organisation with one site and one member, as the migrator (arranging data only).
 * The member is an Owner unless `role` says otherwise, and has no display name unless one is
 * given.
 */
export async function createOrg(
  name: string,
  options: { readonly role?: Role; readonly displayName?: string | null } = {},
): Promise<TestOrg> {
  const org: TestOrg = {
    orgId: testOrgId(randomUUID()),
    siteId: randomUUID(),
    membershipId: randomUUID(),
    oidcSub: `api-test-${randomUUID()}`,
  };
  const client = new pg.Client({ connectionString: need('TEST_DATABASE_MIGRATOR_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    await client.query('INSERT INTO organization (id, name) VALUES ($1, $2)', [org.orgId, name]);
    await client.query('INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, $3, $4)', [
      org.siteId,
      org.orgId,
      `${name} site`,
      'Australia/Melbourne',
    ]);
    await client.query(
      'INSERT INTO membership (id, org_id, oidc_sub, role, display_name) VALUES ($1, $2, $3, $4, $5)',
      [
        org.membershipId,
        org.orgId,
        org.oidcSub,
        options.role ?? 'owner',
        options.displayName ?? null,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
  return org;
}

/** Adds another member to an organisation, an Owner unless `role` says otherwise. */
export async function addMember(
  org: TestOrg,
  role: Role = 'owner',
  displayName: string | null = null,
): Promise<TestOrg> {
  const member: TestOrg = {
    ...org,
    membershipId: randomUUID(),
    oidcSub: `api-test-${randomUUID()}`,
  };
  const client = new pg.Client({ connectionString: need('TEST_DATABASE_MIGRATOR_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    await client.query(
      'INSERT INTO membership (id, org_id, oidc_sub, role, display_name) VALUES ($1, $2, $3, $4, $5)',
      [member.membershipId, member.orgId, member.oidcSub, role, displayName],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
  return member;
}

export interface Operator {
  /** Sends a request as the signed-in operator; state-changing methods get Origin and the CSRF token. */
  fetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  readonly cookie: string;
  readonly csrfToken: string;
}

/**
 * Creates a session for the member through sec.session_create and returns a client that uses it.
 * `authTime` defaults to a minute from now, after any cut-off a test has set (even within the
 * same second, or with the database clock a little ahead; nothing checks an upper bound). Tests
 * of the cut-off pass their own.
 */
export async function signIn(
  t: TestApp,
  org: TestOrg,
  options: { readonly authTime?: Date | null } = {},
): Promise<Operator> {
  const sessionId = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  // In a transaction, as the callback route calls it: sessionCreate takes a PreOrgTx (D2). On the
  // test's own pool: the callback writes auth.login with the session, and this stand-in for it
  // writes no audit row, which the audit-debt guard would refuse on the application's pool.
  const created = await withoutOrg(
    t.testSql('a sign-in without the provider, standing in for the callback'),
    (tx) =>
      sessionCreate(tx, {
        idHash: sha256(sessionId),
        oidcSub: org.oidcSub,
        csrfToken,
        ttlSeconds: 3600,
        idToken: null,
        authTime: options.authTime === undefined ? new Date(Date.now() + 60_000) : options.authTime,
      }),
  );
  if (created.outcome !== 'created') {
    throw new Error(`test member could not sign in: ${created.outcome}`);
  }
  const cookie = `${t.config.sessionCookieName}=${sessionId}`;
  return {
    cookie,
    csrfToken,
    fetch(path, init = {}) {
      const { json, ...rest } = init;
      const method = (rest.method ?? 'GET').toUpperCase();
      const headers = new Headers(rest.headers);
      headers.set('cookie', cookie);
      if (method !== 'GET' && method !== 'HEAD') {
        if (!headers.has('origin')) headers.set('origin', PORTAL_ORIGIN);
        if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', csrfToken);
      }
      if (json !== undefined) headers.set('content-type', 'application/json');
      return fetch(`${t.url}${path}`, {
        ...rest,
        method,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
    },
  };
}

export async function createDisplay(
  operator: Operator,
  org: TestOrg,
  name = 'Test display',
): Promise<{ id: string }> {
  const response = await operator.fetch('/api/displays', {
    method: 'POST',
    json: { siteId: org.siteId, name, canvas: { width: 640, height: 360 } },
  });
  if (response.status !== 201) throw new Error(`display create failed: ${response.status}`);
  return (await response.json()) as { id: string };
}

export async function pngBytes(width = 32, height = 16): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: randomBytes(1)[0] ?? 0, g: 80, b: 160 },
    },
  })
    .png()
    .toBuffer();
}

/** Format and pixel size of an image, decoded here in test code only (the API never decodes). */
export async function imageMetadata(
  bytes: Uint8Array,
): Promise<{ format: string | null; width: number; height: number }> {
  const meta = await sharp(bytes).metadata();
  return { format: meta.format ?? null, width: meta.width ?? 0, height: meta.height ?? 0 };
}

export async function uploadBytes(
  operator: Operator,
  bytes: Uint8Array,
  name = 'sample.png',
): Promise<Response> {
  const body = new FormData();
  body.set('file', new Blob([Uint8Array.from(bytes)]), name);
  return operator.fetch('/api/media', { method: 'POST', body });
}

/** Writes a verdict into the outbox exactly as the worker container does (temp file, then rename). */
export async function actAsWorker(
  t: TestApp,
  result: MediaJobResult | string,
  jobId?: string,
): Promise<void> {
  const id = typeof result === 'string' ? jobId : result.jobId;
  if (id === undefined) throw new Error('job id is required for a raw verdict');
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  await writeFile(join(t.jobsDir, 'outbox', `${id}.json`), text);
}

/** Uploads a PNG, lets the "worker" accept it and has the API ingest the verdict. Returns the ready media. */
export async function readyImage(
  t: TestApp,
  operator: Operator,
  size: { width: number; height: number } = { width: 32, height: 16 },
): Promise<{ id: string; bytes: number; sha256: string }> {
  const upload = await uploadBytes(operator, await pngBytes(size.width, size.height));
  if (upload.status !== 201)
    throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  const { media } = (await upload.json()) as { media: { id: string } };
  await actAsWorker(t, {
    schemaVersion: 1,
    jobId: media.id,
    outcome: 'accepted',
    kind: 'image',
    mimeType: 'image/png',
    width: size.width,
    height: size.height,
    durationMs: null,
    codec: null,
  });
  await t.ctx.media.tick();
  const after = await operator.fetch(`/api/media/${media.id}`);
  const dto = (await after.json()) as { id: string; status: string; bytes: number; sha256: string };
  if (dto.status !== 'ready') throw new Error(`media did not become ready: ${JSON.stringify(dto)}`);
  return dto;
}

export interface PairedPlayer {
  readonly deviceToken: string;
  readonly registrationId: string;
  readonly headers: Record<string, string>;
}

/** Runs the whole pairing flow over HTTP: player asks, operator claims, player collects. */
export async function pairPlayer(
  t: TestApp,
  operator: Operator,
  displayId: string,
): Promise<PairedPlayer> {
  const created = await fetch(`${t.url}/player/pairing`, { method: 'POST' });
  const pairing = (await created.json()) as {
    pairingId: string;
    code: string;
    pollingToken: string;
  };
  const claim = await operator.fetch(`/api/displays/${displayId}/claim`, {
    method: 'POST',
    json: { code: pairing.code },
  });
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.status}`);
  const poll = await fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
    headers: { authorization: `Bearer ${pairing.pollingToken}` },
  });
  const body = (await poll.json()) as {
    status: string;
    deviceToken: string;
    registrationId: string;
  };
  if (body.status !== 'claimed') throw new Error(`pairing was not completed: ${body.status}`);
  return {
    deviceToken: body.deviceToken,
    registrationId: body.registrationId,
    headers: { authorization: `Bearer ${body.deviceToken}` },
  };
}

/** Creates a playlist with the given image ids (5 s each) and publishes it to the display. */
export async function publishImages(
  operator: Operator,
  displayId: string,
  mediaIds: readonly string[],
): Promise<{ publicationId: string; playlistId: string }> {
  const playlist = (await (
    await operator.fetch('/api/playlists', { method: 'POST', json: { name: 'Test playlist' } })
  ).json()) as { id: string };
  const put = await operator.fetch(`/api/playlists/${playlist.id}`, {
    method: 'PUT',
    json: {
      name: 'Test playlist',
      items: mediaIds.map((mediaId) => ({ mediaId, durationMs: 5000, fit: null })),
    },
  });
  if (put.status !== 200) throw new Error(`playlist save failed: ${put.status}`);
  const publish = await operator.fetch(`/api/playlists/${playlist.id}/publish`, {
    method: 'POST',
    json: { displayId },
    headers: { 'idempotency-key': randomUUID() },
  });
  if (publish.status !== 201)
    throw new Error(`publish failed: ${publish.status} ${await publish.text()}`);
  const body = (await publish.json()) as { publicationId: string };
  return { publicationId: body.publicationId, playlistId: playlist.id };
}

/**
 * Uploads bytes that begin like an MP4 file and lets the "worker" accept them as an
 * H.264 video. Nothing decodes the bytes here; the real worker is exercised by
 * tests/integration/media-worker.test.ts.
 */
export async function readyVideo(
  t: TestApp,
  operator: Operator,
  durationMs = 8000,
): Promise<{ id: string }> {
  const head = Buffer.from([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const upload = await uploadBytes(operator, Buffer.concat([head, randomBytes(52)]), 'clip.mp4');
  if (upload.status !== 201)
    throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  const { media } = (await upload.json()) as { media: { id: string } };
  await actAsWorker(t, {
    schemaVersion: 1,
    jobId: media.id,
    outcome: 'accepted',
    kind: 'video',
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationMs,
    codec: 'h264',
  });
  await t.ctx.media.tick();
  const after = await operator.fetch(`/api/media/${media.id}`);
  const dto = (await after.json()) as { id: string; status: string };
  if (dto.status !== 'ready') throw new Error(`video did not become ready: ${JSON.stringify(dto)}`);
  return { id: dto.id };
}

/** Creates a playlist and, when items are given, saves them. Returns its id. */
export async function createPlaylist(
  operator: Operator,
  name: string,
  items: readonly PlaylistItemInput[] = [],
): Promise<string> {
  const created = await operator.fetch('/api/playlists', { method: 'POST', json: { name } });
  if (created.status !== 201) throw new Error(`playlist create failed: ${created.status}`);
  const { id } = (await created.json()) as { id: string };
  if (items.length > 0) {
    const saved = await operator.fetch(`/api/playlists/${id}`, {
      method: 'PUT',
      json: { name, items },
    });
    if (saved.status !== 200)
      throw new Error(`playlist save failed: ${saved.status} ${await saved.text()}`);
  }
  return id;
}

/** One image item of `seconds` seconds with the display's default fit. */
export function imageItem(mediaId: string, seconds = 5): PlaylistItemInput {
  return { mediaId, durationMs: seconds * 1000, fit: null };
}

/** A 24-hour Clock with seconds, white on black. */
export const CLOCK: AppContent = {
  type: 'clock',
  settings: {
    hourCycle: '24',
    showSeconds: true,
    textColour: '#ffffff',
    backgroundColour: '#000000',
  },
};

/** Creates an app through the API and returns it. */
export async function createApp(
  operator: Operator,
  content: AppContent = CLOCK,
  name = 'Lobby clock',
): Promise<AppDto> {
  const response = await operator.fetch('/api/apps', { method: 'POST', json: { name, content } });
  if (response.status !== 201)
    throw new Error(`app create failed: ${response.status} ${await response.text()}`);
  return AppDtoSchema.parse(await response.json());
}

/** One app item of `seconds` seconds. */
export function appItem(appId: string, seconds = 10): PlaylistItemInput {
  return { appId, durationMs: seconds * 1000 };
}

/** Assigns a playlist to a display (null removes the assignment). Nothing is pushed. */
export async function assignPlaylist(
  operator: Operator,
  displayId: string,
  playlistId: string | null,
): Promise<void> {
  const response = await operator.fetch(`/api/displays/${displayId}`, {
    method: 'PATCH',
    json: { assignedPlaylistId: playlistId },
  });
  if (response.status !== 200)
    throw new Error(`assignment failed: ${response.status} ${await response.text()}`);
}

/** One weekly event for the playlist: every day unless `days` (Monday first) says otherwise. */
export function scheduleEvent(
  playlistId: string,
  start = '09:00',
  end = '17:00',
  days: readonly boolean[] = [true, true, true, true, true, true, true],
): ScheduleEventInput {
  return { playlistId, days: [...days], start, end };
}

/** Creates a schedule through the API and returns it. `events` are in priority order. */
export async function createSchedule(
  operator: Operator,
  name: string,
  defaultPlaylistId: string,
  events: readonly ScheduleEventInput[] = [],
): Promise<ScheduleDto> {
  const response = await operator.fetch('/api/schedules', {
    method: 'POST',
    json: { name, defaultPlaylistId, events },
  });
  if (response.status !== 201)
    throw new Error(`schedule create failed: ${response.status} ${await response.text()}`);
  return ScheduleDtoSchema.parse(await response.json());
}

/**
 * Assigns a schedule to a display, which takes a playlist off it (null removes
 * the schedule). Nothing is pushed.
 */
export async function assignSchedule(
  operator: Operator,
  displayId: string,
  scheduleId: string | null,
): Promise<void> {
  const response = await operator.fetch(`/api/displays/${displayId}`, {
    method: 'PATCH',
    json: { assignedScheduleId: scheduleId },
  });
  if (response.status !== 200)
    throw new Error(`assignment failed: ${response.status} ${await response.text()}`);
}

/**
 * The portal's one preset: a main zone over the whole width and a band of `bandPercent` %
 * of the height along the bottom, in basis points.
 */
export function layoutZones(
  mainPlaylistId: string,
  bandPlaylistId: string,
  bandPercent = 15,
): LayoutZoneInput[] {
  const band = bandPercent * 100;
  return [
    { playlistId: mainPlaylistId, x: 0, y: 0, width: LAYOUT_UNITS, height: LAYOUT_UNITS - band },
    { playlistId: bandPlaylistId, x: 0, y: LAYOUT_UNITS - band, width: LAYOUT_UNITS, height: band },
  ];
}

/** Creates a layout through the API and returns it. `zones[0]` is the main zone. */
export async function createLayout(
  operator: Operator,
  name: string,
  zones: readonly LayoutZoneInput[],
): Promise<LayoutDto> {
  const response = await operator.fetch('/api/layouts', { method: 'POST', json: { name, zones } });
  if (response.status !== 201)
    throw new Error(`layout create failed: ${response.status} ${await response.text()}`);
  return LayoutDtoSchema.parse(await response.json());
}

/**
 * Assigns a layout to a display, which takes a playlist or a schedule off it (null
 * removes the layout). Nothing is pushed.
 */
export async function assignLayout(
  operator: Operator,
  displayId: string,
  layoutId: string | null,
): Promise<void> {
  const response = await operator.fetch(`/api/displays/${displayId}`, {
    method: 'PATCH',
    json: { assignedLayoutId: layoutId },
  });
  if (response.status !== 200)
    throw new Error(`assignment failed: ${response.status} ${await response.text()}`);
}

/** `POST /api/push` for the given displays; a fresh Idempotency-Key unless one is passed. */
export function push(
  operator: Operator,
  displayIds: readonly string[],
  key: string = randomUUID(),
): Promise<Response> {
  return operator.fetch('/api/push', {
    method: 'POST',
    json: { displayIds },
    headers: { 'idempotency-key': key },
  });
}

/** The publication a display is currently meant to play, as its status view reports it. */
export async function desiredPublicationId(
  operator: Operator,
  displayId: string,
): Promise<string | null> {
  const response = await operator.fetch(`/api/displays/${displayId}/status`);
  if (response.status !== 200) throw new Error(`status failed: ${response.status}`);
  const view = (await response.json()) as { desired: { publicationId: string } | null };
  return view.desired?.publicationId ?? null;
}

export interface AuditEntry {
  readonly action: string;
  readonly result: string;
  readonly actorId: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly detail: Record<string, unknown> | null;
}

/** The newest audit events of the operator's organisation, newest first. */
export async function auditEvents(operator: Operator, filter = ''): Promise<AuditEntry[]> {
  const response = await operator.fetch(`/api/audit?limit=200${filter}`);
  if (response.status !== 200) throw new Error(`audit list failed: ${response.status}`);
  return ((await response.json()) as { items: AuditEntry[] }).items;
}

/**
 * Fails every media row that is still waiting for validation, in whatever
 * organisation, and returns how many there were.
 *
 * The pipeline has one queue for the whole database, oldest job first, and the
 * deadline of a job grows with every job ahead of it. A test file that finished
 * may have left rows in `processing` (an upload that was never given a verdict,
 * a media row inserted for a database test), and for 30 seconds nothing clears
 * them. A test that measures when a job times out calls this first, so that its
 * result does not depend on which file happened to run before it.
 */
export async function settleStrayMediaJobs(pool: Pool): Promise<number> {
  let settled = 0;
  for (;;) {
    // Through the typed wrapper: the organisation it names is what withOrg takes.
    const jobs = anyOf(
      await mediaProcessingJobs(poolAsTx(databaseOn(pool)), MEDIA_PROCESSING_JOBS_CAP),
    );
    if (jobs.length === 0) return settled;
    const byOrg = new Map<OrgId, string[]>();
    for (const job of jobs) byOrg.set(job.orgId, [...(byOrg.get(job.orgId) ?? []), job.mediaId]);
    let changed = 0;
    for (const [orgId, mediaIds] of byOrg) {
      changed += await withOrg(pool, orgId, async (tx) => {
        const done = await tx.query(
          `UPDATE media
           SET status = 'failed', error_code = 'inspection_timeout',
               error_detail = 'Left in processing by an earlier test file.'
           WHERE org_id = app_org_id() AND id = ANY($1::uuid[]) AND status = 'processing'`,
          [mediaIds],
        );
        return done.rowCount ?? 0;
      });
    }
    if (changed === 0) throw new Error('media rows in processing could not be settled');
    settled += changed;
  }
}

export async function listDir(path: string): Promise<string[]> {
  return (await readdir(path)).filter((name) => !name.startsWith('.worker-alive'));
}

/** The in-write role check of every write transaction (membershipForCheck, auth/permissions.ts). */
export const isRoleCheck = (text: string): boolean =>
  text.includes('FROM membership WHERE id = $1 AND org_id = app_org_id() FOR SHARE');

/**
 * Runs the e-mail alert check once at the app's clock, sending through `ctx.mail` unless given
 * another, and logging nowhere unless given a logger.
 */
export function checkAlerts(
  t: TestApp,
  overrides: Partial<Pick<DisplayAlertDeps, 'mail' | 'shouldStop' | 'logger'>> = {},
): Promise<DisplayAlertResult> {
  const mail = overrides.mail ?? t.ctx.mail;
  if (mail === null) throw new Error('this test app has no mailer');
  return runDisplayAlerts({
    db: t.ctx.db,
    now: t.ctx.now(),
    mail,
    portalOrigin: t.config.portalOrigin,
    logger: overrides.logger ?? { error: () => undefined },
    shouldStop: overrides.shouldStop,
  });
}

/**
 * Arranging only: runs `work` as the migrator in one committed transaction with the
 * organisation's context, which row-level security and membership_guard need (stage-c.md 9.3).
 */
export async function asMigratorIn(
  orgId: string,
  work: (client: pg.Client) => Promise<unknown>,
): Promise<void> {
  const client = new pg.Client({ connectionString: need('TEST_DATABASE_MIGRATOR_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
