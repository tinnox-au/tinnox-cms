/**
 * The commit-outcome table (adoption plan sections 2.3 and 4.2, step 33; decisions D3 and D9;
 * AGENTS.md section 3): for every route that changes state, what a request answers and what it
 * leaves behind when its transaction is struck by a fault of ./support/faults.ts.
 *
 * TABLE is data: one row per route, as the application registers it, with the arrange step of a
 * request that changes something and what each fault mode must leave. The first test below
 * compares its keys with the routes the application serves (`registeredRoutes`, the inventory
 * the cross-organisation conformance test of step 23 uses), so a state-changing route without a
 * row fails there, with the place to add it.
 *
 * The modes, each delivered for real by the harness and proven by `delivered`:
 *
 *  - `statement-timeout`: PostgreSQL cancels a statement of the change (57014) once everything
 *    the change writes has been sent; the transaction rolls back and the route knows it.
 *  - `lock-timeout`: the same with a wait past lock_timeout (55P03).
 *  - `backend-killed`: the backend is ended mid-transaction; the server rolls back.
 *  - `lost-commit-answer`: the COMMIT is sent and answered, and the connection is lost before
 *    the answer arrives: the change is stored and the route cannot know it.
 *
 * The faults strike at the audit row of the change, the last statement before COMMIT, unless a
 * row names another statement (a route that audits nothing). For each row and mode the test
 * asserts:
 *
 *  1. the wire answer: status, error code, `retry-after`, and for `commit_outcome_unknown` D9's
 *     message and `no-store`;
 *  2. the database: after a known rollback the state the change alters is what it was and no
 *     audit row was written; after a lost COMMIT answer the state changed and exactly the
 *     change's audit rows are there (both or neither, AGENTS.md section 3);
 *  3. nothing outside the transaction: no e-mail in the outbox and no file under the media root
 *     or the job folder that was not there before, in every mode, a lost COMMIT answer included
 *     unless the row says what is kept (the bytes of an upload, whose row may exist).
 *
 * D9: `commit_outcome_unknown` is the answer in the lost-COMMIT mode only, and only where the
 * transaction is not READ ONLY and the method changes state; the third test holds the table to
 * that. A row whose behaviour is pinned as found, not as decided, says so in a comment.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@tinnox/db';
import { whileUnauditedAllowed, type Pool, type PoolClient } from '@tinnox/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../src/auth/permissions.ts';
import { COMMIT_OUTCOME_UNKNOWN_MESSAGE } from '../src/errors.ts';
import { declaredRouteAudit } from '../src/route-audit.ts';
import {
  addMember,
  assignPlaylist,
  backendPid,
  capturedLogs,
  CLOCK,
  createApp,
  createDisplay,
  createLayout,
  createOrg,
  createPlaylist,
  createSchedule,
  declaredAudit,
  desiredPublicationId,
  expectError,
  faultHarness,
  imageItem,
  layoutZones,
  pairPlayer,
  pngBytes,
  PORTAL_ORIGIN,
  publishImages,
  push,
  readyImage,
  registeredRoutes,
  signIn,
  startTestApp,
  uploadBytes,
  waitForLockWaiters,
  type AnsweredErrorCode,
  type Fault,
  type IdentityProvider,
  type Operator,
  type PairedPlayer,
  type StatementMatcher,
  type TestApp,
  type TestOrg,
} from './support.ts';

const HERE = 'TABLE in apps/api/test/commit-outcome.integration.test.ts';

/** The four modes every row runs, in this order: the three known rollbacks, then the lost answer. */
const MODES = [
  'statement-timeout',
  'lock-timeout',
  'backend-killed',
  'lost-commit-answer',
] as const;
/**
 * The modes only the sign-in callback adds (SCR-07): the other transient failures raised for
 * real, and a database error that is not transient. `database-error` is the one fault the
 * harness does not make PostgreSQL raise: the callback's transaction has no statement a test
 * can make fail otherwise, so the error is the test's own (`never-sent` with an error).
 */
const CALLBACK_MODES = ['deadlock', 'serialization-failure', 'database-error'] as const;
type Mode = (typeof MODES)[number] | (typeof CALLBACK_MODES)[number];
const LOST = 'lost-commit-answer' satisfies Mode;

/** What a request answers: an error of the envelope, a redirect to the portal, or its 200. */
type Answer =
  | { readonly error: AnsweredErrorCode; readonly retryAfter?: string }
  | { readonly redirect: string }
  | { readonly ok: unknown };
const error = (code: AnsweredErrorCode): Answer => ({ error: code });
/** A wait past lock_timeout as every write answers it. */
const BUSY: Answer = { error: 'service_unavailable', retryAfter: '2' };

/** How the route opens the transaction the faults strike: it decides the default answers. */
type Through = 'changeAsOperator' | 'changeAsDevice' | 'changePreOrg' | 'readOrg';

const FAILED = error('internal_error');
const DEFAULT_ANSWERS: Record<Through, Record<(typeof MODES)[number], Answer>> = {
  changeAsOperator: {
    'statement-timeout': FAILED,
    'lock-timeout': BUSY,
    'backend-killed': FAILED,
    'lost-commit-answer': error('commit_outcome_unknown'),
  },
  changeAsDevice: {
    'statement-timeout': FAILED,
    'lock-timeout': BUSY,
    'backend-killed': FAILED,
    'lost-commit-answer': error('commit_outcome_unknown'),
  },
  // Each route on changePreOrg maps a lock timeout itself, with lockTimeoutAsUnavailable, as
  // changeAsOperator and changeAsDevice do for theirs (Michael, 25 Nov 2026).
  changePreOrg: {
    'statement-timeout': FAILED,
    'lock-timeout': BUSY,
    'backend-killed': FAILED,
    'lost-commit-answer': error('commit_outcome_unknown'),
  },
  // A READ ONLY transaction changed nothing, whether or not its COMMIT arrived (D9).
  readOrg: {
    'statement-timeout': FAILED,
    'lock-timeout': FAILED,
    'backend-killed': FAILED,
    'lost-commit-answer': FAILED,
  },
};

/** What is outside the database: the e-mails sent, and every file of the media root and the jobs. */
interface Outside {
  readonly mail: number;
  readonly files: readonly string[];
}

/** One arranged request of a row, sent once per mode. */
interface Scenario {
  /** Runs before each mode, for a request that needs something fresh (a session to end). */
  prepare?(): Promise<void>;
  /** Sends the request: a real one, through the listener. */
  send(): Promise<Response>;
  /** What the change alters, read as the database administrator. */
  state(): Promise<unknown>;
  /** The other side of the `serialization-failure` mode: it has changed a row `at` locks. */
  rival?(): Promise<PoolClient>;
  /** More to assert on the answer of a mode (a cookie that must not be set). */
  check?(mode: Mode, response: Response): void;
  /** After the lost COMMIT answer: what a repeat of the request answers, and what it leaves. */
  afterUnknown?(): Promise<void>;
  /** After the lost COMMIT answer: what is kept outside the database, when something is. */
  outsideAfterUnknown?(before: Outside, after: Outside): Promise<void>;
}

/** One row of the table. */
interface Row {
  readonly through: Through;
  arrange(): Promise<Scenario>;
  /** The statement the faults strike at; the audit row of the change unless given. */
  readonly at?: StatementMatcher;
  /** The statement a mode strikes at, where it needs one of its own. */
  readonly atIn?: Partial<Record<Mode, StatementMatcher>>;
  /** The modes beyond MODES this row runs. */
  readonly more?: readonly (typeof CALLBACK_MODES)[number][];
  /** The answers that differ from DEFAULT_ANSWERS[through], and those of the modes of `more`. */
  readonly answers?: Partial<Record<Mode, Answer>>;
  /**
   * The audit rows of the committed change, as `action:result` or `action:result:reason`, with
   * ` unscoped` for a row with no organisation. The one action the route states, a success,
   * unless given.
   */
  readonly audits?: readonly string[];
  /** The audit rows a known rollback leaves in a mode: none unless given. */
  readonly auditsAfterRollback?: Partial<Record<Mode, readonly string[]>>;
  /** What a known rollback leaves of the state, when that is not "what it was". */
  readonly rollbackLeaves?: (before: unknown, after: unknown) => void;
  /** False for a route that only reads: a lost COMMIT answer leaves the state as it was. */
  readonly changes?: false;
  /** Wraps the request of a mode (the audit-debt guard's leave for a recorded residual). */
  readonly around?: (mode: Mode, work: () => Promise<Response>) => Promise<Response>;
}

/** A route with no transaction of its own to strike, and the reason. */
interface NoTransaction {
  readonly noTransaction: string;
  /** Sends the request; it must answer `answers` without opening a transaction. */
  send(): Promise<Response>;
  readonly answers: number;
}

const AT_AUDIT: StatementMatcher = (text) =>
  /^\s*INSERT INTO audit_event \(org_id/.test(text) || text.includes('sec.audit_unscoped(');

const faults = faultHarness();
/** What the application logged, for the sign-out catch-all's log lines. */
const logs = capturedLogs();
let t: TestApp;
let org: TestOrg;
let owner: Operator;
/** The test's own statements, never wrapped. */
let sql: Pool;
let admin: pg.Client;

/** The subject the stand-in identity provider answers a sign-in with, and its last state. */
let signingIn = '';
let lastState = '';
const provider: IdentityProvider = {
  beginLogin: (_options?: { readonly reauthenticate?: boolean }) => {
    lastState = randomUUID();
    return Promise.resolve({
      state: lastState,
      nonce: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(32).toString('base64url'),
      url: 'http://localhost:8080/sign-in',
    });
  },
  completeLogin: () =>
    Promise.resolve({ sub: signingIn, acr: null, amr: [], idToken: null, authTime: null }),
  endSessionUrl: () => Promise.resolve(null),
  check: () => Promise.resolve(true),
};

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}
const migratorUrl = (): string => need('TEST_DATABASE_MIGRATOR_URL');

/** One read as the database administrator, who sees every organisation's rows and those with none. */
async function administrator<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  return (await admin.query<R>(text, [...values])).rows;
}

/** The whole row of `table` whose `column` is `value`, or null: any column a change touches shows. */
async function rowOf(table: string, value: string, column = 'id'): Promise<unknown> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error('unexpected name');
  const rows = await administrator<{ row: unknown }>(
    `SELECT to_jsonb(x) AS row FROM public.${table} x WHERE x.${column} = $1`,
    [value],
  );
  return rows[0]?.row ?? null;
}

/** How many rows of `table` have `column` = `value`. */
async function countOf(table: string, column: string, value: string): Promise<number> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error('unexpected name');
  const rows = await administrator<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.${table} x WHERE x.${column} = $1`,
    [value],
  );
  return rows[0]?.n ?? 0;
}

/** The id of the newest audit row, in any organisation or none. */
async function newestAuditRow(): Promise<string> {
  const rows = await administrator<{ id: string }>(
    'SELECT coalesce(max(id), 0)::text AS id FROM public.audit_event',
  );
  return rows[0]?.id ?? '0';
}

/** The audit rows written after row `id`, oldest first, in the notation of Row.audits. */
async function auditRowsAfter(id: string): Promise<string[]> {
  const rows = await administrator<{
    action: string;
    result: string;
    reason: string | null;
    unscoped: boolean;
  }>(
    `SELECT action, result, detail->>'reason' AS reason, org_id IS NULL AS unscoped
       FROM public.audit_event WHERE id > $1::bigint ORDER BY id`,
    [id],
  );
  return rows.map(
    (row) =>
      `${row.action}:${row.result}${row.reason === null ? '' : `:${row.reason}`}${row.unscoped ? ' unscoped' : ''}`,
  );
}

/** Every file under `root`, relative to it. */
async function filesUnder(root: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(join(root, entry.name), path)));
    else found.push(path);
  }
  return found.sort();
}

async function outside(): Promise<Outside> {
  return {
    mail: t.sentMail.length,
    files: [...(await filesUnder(t.jobsDir, 'jobs')), ...(await filesUnder(t.mediaRoot, 'media'))],
  };
}

const send = (
  operator: Operator,
  method: string,
  path: string,
  json?: unknown,
): Promise<Response> => operator.fetch(path, json === undefined ? { method } : { method, json });

/** The id of a row a POST created. */
async function created(response: Promise<Response>): Promise<string> {
  const answer = await response;
  const text = await answer.text();
  if (answer.status !== 201) throw new Error(`arranging failed: ${String(answer.status)} ${text}`);
  return (JSON.parse(text) as { id: string }).id;
}

/** A scenario of one request and the row or the count it alters. */
const change = (request: () => Promise<Response>, state: () => Promise<unknown>): Scenario => ({
  send: request,
  state,
});

/** A row of an operator route: one request, struck at its audit row. */
const operator = (arrange: () => Promise<Scenario>, more: Partial<Row> = {}): Row => ({
  through: 'changeAsOperator',
  arrange,
  ...more,
});

async function twoPlaylists(name: string): Promise<[string, string]> {
  return [await createPlaylist(owner, `${name} A`), await createPlaylist(owner, `${name} B`)];
}

interface Pairing {
  readonly pairingId: string;
  readonly code: string;
  readonly pollingToken: string;
}
async function newPairing(): Promise<Pairing> {
  const response = await fetch(`${t.url}/player/pairing`, { method: 'POST' });
  if (response.status !== 201) throw new Error(`pairing create failed: ${response.status}`);
  return (await response.json()) as Pairing;
}

/** A display of the organisation with a paired player. */
async function pairedDisplay(name: string): Promise<{ id: string; player: PairedPlayer }> {
  const display = await createDisplay(owner, org, name);
  return { id: display.id, player: await pairPlayer(t, owner, display.id) };
}

const asPlayer = (
  player: PairedPlayer,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`${t.url}${path}`, {
    method,
    headers:
      body === undefined
        ? player.headers
        : { ...player.headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The value of a cookie the response sets, or null ('' when it is cleared). */
function setCookie(response: Response, name: string): string | null {
  for (const line of response.headers.getSetCookie()) {
    const [pair = ''] = line.split(';');
    const at = pair.indexOf('=');
    if (pair.slice(0, at) === name) return pair.slice(at + 1);
  }
  return null;
}

/** An invite the owner asked for, still pending. */
const invite = (name: string, email: string): Promise<string> =>
  created(send(owner, 'POST', '/api/invites', { name, email, role: 'viewer' }));

const ALERT_ALREADY_LISTED = 'This address is already on the alert list.';
/** The sign-in the portal shows as "try again later". */
const SIGN_IN_UNAVAILABLE: Answer = {
  redirect: `${PORTAL_ORIGIN}/?authError=provider_unavailable`,
};
/** The failure row of a sign-in whose transaction a transient failure ended (step 26). */
const MEMBER_LOCKED = ['auth.login:failure:member_locked unscoped'];

/**
 * Every route that changes state, as registered: the 35 state-changing operator routes
 * (tests/integration/routes.ts lists the same ones, and session-csrf.test.ts holds that list to
 * the application), sign-in and sign-out, the public alert confirmation, and the player routes
 * that write or are POSTs.
 */
const TABLE: Readonly<Record<string, Row | NoTransaction>> = {
  'POST /api/displays': operator(async () => {
    const name = `Outcome screen ${randomUUID()}`;
    return change(
      () =>
        send(owner, 'POST', '/api/displays', {
          siteId: org.siteId,
          name,
          canvas: { width: 640, height: 360 },
        }),
      () => countOf('display', 'name', name),
    );
  }),
  'PATCH /api/displays/:id': operator(async () => {
    const display = await createDisplay(owner, org, 'Before the update');
    return change(
      () => send(owner, 'PATCH', `/api/displays/${display.id}`, { name: 'After the update' }),
      () => rowOf('display', display.id),
    );
  }),
  'POST /api/displays/:id/claim': operator(
    async () => {
      const display = await createDisplay(owner, org, 'Claimed screen');
      const pairing = await newPairing();
      return change(
        () => send(owner, 'POST', `/api/displays/${display.id}/claim`, { code: pairing.code }),
        () => rowOf('pairing_session', pairing.pairingId),
      );
    },
    // The display had no player, so nothing is revoked with the claim.
    { audits: ['pairing.claim:success'] },
  ),
  'POST /api/displays/:id/revoke-player': operator(
    async () => {
      const display = await pairedDisplay('Revoked screen');
      return change(
        () => send(owner, 'POST', `/api/displays/${display.id}/revoke-player`),
        () => rowOf('player_registration', display.player.registrationId),
      );
    },
    { audits: ['player.revoke:success:operator'] },
  ),
  'POST /api/media': operator(async () => {
    const mediaIds = async (): Promise<string[]> =>
      (
        await administrator<{ id: string }>(
          'SELECT id FROM public.media WHERE org_id = $1 ORDER BY id',
          [org.orgId],
        )
      ).map((row) => row.id);
    let before: string[] = [];
    return {
      prepare: async () => {
        before = await mediaIds();
      },
      send: async () => uploadBytes(owner, await pngBytes(), 'outcome.png'),
      state: mediaIds,
      // The row may exist, so the received bytes are kept for it and nothing else is: no job is
      // queued, since the route cannot say there is a row to validate (SCX-03).
      outsideAfterUnknown: async (was, now) => {
        const [id] = (await mediaIds()).filter((one) => !before.includes(one));
        expect(now.mail).toBe(was.mail);
        expect(now.files.filter((file) => !was.files.includes(file))).toEqual([
          `jobs/inbox/${String(id)}.part`,
        ]);
        expect(was.files.filter((file) => !now.files.includes(file))).toEqual([]);
      },
    };
  }),
  'PATCH /api/media/:id': operator(async () => {
    const image = await readyImage(t, owner);
    return change(
      () => send(owner, 'PATCH', `/api/media/${image.id}`, { name: 'Renamed image' }),
      () => rowOf('media', image.id),
    );
  }),
  // After the lost answer the row is gone and its stored bytes stay: the route deletes them only
  // once it knows the row went (step 27). Nothing names those bytes afterwards.
  'DELETE /api/media/:id': operator(async () => {
    const image = await readyImage(t, owner);
    return change(
      () => send(owner, 'DELETE', `/api/media/${image.id}`),
      () => rowOf('media', image.id),
    );
  }),
  'POST /api/apps': operator(async () => {
    const name = `Outcome clock ${randomUUID()}`;
    return change(
      () => send(owner, 'POST', '/api/apps', { name, content: CLOCK }),
      () => countOf('app', 'name', name),
    );
  }),
  'PATCH /api/apps/:id': operator(async () => {
    const app = await createApp(owner, CLOCK, 'Clock A');
    return change(
      () => send(owner, 'PATCH', `/api/apps/${app.id}`, { name: 'Clock A renamed' }),
      () => rowOf('app', app.id),
    );
  }),
  'DELETE /api/apps/:id': operator(async () => {
    const app = await createApp(owner, CLOCK, 'Clock B');
    return change(
      () => send(owner, 'DELETE', `/api/apps/${app.id}`),
      () => rowOf('app', app.id),
    );
  }),
  'POST /api/schedules': operator(async () => {
    const [playlist] = await twoPlaylists('Schedule create');
    const name = `Outcome hours ${randomUUID()}`;
    return change(
      () =>
        send(owner, 'POST', '/api/schedules', { name, defaultPlaylistId: playlist, events: [] }),
      () => countOf('schedule', 'name', name),
    );
  }),
  'PUT /api/schedules/:id': operator(async () => {
    const [playlist] = await twoPlaylists('Schedule update');
    const schedule = await createSchedule(owner, 'Hours A', playlist);
    return change(
      () =>
        send(owner, 'PUT', `/api/schedules/${schedule.id}`, {
          name: 'Hours A renamed',
          defaultPlaylistId: playlist,
          events: [],
        }),
      () => rowOf('schedule', schedule.id),
    );
  }),
  'DELETE /api/schedules/:id': operator(async () => {
    const [playlist] = await twoPlaylists('Schedule delete');
    const schedule = await createSchedule(owner, 'Hours B', playlist);
    return change(
      () => send(owner, 'DELETE', `/api/schedules/${schedule.id}`),
      () => rowOf('schedule', schedule.id),
    );
  }),
  'POST /api/layouts': operator(async () => {
    const [main, band] = await twoPlaylists('Layout create');
    const name = `Outcome layout ${randomUUID()}`;
    return change(
      () => send(owner, 'POST', '/api/layouts', { name, zones: layoutZones(main, band) }),
      () => countOf('layout', 'name', name),
    );
  }),
  'PUT /api/layouts/:id': operator(async () => {
    const [main, band] = await twoPlaylists('Layout update');
    const layout = await createLayout(owner, 'Layout A', layoutZones(main, band));
    return change(
      () =>
        send(owner, 'PUT', `/api/layouts/${layout.id}`, {
          name: 'Layout A renamed',
          zones: layoutZones(main, band),
        }),
      () => rowOf('layout', layout.id),
    );
  }),
  'DELETE /api/layouts/:id': operator(async () => {
    const [main, band] = await twoPlaylists('Layout delete');
    const layout = await createLayout(owner, 'Layout B', layoutZones(main, band));
    return change(
      () => send(owner, 'DELETE', `/api/layouts/${layout.id}`),
      () => rowOf('layout', layout.id),
    );
  }),
  'POST /api/tags': operator(async () => {
    const name = `outcome-${randomUUID().slice(0, 8)}`;
    return change(
      () => send(owner, 'POST', '/api/tags', { scope: 'media', name }),
      () => countOf('tag', 'name', name),
    );
  }),
  'PATCH /api/tags/:id': operator(async () => {
    const id = await created(send(owner, 'POST', '/api/tags', { scope: 'media', name: 'Tag A' }));
    return change(
      () => send(owner, 'PATCH', `/api/tags/${id}`, { name: 'Tag A renamed' }),
      () => rowOf('tag', id),
    );
  }),
  'DELETE /api/tags/:id': operator(async () => {
    const id = await created(send(owner, 'POST', '/api/tags', { scope: 'media', name: 'Tag B' }));
    return change(
      () => send(owner, 'DELETE', `/api/tags/${id}`),
      () => rowOf('tag', id),
    );
  }),
  'POST /api/folders': operator(async () => {
    const name = `Outcome folder ${randomUUID()}`;
    return change(
      () => send(owner, 'POST', '/api/folders', { name }),
      () => countOf('folder', 'name', name),
    );
  }),
  'PATCH /api/folders/:id': operator(async () => {
    const id = await created(send(owner, 'POST', '/api/folders', { name: 'Folder A' }));
    return change(
      () => send(owner, 'PATCH', `/api/folders/${id}`, { name: 'Folder A renamed' }),
      () => rowOf('folder', id),
    );
  }),
  'DELETE /api/folders/:id': operator(async () => {
    const id = await created(send(owner, 'POST', '/api/folders', { name: 'Folder B' }));
    return change(
      () => send(owner, 'DELETE', `/api/folders/${id}`),
      () => rowOf('folder', id),
    );
  }),
  'POST /api/playlists': operator(async () => {
    const name = `Outcome loop ${randomUUID()}`;
    return change(
      () => send(owner, 'POST', '/api/playlists', { name }),
      () => countOf('playlist', 'name', name),
    );
  }),
  'PUT /api/playlists/:id': operator(async () => {
    const id = await createPlaylist(owner, 'Loop A');
    return change(
      () => send(owner, 'PUT', `/api/playlists/${id}`, { name: 'Loop A renamed', items: [] }),
      () => rowOf('playlist', id),
    );
  }),
  'DELETE /api/playlists/:id': operator(async () => {
    const id = await createPlaylist(owner, 'Loop B');
    return change(
      () => send(owner, 'DELETE', `/api/playlists/${id}`),
      () => rowOf('playlist', id),
    );
  }),
  'POST /api/playlists/:id/duplicate': operator(async () => {
    const id = await createPlaylist(owner, `Loop to copy ${randomUUID()}`);
    return change(
      () => send(owner, 'POST', `/api/playlists/${id}/duplicate`),
      () => countOf('playlist', 'org_id', org.orgId),
    );
  }),
  // The client's repeat with the same key replays the one publication the lost answer made
  // (changeOncePerKey, step 27): the server did not run the publish again by itself.
  'POST /api/playlists/:id/publish': operator(async () => {
    const display = await createDisplay(owner, org, 'Published screen');
    const image = await readyImage(t, owner);
    const playlist = await createPlaylist(owner, 'Published loop', [imageItem(image.id)]);
    const key = randomUUID();
    const publish = (): Promise<Response> =>
      owner.fetch(`/api/playlists/${playlist}/publish`, {
        method: 'POST',
        json: { displayId: display.id },
        headers: { 'idempotency-key': key },
      });
    const publications = (): Promise<number> => countOf('publication', 'display_id', display.id);
    return {
      send: publish,
      state: publications,
      afterUnknown: async () => {
        expect(await publications()).toBe(1);
        const mark = await newestAuditRow();
        const again = await publish();
        expect(again.status).toBe(200);
        const body = (await again.json()) as { publicationId: string; replayed: boolean };
        expect(body.replayed).toBe(true);
        expect(await publications()).toBe(1);
        expect(await desiredPublicationId(owner, display.id)).toBe(body.publicationId);
        // One audit row for the publication, which it names, and none for the replay.
        expect(await auditRowsAfter(mark)).toEqual([]);
        expect(await countOf('audit_event', 'object_id', body.publicationId)).toBe(1);
      },
    };
  }),
  'POST /api/push': operator(async () => {
    const display = await createDisplay(owner, org, 'Pushed screen');
    const image = await readyImage(t, owner);
    const playlist = await createPlaylist(owner, 'Pushed loop', [imageItem(image.id)]);
    await assignPlaylist(owner, display.id, playlist);
    const key = randomUUID();
    const publications = (): Promise<number> => countOf('publication', 'display_id', display.id);
    return {
      send: () => push(owner, [display.id], key),
      state: publications,
      afterUnknown: async () => {
        const mark = await newestAuditRow();
        const again = await push(owner, [display.id], key);
        expect(again.status).toBe(200);
        expect(await publications()).toBe(1);
        expect(await auditRowsAfter(mark)).toEqual([]);
      },
    };
  }),
  'PATCH /api/members/:id': operator(
    async () => {
      const member = await addMember(org, 'viewer', 'Rae Role');
      return change(
        () => send(owner, 'PATCH', `/api/members/${member.membershipId}`, { role: 'editor' }),
        () => rowOf('membership', member.membershipId),
      );
    },
    { audits: ['membership.role_change:success'] },
  ),
  'POST /api/members/:id/remove': operator(
    async () => {
      const member = await addMember(org, 'viewer', 'Rem Removed');
      return change(
        () => send(owner, 'POST', `/api/members/${member.membershipId}/remove`),
        () => rowOf('membership', member.membershipId),
      );
    },
    { audits: ['membership.remove:success'] },
  ),
  'POST /api/members/:id/sign-out': operator(async () => {
    const member = await addMember(org, 'viewer', 'Sal Signed-Out');
    return change(
      () => send(owner, 'POST', `/api/members/${member.membershipId}/sign-out`),
      () => rowOf('membership', member.membershipId),
    );
  }),
  'POST /api/invites': operator(async () => {
    const email = `invited-${randomUUID().slice(0, 8)}@example.com`;
    return change(
      () => send(owner, 'POST', '/api/invites', { name: 'Ines Invitee', email, role: 'viewer' }),
      () => countOf('member_invite', 'email', email),
    );
  }),
  'POST /api/invites/:id/cancel': operator(
    async () => {
      const id = await invite('Cam Cancelled', 'cancelled@example.com');
      return change(
        () => send(owner, 'POST', `/api/invites/${id}/cancel`),
        () => rowOf('member_invite', id),
      );
    },
    { audits: ['invite.cancel:success:cancelled'] },
  ),
  // D9: no confirmation goes to an address the server cannot say it stored, and adding it again
  // answers 409, since it was stored. Section 3 of the head of this file holds the "no mail".
  'POST /api/alert-recipients': operator(async () => {
    const email = `maybe-${randomUUID().slice(0, 8)}@example.com`;
    const add = (): Promise<Response> => send(owner, 'POST', '/api/alert-recipients', { email });
    return {
      send: add,
      state: () => rowOf('alert_recipient', email, 'email'),
      afterUnknown: async () => {
        // It was stored: the list shows it waiting for its confirmation.
        const listed = (await (await owner.fetch('/api/alert-recipients')).json()) as {
          items: { email: string; status: string }[];
        };
        expect(listed.items.filter((item) => item.email === email)).toMatchObject([
          { status: 'waiting' },
        ]);
        // A repeat neither adds a second row, nor mails the first, nor audits anything.
        const mail = t.sentMail.length;
        const mark = await newestAuditRow();
        expect((await expectError(await add(), 'conflict')).message).toBe(ALERT_ALREADY_LISTED);
        expect(t.sentMail.length).toBe(mail);
        expect(await countOf('alert_recipient', 'email', email)).toBe(1);
        expect(await auditRowsAfter(mark)).toEqual([]);
      },
    };
  }),
  'DELETE /api/alert-recipients/:id': operator(async () => {
    const id = await created(
      send(owner, 'POST', '/api/alert-recipients', { email: 'removed@example.com' }),
    );
    return change(
      () => send(owner, 'DELETE', `/api/alert-recipients/${id}`),
      () => rowOf('alert_recipient', id),
    );
  }),

  // One autocommit statement stores the login state (poolAsTx): there is no transaction whose
  // COMMIT could be lost, and the route audits nothing (login_state, D3).
  'GET /api/auth/login': {
    noTransaction:
      'stores the login state in one autocommit statement of its own, so it has no transaction to strike and no COMMIT to lose',
    send: () => fetch(`${t.url}/api/auth/login`, { redirect: 'manual' }),
    answers: 303,
  },
  // SCR-07: every sign-in that ends without a session writes an auth.login row. A transaction
  // that rolled back took its own row with it, so the failure is recorded on its own, with the
  // classifier's reading of the error as the reason: member_locked for the four transient
  // failures (step 26), database_error for any other error of the database, server_error for
  // anything else. A GET that writes answers internal_error after a lost COMMIT answer (D9),
  // and then no failure row is written: the session and its success row may both be stored.
  'GET /api/auth/callback': {
    through: 'changePreOrg',
    arrange: async () => {
      const member = await addMember(org, 'viewer', 'Sig Signing-In');
      return {
        send: async () => {
          signingIn = member.oidcSub;
          const begin = await fetch(`${t.url}/api/auth/login`, { redirect: 'manual' });
          const preAuth = setCookie(begin, t.config.loginCookieName);
          if (begin.status !== 303 || preAuth === null) throw new Error('sign-in did not begin');
          return fetch(`${t.url}/api/auth/callback?code=test&state=${lastState}`, {
            redirect: 'manual',
            headers: { cookie: `${t.config.loginCookieName}=${preAuth}` },
          });
        },
        state: () => countOf('session', 'membership_id', member.membershipId),
        rival: async () => {
          const client = await sql.connect();
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
          await client.query(
            'UPDATE membership SET display_name = $2 WHERE id = $1 AND org_id = app_org_id()',
            [member.membershipId, 'Sig Changed-Meanwhile'],
          );
          return client;
        },
        // No mode hands the browser a session: the one a lost answer left has no holder.
        check: (_mode, response) => {
          expect(setCookie(response, t.config.sessionCookieName) ?? '').toBe('');
        },
      };
    },
    more: CALLBACK_MODES,
    // The statement that locks the member row, which the rival changed.
    atIn: { 'serialization-failure': (text) => text.includes('sec.session_create') },
    answers: {
      'statement-timeout': SIGN_IN_UNAVAILABLE,
      'lock-timeout': SIGN_IN_UNAVAILABLE,
      deadlock: SIGN_IN_UNAVAILABLE,
      'serialization-failure': SIGN_IN_UNAVAILABLE,
      'database-error': FAILED,
      'backend-killed': FAILED,
      'lost-commit-answer': FAILED,
    },
    auditsAfterRollback: {
      'statement-timeout': MEMBER_LOCKED,
      'lock-timeout': MEMBER_LOCKED,
      deadlock: MEMBER_LOCKED,
      'serialization-failure': MEMBER_LOCKED,
      'database-error': ['auth.login:failure:database_error unscoped'],
      'backend-killed': ['auth.login:failure:server_error unscoped'],
    },
  },
  // The sign-out catch-all, as decided (Michael, 25 Nov 2026; adoption plan section 7, item 11):
  // after any failure of its change the route runs sessionRevokeUnaudited, so the session is
  // ended all the same, in a statement of its own. In this row the fallback always ends it:
  //  - a statement timeout or a killed backend answers 500 internal_error, and no auth.logout
  //    row exists: the accepted CX-01 residual (the audit-debt guard is given leave for it, as
  //    in audit-failure.test.ts);
  //  - a lock timeout rolled back too, and the fallback then ended the session, so the sign-out
  //    happened and answers as one, with no audit row (the same residual). "Try again" (503)
  //    would be untrue: there is nothing left to end. The cases where the fallback finds
  //    nothing, or fails too, are in the describe at the end of this file;
  //  - a lost COMMIT answer answers 500 commit_outcome_unknown; the first transaction did end
  //    the session and write its auth.logout row, and the fallback finds nothing to end.
  // The browser's cookie is cleared in every mode.
  'POST /api/auth/logout': {
    through: 'changePreOrg',
    arrange: async () => {
      const member = await addMember(org, 'viewer', 'Lou Leaving');
      let session: Operator | undefined;
      return {
        prepare: async () => {
          session = await signIn(t, member);
        },
        send: () => {
          if (session === undefined) throw new Error('no session to end');
          return send(session, 'POST', '/api/auth/logout');
        },
        // The member's live sessions: one before each mode.
        state: async () =>
          (
            await administrator<{ n: number }>(
              'SELECT count(*)::int AS n FROM public.session WHERE membership_id = $1 AND revoked_at IS NULL',
              [member.membershipId],
            )
          )[0]?.n,
        check: (_mode, response) => {
          expect(setCookie(response, t.config.sessionCookieName)).toBe('');
        },
      };
    },
    answers: { 'lock-timeout': { ok: { redirectTo: null } } },
    rollbackLeaves: (before, after) => {
      expect([before, after]).toEqual([1, 0]);
    },
    around: (mode, work) =>
      mode === LOST
        ? work()
        : whileUnauditedAllowed(
            migratorUrl(),
            'session',
            'the accepted CX-01 residual: a sign-out whose change rolled back still ends the session, through sessionRevokeUnaudited (adoption plan section 2.1 A)',
            work,
          ),
  },
  // Public: the link's owner posts the token. A lost answer uses the link up: the address is
  // confirmed, and a repeat answers the 404 of a link that is not valid.
  'POST /api/alert-recipients/confirm': {
    through: 'changePreOrg',
    arrange: async () => {
      const id = await created(
        send(owner, 'POST', '/api/alert-recipients', { email: 'confirmed@example.com' }),
      );
      const token = /\/alerts\/confirm#([A-Za-z0-9_-]{43})/.exec(
        t.sentMail.at(-1)?.text ?? '',
      )?.[1];
      if (token === undefined) throw new Error('no confirmation e-mail');
      const confirm = (): Promise<Response> =>
        fetch(`${t.url}/api/alert-recipients/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      return {
        send: confirm,
        state: () => rowOf('alert_recipient', id),
        afterUnknown: async () => {
          await expectError(await confirm(), 'not_found');
        },
      };
    },
    audits: ['alert_recipient.confirm:success'],
  },

  'POST /player/pairing': {
    through: 'changePreOrg',
    arrange: () =>
      Promise.resolve(
        change(
          () => fetch(`${t.url}/player/pairing`, { method: 'POST' }),
          async () =>
            (
              await administrator<{ n: number }>(
                'SELECT count(*)::int AS n FROM public.pairing_session',
              )
            )[0]?.n,
        ),
      ),
    audits: ['pairing.create:success unscoped'],
  },
  // A GET that writes: the poll that collects the credential completes the pairing. After a lost
  // COMMIT answer it answers internal_error (D9, SEC-8 of the group C review): the registration
  // and its audit row exist, and the device token the player never received is held by nobody.
  'GET /player/pairing/:id': {
    through: 'changePreOrg',
    arrange: async () => {
      const display = await createDisplay(owner, org, 'Paired screen');
      const pairing = await newPairing();
      const claim = await send(owner, 'POST', `/api/displays/${display.id}/claim`, {
        code: pairing.code,
      });
      if (claim.status !== 200) throw new Error(`claim failed: ${String(claim.status)}`);
      return change(
        () =>
          fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
            headers: { authorization: `Bearer ${pairing.pollingToken}` },
          }),
        () => countOf('player_registration', 'display_id', display.id),
      );
    },
    answers: { 'lost-commit-answer': FAILED },
    audits: ['pairing.complete:success'],
  },
  'DELETE /player/registration': {
    through: 'changeAsDevice',
    arrange: async () => {
      const display = await pairedDisplay('Reset screen');
      return change(
        () => asPlayer(display.player, 'DELETE', '/player/registration'),
        () => rowOf('player_registration', display.player.registrationId),
      );
    },
    audits: ['player.revoke:success:player_reset'],
  },
  // A POST that only reads (D9): its transaction is READ ONLY, so a lost COMMIT answer is a
  // plain failure and nothing changed either way.
  'POST /player/media-urls': {
    through: 'readOrg',
    arrange: async () => {
      const display = await pairedDisplay('Addressed screen');
      const image = await readyImage(t, owner);
      const { publicationId } = await publishImages(owner, display.id, [image.id]);
      return change(
        () =>
          asPlayer(display.player, 'POST', '/player/media-urls', {
            publicationId,
            assetIds: [image.id],
          }),
        () => rowOf('display_delivery', display.id, 'display_id'),
      );
    },
    at: /FROM display_delivery/,
    audits: [],
    changes: false,
  },
  // Telemetry: audited nowhere (D3), so the faults strike at its last write.
  'POST /player/heartbeat': {
    through: 'changeAsDevice',
    arrange: async () => {
      const display = await pairedDisplay('Reporting screen');
      return change(
        () =>
          asPlayer(display.player, 'POST', '/player/heartbeat', {
            schemaVersion: 1,
            seq: 1,
            sentAt: new Date().toISOString(),
            displayId: display.id,
            downloadedPublicationId: null,
            activePublicationId: null,
            activeItemIndex: null,
            playerState: 'idle',
            staging: null,
            errors: [],
            player: { version: 'integration-test', storagePersisted: null, online: true },
          }),
        () => rowOf('display_delivery', display.id, 'display_id'),
      );
    },
    at: /^\s*INSERT INTO heartbeat_log/,
    audits: [],
  },
};

const isRow = (entry: Row | NoTransaction): entry is Row => 'through' in entry;
const methodOf = (route: string): string => route.slice(0, route.indexOf(' '));

/** A route that changes state: any method but GET, and a GET whose statement is not read_only. */
function changesState(route: string): boolean {
  if (methodOf(route) !== 'GET') return true;
  const declared = declaredRouteAudit(route, ROUTE_PERMISSIONS);
  if (declared === undefined) throw new Error(`${route} has no audit statement`);
  return !('none' in declared.audit && declared.audit.none === 'read_only');
}

const modesOf = (row: Row): readonly Mode[] => [...MODES, ...(row.more ?? [])];

function answerOf(route: string, row: Row, mode: Mode): Answer {
  const given = row.answers?.[mode];
  if (given !== undefined) return given;
  const byDefault = MODES.find((one) => one === mode);
  if (byDefault === undefined) {
    throw new Error(
      `the row of ${route} runs ${mode} and gives no answer for it: add it to its answers in ${HERE}`,
    );
  }
  return DEFAULT_ANSWERS[row.through][byDefault];
}

/** The audit rows of the row's committed change. */
function auditsOf(route: string, row: Row): readonly string[] {
  if (row.audits !== undefined) return row.audits;
  const own = declaredAudit(route)?.own ?? [];
  const [action, ...others] = own;
  if (action === undefined || others.length > 0) {
    throw new Error(
      `${route} states ${own.length === 0 ? 'no audit action' : own.join(', ')}: give its row in ${HERE} the audit rows its request writes, as audits`,
    );
  }
  return [`${action}:success`];
}

/** The fault of a mode at `at`. */
function faultOf(mode: Mode, at: StatementMatcher, rival: PoolClient | undefined): Fault {
  switch (mode) {
    case 'statement-timeout':
    case 'lock-timeout':
    case 'backend-killed':
    case 'lost-commit-answer':
    case 'deadlock':
      return { mode, at };
    case 'serialization-failure':
      if (rival === undefined) throw new Error('the serialization-failure mode needs a rival');
      return { mode, at, rival };
    case 'database-error':
      return {
        mode: 'never-sent',
        at,
        // A violation no route maps and the classifier does not call transient.
        error: Object.assign(new pg.DatabaseError('a refusal the test made up', 0, 'error'), {
          code: '23001',
        }),
      };
  }
}

beforeAll(async () => {
  t = await startTestApp({}, 1000, {
    wrapPool: faults.wrapPool,
    identityProvider: provider,
    logger: logs.logger,
  });
  org = await createOrg('Commit outcomes', { displayName: 'Olive Owner' });
  owner = await signIn(t, org);
  sql = t.testSql('the rival of a race the commit-outcome table loses on purpose');
  const url = new URL(migratorUrl());
  url.username = 'postgres';
  url.password = encodeURIComponent(need('POSTGRES_SUPERUSER_PASSWORD'));
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
});
afterEach(() => {
  faults.disarmAll();
});
afterAll(async () => {
  await admin.end();
  await t.close();
});

describe('the commit-outcome table has a row for every route that changes state (step 33)', () => {
  it('has a row for every state-changing route the application registers, and for no other', () => {
    const routes = registeredRoutes(t.app).filter(changesState);
    // The API's two route tables were read: the 35 operator writes and the routes outside them.
    expect(routes.length).toBeGreaterThan(40);
    const missing = routes
      .filter((route) => !Object.hasOwn(TABLE, route))
      .map(
        (route) =>
          `No commit-outcome row for ${route}: the route changes state, so add a row for it to ${HERE}, with the arrange step of a request that changes something and what each fault mode must leave (adoption plan step 33). A route that only reads says so in its audit statement instead: read(...) in ROUTE_PERMISSIONS, or noAudit('read_only') in OTHER_ROUTE_AUDIT`,
      );
    expect(missing).toEqual([]);
    const unknown = Object.keys(TABLE)
      .filter((route) => !routes.includes(route))
      .map(
        (route) =>
          `${route} has a row in ${HERE}, but the application registers no such state-changing route: remove the row, or correct its method and pattern`,
      );
    expect(unknown).toEqual([]);
  });

  it('strikes the audit row of every route that states one, and names another statement only for a route that audits nothing', () => {
    for (const [route, row] of Object.entries(TABLE)) {
      if (!isRow(row)) continue;
      const audited = (declaredAudit(route)?.own ?? []).length > 0;
      expect(
        row.at === undefined,
        `${route}: the faults strike at the audit row of a change that has one`,
      ).toBe(audited);
    }
  });

  it('answers commit_outcome_unknown in the lost-COMMIT mode only, and only for a method that changes state on a transaction that is not READ ONLY (D9)', () => {
    for (const [route, row] of Object.entries(TABLE)) {
      if (!isRow(row)) continue;
      for (const mode of modesOf(row)) {
        const answer = answerOf(route, row, mode);
        const unknown = 'error' in answer && answer.error === 'commit_outcome_unknown';
        expect(unknown, `${route} in the ${mode} mode`).toBe(
          mode === LOST && row.through !== 'readOrg' && methodOf(route) !== 'GET',
        );
      }
    }
  });
});

for (const [route, entry] of Object.entries(TABLE)) {
  if (!isRow(entry)) {
    describe(`${route}: no transaction to strike`, () => {
      it(`answers without opening a transaction: ${entry.noTransaction}`, async () => {
        // A transaction of the route would begin on a connection the harness wraps, and fail.
        const begun = faults.arm({
          mode: 'never-sent',
          at: /^BEGIN/,
          error: new Error('the route opened a transaction'),
        });
        const response = await entry.send();
        expect(
          response.status,
          `${route} opens a transaction now: give it a full row in ${HERE}`,
        ).toBe(entry.answers);
        begun.disarm();
        await expect(begun.delivered).rejects.toThrow('disarmed before it struck');
      });
    });
    continue;
  }

  const row = entry;
  describe(`${route}: what each fault leaves`, () => {
    // Arranged once, by the first mode that runs: a known rollback leaves it as it was, and the
    // lost answer, which changes it, comes last.
    let arranged: Promise<Scenario> | undefined;

    for (const mode of [...(row.more ?? []), ...MODES]) {
      const expected = answerOf(route, row, mode);
      const title =
        'error' in expected
          ? `answers ${expected.error}`
          : 'redirect' in expected
            ? `redirects to ${expected.redirect}`
            : `answers 200 ${JSON.stringify(expected.ok)}`;
      it(`${mode}: ${title}`, async () => {
        arranged ??= row.arrange();
        const scenario = await arranged;
        await scenario.prepare?.();
        const before = await scenario.state();
        const outsideBefore = await outside();
        const mark = await newestAuditRow();

        const rival = mode === 'serialization-failure' ? await scenario.rival?.() : undefined;
        let response: Response;
        let struck;
        try {
          const fault = faults.arm(faultOf(mode, row.atIn?.[mode] ?? row.at ?? AT_AUDIT, rival));
          const request = (): Promise<Response> => scenario.send();
          response = await (row.around === undefined ? request() : row.around(mode, request));
          // A fault that never struck shows nothing: the request did not reach the statement.
          fault.disarm();
          struck = await fault.delivered;
        } finally {
          await rival?.query('ROLLBACK').catch(() => undefined);
          rival?.release();
        }
        if (mode === LOST) expect(struck.commitTag).toBe('COMMIT');

        // 1. The wire answer.
        scenario.check?.(mode, response);
        if ('redirect' in expected) {
          expect(response.status).toBe(303);
          expect(response.headers.get('location')).toBe(expected.redirect);
        } else if ('ok' in expected) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual(expected.ok);
        } else {
          expect(response.headers.get('retry-after')).toBe(expected.retryAfter ?? null);
          const { message } = await expectError(response, expected.error);
          if (expected.error === 'commit_outcome_unknown') {
            expect(message).toBe(COMMIT_OUTCOME_UNKNOWN_MESSAGE);
            expect(response.headers.get('cache-control')).toBe('no-store');
          }
        }

        const after = await scenario.state();
        const audited = await auditRowsAfter(mark);
        const outsideAfter = await outside();

        if (mode !== LOST) {
          // 2. A known rollback: the state is what it was, and nothing was audited.
          if (row.rollbackLeaves === undefined) expect(after).toEqual(before);
          else row.rollbackLeaves(before, after);
          expect(audited).toEqual(row.auditsAfterRollback?.[mode] ?? []);
          // 3. Nothing outside the transaction either.
          expect(outsideAfter).toEqual(outsideBefore);
          return;
        }

        // 2. The lost answer: the change is stored, with exactly its audit rows.
        if (row.changes === false) expect(after).toEqual(before);
        else expect(after).not.toEqual(before);
        expect(audited).toEqual(auditsOf(route, row));
        // 3. Nothing outside the transaction, but what the row says is kept for the change.
        if (scenario.outsideAfterUnknown === undefined) expect(outsideAfter).toEqual(outsideBefore);
        else await scenario.outsideAfterUnknown(outsideBefore, outsideAfter);
        await scenario.afterUnknown?.();
      });
    }
  });
}

/**
 * The sign-out catch-all (adoption plan section 7, item 11; Michael, 25 Nov 2026): the route
 * ends the session with sessionRevokeUnaudited after any failure of its audited transaction.
 * The behaviour is kept; what is held here is that the answer and the log line are true in each
 * case. The log is read through `capturedLogs`, the production logger writing into an array.
 */
describe('the sign-out catch-all says what happened, in its answer and its log line', () => {
  const NOT_AUDITED = 'sign-out was not audited; the session was ended anyway';
  const COMMITTED_OR_ENDED_ELSEWHERE =
    'sign-out did not confirm its COMMIT and no live session was left to end: it committed, with its audit row, or another request ended the session; nothing was ended without an audit row';
  const ENDED_ELSEWHERE =
    'sign-out failed and no live session was left to end: another request ended the session; nothing was ended without an audit row';
  const STILL_ACTIVE = 'sign-out failed and the session may still be active';
  const RESIDUAL =
    'the accepted CX-01 residual: a sign-out whose change rolled back still ends the session, through sessionRevokeUnaudited (adoption plan section 2.1 A)';

  /** A member with one live session, and what the test reads of it afterwards. */
  async function signedIn(name: string) {
    const member = await addMember(org, 'viewer', name);
    const session = await signIn(t, member);
    const live = async (): Promise<number | undefined> =>
      (
        await administrator<{ n: number }>(
          'SELECT count(*)::int AS n FROM public.session WHERE membership_id = $1 AND revoked_at IS NULL',
          [member.membershipId],
        )
      )[0]?.n;
    return {
      session,
      live,
      idHash: sha256(session.cookie.slice(session.cookie.indexOf('=') + 1)),
      signOut: () => send(session, 'POST', '/api/auth/logout'),
    };
  }

  /** The sign-out lines logged since line `from`, with the level of each. */
  const signOutLines = (from: number): string[] =>
    logs.lines
      .slice(from)
      .filter((line) => line.msg.startsWith('sign-out'))
      .map((line) => `${String(line.level)} ${line.msg}`);

  /**
   * Holds the session row as a transaction that has ended the session and not committed, so
   * the sign-out waits for it: what a concurrent revocation of the same session is.
   */
  async function whileSessionRowIsHeld(
    idHash: Buffer,
    work: (holder: PoolClient) => Promise<void>,
  ): Promise<void> {
    const holder = await sql.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM sec.session_revoke($1)', [idHash]);
      await work(holder);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  /**
   * Waits until the fallback's own statement waits for a lock of backend `holder`. The pool may
   * give the fallback the connection the audited transaction just used, so the wait is told
   * from the first one by its statement, read from the server, not by its backend.
   */
  async function fallbackWaitsBehind(holder: number, signingOut: Promise<unknown>): Promise<void> {
    let ended = false;
    const mark = (): void => {
      ended = true;
    };
    signingOut.then(mark, mark);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const endedBefore = ended;
      const { rowCount } = await sql.query(
        `SELECT 1 FROM pg_stat_activity a
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
            AND a.query LIKE 'SELECT 1 FROM sec.session_revoke(%'
            AND $1 = ANY (pg_blocking_pids(a.pid))`,
        [holder],
      );
      if (rowCount !== null && rowCount > 0) return;
      if (endedBefore) throw new Error('the sign-out ended before its fallback waited for a lock');
      if (Date.now() > deadline) {
        throw new Error('the sign-out fallback did not wait for the session row within 15 s');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('a lost COMMIT answer: 500 commit_outcome_unknown; the session is ended with its one auth.logout row, and the log line does not say "not audited"', async () => {
    const leaving = await signedIn('Una Unknown');
    const mark = await newestAuditRow();
    const from = logs.lines.length;
    const fault = faults.arm({ mode: 'lost-commit-answer', at: AT_AUDIT });
    const response = await leaving.signOut();
    expect((await fault.delivered).commitTag).toBe('COMMIT');
    await expectError(response, 'commit_outcome_unknown');
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    expect(await leaving.live()).toBe(0);
    expect(await auditRowsAfter(mark)).toEqual(['auth.logout:success']);
    expect(signOutLines(from)).toEqual([`50 ${COMMITTED_OR_ENDED_ELSEWHERE}`]);
  });

  it('a known rollback: 500 internal_error; the fallback ends the session with no audit row, and the log line says so', async () => {
    const leaving = await signedIn('Rollo Rolled-Back');
    const mark = await newestAuditRow();
    const from = logs.lines.length;
    const fault = faults.arm({ mode: 'statement-timeout', at: AT_AUDIT });
    const response = await whileUnauditedAllowed(migratorUrl(), 'session', RESIDUAL, () =>
      leaving.signOut(),
    );
    await fault.delivered;
    await expectError(response, 'internal_error');
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    expect(await leaving.live()).toBe(0);
    expect(await auditRowsAfter(mark)).toEqual([]);
    expect(signOutLines(from)).toEqual([`50 ${NOT_AUDITED}`]);
  });

  it('a lock timeout, and the fallback ends the session: the sign-out answers 200 with the cookie cleared, not 503, and the log line says it was not audited', async () => {
    const leaving = await signedIn('Lottie Locked');
    const mark = await newestAuditRow();
    const from = logs.lines.length;
    const fault = faults.arm({ mode: 'lock-timeout', at: AT_AUDIT });
    const response = await whileUnauditedAllowed(migratorUrl(), 'session', RESIDUAL, () =>
      leaving.signOut(),
    );
    expect((await fault.delivered).sqlstate).toBe('55P03');
    expect(response.status).toBe(200);
    // No ID token: the fallback does not read it, so the provider is given none.
    expect(await response.json()).toEqual({ redirectTo: null });
    expect(response.headers.get('retry-after')).toBeNull();
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    expect(await leaving.live()).toBe(0);
    expect(await auditRowsAfter(mark)).toEqual([]);
    expect(signOutLines(from)).toEqual([`50 ${NOT_AUDITED}`]);
    // The session is gone for the browser too.
    await expectError(await leaving.session.fetch('/api/displays'), 'unauthenticated');
  });

  // The two cases below take the session row for real. The guard's own session lookup records
  // activity on that row, so the row is taken once the request is past it: the sign-out is held
  // before its sec.session_revoke, the other revocation takes the row, and the hold is released.
  const AT_REVOKE = (text: string): boolean => text.includes('sec.session_revoke(');

  it('a lock timeout behind a revocation that then commits: the fallback waits for it too and finds nothing to end, so the answer is the 401 of a session that is not live, and no row is missing', async () => {
    const leaving = await signedIn('Elsa Elsewhere');
    const mark = await newestAuditRow();
    const from = logs.lines.length;
    const held = faults.hold(AT_REVOKE);
    const signingOut = leaving.signOut();
    const route = await held.reached;
    await whileSessionRowIsHeld(leaving.idHash, async (holder) => {
      held.release();
      // The audited transaction waits for the session row, for all of lock_timeout (5 s).
      expect(
        await waitForLockWaiters(
          sql,
          backendPid(holder),
          1,
          'the sign-out never waited for the session row',
          { waiter: signingOut },
        ),
      ).toEqual([route]);
      // It timed out, and the fallback now waits for the same row on another connection.
      await fallbackWaitsBehind(backendPid(holder), signingOut);
      await holder.query('COMMIT');
    });
    const response = await signingOut;
    expect(response.headers.get('retry-after')).toBeNull();
    await expectError(response, 'unauthenticated');
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    expect(await leaving.live()).toBe(0);
    // The sign-out wrote nothing: the other revocation ended the session (the test's own SQL).
    expect(await auditRowsAfter(mark)).toEqual([]);
    expect(signOutLines(from)).toEqual([`50 ${ENDED_ELSEWHERE}`]);
  });

  it('a lock timeout, and the fallback times out too: 503 service_unavailable with retry-after 2, as every other write answers a lock timeout; the session is still live and the log line says it may be', async () => {
    const leaving = await signedIn('Stella Still-Active');
    const mark = await newestAuditRow();
    const from = logs.lines.length;
    const held = faults.hold(AT_REVOKE);
    const signingOut = leaving.signOut();
    await held.reached;
    let response: Response | undefined;
    await whileSessionRowIsHeld(leaving.idHash, async () => {
      held.release();
      // The row is not let go while the route runs: both of its statements wait out lock_timeout.
      response = await signingOut;
    });
    if (response === undefined) throw new Error('no answer');
    expect(response.headers.get('retry-after')).toBe('2');
    await expectError(response, 'service_unavailable');
    expect(await leaving.live()).toBe(1);
    expect(await auditRowsAfter(mark)).toEqual([]);
    expect(signOutLines(from)).toEqual([
      '50 sign-out could not end the session either',
      `50 ${STILL_ACTIVE}`,
    ]);
    // PINNED, a finding (Low): the browser's cookie is cleared before the transaction, in every
    // case, so this browser cannot "try again", although the session is still live on the
    // server until it expires or is ended some other way.
    expect(setCookie(response, t.config.sessionCookieName)).toBe('');
    const still = (await (await leaving.session.fetch('/api/session')).json()) as {
      authenticated: boolean;
    };
    expect(still.authenticated).toBe(true);
  });

  // PINNED, a finding (Low), not decided: the guard's session lookup records activity on the
  // session row (sec.session_by_id_hash), outside any transaction of the route. When another
  // transaction holds that row past lock_timeout (a slow member change that ends the member's
  // sessions, the incident script), the request answers 500 internal_error, not the 503 of a
  // lock timeout inside a write, and the route never runs: a sign-out then ends nothing.
  it('pins: a request whose session row is held past lock_timeout at the session lookup answers 500 internal_error, before the route runs', async () => {
    const leaving = await signedIn('Gus Guarded');
    const mark = await newestAuditRow();
    const from = logs.lines.length;
    let response: Response | undefined;
    await whileSessionRowIsHeld(leaving.idHash, async (holder) => {
      const signingOut = leaving.signOut();
      await waitForLockWaiters(sql, backendPid(holder), 1, 'the session lookup never waited', {
        waiter: signingOut,
      });
      response = await signingOut;
    });
    if (response === undefined) throw new Error('no answer');
    expect(response.headers.get('retry-after')).toBeNull();
    await expectError(response, 'internal_error');
    // The route did not run: no cookie was cleared, nothing was logged by it, nothing changed.
    expect(setCookie(response, t.config.sessionCookieName)).toBeNull();
    expect(signOutLines(from)).toEqual([]);
    expect(await leaving.live()).toBe(1);
    expect(await auditRowsAfter(mark)).toEqual([]);
  });
});
