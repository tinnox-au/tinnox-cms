/**
 * The races (adoption plan section 4.2, step 33; TST-9 of the group C review): pairs of real
 * requests that meet in PostgreSQL, with the meeting read from the server.
 *
 * How a pair is raced (`race`): the winner is a real request stopped before its COMMIT, with
 * everything it writes sent and locked and nothing of it visible; the loser is a real request
 * sent then; the test waits until the server shows the loser's backend waiting for a lock the
 * winner's backend holds (`waitForLockWaiters`), and only then lets the winner commit. Nothing
 * sleeps for a guessed time, and a loser that ends without having waited fails the test at
 * once, with a message, instead of passing on luck.
 *
 * Three groups:
 *
 *  1. One race per constraint a route maps to an answer (CONSTRAINTS of @tinnox/db, step 26).
 *     For each, the request that maps the constraint is the loser, and the test pins who
 *     decided its answer: PostgreSQL, refusing with that constraint (`refusedBy`, read from the
 *     errors the server raised on the application's connections), or the route's own lock and
 *     check, which made the loser wait and then see the winner's change, so that the constraint
 *     never fired (`refusedBy: null`). Most mapped constraints are of the second kind: the row
 *     locks the routes take (FOR SHARE on a playlist, FOR KEY SHARE on a media item, the
 *     membership lock) leave the constraint as the last line behind them. Removing such a lock
 *     turns `refusedBy` from null to the constraint's name, and the row fails. The first test
 *     holds the table to the registry: a registered constraint with no race, and no reason for
 *     having none, fails there. The last-Owner trigger has a describe of its own: its race
 *     needs an organisation with two Owners.
 *  2. The Idempotency-Key of publish and push: two requests with one key at once, the unique
 *     index `publication_idempotency` really refusing a request (a rival that did not take the
 *     key lock), and the keyed re-run's answer to a media foreign key (TST-9), which only an
 *     injected error can reach: the test says why.
 *  3. The pairs section 4.2 lists as not covered: a revoke against a revoke, against a player's
 *     reset and against a claim, and a single-session sign-out against a request in flight.
 *
 * Rule 2 (AGENTS.md): two of the races have a bystander in another organisation, sent while the
 * winner still holds its locks; it must answer without waiting, and as if it were alone.
 */
import { randomUUID } from 'node:crypto';
import { CONSTRAINTS, type ConstraintName } from '@tinnox/db';
import type { Pool, PoolClient } from '@tinnox/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appItem,
  assignPlaylist,
  CLOCK,
  createApp,
  createDisplay,
  createLayout,
  createOrg,
  createPlaylist,
  createSchedule,
  expectError,
  faultHarness,
  imageItem,
  layoutZones,
  pairPlayer,
  push,
  reachedBefore,
  readyImage,
  scheduleEvent,
  signIn,
  startTestApp,
  waitForLockWaiters,
  withoutWaitingFor,
  type AnsweredErrorCode,
  type Operator,
  type PairedPlayer,
  type StatementMatcher,
  type TestApp,
  type TestOrg,
} from './support.ts';

const HERE = 'apps/api/test/races.integration.test.ts';

/** The audit row of a change: the last statement before its COMMIT. */
const AT_AUDIT: StatementMatcher = (text) =>
  /^\s*INSERT INTO audit_event \(org_id/.test(text) || text.includes('sec.audit_unscoped(');

const faults = faultHarness();
let t: TestApp;
let org: TestOrg;
let owner: Operator;
/** Another organisation, for the bystanders. */
let otherOrg: TestOrg;
let otherOwner: Operator;
/** The test's own statements, never wrapped. */
let sql: Pool;
let admin: pg.Client;

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** One read as the database administrator, who sees every organisation's rows. */
async function administrator<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  return (await admin.query<R>(text, [...values])).rows;
}

/** How many rows of `table` have `column` = `value`, and `more` if given. */
async function countOf(table: string, column: string, value: string, more = ''): Promise<number> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error('unexpected name');
  const rows = await administrator<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.${table} x WHERE x.${column} = $1 ${more}`,
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

/** The audit rows written after row `id`, oldest first, as `action:result` or `action:result:reason`. */
async function auditRowsAfter(id: string): Promise<string[]> {
  const rows = await administrator<{ action: string; result: string; reason: string | null }>(
    `SELECT action, result, detail->>'reason' AS reason
       FROM public.audit_event WHERE id > $1::bigint ORDER BY id`,
    [id],
  );
  return rows.map(
    (row) => `${row.action}:${row.result}${row.reason === null ? '' : `:${row.reason}`}`,
  );
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

/** What a request answered, for one comparison of everything at once. */
type Answered =
  { readonly status: number } | { readonly error: AnsweredErrorCode; readonly message: string };

async function answered(response: Response): Promise<Answered> {
  if (response.status < 400) {
    await response.arrayBuffer();
    return { status: response.status };
  }
  const body = (await response.json()) as { error: { code: AnsweredErrorCode; message: string } };
  return { error: body.error.code, message: body.error.message };
}

interface Raced {
  readonly won: Response;
  readonly lost: Response;
  /** The winner's backend, whose locks the loser waited for. */
  readonly winnerPid: number;
}

/**
 * Races two requests: `winner` is stopped before its COMMIT (the first COMMIT after a statement
 * `wrote` matches; its audit row unless given), `loser` is sent, and once the server shows a
 * backend waiting for a lock of the winner's backend, `meanwhile` runs and the winner commits.
 * Fails at once when the winner answers before its COMMIT, or the loser ends without waiting.
 */
async function race(
  winner: () => Promise<Response>,
  loser: () => Promise<Response>,
  options: {
    readonly wrote?: StatementMatcher;
    /** Only a wait for this kind of lock counts ('advisory' for a key lock). */
    readonly locktype?: string;
    /** Runs while the winner holds its locks and the loser waits. */
    readonly meanwhile?: (winnerPid: number) => Promise<void>;
  } = {},
): Promise<Raced> {
  const wrote = options.wrote ?? AT_AUDIT;
  let written = false;
  const held = faults.hold((text) => {
    if (typeof wrote === 'function' ? wrote(text) : wrote.test(text)) written = true;
    return written && text === 'COMMIT';
  });
  const winning = winner();
  const winnerPid = await reachedBefore(held, winning, 'the winner');
  const losing = loser();
  try {
    await waitForLockWaiters(
      sql,
      winnerPid,
      1,
      'the loser never waited for a lock the winner holds',
      {
        waiter: losing,
        ...(options.locktype === undefined ? {} : { locktype: options.locktype }),
      },
    );
    await options.meanwhile?.(winnerPid);
  } finally {
    held.release();
  }
  return { won: await winning, lost: await losing, winnerPid };
}

/** One row of the constraint table: a pair of requests, and what must come of it. */
interface ConstraintRace {
  /** The registered constraints this pair is the race of. */
  readonly constraints: readonly ConstraintName[];
  /** The route that maps them, the loser. */
  readonly loser: string;
  /** The request that wins. */
  readonly winner: string;
  arrange(): Promise<{
    winner(): Promise<Response>;
    loser(): Promise<Response>;
    /** How many of the thing the pair fights over exist afterwards: one change, not two. */
    changes(): Promise<number>;
  }>;
  /** The winner's status and its one audit row. */
  readonly won: { readonly status: number; readonly audit: string };
  /** The loser's answer. */
  readonly lost: { readonly error: AnsweredErrorCode; readonly message: string };
  /**
   * Who refused the loser: the constraint PostgreSQL raised, or null when the route's own lock
   * made it wait and its own check then saw the winner's change (the constraint did not fire).
   */
  readonly refusedBy: ConstraintName | null;
  /** The audit rows the loser wrote: none unless rule 3 says its refusal is audited. */
  readonly lostAudit?: readonly string[];
  /** `changes()` afterwards: 1 unless given. */
  readonly changes?: number;
  /** The same request in another organisation, sent while the winner holds its locks. */
  bystander?(): Promise<Response>;
}

const PLAYLIST_GONE_FROM_SCHEDULE = 'A playlist in this schedule does not exist or was deleted.';
const PLAYLIST_GONE_FROM_LAYOUT = 'A playlist in this layout does not exist or was deleted.';
const ITEMS_NOT_SAVED = 'The playlist has items that cannot be saved.';

const deletePlaylist = (id: string) => (): Promise<Response> =>
  send(owner, 'DELETE', `/api/playlists/${id}`);
const playlistDeleted = (id: string) => (): Promise<number> =>
  countOf('playlist', 'id', id, 'AND x.deleted_at IS NOT NULL');

/**
 * Every constraint a route maps to an answer (step 26), each with the race of the two requests
 * that could meet at it.
 */
const CONSTRAINT_RACES: readonly ConstraintRace[] = [
  {
    constraints: ['folder_org_name_key'],
    winner: 'POST /api/folders',
    loser: 'POST /api/folders with the same name',
    arrange: () => {
      const name = `Raced folder ${randomUUID()}`;
      const create = (as: Operator) => (): Promise<Response> =>
        send(as, 'POST', '/api/folders', { name });
      CONSTRAINT_BYSTANDERS.set('folder_org_name_key', create(otherOwner));
      return Promise.resolve({
        winner: create(owner),
        loser: create(owner),
        changes: () => countOf('folder', 'name', name, `AND x.org_id = '${org.orgId}'`),
      });
    },
    won: { status: 201, audit: 'folder.create:success' },
    lost: { error: 'conflict', message: 'Another folder already has that name.' },
    refusedBy: 'folder_org_name_key',
    bystander: () => bystanderOf('folder_org_name_key'),
  },
  {
    constraints: ['tag_org_scope_name_key'],
    winner: 'POST /api/tags',
    loser: 'POST /api/tags with the same scope and name',
    arrange: () => {
      const name = `raced-${randomUUID().slice(0, 8)}`;
      const create = (): Promise<Response> =>
        send(owner, 'POST', '/api/tags', { scope: 'media', name });
      return Promise.resolve({
        winner: create,
        loser: create,
        changes: () => countOf('tag', 'name', name),
      });
    },
    won: { status: 201, audit: 'tag.create:success' },
    lost: { error: 'conflict', message: 'Another tag of this kind already has that name.' },
    refusedBy: 'tag_org_scope_name_key',
  },
  {
    constraints: ['media_folder_fk'],
    winner: 'DELETE /api/folders/:id',
    loser: 'PATCH /api/media/:id into that folder',
    arrange: async () => {
      const folder = await created(send(owner, 'POST', '/api/folders', { name: randomUUID() }));
      const image = await readyImage(t, owner);
      return {
        winner: () => send(owner, 'DELETE', `/api/folders/${folder}`),
        loser: () => send(owner, 'PATCH', `/api/media/${image.id}`, { folderId: folder }),
        changes: async () => 1 - (await countOf('folder', 'id', folder)),
      };
    },
    won: { status: 204, audit: 'folder.delete:success' },
    lost: { error: 'not_found', message: 'The folder was not found.' },
    refusedBy: 'media_folder_fk',
  },
  {
    constraints: ['media_tag_tag_fk'],
    winner: 'DELETE /api/tags/:id',
    loser: 'PATCH /api/media/:id with that tag',
    arrange: async () => {
      const tag = await created(
        send(owner, 'POST', '/api/tags', { scope: 'media', name: randomUUID().slice(0, 12) }),
      );
      const image = await readyImage(t, owner);
      return {
        winner: () => send(owner, 'DELETE', `/api/tags/${tag}`),
        loser: () => send(owner, 'PATCH', `/api/media/${image.id}`, { tagIds: [tag] }),
        changes: async () => 1 - (await countOf('tag', 'id', tag)),
      };
    },
    won: { status: 204, audit: 'tag.delete:success' },
    lost: { error: 'not_found', message: 'The tag was not found.' },
    refusedBy: 'media_tag_tag_fk',
  },
  {
    constraints: ['display_tag_tag_fk'],
    winner: 'DELETE /api/tags/:id',
    loser: 'PATCH /api/displays/:id with that tag',
    arrange: async () => {
      const tag = await created(
        send(owner, 'POST', '/api/tags', { scope: 'display', name: randomUUID().slice(0, 12) }),
      );
      const display = await createDisplay(owner, org, 'Tagged meanwhile');
      return {
        winner: () => send(owner, 'DELETE', `/api/tags/${tag}`),
        loser: () => send(owner, 'PATCH', `/api/displays/${display.id}`, { tagIds: [tag] }),
        changes: async () => 1 - (await countOf('tag', 'id', tag)),
      };
    },
    won: { status: 204, audit: 'tag.delete:success' },
    lost: { error: 'not_found', message: 'The tag was not found.' },
    refusedBy: 'display_tag_tag_fk',
  },
  // From here on the route's own lock decides: the loser waits for it, and its own check then
  // sees what the winner did. The constraint stays behind the lock and does not fire.
  {
    // The display's FOR SHARE on the playlist waits for the delete, then finds it deleted.
    constraints: ['display_assigned_playlist_fk', 'display_assigned_playlist_guard'],
    winner: 'DELETE /api/playlists/:id',
    loser: 'PATCH /api/displays/:id assigning that playlist',
    arrange: async () => {
      const playlist = await createPlaylist(owner, 'Deleted under an assignment');
      const display = await createDisplay(owner, org, 'Assigned meanwhile');
      return {
        winner: deletePlaylist(playlist),
        loser: () =>
          send(owner, 'PATCH', `/api/displays/${display.id}`, { assignedPlaylistId: playlist }),
        changes: playlistDeleted(playlist),
      };
    },
    won: { status: 204, audit: 'playlist.delete:success' },
    lost: { error: 'not_found', message: 'The playlist was not found.' },
    refusedBy: null,
  },
  {
    // The delete's FOR UPDATE on the playlist waits for the assignment's FOR SHARE.
    constraints: ['playlist_delete_guard'],
    winner: 'PATCH /api/displays/:id assigning the playlist',
    loser: 'DELETE /api/playlists/:id',
    arrange: async () => {
      const playlist = await createPlaylist(owner, 'Assigned under a delete');
      const display = await createDisplay(owner, org, 'Raced assignment');
      return {
        winner: () =>
          send(owner, 'PATCH', `/api/displays/${display.id}`, { assignedPlaylistId: playlist }),
        loser: deletePlaylist(playlist),
        changes: () => countOf('display', 'assigned_playlist_id', playlist),
      };
    },
    won: { status: 200, audit: 'display.update:success' },
    lost: {
      error: 'playlist_in_use',
      message: 'This playlist is assigned to a screen. Assign other content to the screen first.',
    },
    refusedBy: null,
  },
  {
    constraints: ['display_assigned_playlist_fk'],
    winner: 'DELETE /api/playlists/:id',
    loser: 'POST /api/playlists/:id/publish, which assigns the playlist',
    arrange: async () => {
      const image = await readyImage(t, owner);
      const playlist = await createPlaylist(owner, 'Deleted under a publish', [
        imageItem(image.id),
      ]);
      const display = await createDisplay(owner, org, 'Published meanwhile');
      return {
        winner: deletePlaylist(playlist),
        loser: () =>
          owner.fetch(`/api/playlists/${playlist}/publish`, {
            method: 'POST',
            json: { displayId: display.id },
            headers: { 'idempotency-key': randomUUID() },
          }),
        changes: playlistDeleted(playlist),
      };
    },
    won: { status: 204, audit: 'playlist.delete:success' },
    lost: { error: 'not_found', message: 'The playlist was not found.' },
    refusedBy: null,
  },
  {
    constraints: ['display_assigned_schedule_fk'],
    winner: 'DELETE /api/schedules/:id',
    loser: 'PATCH /api/displays/:id assigning that schedule',
    arrange: async () => {
      const playlist = await createPlaylist(owner, 'Under a raced schedule');
      const schedule = await createSchedule(owner, 'Deleted under an assignment', playlist);
      const display = await createDisplay(owner, org, 'Scheduled meanwhile');
      return {
        winner: () => send(owner, 'DELETE', `/api/schedules/${schedule.id}`),
        loser: () =>
          send(owner, 'PATCH', `/api/displays/${display.id}`, { assignedScheduleId: schedule.id }),
        changes: async () => 1 - (await countOf('schedule', 'id', schedule.id)),
      };
    },
    won: { status: 204, audit: 'schedule.delete:success' },
    lost: { error: 'not_found', message: 'The schedule was not found.' },
    refusedBy: null,
  },
  {
    constraints: ['display_assigned_schedule_fk'],
    winner: 'PATCH /api/displays/:id assigning the schedule',
    loser: 'DELETE /api/schedules/:id',
    arrange: async () => {
      const playlist = await createPlaylist(owner, 'Under an assigned schedule');
      const schedule = await createSchedule(owner, 'Assigned under a delete', playlist);
      const display = await createDisplay(owner, org, 'Raced schedule');
      return {
        winner: () =>
          send(owner, 'PATCH', `/api/displays/${display.id}`, { assignedScheduleId: schedule.id }),
        loser: () => send(owner, 'DELETE', `/api/schedules/${schedule.id}`),
        changes: () => countOf('display', 'assigned_schedule_id', schedule.id),
      };
    },
    won: { status: 200, audit: 'display.update:success' },
    lost: {
      error: 'schedule_in_use',
      message: 'This schedule is assigned to a screen. Assign other content to the screen first.',
    },
    refusedBy: null,
  },
  {
    constraints: ['display_assigned_layout_fk'],
    winner: 'DELETE /api/layouts/:id',
    loser: 'PATCH /api/displays/:id assigning that layout',
    arrange: async () => {
      const main = await createPlaylist(owner, 'Main of a raced layout');
      const band = await createPlaylist(owner, 'Band of a raced layout');
      const layout = await createLayout(
        owner,
        'Deleted under an assignment',
        layoutZones(main, band),
      );
      const display = await createDisplay(owner, org, 'Laid out meanwhile');
      return {
        winner: () => send(owner, 'DELETE', `/api/layouts/${layout.id}`),
        loser: () =>
          send(owner, 'PATCH', `/api/displays/${display.id}`, { assignedLayoutId: layout.id }),
        changes: async () => 1 - (await countOf('layout', 'id', layout.id)),
      };
    },
    won: { status: 204, audit: 'layout.delete:success' },
    lost: { error: 'not_found', message: 'The layout was not found.' },
    refusedBy: null,
  },
  {
    constraints: ['display_assigned_layout_fk'],
    winner: 'PATCH /api/displays/:id assigning the layout',
    loser: 'DELETE /api/layouts/:id',
    arrange: async () => {
      const main = await createPlaylist(owner, 'Main of an assigned layout');
      const band = await createPlaylist(owner, 'Band of an assigned layout');
      const layout = await createLayout(owner, 'Assigned under a delete', layoutZones(main, band));
      const display = await createDisplay(owner, org, 'Raced layout');
      return {
        winner: () =>
          send(owner, 'PATCH', `/api/displays/${display.id}`, { assignedLayoutId: layout.id }),
        loser: () => send(owner, 'DELETE', `/api/layouts/${layout.id}`),
        changes: () => countOf('display', 'assigned_layout_id', layout.id),
      };
    },
    won: { status: 200, audit: 'display.update:success' },
    lost: {
      error: 'layout_in_use',
      message: 'This layout is assigned to a screen. Assign other content to the screen first.',
    },
    refusedBy: null,
  },
  {
    constraints: ['schedule_default_playlist_fk', 'schedule_default_playlist_guard'],
    winner: 'DELETE /api/playlists/:id',
    loser: 'POST /api/schedules with that default playlist',
    arrange: async () => {
      const playlist = await createPlaylist(owner, 'Deleted under a schedule');
      const name = `Raced schedule ${randomUUID()}`;
      return {
        winner: deletePlaylist(playlist),
        loser: () =>
          send(owner, 'POST', '/api/schedules', { name, defaultPlaylistId: playlist, events: [] }),
        changes: async () =>
          (await playlistDeleted(playlist)()) + (await countOf('schedule', 'name', name)),
      };
    },
    won: { status: 204, audit: 'playlist.delete:success' },
    lost: { error: 'validation_failed', message: PLAYLIST_GONE_FROM_SCHEDULE },
    refusedBy: null,
  },
  {
    constraints: ['schedule_event_playlist_fk', 'schedule_event_playlist_guard'],
    winner: 'DELETE /api/playlists/:id',
    loser: 'POST /api/schedules with an event for that playlist',
    arrange: async () => {
      const kept = await createPlaylist(owner, 'Default of a raced schedule');
      const playlist = await createPlaylist(owner, 'Deleted under an event');
      const name = `Raced events ${randomUUID()}`;
      return {
        winner: deletePlaylist(playlist),
        loser: () =>
          send(owner, 'POST', '/api/schedules', {
            name,
            defaultPlaylistId: kept,
            events: [scheduleEvent(playlist)],
          }),
        changes: async () =>
          (await playlistDeleted(playlist)()) + (await countOf('schedule', 'name', name)),
      };
    },
    won: { status: 204, audit: 'playlist.delete:success' },
    lost: { error: 'validation_failed', message: PLAYLIST_GONE_FROM_SCHEDULE },
    refusedBy: null,
  },
  {
    constraints: ['layout_zone_playlist_fk', 'layout_zone_playlist_guard'],
    winner: 'DELETE /api/playlists/:id',
    loser: 'POST /api/layouts with a zone for that playlist',
    arrange: async () => {
      const kept = await createPlaylist(owner, 'Main of a raced layout');
      const playlist = await createPlaylist(owner, 'Deleted under a zone');
      const name = `Raced layout ${randomUUID()}`;
      return {
        winner: deletePlaylist(playlist),
        loser: () =>
          send(owner, 'POST', '/api/layouts', { name, zones: layoutZones(kept, playlist) }),
        changes: async () =>
          (await playlistDeleted(playlist)()) + (await countOf('layout', 'name', name)),
      };
    },
    won: { status: 204, audit: 'playlist.delete:success' },
    lost: { error: 'validation_failed', message: PLAYLIST_GONE_FROM_LAYOUT },
    refusedBy: null,
  },
  {
    // The save's FOR KEY SHARE on the media row waits for the delete, then finds no row.
    constraints: ['playlist_item_media_id_org_id_fkey'],
    winner: 'DELETE /api/media/:id',
    loser: 'PUT /api/playlists/:id with that file',
    arrange: async () => {
      const image = await readyImage(t, owner);
      const playlist = await createPlaylist(owner, 'Saved under a media delete');
      return {
        winner: () => send(owner, 'DELETE', `/api/media/${image.id}`),
        loser: () =>
          send(owner, 'PUT', `/api/playlists/${playlist}`, {
            name: 'Saved under a media delete',
            items: [imageItem(image.id)],
          }),
        changes: async () =>
          1 -
          (await countOf('media', 'id', image.id)) +
          (await countOf('playlist_item', 'playlist_id', playlist)),
      };
    },
    won: { status: 204, audit: 'media.delete:success' },
    lost: { error: 'validation_failed', message: ITEMS_NOT_SAVED },
    refusedBy: null,
  },
  {
    constraints: ['playlist_item_media_id_org_id_fkey'],
    winner: 'PUT /api/playlists/:id with the file',
    loser: 'DELETE /api/media/:id',
    arrange: async () => {
      const image = await readyImage(t, owner);
      const playlist = await createPlaylist(owner, 'Saved before a media delete');
      return {
        winner: () =>
          send(owner, 'PUT', `/api/playlists/${playlist}`, {
            name: 'Saved before a media delete',
            items: [imageItem(image.id)],
          }),
        loser: () => send(owner, 'DELETE', `/api/media/${image.id}`),
        changes: () => countOf('playlist_item', 'media_id', image.id),
      };
    },
    won: { status: 200, audit: 'playlist.update:success' },
    lost: {
      error: 'media_in_use',
      message: 'This file is used in a playlist. Remove it from the playlist first.',
    },
    refusedBy: null,
  },
  {
    constraints: ['playlist_item_app_fk'],
    winner: 'DELETE /api/apps/:id',
    loser: 'PUT /api/playlists/:id with that app',
    arrange: async () => {
      const app = await createApp(owner, CLOCK, `Raced clock ${randomUUID().slice(0, 8)}`);
      const playlist = await createPlaylist(owner, 'Saved under an app delete');
      return {
        winner: () => send(owner, 'DELETE', `/api/apps/${app.id}`),
        loser: () =>
          send(owner, 'PUT', `/api/playlists/${playlist}`, {
            name: 'Saved under an app delete',
            items: [appItem(app.id)],
          }),
        changes: async () =>
          1 -
          (await countOf('app', 'id', app.id)) +
          (await countOf('playlist_item', 'playlist_id', playlist)),
      };
    },
    won: { status: 204, audit: 'app.delete:success' },
    lost: { error: 'validation_failed', message: ITEMS_NOT_SAVED },
    refusedBy: null,
  },
  {
    constraints: ['playlist_item_app_fk'],
    winner: 'PUT /api/playlists/:id with the app',
    loser: 'DELETE /api/apps/:id',
    arrange: async () => {
      const app = await createApp(owner, CLOCK, `Used clock ${randomUUID().slice(0, 8)}`);
      const playlist = await createPlaylist(owner, 'Saved before an app delete');
      return {
        winner: () =>
          send(owner, 'PUT', `/api/playlists/${playlist}`, {
            name: 'Saved before an app delete',
            items: [appItem(app.id)],
          }),
        loser: () => send(owner, 'DELETE', `/api/apps/${app.id}`),
        changes: () => countOf('playlist_item', 'app_id', app.id),
      };
    },
    won: { status: 200, audit: 'playlist.update:success' },
    lost: {
      error: 'app_in_use',
      message: 'This app is used in a playlist. Remove it from the playlist first.',
    },
    refusedBy: null,
  },
  {
    // The media side of the publication's key. The publish holds FOR KEY SHARE on the file, so
    // the delete waits, and then the playlist that was published still uses the file. The
    // publish side of this key has no second request that could meet it (a file in a playlist
    // cannot be deleted): see the keyed re-run below.
    constraints: ['publication_asset_media_id_org_id_fkey'],
    winner: 'POST /api/playlists/:id/publish',
    loser: 'DELETE /api/media/:id of a file it publishes',
    arrange: async () => {
      const image = await readyImage(t, owner);
      const playlist = await createPlaylist(owner, 'Published before a media delete', [
        imageItem(image.id),
      ]);
      const display = await createDisplay(owner, org, 'Published under a delete');
      return {
        winner: () =>
          owner.fetch(`/api/playlists/${playlist}/publish`, {
            method: 'POST',
            json: { displayId: display.id },
            headers: { 'idempotency-key': randomUUID() },
          }),
        loser: () => send(owner, 'DELETE', `/api/media/${image.id}`),
        changes: () => countOf('publication_asset', 'media_id', image.id),
      };
    },
    won: { status: 201, audit: 'publication.create:success' },
    lost: {
      error: 'media_in_use',
      message: 'This file is used in a playlist. Remove it from the playlist first.',
    },
    refusedBy: null,
  },
  {
    // Two member changes serialise on the membership lock; the second rename then meets the
    // unique key, which has no check before it.
    constraints: ['membership_org_display_name_key'],
    winner: 'PATCH /api/members/:id with a name',
    loser: 'PATCH /api/members/:id of another member with the same name',
    arrange: async () => {
      const first = await addMember(org, 'viewer', `First ${randomUUID().slice(0, 8)}`);
      const second = await addMember(org, 'viewer', `Second ${randomUUID().slice(0, 8)}`);
      const displayName = `Raced name ${randomUUID().slice(0, 8)}`;
      return {
        winner: () => send(owner, 'PATCH', `/api/members/${first.membershipId}`, { displayName }),
        loser: () => send(owner, 'PATCH', `/api/members/${second.membershipId}`, { displayName }),
        changes: () => countOf('membership', 'display_name', displayName),
      };
    },
    won: { status: 200, audit: 'membership.update:success' },
    lost: {
      error: 'conflict',
      message: 'Another person in this organisation has, or had, this name.',
    },
    refusedBy: 'membership_org_display_name_key',
  },
  {
    // Under the membership lock the second invite's own check sees the first.
    constraints: ['member_invite_pending_email_key'],
    winner: 'POST /api/invites',
    loser: 'POST /api/invites for the same address',
    arrange: () => {
      const email = `raced-${randomUUID().slice(0, 8)}@example.com`;
      const invite = (name: string) => (): Promise<Response> =>
        send(owner, 'POST', '/api/invites', { name, email, role: 'viewer' });
      return Promise.resolve({
        winner: invite(`Ida ${randomUUID().slice(0, 8)}`),
        loser: invite(`Ivo ${randomUUID().slice(0, 8)}`),
        changes: () => countOf('member_invite', 'email', email),
      });
    },
    won: { status: 201, audit: 'invite.create:success' },
    lost: { error: 'conflict', message: 'An invite for this address is already waiting.' },
    refusedBy: null,
  },
  {
    constraints: ['member_invite_pending_name_key'],
    winner: 'POST /api/invites',
    loser: 'POST /api/invites with the same name',
    arrange: () => {
      const name = `Nia ${randomUUID().slice(0, 8)}`;
      const invite = (): Promise<Response> =>
        send(owner, 'POST', '/api/invites', {
          name,
          email: `named-${randomUUID().slice(0, 8)}@example.com`,
          role: 'viewer',
        });
      return Promise.resolve({
        winner: invite,
        loser: invite,
        changes: () => countOf('member_invite', 'name', name),
      });
    },
    won: { status: 201, audit: 'invite.create:success' },
    lost: { error: 'conflict', message: 'Another person in this organisation has this name.' },
    refusedBy: null,
  },
];

/** The bystander of a row, set by its arrange step (it needs the row's own values). */
const CONSTRAINT_BYSTANDERS = new Map<ConstraintName, () => Promise<Response>>();
function bystanderOf(name: ConstraintName): Promise<Response> {
  const request = CONSTRAINT_BYSTANDERS.get(name);
  if (request === undefined) throw new Error(`the row of ${name} arranged no bystander`);
  return request();
}

/**
 * The registered constraints with no row above, and why. A name is here for one of three
 * reasons: no route maps it (nothing answers it, so there is no documented answer to lose a
 * race for); or its race is in another describe of this file; or in another test.
 */
const RACED_ELSEWHERE_OR_NOT: { readonly [Name in ConstraintName]?: string } = {
  publication_idempotency:
    'the describe "one Idempotency-Key, two requests" below: the key lock decides between two requests, and the index refuses a rival that did not take the lock',
  membership_last_owner:
    'the describe "the last two Owners" below: it needs an organisation of its own, and its loser is refused before the route\'s check or the trigger is reached',
  display_tag_display_fk:
    'no route maps it: PATCH /api/displays/:id holds the display FOR UPDATE before it writes its tags, and nothing deletes a display',
  media_tag_media_fk:
    'no route maps it: PATCH /api/media/:id holds the media row FOR UPDATE before it writes its tags, so a delete of the file waits for it',
  media_default_duration_images_only:
    'no route maps it: PATCH /api/media/:id checks the kind of the row it holds locked, and a kind never changes',
  member_invite_guard:
    'no route maps it: the cancel route reads the invite under the membership lock; the guard is the last line for SQL of another origin',
  membership_oidc_sub_key:
    'no route maps it: only provisioning inserts a member (scripts/lib/provision.ts maps it there, tested by tests/integration/provision-member.test.ts)',
  membership_removed_final:
    'no route maps it: lockTarget refuses a removed member under the row lock before any write',
};

beforeAll(async () => {
  t = await startTestApp({}, 1000, { wrapPool: faults.wrapPool });
  org = await createOrg('Races', { displayName: 'Rae Racer' });
  owner = await signIn(t, org);
  otherOrg = await createOrg('Races, the bystander', { displayName: 'Bea Bystander' });
  otherOwner = await signIn(t, otherOrg);
  sql = t.testSql('reading pg_locks and pg_stat_activity, and the rival of a race lost on purpose');
  const url = new URL(need('TEST_DATABASE_MIGRATOR_URL'));
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

describe('one lost race per constraint a route maps to an answer (step 33, step 26)', () => {
  it('has a race for every registered constraint, or the reason it has none', () => {
    const raced = new Set(CONSTRAINT_RACES.flatMap((row) => row.constraints));
    const missing = Object.keys(CONSTRAINTS)
      .filter((name) => !raced.has(name as ConstraintName))
      .filter((name) => !Object.hasOwn(RACED_ELSEWHERE_OR_NOT, name))
      .map(
        (name) =>
          `No race for the constraint ${name}: when a route maps it to an answer (the constraints option of changeAsOperator), add a row for the two requests that can meet at it to CONSTRAINT_RACES in ${HERE}; when no route maps it, add it to RACED_ELSEWHERE_OR_NOT there with the reason`,
      );
    expect(missing).toEqual([]);
    const both = Object.keys(RACED_ELSEWHERE_OR_NOT).filter((name) =>
      raced.has(name as ConstraintName),
    );
    expect(both, 'a constraint with a row needs no reason for having none').toEqual([]);
    const unknown = Object.keys(RACED_ELSEWHERE_OR_NOT).filter(
      (name) => !Object.hasOwn(CONSTRAINTS, name),
    );
    expect(unknown, 'not a registered constraint any more').toEqual([]);
  });

  for (const row of CONSTRAINT_RACES) {
    const by =
      row.refusedBy === null
        ? 'its own lock and check decide, the constraint does not fire'
        : `PostgreSQL refuses it with ${row.refusedBy}`;
    it(`${row.constraints.join(', ')}: ${row.loser} loses to ${row.winner} and answers ${row.lost.error}: ${by}`, async () => {
      const pair = await row.arrange();
      const mark = await newestAuditRow();
      let bystander: Answered | undefined;
      const { won, lost } = await race(pair.winner, pair.loser, {
        meanwhile: async (winnerPid) => {
          if (row.bystander === undefined) return;
          bystander = await answered(
            await withoutWaitingFor(
              sql,
              winnerPid,
              row.bystander(),
              'another organisation’s request was held up by this organisation’s transaction',
              // The loser.
              { already: 1 },
            ),
          );
        },
      });
      expect({
        won: await answered(won),
        lost: await answered(lost),
        // Every constraint PostgreSQL refused a statement with during the race.
        refusedBy: faults.databaseErrors().map((seen) => seen.constraint),
        audit: await auditRowsAfter(mark),
        changes: await pair.changes(),
      }).toEqual({
        won: { status: row.won.status },
        lost: row.lost,
        refusedBy: row.refusedBy === null ? [] : [row.refusedBy],
        // The winner's row, the bystander's, and nothing of the loser's unless the row says so.
        audit: [
          row.won.audit,
          ...(row.bystander === undefined ? [] : [row.won.audit]),
          ...(row.lostAudit ?? []),
        ],
        changes: row.changes ?? 1,
      });
      // Rule 2: the other organisation answered as if it were alone, while the lock was held.
      if (row.bystander !== undefined) expect(bystander).toEqual({ status: row.won.status });
    });
  }
});

describe('the last two Owners demote each other at once (membership_last_owner)', () => {
  it('the second waits for the first, which ends its sessions, and answers 401: one role change, the organisation keeps an Owner, and the trigger never has to refuse', async () => {
    const pairOrg = await createOrg('Races, two Owners', { displayName: 'Ona First' });
    const first = await signIn(t, pairOrg);
    const other = await addMember(pairOrg, 'owner', 'Otto Second');
    const second = await signIn(t, other);
    const mark = await newestAuditRow();
    // The demotion ends the second Owner's sessions (stage-c.md 1.6), and holds those session
    // rows until it commits: the second Owner's request waits for its own session row at the
    // guard's lookup, before it reaches the membership lock, and then has no session.
    const { won, lost } = await race(
      () => send(first, 'PATCH', `/api/members/${other.membershipId}`, { role: 'admin' }),
      () => send(second, 'PATCH', `/api/members/${pairOrg.membershipId}`, { role: 'admin' }),
    );
    expect(won.status).toBe(200);
    // Not the 409 last_owner of the route's check or of the trigger: neither is reached.
    await expectError(lost, 'unauthenticated');
    expect(faults.databaseErrors()).toEqual([]);
    expect(await auditRowsAfter(mark)).toEqual(['membership.role_change:success']);
    expect(
      await administrator(
        'SELECT role FROM public.membership WHERE org_id = $1 AND removed_at IS NULL ORDER BY role',
        [pairOrg.orgId],
      ),
    ).toEqual([{ role: 'admin' }, { role: 'owner' }]);
  });
});

/** A display with a ready image in a playlist assigned to it: what a publish or a push needs. */
async function publishable(
  as: Operator,
  inOrg: TestOrg,
  name: string,
): Promise<{ displayId: string; playlistId: string; mediaId: string }> {
  const display = await createDisplay(as, inOrg, name);
  const image = await readyImage(t, as);
  const playlistId = await createPlaylist(as, `${name} loop`, [imageItem(image.id)]);
  await assignPlaylist(as, display.id, playlistId);
  return { displayId: display.id, playlistId, mediaId: image.id };
}

const publish = (as: Operator, playlistId: string, displayId: string, key: string) => () =>
  as.fetch(`/api/playlists/${playlistId}/publish`, {
    method: 'POST',
    json: { displayId },
    headers: { 'idempotency-key': key },
  });

const publicationsOf = (displayId: string): Promise<number> =>
  countOf('publication', 'display_id', displayId);

/** The key lock of changeOncePerKey, the first statement of every keyed attempt. */
const AT_KEY_LOCK = (text: string): boolean => text.includes("'tinnox.publish:'");
const AT_PUBLICATION = /^\s*INSERT INTO publication \(/;
const AT_PUBLICATION_ASSET = /^\s*INSERT INTO publication_asset /;

/**
 * A transaction of the test's own that has inserted a publication for `displayId` under `key`
 * without taking the key lock, and has not committed: what the unique index exists to refuse.
 * The row is a copy of the display's publication `like`, under an id of its own.
 */
async function rivalPublication(
  inOrg: TestOrg,
  like: string,
  key: string,
): Promise<{ rival: PoolClient; id: string }> {
  const id = randomUUID();
  const rival = await sql.connect();
  try {
    await rival.query('BEGIN');
    await rival.query("SELECT set_config('app.org_id', $1, true)", [inOrg.orgId]);
    await rival.query(
      `INSERT INTO publication (id, org_id, display_id, playlist_id, manifest, idempotency_key, created_by)
       SELECT $2::uuid, org_id, display_id, playlist_id,
              jsonb_set(manifest, '{publicationId}', to_jsonb($2::uuid::text)), $3, created_by
         FROM publication WHERE id = $1 AND org_id = app_org_id()`,
      [like, id, key],
    );
  } catch (error) {
    await rival.query('ROLLBACK').catch(() => undefined);
    rival.release();
    throw error;
  }
  return { rival, id };
}

describe('one Idempotency-Key, two requests (publication_idempotency; TST-9)', () => {
  it('two publishes with one key at once: the second waits for the key lock and replays the first; one publication, one audit row, and another organisation with the same key is not held up', async () => {
    const mine = await publishable(owner, org, 'Keyed publish');
    const theirs = await publishable(otherOwner, otherOrg, 'Keyed publish, bystander');
    const key = randomUUID();
    const mark = await newestAuditRow();
    let bystander: Response | undefined;
    const { won, lost } = await race(
      publish(owner, mine.playlistId, mine.displayId, key),
      publish(owner, mine.playlistId, mine.displayId, key),
      {
        locktype: 'advisory',
        // Rule 2: the same key in another organisation is another key.
        meanwhile: async (winnerPid) => {
          bystander = await withoutWaitingFor(
            sql,
            winnerPid,
            publish(otherOwner, theirs.playlistId, theirs.displayId, key)(),
            'another organisation’s publish under the same Idempotency-Key was held up',
            // The loser.
            { already: 1 },
          );
        },
      },
    );
    expect(won.status).toBe(201);
    const first = (await won.json()) as { publicationId: string; replayed: boolean };
    expect(first.replayed).toBe(false);
    expect(lost.status).toBe(200);
    expect(await lost.json()).toEqual({ ...first, replayed: true });
    expect(bystander?.status).toBe(201);
    const other = (await bystander?.json()) as { publicationId: string; replayed: boolean };
    expect(other.replayed).toBe(false);
    expect(other.publicationId).not.toBe(first.publicationId);
    expect(await publicationsOf(mine.displayId)).toBe(1);
    expect(await publicationsOf(theirs.displayId)).toBe(1);
    // The lock decided: the index refused nobody.
    expect(faults.databaseErrors()).toEqual([]);
    expect(await auditRowsAfter(mark)).toEqual([
      'publication.create:success',
      'publication.create:success',
    ]);
  });

  it('two pushes with one key at once: the second waits for the key lock and returns the first one’s publication; one publication, one audit row', async () => {
    const mine = await publishable(owner, org, 'Keyed push');
    const key = randomUUID();
    const mark = await newestAuditRow();
    const { won, lost } = await race(
      () => push(owner, [mine.displayId], key),
      () => push(owner, [mine.displayId], key),
      { locktype: 'advisory' },
    );
    expect(won.status).toBe(200);
    expect(lost.status).toBe(200);
    const first = (await won.json()) as { results: { publicationId: string; outcome: string }[] };
    expect(first.results).toMatchObject([{ displayId: mine.displayId, outcome: 'published' }]);
    expect(await lost.json()).toEqual(first);
    expect(await publicationsOf(mine.displayId)).toBe(1);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await auditRowsAfter(mark)).toEqual(['publication.create:success']);
  });

  it.each([
    [
      'publish',
      (p: { playlistId: string; displayId: string }, key: string) =>
        publish(owner, p.playlistId, p.displayId, key)(),
    ],
    [
      'push',
      (p: { playlistId: string; displayId: string }, key: string) =>
        push(owner, [p.displayId], key),
    ],
  ] as const)(
    'a %s that really loses the key’s unique index to a rival that took no key lock runs once more and replays the rival’s publication: nothing of its own is stored or audited',
    async (_, request) => {
      const mine = await publishable(owner, org, 'Lost key race');
      const before = (await (
        await publish(owner, mine.playlistId, mine.displayId, randomUUID())()
      ).json()) as { publicationId: string };
      // The playlist changes after that publication, so a push has something to publish too.
      const edited = await send(owner, 'PUT', `/api/playlists/${mine.playlistId}`, {
        name: 'Lost key race loop',
        items: [imageItem(mine.mediaId, 7)],
      });
      expect(edited.status).toBe(200);
      const key = randomUUID();
      const { rival, id } = await rivalPublication(org, before.publicationId, key);
      const mark = await newestAuditRow();
      let response: Response;
      try {
        const fault = faults.arm({ mode: 'unique-violation', at: AT_PUBLICATION, rival });
        response = await request(mine, key);
        // A fault that never struck shows nothing: the request did not reach the insert.
        fault.disarm();
        expect(await fault.delivered).toMatchObject({ sqlstate: '23505' });
      } finally {
        await rival.query('ROLLBACK').catch(() => undefined);
        rival.release();
      }
      // PostgreSQL refused the first attempt with the key's index, and nothing else.
      expect(faults.databaseErrors().map((seen) => seen.constraint)).toEqual([
        'publication_idempotency',
      ]);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        publicationId?: string;
        replayed?: boolean;
        results?: { publicationId: string; outcome: string }[];
      };
      expect(body.publicationId ?? body.results?.[0]?.publicationId).toBe(id);
      if (body.results === undefined) expect(body.replayed).toBe(true);
      // The earlier publication and the rival's: the request made none.
      expect(await publicationsOf(mine.displayId)).toBe(2);
      expect(await auditRowsAfter(mark)).toEqual([]);
    },
  );

  // TST-9, the answer of the keyed re-run to a media foreign key (BEH-5 of the group C review:
  // the second attempt carries the route's constraint map, where it once answered a raw 500).
  // PINNED BY INJECTION, and it cannot be otherwise: PostgreSQL cannot be brought to raise this
  // error on the re-run. (1) The re-run publishes only when the key has no publication, but it
  // runs because the key's index refused the first attempt, so a publication with the key is
  // committed, and publications are immutable for every role (publication_immutable), so it is
  // still there: the re-run replays. (2) A publish holds FOR KEY SHARE on every file it
  // publishes, so no transaction can delete one under it. (3) An asset row for any other file
  // is refused first by publication_asset_guard (23001, no constraint name). So both errors
  // here are the test's own, sent in place of the statement (`never-sent`), with the SQLSTATE
  // and constraint name PostgreSQL would give them.
  it.each([
    [
      'publish',
      'A file, app or screen used by this playlist changed meanwhile. Try again.',
      (p: { playlistId: string; displayId: string }, key: string) =>
        publish(owner, p.playlistId, p.displayId, key)(),
    ],
    [
      'push',
      "Something used by a screen's assigned content changed meanwhile. Nothing is lost: try again.",
      (p: { playlistId: string; displayId: string }, key: string) =>
        push(owner, [p.displayId], key),
    ],
  ] as const)(
    'pins by injection: a %s whose keyed re-run meets the media foreign key answers 409 conflict, and stores and audits nothing (TST-9)',
    async (_, message, request) => {
      const mine = await publishable(owner, org, 'Keyed re-run');
      const mark = await newestAuditRow();
      const violation = (code: string, constraint: string): Error =>
        Object.assign(new pg.DatabaseError('a refusal the test made up', 0, 'error'), {
          code,
          constraint,
        });
      const lostKey = faults.arm({
        mode: 'never-sent',
        at: AT_PUBLICATION,
        error: violation('23505', 'publication_idempotency'),
      });
      let keyLocks = 0;
      const rerun = faults.hold((text) => AT_KEY_LOCK(text) && ++keyLocks === 2);
      const answering = request(mine, randomUUID());
      // The second attempt has begun: only now is the foreign key armed, for its asset rows.
      await reachedBefore(rerun, answering, 'the keyed request');
      await lostKey.delivered;
      const gone = faults.arm({
        mode: 'never-sent',
        at: AT_PUBLICATION_ASSET,
        error: violation('23503', 'publication_asset_media_id_org_id_fkey'),
      });
      rerun.release();
      const response = await answering;
      gone.disarm();
      await gone.delivered;
      expect((await expectError(response, 'conflict')).message).toBe(message);
      expect(keyLocks).toBe(2);
      expect(await publicationsOf(mine.displayId)).toBe(0);
      expect(await auditRowsAfter(mark)).toEqual([]);
    },
  );
});

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
const poll = async (pairing: Pairing): Promise<{ status: string }> =>
  (await (
    await fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${pairing.pollingToken}` },
    })
  ).json()) as { status: string };

async function pairedDisplay(name: string): Promise<{ id: string; player: PairedPlayer }> {
  const display = await createDisplay(owner, org, name);
  return { id: display.id, player: await pairPlayer(t, owner, display.id) };
}
const revoke = (displayId: string) => (): Promise<Response> =>
  send(owner, 'POST', `/api/displays/${displayId}/revoke-player`);
const reset = (player: PairedPlayer) => (): Promise<Response> =>
  fetch(`${t.url}/player/registration`, { method: 'DELETE', headers: player.headers });
const claim = (displayId: string, pairing: Pairing) => (): Promise<Response> =>
  send(owner, 'POST', `/api/displays/${displayId}/claim`, { code: pairing.code });
/** The display's registrations: how many are active, and why the others ended. */
const registrations = (displayId: string): Promise<{ active: boolean; reason: string | null }[]> =>
  administrator(
    `SELECT revoked_at IS NULL AS active, revoked_reason AS reason
       FROM public.player_registration WHERE display_id = $1 ORDER BY created_at, id`,
    [displayId],
  );
const manifestStatus = async (player: PairedPlayer): Promise<number> =>
  (await fetch(`${t.url}/player/manifest`, { headers: player.headers })).status;

describe('revocations that meet (section 4.2: revoke against revoke, against a reset, against a claim)', () => {
  it('two operator revokes of one screen at once: the second waits and finds no player; one registration ended once, and each attempt has its audit row (D3)', async () => {
    const display = await pairedDisplay('Revoked twice');
    const mark = await newestAuditRow();
    const { won, lost } = await race(revoke(display.id), revoke(display.id));
    expect(won.status).toBe(200);
    expect(await won.json()).toMatchObject({
      revokedRegistrationId: display.player.registrationId,
    });
    expect(lost.status).toBe(200);
    expect(await lost.json()).toMatchObject({ revokedRegistrationId: null });
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'player.revoke:success:operator',
      'player.revoke:success:operator',
    ]);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('an operator revoke against a player’s reset that is committing: the revoke waits, finds the registration ended and ends nothing; the reason stays player_reset', async () => {
    const display = await pairedDisplay('Reset, then revoked');
    const mark = await newestAuditRow();
    const { won, lost } = await race(reset(display.player), revoke(display.id));
    expect(won.status).toBe(204);
    expect(lost.status).toBe(200);
    expect(await lost.json()).toMatchObject({ revokedRegistrationId: null });
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'player_reset' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'player.revoke:success:player_reset',
      'player.revoke:success:operator',
    ]);
  });

  it('a player’s reset against an operator revoke that is committing: the reset waits, finds itself revoked, answers 204 and writes nothing; one audit row', async () => {
    const display = await pairedDisplay('Revoked, then reset');
    const mark = await newestAuditRow();
    const { won, lost } = await race(revoke(display.id), reset(display.player));
    expect(won.status).toBe(200);
    expect(lost.status).toBe(204);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual(['player.revoke:success:operator']);
  });

  it('an operator revoke against a claim that is committing: the revoke waits and then cancels that claim, so the new player collects nothing and the screen has no active registration', async () => {
    const display = await pairedDisplay('Claimed, then revoked');
    const pairing = await newPairing();
    const mark = await newestAuditRow();
    const { won, lost } = await race(claim(display.id, pairing), revoke(display.id));
    expect(won.status).toBe(200);
    expect(await won.json()).toMatchObject({
      replacedRegistrationId: display.player.registrationId,
    });
    expect(lost.status).toBe(200);
    // The claim had already ended the old player; the revoke ended the claim.
    expect(await lost.json()).toEqual({ revokedRegistrationId: null, cancelledPairingCount: 1 });
    expect(await poll(pairing)).toEqual({ status: 'expired' });
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'replaced' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'pairing.claim:success',
      'player.revoke:success:replaced',
      'player.revoke:success:operator',
    ]);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('a claim against an operator revoke that is committing: the claim waits and then pairs a screen that has no player; never a second active registration', async () => {
    const display = await pairedDisplay('Revoked, then claimed');
    const pairing = await newPairing();
    const mark = await newestAuditRow();
    const { won, lost } = await race(revoke(display.id), claim(display.id, pairing));
    expect(won.status).toBe(200);
    expect(await won.json()).toMatchObject({
      revokedRegistrationId: display.player.registrationId,
    });
    expect(lost.status).toBe(200);
    // Nothing left for the claim to replace.
    expect(await lost.json()).toMatchObject({ replacedRegistrationId: null });
    expect(await poll(pairing)).toMatchObject({ status: 'claimed' });
    expect(await registrations(display.id)).toEqual([
      { active: false, reason: 'operator' },
      { active: true, reason: null },
    ]);
    expect(await auditRowsAfter(mark)).toEqual([
      'player.revoke:success:operator',
      'pairing.claim:success',
      'pairing.complete:success',
    ]);
  });
});

describe('a single-session sign-out against a request in flight (section 4.2)', () => {
  const folders = (name: string): Promise<number> => countOf('folder', 'name', name);

  it('a write already past its role check finishes after the sign-out has committed, which did not wait for it; the next request with that session answers 401', async () => {
    const member = await addMember(org, 'editor', `Flo ${randomUUID().slice(0, 8)}`);
    const session = await signIn(t, member);
    const name = `In flight ${randomUUID()}`;
    const mark = await newestAuditRow();
    // The write is stopped before its audit row: its role check is done, its folder inserted.
    const held = faults.hold(AT_AUDIT);
    const writing = send(session, 'POST', '/api/folders', { name });
    const writer = await reachedBefore(held, writing, 'the write in flight');
    const signedOut = await withoutWaitingFor(
      sql,
      writer,
      send(session, 'POST', '/api/auth/logout'),
      'the sign-out waited for the member’s request in flight',
    );
    expect(signedOut.status).toBe(200);
    held.release();
    // The stated window, as for a device (D8): a request past its check finishes its one
    // transaction; nothing reads the session again inside it.
    expect((await writing).status).toBe(201);
    expect(await folders(name)).toBe(1);
    await expectError(
      await send(session, 'POST', '/api/folders', { name: randomUUID() }),
      'unauthenticated',
    );
    expect(await auditRowsAfter(mark)).toEqual(['auth.logout:success', 'folder.create:success']);
  });

  it('a write sent while the sign-out is committing waits at the session lookup and answers 401: nothing is written', async () => {
    const member = await addMember(org, 'editor', `Sol ${randomUUID().slice(0, 8)}`);
    const session = await signIn(t, member);
    const name = `After the sign-out ${randomUUID()}`;
    const mark = await newestAuditRow();
    const { won, lost } = await race(
      () => send(session, 'POST', '/api/auth/logout'),
      () => send(session, 'POST', '/api/folders', { name }),
    );
    expect(won.status).toBe(200);
    await expectError(lost, 'unauthenticated');
    expect(await folders(name)).toBe(0);
    expect(await auditRowsAfter(mark)).toEqual(['auth.logout:success']);
  });
});
