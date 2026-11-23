/**
 * A change and its audit row have one outcome, for every audit action (adoption plan section
 * 2.1, step 17; decisions D2 and D3; AGENTS.md section 3).
 *
 * CASES has one entry per member of AuditAction, and the type makes a missing one a compile
 * error. Each case names what writes the action (a route as the application registers it, or a
 * writer outside the routes), and gives the request, job or command that writes it and a read
 * of the state it changes. An action that several routes say they write has a case through
 * each of them, and a route's statement with no case fails the second test below: so what a
 * route says it audits (apps/api/src/route-audit.ts, ROUTE_PERMISSIONS) is shown to be written,
 * on the transaction of the change. The harness, for every case alike:
 *
 *  1. checks that the named route, or the off-route list, declares the action
 *     (apps/api/src/route-audit.ts), so the statement and the test cannot drift;
 *  2. makes every insert of that action fail in the database (whileAuditFails of
 *     @tinnox/db/testing) and runs the attempt;
 *  3. requires that the fault refused at least one insert: a case that never reaches the audit
 *     write proves nothing, and fails here;
 *  4. requires that no row of the action was written and that the state is what it was
 *     (the change rolled back with its audit row);
 *  5. removes the fault, runs the same attempt again, and requires that it now answers as a
 *     success does, that the state changed and that the action's row is there: the failure in
 *     step 2 was the audit row and nothing else;
 *  6. requires that the request wrote no audit action its route does not state.
 *
 * Three kinds of case differ from that, each by name: a refusal, where nothing changes either
 * way and the refusal stands when it cannot be recorded (D2); the sign-out, where ending the
 * session is the safe direction and is accepted without its row (the CX-01 residual); and
 * pairing.cancel, which only migration 0012 writes and whose upgrade test holds the same proof.
 *
 * So an action that nothing writes cannot stay in AUDIT_ACTIONS: it has no case that passes
 * step 3 (D3).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS, PLAYER_PREFIX, ROUTES, type AuditAction } from '@tinnox/contracts';
import { connectMigrator, type MigratorPool } from '@tinnox/db/migrate';
import { removeAuditFault, whileAuditFails, whileUnauditedAllowed } from '@tinnox/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentityProvider } from '@tinnox/api/test-support';
import type { IdpAccount, IdpDirectory } from '../../scripts/lib/idp.ts';
import { fulfil, mfaReset } from '../../scripts/lib/provision.ts';
import {
  actAsWorker,
  addAlertAddress,
  addMember,
  assignPlaylist,
  checkAlerts,
  CLOCK,
  confirmAlertAddress,
  createApp,
  createDisplay,
  createLayout,
  createOrg,
  createPlaylist,
  createSchedule,
  declaredAudit,
  declaredAudits,
  heartbeatBody,
  imageItem,
  lastConfirmationToken,
  layoutZones,
  migratorUrl,
  newPairing,
  offRouteWriter,
  pairPlayer,
  pngBytes,
  pollPairing,
  push,
  readyImage,
  repoRoot,
  sendHeartbeat,
  signIn,
  startTestApp,
  uploadBytes,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

/** What an attempt answered: an HTTP status, or a word for a job or a command. */
type Answer = number | string;

/** How the change relates to its audit row. */
type Outcome =
  /** The change rolls back with its audit row. */
  | 'rolls_back'
  /** A refusal: nothing changes either way, and it is answered the same when it cannot be recorded. */
  | 'refusal_stands'
  /** An accepted residual: what the failing attempt leaves behind, and the decision that accepts it. */
  | { readonly residual: string; readonly leaves: unknown; readonly unauditedTable: string };

interface Scenario {
  /** Sends the request, or runs the job or the command, that writes the action. */
  attempt(): Promise<Answer>;
  /** What the action's change alters, read as the database administrator. */
  state(): Promise<unknown>;
  /** The answer while the audit row cannot be written. */
  readonly whenAuditFails: Answer;
  /** The answer once it can. */
  readonly whenAudited: Answer;
  readonly outcome?: Outcome;
}

/** One way an action is written: the writer, and how to arrange the scenario that reaches it. */
interface Case {
  /** The route that writes the action, as registered, or OFF_ROUTE for a writer outside the routes. */
  readonly through: string;
  arrange(): Promise<Scenario>;
}
const via = (through: string, arrange: () => Promise<Scenario>): Case => ({ through, arrange });

/** An action no code writes: a merged migration wrote it once, and its upgrade test fails it. */
interface MigrationOnly {
  readonly migration: string;
  readonly provedIn: string;
}

const OFF_ROUTE = 'offRoute';
const route = (method: string, pattern: string): string => `${method} ${pattern}`;

const DELAY_MS = 31 * 60 * 1000;
const STAFF = 'sam.staff';

let t: TestApp;
/** A second application, whose clock a case may move without touching the sessions of `t`. */
let clocked: TestApp;
let org: TestOrg;
let owner: Operator;
let provisioning: MigratorPool;
/** The subject the stand-in identity provider answers a sign-in with. */
let signingIn = '';

/** The identity provider of `t`: answers every sign-in with `signingIn`, as credential-audit.test.ts does. */
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

/** One read as the database administrator, who sees every organisation's rows and the ones with none. */
async function administrator<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  const url = new URL(migratorUrl());
  url.username = 'postgres';
  url.password = encodeURIComponent(process.env['POSTGRES_SUPERUSER_PASSWORD'] ?? '');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query<R>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

/** The whole row of `table` with this id, or null: any column the change touches shows. */
async function rowOf(table: string, id: string): Promise<unknown> {
  if (!/^[a-z_]+$/.test(table)) throw new Error('unexpected table name');
  const rows = await administrator<{ row: unknown }>(
    `SELECT to_jsonb(x) AS row FROM public.${table} x WHERE x.id = $1`,
    [id],
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

const rowsOfAction = async (action: AuditAction): Promise<number> =>
  countOf('audit_event', 'action', action);

/** The id of the newest audit row, in any organisation or none. */
async function newestAuditRow(): Promise<string> {
  const rows = await administrator<{ id: string }>(
    'SELECT coalesce(max(id), 0)::text AS id FROM public.audit_event',
  );
  return rows[0]?.id ?? '0';
}

/** The actions of the audit rows written after the row `id`. */
async function actionsWrittenAfter(id: string): Promise<string[]> {
  const rows = await administrator<{ action: string }>(
    'SELECT DISTINCT action FROM public.audit_event WHERE id > $1::bigint ORDER BY action',
    [id],
  );
  return rows.map((row) => row.action);
}

const send = (
  operator: Operator,
  method: string,
  path: string,
  json?: unknown,
): Promise<Response> => operator.fetch(path, json === undefined ? { method } : { method, json });
const status = async (response: Promise<Response>): Promise<number> => (await response).status;

/** The id of a row a POST created. */
async function created(response: Promise<Response>): Promise<string> {
  const answer = await response;
  const text = await answer.text();
  if (answer.status !== 201) throw new Error(`arranging failed: ${String(answer.status)} ${text}`);
  return (JSON.parse(text) as { id: string }).id;
}

/** A change through a route: one request, and the row or the count it alters. */
function change(
  request: () => Promise<Response>,
  state: () => Promise<unknown>,
  whenAudited: number,
): Scenario {
  return { attempt: () => status(request()), state, whenAuditFails: 500, whenAudited };
}

/** A fake identity-provider reader for provisioning. */
function directory(accounts: Readonly<Record<string, IdpAccount>>): IdpDirectory {
  return {
    findByUsername: (username) =>
      Promise.resolve(Object.hasOwn(accounts, username) ? (accounts[username] ?? null) : null),
  };
}

/** Runs a provisioning command and says whether it committed. */
const command = (run: () => Promise<unknown>): Promise<Answer> =>
  run().then(
    () => 'committed',
    () => 'failed',
  );

/** A paired screen of the organisation that has just reported. */
async function reportingScreen(name: string): Promise<{
  readonly id: string;
  report(): Promise<void>;
}> {
  const display = await createDisplay(owner, org, name);
  const player = await pairPlayer(t, owner, display.id);
  let seq = 0;
  const report = async (): Promise<void> => {
    seq += 1;
    const sent = await sendHeartbeat(t, player, heartbeatBody(display.id, seq));
    if (sent.status !== 200) throw new Error(`heartbeat failed: ${String(sent.status)}`);
  };
  await report();
  return { id: display.id, report };
}

/** Runs `work` with the application clock past the offline delay, then puts the clock back. */
async function later<T>(work: () => Promise<T>): Promise<T> {
  t.advanceClock(DELAY_MS);
  try {
    return await work();
  } finally {
    t.advanceClock(-DELAY_MS);
  }
}

/** The alert e-mails about one screen, by its name. */
const mailFor = (name: string): number =>
  t.sentMail.filter((mail) => mail.subject.endsWith(`: ${name}`)).length;

/** A confirmed alert address, so the alert check has somebody to write to. */
let alertAddress: Promise<void> | undefined;
function confirmedAlertAddress(): Promise<void> {
  alertAddress ??= (async () => {
    const added = await addAlertAddress(owner, 'ops@example.com');
    if (added.status !== 201) throw new Error(`adding an alert address failed: ${added.status}`);
    const confirmed = await confirmAlertAddress(t, lastConfirmationToken(t));
    if (confirmed.status !== 204) throw new Error(`confirming failed: ${confirmed.status}`);
  })();
  return alertAddress;
}

/** An Admin of the organisation who has asked for one invite, still pending. */
async function adminWithInvite(
  name: string,
  email: string,
): Promise<{ readonly admin: TestOrg; readonly invite: string }> {
  const admin = await addMember(org, 'admin', name);
  const invite = await created(
    send(await signIn(t, admin), 'POST', '/api/invites', {
      name: `${name}'s invitee`,
      email,
      role: 'viewer',
    }),
  );
  return { admin, invite };
}

/** Two empty playlists, for the schedules and layouts that need one to point at. */
async function twoPlaylists(name: string): Promise<[string, string]> {
  return [await createPlaylist(owner, `${name} A`), await createPlaylist(owner, `${name} B`)];
}

/**
 * Every audit action, and every way a route says it writes one: an action that several routes
 * write has a case through each (the list). The second test below fails a route's statement
 * that no case goes through.
 */
const CASES: { readonly [A in AuditAction]: Case | readonly Case[] | MigrationOnly } = {
  'auth.login': via(route('GET', ROUTES.authCallback), async () => {
    const member = await addMember(org, 'viewer');
    return {
      attempt: async () => {
        signingIn = member.oidcSub;
        const begin = await fetch(`${t.url}${ROUTES.authLogin}`, { redirect: 'manual' });
        const preAuth = new RegExp(`${t.config.loginCookieName}=([^;]+)`).exec(
          begin.headers.get('set-cookie') ?? '',
        )?.[1];
        if (begin.status !== 303 || preAuth === undefined) throw new Error('sign-in did not begin');
        const callback = await fetch(
          `${t.url}${ROUTES.authCallback}?code=test&state=${lastState}`,
          {
            redirect: 'manual',
            headers: { cookie: `${t.config.loginCookieName}=${preAuth}` },
          },
        );
        return callback.status;
      },
      state: () => countOf('session', 'membership_id', member.membershipId),
      whenAuditFails: 500,
      whenAudited: 303,
    };
  }),
  'auth.logout': via(route('POST', ROUTES.authLogout), async () => {
    const member = await addMember(org, 'viewer');
    let last: Operator | undefined;
    return {
      attempt: async () => {
        last = await signIn(t, member);
        return status(send(last, 'POST', ROUTES.authLogout));
      },
      // Whether the session that signed out still opens the API.
      state: async () =>
        last === undefined ? 'no session yet' : status(last.fetch('/api/displays')),
      whenAuditFails: 500,
      whenAudited: 200,
      outcome: {
        residual:
          'the accepted CX-01 residual: a sign-out whose audit row cannot be written still ends the session, through sessionRevokeUnaudited (adoption plan section 2.1 A)',
        leaves: 401,
        unauditedTable: 'session',
      },
    };
  }),
  'display.create': via(route('POST', ROUTES.displays), async () =>
    change(
      () =>
        send(owner, 'POST', '/api/displays', {
          siteId: org.siteId,
          name: 'Never audited screen',
          canvas: { width: 640, height: 360 },
        }),
      () => countOf('display', 'name', 'Never audited screen'),
      201,
    ),
  ),
  'display.update': via(route('PATCH', ROUTES.displayPattern), async () => {
    const display = await createDisplay(owner, org, 'Before the update');
    return change(
      () => send(owner, 'PATCH', `/api/displays/${display.id}`, { name: 'After the update' }),
      () => rowOf('display', display.id),
      200,
    );
  }),
  'display.offline_alert': via(OFF_ROUTE, async () => {
    await confirmedAlertAddress();
    const name = 'Offline alert screen';
    const screen = await reportingScreen(name);
    return {
      // The check runs over every organisation; this screen's episode and e-mail are the answer.
      attempt: async () => {
        await later(() => checkAlerts(t));
        return `${String(mailFor(name))} e-mail(s)`;
      },
      state: () => countOf('display_alert', 'display_id', screen.id),
      whenAuditFails: '0 e-mail(s)',
      whenAudited: '1 e-mail(s)',
    };
  }),
  'display.online_alert': via(OFF_ROUTE, async () => {
    await confirmedAlertAddress();
    const name = 'Online alert screen';
    const screen = await reportingScreen(name);
    // The episode opens (audited as display.offline_alert), then the screen reports again.
    await later(async () => {
      await checkAlerts(t);
      await screen.report();
    });
    if (mailFor(name) !== 1) throw new Error('the offline episode did not open');
    return {
      attempt: async () => {
        await later(() => checkAlerts(t));
        return `${String(mailFor(name))} e-mail(s)`;
      },
      state: () => countOf('display_alert', 'display_id', screen.id),
      whenAuditFails: '1 e-mail(s)',
      whenAudited: '2 e-mail(s)',
    };
  }),
  'pairing.create': via(route('POST', ROUTES.playerPairing), async () => ({
    attempt: () => status(fetch(`${t.url}${ROUTES.playerPairing}`, { method: 'POST' })),
    state: async () =>
      (
        await administrator<{ n: number }>('SELECT count(*)::int AS n FROM public.pairing_session')
      )[0]?.n,
    whenAuditFails: 500,
    whenAudited: 201,
  })),
  'pairing.claim': via(route('POST', ROUTES.displayClaimPattern), async () => {
    const display = await createDisplay(owner, org, 'Claimed screen');
    const pairing = await newPairing(t);
    return change(
      () => send(owner, 'POST', `/api/displays/${display.id}/claim`, { code: pairing.code }),
      () => rowOf('pairing_session', pairing.pairingId),
      200,
    );
  }),
  'pairing.complete': via(route('GET', ROUTES.playerPairingPollPattern), async () => {
    const display = await createDisplay(owner, org, 'Paired screen');
    const pairing = await newPairing(t);
    const claim = await send(owner, 'POST', `/api/displays/${display.id}/claim`, {
      code: pairing.code,
    });
    if (claim.status !== 200) throw new Error(`claim failed: ${String(claim.status)}`);
    return {
      attempt: () => status(pollPairing(t, pairing)),
      // No credential is issued without the row: no registration exists.
      state: () => countOf('player_registration', 'display_id', display.id),
      whenAuditFails: 500,
      whenAudited: 200,
    };
  }),
  'pairing.lock': via(route('GET', ROUTES.playerPairingPollPattern), async () => {
    const pairing = await newPairing(t);
    let attempts = 0;
    // A well-formed polling token that is not this pairing's.
    const wrong = (): Promise<number> => {
      attempts += 1;
      return status(
        fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
          headers: { authorization: `Bearer ${'A'.repeat(42)}${String(attempts % 10)}` },
        }),
      );
    };
    // Four wrong tokens count; the fifth locks the session.
    for (let i = 0; i < 4; i += 1) {
      if ((await wrong()) !== 404) throw new Error('a wrong polling token was not answered 404');
    }
    return {
      attempt: wrong,
      state: async () =>
        (
          await administrator<{ status: string }>(
            'SELECT status FROM public.pairing_session WHERE id = $1',
            [pairing.pairingId],
          )
        )[0]?.status,
      whenAuditFails: 500,
      whenAudited: 404,
    };
  }),
  'pairing.cancel': {
    migration: 'db/migrations/0012_pairing_upgrade_cleanup.sql',
    provedIn: 'packages/db/test/migration-0012.integration.test.ts',
  },
  'player.revoke': [
    via(route('POST', ROUTES.displayRevokePlayerPattern), async () => {
      const display = await createDisplay(owner, org, 'Revoked screen');
      const player = await pairPlayer(t, owner, display.id);
      return change(
        () => send(owner, 'POST', `/api/displays/${display.id}/revoke-player`),
        () => rowOf('player_registration', player.registrationId),
        200,
      );
    }),
    // Claiming a screen that has a player replaces it: the old credential and the new claim
    // have one outcome.
    via(route('POST', ROUTES.displayClaimPattern), async () => {
      const display = await createDisplay(owner, org, 'Re-paired screen');
      const player = await pairPlayer(t, owner, display.id);
      const pairing = await newPairing(t);
      return change(
        () => send(owner, 'POST', `/api/displays/${display.id}/claim`, { code: pairing.code }),
        async () => [
          await rowOf('player_registration', player.registrationId),
          await rowOf('pairing_session', pairing.pairingId),
        ],
        200,
      );
    }),
    // The player gives up its own credential.
    via(route('DELETE', `${PLAYER_PREFIX}/registration`), async () => {
      const display = await createDisplay(owner, org, 'Reset screen');
      const player = await pairPlayer(t, owner, display.id);
      return change(
        () =>
          fetch(`${t.url}${PLAYER_PREFIX}/registration`, {
            method: 'DELETE',
            headers: player.headers,
          }),
        () => rowOf('player_registration', player.registrationId),
        204,
      );
    }),
  ],
  'player.auth_rejected': via(route('GET', ROUTES.playerManifest), async () => ({
    // A device credential nobody issued. The row is written for the first failure of a client
    // in a window, so each attempt starts a new window on this application's own clock.
    attempt: async () => {
      clocked.advanceClock(60 * 60 * 1000);
      const token = randomBytes(32).toString('base64url');
      return status(
        fetch(`${clocked.url}${ROUTES.playerManifest}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    },
    state: async () =>
      (
        await administrator<{ n: number }>(
          'SELECT count(*)::int AS n FROM public.player_registration',
        )
      )[0]?.n,
    whenAuditFails: 401,
    whenAudited: 401,
    outcome: 'refusal_stands',
  })),
  'media.upload': via(route('POST', ROUTES.media), async () => ({
    attempt: async () => status(uploadBytes(owner, await pngBytes(), 'never-audited.png')),
    state: () => countOf('media', 'org_id', org.orgId),
    whenAuditFails: 500,
    whenAudited: 201,
  })),
  'media.validate': via(OFF_ROUTE, async () => {
    const upload = await uploadBytes(owner, await pngBytes(), 'validated.png');
    if (upload.status !== 201) throw new Error(`upload failed: ${String(upload.status)}`);
    const { media } = (await upload.json()) as { media: { id: string } };
    await actAsWorker(t, {
      schemaVersion: 1,
      jobId: media.id,
      outcome: 'accepted',
      kind: 'image',
      mimeType: 'image/png',
      width: 32,
      height: 16,
      durationMs: null,
      codec: null,
    });
    const statusOfMedia = async (): Promise<string> =>
      (
        await administrator<{ status: string }>('SELECT status FROM public.media WHERE id = $1', [
          media.id,
        ])
      )[0]?.status ?? 'gone';
    return {
      // The pipeline takes the verdict; a failure leaves the job for the next tick.
      attempt: async () => {
        await t.ctx.media.tick();
        return statusOfMedia();
      },
      state: () => rowOf('media', media.id),
      whenAuditFails: 'processing',
      whenAudited: 'ready',
    };
  }),
  'media.update': via(route('PATCH', ROUTES.mediaItemPattern), async () => {
    const image = await readyImage(t, owner);
    return change(
      () => send(owner, 'PATCH', `/api/media/${image.id}`, { name: 'Renamed image' }),
      () => rowOf('media', image.id),
      200,
    );
  }),
  'media.delete': via(route('DELETE', ROUTES.mediaItemPattern), async () => {
    const image = await readyImage(t, owner);
    return change(
      () => send(owner, 'DELETE', `/api/media/${image.id}`),
      () => rowOf('media', image.id),
      204,
    );
  }),
  'tag.create': via(route('POST', ROUTES.tags), async () =>
    change(
      () => send(owner, 'POST', '/api/tags', { scope: 'media', name: 'Never audited tag' }),
      () => countOf('tag', 'name', 'Never audited tag'),
      201,
    ),
  ),
  'tag.update': via(route('PATCH', ROUTES.tagPattern), async () => {
    const id = await created(send(owner, 'POST', '/api/tags', { scope: 'media', name: 'Tag A' }));
    return change(
      () => send(owner, 'PATCH', `/api/tags/${id}`, { name: 'Tag A renamed' }),
      () => rowOf('tag', id),
      200,
    );
  }),
  'tag.delete': via(route('DELETE', ROUTES.tagPattern), async () => {
    const id = await created(send(owner, 'POST', '/api/tags', { scope: 'media', name: 'Tag B' }));
    return change(
      () => send(owner, 'DELETE', `/api/tags/${id}`),
      () => rowOf('tag', id),
      204,
    );
  }),
  'folder.create': via(route('POST', ROUTES.folders), async () =>
    change(
      () => send(owner, 'POST', '/api/folders', { name: 'Never audited folder' }),
      () => countOf('folder', 'name', 'Never audited folder'),
      201,
    ),
  ),
  'folder.update': via(route('PATCH', ROUTES.folderPattern), async () => {
    const id = await created(send(owner, 'POST', '/api/folders', { name: 'Folder A' }));
    return change(
      () => send(owner, 'PATCH', `/api/folders/${id}`, { name: 'Folder A renamed' }),
      () => rowOf('folder', id),
      200,
    );
  }),
  'folder.delete': via(route('DELETE', ROUTES.folderPattern), async () => {
    const id = await created(send(owner, 'POST', '/api/folders', { name: 'Folder B' }));
    return change(
      () => send(owner, 'DELETE', `/api/folders/${id}`),
      () => rowOf('folder', id),
      204,
    );
  }),
  'app.create': via(route('POST', ROUTES.apps), async () =>
    change(
      () => send(owner, 'POST', '/api/apps', { name: 'Never audited clock', content: CLOCK }),
      () => countOf('app', 'name', 'Never audited clock'),
      201,
    ),
  ),
  'app.update': via(route('PATCH', ROUTES.appPattern), async () => {
    const app = await createApp(owner, CLOCK, 'Clock A');
    return change(
      () => send(owner, 'PATCH', `/api/apps/${app.id}`, { name: 'Clock A renamed' }),
      () => rowOf('app', app.id),
      200,
    );
  }),
  'app.delete': via(route('DELETE', ROUTES.appPattern), async () => {
    const app = await createApp(owner, CLOCK, 'Clock B');
    return change(
      () => send(owner, 'DELETE', `/api/apps/${app.id}`),
      () => rowOf('app', app.id),
      204,
    );
  }),
  'playlist.create': [
    via(route('POST', ROUTES.playlists), async () =>
      change(
        () => send(owner, 'POST', '/api/playlists', { name: 'Never audited loop' }),
        () => countOf('playlist', 'name', 'Never audited loop'),
        201,
      ),
    ),
    via(route('POST', ROUTES.playlistDuplicatePattern), async () => {
      const id = await createPlaylist(owner, 'Loop to copy');
      return change(
        () => send(owner, 'POST', `/api/playlists/${id}/duplicate`),
        () => countOf('playlist', 'org_id', org.orgId),
        201,
      );
    }),
  ],
  'playlist.update': via(route('PUT', ROUTES.playlistPattern), async () => {
    const id = await createPlaylist(owner, 'Loop A');
    return change(
      () => send(owner, 'PUT', `/api/playlists/${id}`, { name: 'Loop A renamed', items: [] }),
      () => rowOf('playlist', id),
      200,
    );
  }),
  'playlist.delete': via(route('DELETE', ROUTES.playlistPattern), async () => {
    const id = await createPlaylist(owner, 'Loop B');
    return change(
      () => send(owner, 'DELETE', `/api/playlists/${id}`),
      () => rowOf('playlist', id),
      204,
    );
  }),
  'schedule.create': via(route('POST', ROUTES.schedules), async () => {
    const [playlist] = await twoPlaylists('Schedule create');
    return change(
      () =>
        send(owner, 'POST', '/api/schedules', {
          name: 'Never audited hours',
          defaultPlaylistId: playlist,
          events: [],
        }),
      () => countOf('schedule', 'name', 'Never audited hours'),
      201,
    );
  }),
  'schedule.update': via(route('PUT', ROUTES.schedulePattern), async () => {
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
      200,
    );
  }),
  'schedule.delete': via(route('DELETE', ROUTES.schedulePattern), async () => {
    const [playlist] = await twoPlaylists('Schedule delete');
    const schedule = await createSchedule(owner, 'Hours B', playlist);
    return change(
      () => send(owner, 'DELETE', `/api/schedules/${schedule.id}`),
      () => rowOf('schedule', schedule.id),
      204,
    );
  }),
  'layout.create': via(route('POST', ROUTES.layouts), async () => {
    const [main, band] = await twoPlaylists('Layout create');
    return change(
      () =>
        send(owner, 'POST', '/api/layouts', {
          name: 'Never audited layout',
          zones: layoutZones(main, band),
        }),
      () => countOf('layout', 'name', 'Never audited layout'),
      201,
    );
  }),
  'layout.update': via(route('PUT', ROUTES.layoutPattern), async () => {
    const [main, band] = await twoPlaylists('Layout update');
    const layout = await createLayout(owner, 'Layout A', layoutZones(main, band));
    return change(
      () =>
        send(owner, 'PUT', `/api/layouts/${layout.id}`, {
          name: 'Layout A renamed',
          zones: layoutZones(main, band),
        }),
      () => rowOf('layout', layout.id),
      200,
    );
  }),
  'layout.delete': via(route('DELETE', ROUTES.layoutPattern), async () => {
    const [main, band] = await twoPlaylists('Layout delete');
    const layout = await createLayout(owner, 'Layout B', layoutZones(main, band));
    return change(
      () => send(owner, 'DELETE', `/api/layouts/${layout.id}`),
      () => rowOf('layout', layout.id),
      204,
    );
  }),
  'publication.create': [
    via(route('POST', ROUTES.playlistPublishPattern), async () => {
      const display = await createDisplay(owner, org, 'Published screen');
      const image = await readyImage(t, owner);
      const playlist = await createPlaylist(owner, 'Published loop', [imageItem(image.id)]);
      return change(
        () =>
          owner.fetch(`/api/playlists/${playlist}/publish`, {
            method: 'POST',
            json: { displayId: display.id },
            headers: { 'idempotency-key': randomUUID() },
          }),
        () => countOf('publication', 'display_id', display.id),
        201,
      );
    }),
    via(route('POST', ROUTES.push), async () => {
      const display = await createDisplay(owner, org, 'Pushed screen');
      const image = await readyImage(t, owner);
      const playlist = await createPlaylist(owner, 'Pushed loop', [imageItem(image.id)]);
      await assignPlaylist(owner, display.id, playlist);
      return change(
        () => push(owner, [display.id]),
        () => countOf('publication', 'display_id', display.id),
        200,
      );
    }),
  ],
  'invite.create': via(route('POST', ROUTES.invites), async () =>
    change(
      () =>
        send(owner, 'POST', '/api/invites', {
          name: 'Ines Invitee',
          email: 'ines@example.com',
          role: 'viewer',
        }),
      () => countOf('member_invite', 'org_id', org.orgId),
      201,
    ),
  ),
  'invite.cancel': [
    via(route('POST', ROUTES.inviteCancelPattern), async () => {
      const id = await created(
        send(owner, 'POST', '/api/invites', {
          name: 'Cam Cancelled',
          email: 'cam@example.com',
          role: 'viewer',
        }),
      );
      return change(
        () => send(owner, 'POST', `/api/invites/${id}/cancel`),
        () => rowOf('member_invite', id),
        204,
      );
    }),
    // A demotion cancels the invites the member may no longer send, in the same transaction:
    // when that row fails, the member keeps the role and the invite stays pending.
    via(route('PATCH', ROUTES.memberPattern), async () => {
      const { admin, invite } = await adminWithInvite('Dee Demoted', 'dees.invitee@example.com');
      return change(
        () => send(owner, 'PATCH', `/api/members/${admin.membershipId}`, { role: 'viewer' }),
        async () => [
          await rowOf('membership', admin.membershipId),
          await rowOf('member_invite', invite),
        ],
        200,
      );
    }),
    // So does a removal.
    via(route('POST', ROUTES.memberRemovePattern), async () => {
      const { admin, invite } = await adminWithInvite('Gil Gone', 'gils.invitee@example.com');
      return change(
        () => send(owner, 'POST', `/api/members/${admin.membershipId}/remove`),
        async () => [
          await rowOf('membership', admin.membershipId),
          await rowOf('member_invite', invite),
        ],
        200,
      );
    }),
  ],
  // The API adds no member: provisioning's fulfil does, as tinnox_migrator.
  'membership.create': via(OFF_ROUTE, async () => {
    const id = await created(
      send(owner, 'POST', '/api/invites', {
        name: 'Fay Fulfilled',
        email: 'fay@example.com',
        role: 'editor',
      }),
    );
    const fay: IdpAccount = {
      subject: `audit-failure-${randomUUID()}`,
      email: 'fay@example.com',
      enabled: true,
    };
    return {
      attempt: () =>
        command(() =>
          fulfil(provisioning, directory({ fay }), {
            inviteId: id,
            username: 'fay',
            confirmedWith: 'TICKET-17',
            executedBy: STAFF,
          }),
        ),
      // The member row and the invite it closes.
      state: async () => [
        await countOf('membership', 'oidc_sub', fay.subject),
        await rowOf('member_invite', id),
      ],
      whenAuditFails: 'failed',
      whenAudited: 'committed',
    };
  }),
  'membership.role_change': via(route('PATCH', ROUTES.memberPattern), async () => {
    const member = await addMember(org, 'viewer', 'Rae Role');
    return change(
      () => send(owner, 'PATCH', `/api/members/${member.membershipId}`, { role: 'editor' }),
      () => rowOf('membership', member.membershipId),
      200,
    );
  }),
  'membership.update': via(route('PATCH', ROUTES.memberPattern), async () => {
    const member = await addMember(org, 'viewer', 'Nat Name');
    return change(
      () =>
        send(owner, 'PATCH', `/api/members/${member.membershipId}`, { displayName: 'Nat Renamed' }),
      () => rowOf('membership', member.membershipId),
      200,
    );
  }),
  'membership.remove': via(route('POST', ROUTES.memberRemovePattern), async () => {
    const member = await addMember(org, 'viewer', 'Rem Removed');
    return change(
      () => send(owner, 'POST', `/api/members/${member.membershipId}/remove`),
      () => rowOf('membership', member.membershipId),
      200,
    );
  }),
  'membership.sessions_end': via(route('POST', ROUTES.memberSignOutPattern), async () => {
    const member = await addMember(org, 'viewer', 'Sal Signed-Out');
    return change(
      () => send(owner, 'POST', `/api/members/${member.membershipId}/sign-out`),
      () => rowOf('membership', member.membershipId),
      200,
    );
  }),
  // Provisioning only: a sign-in reset ends the member's sessions.
  'membership.mfa_reset': via(OFF_ROUTE, async () => {
    const member = await addMember(org, 'viewer', 'Mia Reset');
    const mia: IdpAccount = { subject: member.oidcSub, email: null, enabled: true };
    return {
      attempt: () =>
        command(() =>
          mfaReset(provisioning, directory({ mia }), {
            username: 'mia',
            requestRef: 'REQ-17',
            executedBy: STAFF,
            // The organisation has another Owner, so the reset needs their word.
            confirmedWith: 'TICKET-18',
          }),
        ),
      state: () => rowOf('membership', member.membershipId),
      whenAuditFails: 'failed',
      whenAudited: 'committed',
    };
  }),
  'alert_recipient.add': via(route('POST', ROUTES.alertRecipients), async () =>
    change(
      () => addAlertAddress(owner, 'added@example.com'),
      () => countOf('alert_recipient', 'email', 'added@example.com'),
      201,
    ),
  ),
  'alert_recipient.remove': via(route('DELETE', ROUTES.alertRecipientPattern), async () => {
    const id = await created(addAlertAddress(owner, 'removed@example.com'));
    return change(
      () => send(owner, 'DELETE', `/api/alert-recipients/${id}`),
      () => rowOf('alert_recipient', id),
      204,
    );
  }),
  'alert_recipient.confirm': via(route('POST', ROUTES.alertRecipientConfirm), async () => {
    const id = await created(addAlertAddress(owner, 'confirmed@example.com'));
    const token = lastConfirmationToken(t);
    return {
      // The link is not used up by the failure: the same token confirms afterwards.
      attempt: () => status(confirmAlertAddress(t, token)),
      state: () => rowOf('alert_recipient', id),
      whenAuditFails: 500,
      whenAudited: 204,
    };
  }),
  'security.csrf_rejected': via(route('POST', ROUTES.folders), async () => ({
    attempt: () =>
      status(
        owner.fetch('/api/folders', {
          method: 'POST',
          json: { name: 'From another site' },
          headers: { origin: 'https://elsewhere.example' },
        }),
      ),
    state: () => countOf('folder', 'name', 'From another site'),
    whenAuditFails: 403,
    whenAudited: 403,
    outcome: 'refusal_stands',
  })),
  // A refusal by a people rule is recorded every time (nobody changes their own membership);
  // a refusal by role alone is thresholded per member.
  'security.permission_denied': via(route('PATCH', ROUTES.memberPattern), async () => ({
    attempt: () =>
      status(send(owner, 'PATCH', `/api/members/${org.membershipId}`, { displayName: 'Myself' })),
    state: () => rowOf('membership', org.membershipId),
    whenAuditFails: 403,
    whenAudited: 403,
    outcome: 'refusal_stands',
  })),
};

beforeAll(async () => {
  t = await startTestApp();
  clocked = await startTestApp();
  (t.ctx as { idp: IdentityProvider }).idp = provider;
  org = await createOrg('Audit failure', { displayName: 'Olive Owner' });
  owner = await signIn(t, org);
  provisioning = await connectMigrator(migratorUrl(), { applicationName: 'tinnox-provision' });
});
afterAll(async () => {
  await removeAuditFault(migratorUrl());
  await provisioning.end();
  await clocked.close();
  await t.close();
});

const isMigrationOnly = (entry: Case | readonly Case[] | MigrationOnly): entry is MigrationOnly =>
  'migration' in entry;
const casesOf = (action: AuditAction): readonly Case[] => {
  const entry = CASES[action];
  if (isMigrationOnly(entry)) return [];
  return 'through' in entry ? [entry] : entry;
};

describe('every audit action has a case, and every statement of a route has one (D3)', () => {
  it('has a case for every action of AUDIT_ACTIONS, and for nothing else', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(
        Object.hasOwn(CASES, action) &&
          (isMigrationOnly(CASES[action]) || casesOf(action).length > 0),
        `No audit-failure case for ${action}: add it to CASES in tests/integration/audit-failure.test.ts, or delete the action if nothing writes it (D3)`,
      ).toBe(true);
    }
    expect(Object.keys(CASES).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('goes through every route for every action the route says its own work writes', () => {
    const stated = declaredAudits();
    // The API's two tables were read: the operator writes, and the routes outside them.
    expect(stated.length).toBeGreaterThan(70);
    const missing = stated.flatMap(({ route: through, own }) =>
      own
        .filter((action) => !casesOf(action).some((one) => one.through === through))
        .map(
          (action) =>
            `No audit-failure case for ${action} through ${through}: the route says it writes the action, so add a case with via('${through}', ...) to CASES['${action}'], or correct the route's statement`,
        ),
    );
    expect(missing).toEqual([]);
  });
});

describe('a change and its audit row have one outcome', () => {
  for (const action of AUDIT_ACTIONS) {
    const entry = CASES[action];

    if (isMigrationOnly(entry)) {
      it(`${action}: written by a merged migration alone, whose upgrade test fails its audit row`, () => {
        expect(offRouteWriter(action), `${action} needs its writer in OFF_ROUTE_AUDIT`).toContain(
          'migration',
        );
        // One statement: the change and its audit rows cannot come apart inside the migration.
        const migration = readFileSync(join(repoRoot, entry.migration), 'utf8');
        expect(migration).toMatch(
          new RegExp(
            `WITH \\w+ AS \\(\\s*UPDATE [^;]*\\)\\s*INSERT INTO public\\.audit_event [^;]*'${action.replace('.', '\\.')}'[^;]*;`,
          ),
        );
        // The proof itself is in the migration's upgrade test, where the old schema is built.
        expect(existsSync(join(repoRoot, entry.provedIn))).toBe(true);
        const proof = readFileSync(join(repoRoot, entry.provedIn), 'utf8');
        expect(proof).toContain(`whileAuditFails(migratorUrl(), '${action}'`);
        expect(proof).toMatch(/refused\)\.toBeGreaterThan\(0\)/);
      });
      continue;
    }

    for (const { through, arrange } of casesOf(action)) {
      const where = through === OFF_ROUTE ? 'outside the routes' : `through ${through}`;
      it(`${action}, ${where}: nothing of the change is kept when its audit row cannot be written`, async () => {
        const scenario = await arrange();
        const outcome = scenario.outcome ?? 'rolls_back';

        // 1. The writer says so itself.
        if (through === OFF_ROUTE) {
          expect(
            offRouteWriter(action),
            `${action} is written outside the routes: name its writer in OFF_ROUTE_AUDIT (apps/api/src/route-audit.ts)`,
          ).toBeDefined();
        } else {
          const declared = declaredAudit(through);
          expect(declared, `${through} is not a route with an audit statement`).toBeDefined();
          expect(
            outcome === 'refusal_stands' ? declared?.guard : declared?.own,
            `${through} writes ${action}: say so in its audit statement (ROUTE_PERMISSIONS or OTHER_ROUTE_AUDIT)`,
          ).toContain(action);
        }

        const before = await scenario.state();
        const rowsBefore = await rowsOfAction(action);

        // 2 and 3. The audit row fails, and the attempt really tried to write it.
        const failing = (): Promise<Answer> => scenario.attempt();
        const failed = await whileAuditFails(migratorUrl(), action, () =>
          typeof outcome === 'object'
            ? whileUnauditedAllowed(
                migratorUrl(),
                outcome.unauditedTable,
                outcome.residual,
                failing,
              )
            : failing(),
        );
        expect(
          failed.refused,
          `the attempt never tried to write a ${action} row, so this case shows nothing: make it reach the audit write`,
        ).toBeGreaterThan(0);
        expect(failed.result).toBe(scenario.whenAuditFails);

        // 4. No row of the action, and the state the change would alter is what it was.
        expect(await rowsOfAction(action)).toBe(rowsBefore);
        if (typeof outcome === 'object') {
          expect(await scenario.state()).toEqual(outcome.leaves);
        } else {
          expect(await scenario.state()).toEqual(before);
        }

        // 5. Without the fault the same attempt goes through, and its row is there.
        const lastRow = await newestAuditRow();
        expect(await scenario.attempt()).toBe(scenario.whenAudited);
        expect(await rowsOfAction(action)).toBeGreaterThan(rowsBefore);
        if (outcome === 'rolls_back') {
          expect(await scenario.state()).not.toEqual(before);
        } else if (outcome === 'refusal_stands') {
          expect(await scenario.state()).toEqual(before);
          expect(scenario.whenAuditFails).toBe(scenario.whenAudited);
        } else {
          expect(await scenario.state()).toEqual(outcome.leaves);
        }

        // 6. And the request wrote no action its route does not state. A job outside the
        // routes runs over every organisation, so its rows say nothing about one statement.
        if (through !== OFF_ROUTE) {
          const declared = declaredAudit(through);
          const stated: readonly string[] = [...(declared?.own ?? []), ...(declared?.guard ?? [])];
          expect(
            (await actionsWrittenAfter(lastRow)).filter((written) => !stated.includes(written)),
            `${through} wrote an audit action it does not state: add it to the route's audit statement (ROUTE_PERMISSIONS or OTHER_ROUTE_AUDIT)`,
          ).toEqual([]);
        }
      });
    }
  }
});
