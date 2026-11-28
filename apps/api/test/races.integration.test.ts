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
 * Four groups:
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
 *  4. A screen deleted (DELETE /api/displays/:id, CMS-41, migration 0017) while it is being
 *     edited, published or pushed to, paired, revoked, reset by its player or reported on, in
 *     both orders: the request that comes second waits, and then either answers 404 or the
 *     delete undoes what the first one did to the screen's player. No constraint and no guard
 *     is raised. The describe's comment says why the alert check has no race there.
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
    // The publish's FOR SHARE on the playlist (loadPlaylistDrafts) waits for the delete, then
    // finds no live playlist.
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
    // The display's FOR SHARE on the schedule waits for the delete, then finds no row.
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
    // The delete's FOR UPDATE on the schedule waits for the assignment's FOR SHARE, then finds
    // the screen that has it.
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
    // The display's FOR SHARE on the layout waits for the delete, then finds no row.
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
    // The delete's FOR UPDATE on the layout waits for the assignment's FOR SHARE, then finds
    // the screen that has it.
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
    // The save's FOR SHARE on every playlist it names (saveSchedule) waits for the delete, then
    // finds the default playlist not live.
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
    // The same FOR SHARE of saveSchedule, for the playlist of an event.
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
    // The save's FOR SHARE on every playlist of its zones (saveLayout) waits for the delete,
    // then finds one not live.
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
    // The delete's FOR UPDATE on the media row waits for the save's FOR KEY SHARE, then finds
    // the playlist that uses the file.
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
    // The save's FOR KEY SHARE on the app row (loadAppRecords) waits for the delete, then finds
    // no row.
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
    // The delete's FOR UPDATE on the app row waits for the save's FOR KEY SHARE, then finds the
    // playlist that uses the app.
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
    // The membership lock (lockMembership) makes the second invite wait; its own check of the
    // address then sees the first.
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
    // The same membership lock (lockMembership), then the second invite's own check of the name.
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
    'no route maps it: PATCH /api/displays/:id holds the live display FOR UPDATE before it writes its tags, and a deleted screen keeps its row (deleted_at, 0017), so the key cannot fire; the edit that loses to a delete, in the describe "a screen deleted while something else happens to it" below, answers 404',
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
  // PINNED BY INJECTION, because the 409 this mapping gives is unreachable: no requests, in any
  // order, make PostgreSQL raise the media foreign key on the re-run. (1) The re-run runs
  // because the key's index refused the first attempt, so a publication with the key is
  // committed, and a publication is immutable for every role (publication_immutable): the re-run
  // finds it and replays, and inserts no asset row. (2) Were it to publish, it holds FOR KEY
  // SHARE on every file it publishes, so no transaction can delete one under it. (3) An asset
  // row for any other file is refused first by publication_asset_guard (23001, no constraint
  // name). So both errors below are the test's own, sent in place of the statement
  // (`never-sent`) with the SQLSTATE and constraint name PostgreSQL would give them. What this
  // pins is only that the second attempt applies the map; it is not evidence that the answer
  // can occur. The plan asks for this violation "driven through PostgreSQL" (step 33, inherited
  // from group C), which cannot be done; whether the mapping stays is Michael's to decide.
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

/** What is left of a screen: whether it is deleted, and what it still has assigned or tagged. */
async function screen(
  displayId: string,
): Promise<{ deleted: boolean; assigned: number; tags: number } | undefined> {
  const rows = await administrator<{ deleted: boolean; assigned: number; tags: number }>(
    `SELECT d.deleted_at IS NOT NULL AS deleted,
            num_nonnulls(d.assigned_playlist_id, d.assigned_schedule_id, d.assigned_layout_id) AS assigned,
            (SELECT count(*)::int FROM public.display_tag dt WHERE dt.display_id = d.id) AS tags
       FROM public.display d WHERE d.id = $1`,
    [displayId],
  );
  return rows[0];
}
/** A deleted screen: the row kept, nothing assigned to it, no tag on it (0017). */
const DELETED = { deleted: true, assigned: 0, tags: 0 };
const LIVE = { deleted: false };
const SCREEN_GONE = { error: 'not_found', message: 'The screen was not found.' };

/** What the screen's delete recorded: the claims it cancelled and the registration it revoked. */
async function deleteRecorded(displayId: string): Promise<unknown> {
  const rows = await administrator<{ detail: unknown }>(
    `SELECT detail FROM public.audit_event
      WHERE action = 'display.delete' AND object_id::text = $1 ORDER BY id`,
    [displayId],
  );
  return rows.map((row) => row.detail);
}

/*
 * Left out on purpose: the e-mail alert check (apps/api/src/alerts.ts) against a delete. Its
 * insert of an episode takes a share of the display row, so it would wait for a delete that is
 * committing and then open an episode for the deleted screen: the stray e-mail its stated
 * shortcut accepts for any revocation that commits during a run ("settings and the active
 * registration are read once per organisation per run"), and the next run closes that episode
 * silently (display-alerts.test.ts, "closes the open episode of a deleted screen silently"). No
 * race is written because the check runs over every organisation of the shared test database
 * and a hold cannot tell its transactions apart by statement text, so the winner could be
 * another file's organisation.
 */
describe('a screen deleted while something else happens to it (CMS-41, migration 0017)', () => {
  const remove = (displayId: string) => (): Promise<Response> =>
    send(owner, 'DELETE', `/api/displays/${displayId}`);
  /** The poll of the player that asked for `pairing`: for a claimed session, the collection. */
  const collect = (pairing: Pairing) => (): Promise<Response> =>
    fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${pairing.pollingToken}` },
    });
  /**
   * A report of a player. The first inserts the screen's delivery row, whose foreign key takes a
   * share of the display row; a later one inserts no delivery row, and meets the display row only
   * when its history row is kept (one per display in ten seconds), whose foreign key takes that
   * share. That share is where a report meets a delete, which holds the row FOR UPDATE.
   */
  const heartbeat =
    (displayId: string, player: PairedPlayer, seq = 1) =>
    (): Promise<Response> =>
      fetch(`${t.url}/player/heartbeat`, {
        method: 'POST',
        headers: { ...player.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          seq,
          sentAt: new Date().toISOString(),
          displayId,
          downloadedPublicationId: null,
          activePublicationId: null,
          activeItemIndex: null,
          playerState: 'idle',
          staging: null,
          errors: [],
          player: { version: 'integration-test', storagePersisted: null, online: true },
        }),
      });
  /** The heartbeat's history row, its last write. */
  const AT_HEARTBEAT_LOG = /^\s*INSERT INTO heartbeat_log/;
  /** What the screen's player last reported, as stored. */
  const reported = (
    displayId: string,
  ): Promise<{ registration: string | null; seq: string | null; desired: string | null }[]> =>
    administrator(
      `SELECT reporting_registration_id AS registration, last_seq::text AS seq,
              desired_publication_id AS desired
         FROM public.display_delivery WHERE display_id = $1`,
      [displayId],
    );
  const displayTag = (): Promise<string> =>
    created(
      send(owner, 'POST', '/api/tags', { scope: 'display', name: randomUUID().slice(0, 12) }),
    );

  it('two deletes of one screen at once: the second waits for the screen’s pairing lock and answers 404; one delete, one audit row', async () => {
    const display = await pairedDisplay('Deleted twice');
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), remove(display.id), {
      locktype: 'advisory',
    });
    expect(won.status).toBe(204);
    expect(await answered(lost)).toEqual(SCREEN_GONE);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('an edit that is committing against a delete: the delete waits for the display row, then takes off the tag the edit put on', async () => {
    const display = await createDisplay(owner, org, 'Edited, then deleted');
    const tag = await displayTag();
    const mark = await newestAuditRow();
    const { won, lost } = await race(
      () => send(owner, 'PATCH', `/api/displays/${display.id}`, { name: 'Renamed', tagIds: [tag] }),
      remove(display.id),
    );
    expect(won.status).toBe(200);
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await deleteRecorded(display.id)).toMatchObject([{ tagCount: 1 }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'display.update:success',
      'display.delete:success',
    ]);
  });

  it('an edit against a delete that is committing: the edit waits for the display row and answers 404; no tag is written, and neither display_tag_display_fk nor display_deleted_guard has to refuse it', async () => {
    const display = await createDisplay(owner, org, 'Deleted, then edited');
    const tag = await displayTag();
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), () =>
      send(owner, 'PATCH', `/api/displays/${display.id}`, { name: 'Back again', tagIds: [tag] }),
    );
    expect(won.status).toBe(204);
    expect(await answered(lost)).toEqual(SCREEN_GONE);
    // The edit's own lock and check decided: PostgreSQL refused nothing.
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await countOf('display', 'name', 'Back again', `AND x.id = '${display.id}'`)).toBe(0);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
  });

  it('a publish that is committing against a delete: the delete waits for the display row; the publication stays, as publications do, and the screen is deleted with nothing assigned', async () => {
    const mine = await publishable(owner, org, 'Published, then deleted');
    const key = randomUUID();
    const mark = await newestAuditRow();
    const { won, lost } = await race(
      publish(owner, mine.playlistId, mine.displayId, key),
      remove(mine.displayId),
    );
    expect(won.status).toBe(201);
    const { publicationId } = (await won.json()) as { publicationId: string };
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(mine.displayId)).toEqual(DELETED);
    expect(await publicationsOf(mine.displayId)).toBe(1);
    // The delete does not touch the pointer (U-14): it still names what was published.
    expect(await reported(mine.displayId)).toMatchObject([{ desired: publicationId }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'publication.create:success',
      'display.delete:success',
    ]);
    // PINNED, as found (Observation), not decided: a repeat of that publish, with its key,
    // replays the publication of a screen that is now deleted, where every other request for
    // the screen answers 404. changeOncePerKey looks the key up before it locks the display; a
    // push looks its screens up first, and its repeat answers 404 (the next test).
    const repeat = await publish(owner, mine.playlistId, mine.displayId, key)();
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ publicationId, replayed: true });
    expect(
      await answered(await publish(owner, mine.playlistId, mine.displayId, randomUUID())()),
    ).toEqual(SCREEN_GONE);
    // The playlist the screen had is free to go.
    expect((await deletePlaylist(mine.playlistId)()).status).toBe(204);
  });

  it('a push that is committing against a delete: the delete waits for the display row; the publication stays, and a repeat of the push with its key answers 404', async () => {
    const mine = await publishable(owner, org, 'Pushed, then deleted');
    const key = randomUUID();
    const mark = await newestAuditRow();
    const { won, lost } = await race(
      () => push(owner, [mine.displayId], key),
      remove(mine.displayId),
    );
    expect(won.status).toBe(200);
    expect(await won.json()).toMatchObject({
      results: [{ displayId: mine.displayId, outcome: 'published' }],
    });
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(mine.displayId)).toEqual(DELETED);
    expect(await publicationsOf(mine.displayId)).toBe(1);
    expect(await auditRowsAfter(mark)).toEqual([
      'publication.create:success',
      'display.delete:success',
    ]);
    // The push reads its screens before the key: the repeat does not replay.
    expect(await answered(await push(owner, [mine.displayId], key))).toEqual(SCREEN_GONE);
  });

  it('a publish against a delete that is committing: the publish waits for the display row and answers 404; nothing is published or audited', async () => {
    const mine = await publishable(owner, org, 'Deleted, then published');
    const mark = await newestAuditRow();
    const { won, lost } = await race(
      remove(mine.displayId),
      publish(owner, mine.playlistId, mine.displayId, randomUUID()),
    );
    expect(won.status).toBe(204);
    expect(await answered(lost)).toEqual(SCREEN_GONE);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(mine.displayId)).toEqual(DELETED);
    expect(await publicationsOf(mine.displayId)).toBe(0);
    expect(await reported(mine.displayId)).toEqual([]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
  });

  it('a push of two screens against a delete of the second that is committing: the push waits at the second and answers 404 without results; the first stays published (the stated shortcut of routes/push.ts)', async () => {
    const kept = await publishable(owner, org, 'Pushed and kept');
    const gone = await publishable(owner, org, 'Deleted under a push');
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(gone.displayId), () =>
      push(owner, [kept.displayId, gone.displayId], randomUUID()),
    );
    expect(won.status).toBe(204);
    expect(await answered(lost)).toEqual(SCREEN_GONE);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(gone.displayId)).toEqual(DELETED);
    expect(await publicationsOf(gone.displayId)).toBe(0);
    // Each screen is a transaction of its own: the first had committed before the push waited.
    expect(await screen(kept.displayId)).toMatchObject(LIVE);
    expect(await publicationsOf(kept.displayId)).toBe(1);
    // The delete's row was written first; it committed after the first screen's publication.
    expect(await auditRowsAfter(mark)).toEqual([
      'display.delete:success',
      'publication.create:success',
    ]);
  });

  it('a claim that is committing against a delete: the delete waits for the pairing lock and then cancels that claim, so the new player collects nothing', async () => {
    const display = await pairedDisplay('Claimed, then deleted');
    const pairing = await newPairing();
    const mark = await newestAuditRow();
    const { won, lost } = await race(claim(display.id, pairing), remove(display.id), {
      locktype: 'advisory',
    });
    expect(won.status).toBe(200);
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    // The claim had ended the old player; the delete ended the claim.
    expect(await deleteRecorded(display.id)).toMatchObject([
      { cancelledPairingIds: [pairing.pairingId], revokedRegistrationId: null },
    ]);
    expect(await poll(pairing)).toEqual({ status: 'expired' });
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'replaced' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'pairing.claim:success',
      'player.revoke:success:replaced',
      'display.delete:success',
    ]);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('a claim against a delete that is committing: the claim waits for the pairing lock, reads the screen again and answers 404; the code is not used up and no wrong attempt is counted', async () => {
    const display = await pairedDisplay('Deleted, then claimed');
    const other = await createDisplay(owner, org, 'Claimed instead');
    const pairing = await newPairing();
    const wrongAttempts = (): Promise<number> =>
      countOf('pairing_claim_failure', 'membership_id', org.membershipId);
    const wrongBefore = await wrongAttempts();
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), claim(display.id, pairing), {
      locktype: 'advisory',
    });
    expect(won.status).toBe(204);
    expect(await answered(lost)).toEqual(SCREEN_GONE);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await wrongAttempts()).toBe(wrongBefore);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    // The code still pairs another screen.
    expect(await poll(pairing)).toMatchObject({ status: 'pending' });
    expect((await claim(other.id, pairing)()).status).toBe(200);
  });

  it('a collection that is committing against a delete: the delete waits for the pairing session row and then revokes the registration the collection made; the credential the player was given answers 401', async () => {
    const display = await createDisplay(owner, org, 'Collected, then deleted');
    const pairing = await newPairing();
    expect((await claim(display.id, pairing)()).status).toBe(200);
    const mark = await newestAuditRow();
    const { won, lost } = await race(collect(pairing), remove(display.id));
    expect(won.status).toBe(200);
    const collected = (await won.json()) as {
      status: string;
      deviceToken: string;
      registrationId: string;
    };
    expect(collected.status).toBe('claimed');
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    // Nothing was left to cancel: the claim was collected. The registration it made is ended.
    expect(await deleteRecorded(display.id)).toMatchObject([
      { cancelledPairingIds: [], revokedRegistrationId: collected.registrationId },
    ]);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'pairing.complete:success',
      'display.delete:success',
    ]);
    const manifest = await fetch(`${t.url}/player/manifest`, {
      headers: { authorization: `Bearer ${collected.deviceToken}` },
    });
    await expectError(manifest, 'device_revoked');
  });

  it('a collection against a delete that is committing: the poll waits for the pairing session row the delete cancelled and answers expired; no player is made', async () => {
    const display = await createDisplay(owner, org, 'Deleted, then collected');
    const pairing = await newPairing();
    expect((await claim(display.id, pairing)()).status).toBe(200);
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), collect(pairing));
    expect(won.status).toBe(204);
    expect(lost.status).toBe(200);
    expect(await lost.json()).toEqual({ status: 'expired' });
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await deleteRecorded(display.id)).toMatchObject([
      { cancelledPairingIds: [pairing.pairingId], revokedRegistrationId: null },
    ]);
    expect(await registrations(display.id)).toEqual([]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
  });

  it('an operator revoke that is committing against a delete: the delete waits for the pairing lock and finds no player left to end; the registration is ended once', async () => {
    const display = await pairedDisplay('Revoked, then deleted');
    const mark = await newestAuditRow();
    const { won, lost } = await race(revoke(display.id), remove(display.id), {
      locktype: 'advisory',
    });
    expect(won.status).toBe(200);
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await deleteRecorded(display.id)).toMatchObject([{ revokedRegistrationId: null }]);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'player.revoke:success:operator',
      'display.delete:success',
    ]);
  });

  it('an operator revoke against a delete that is committing: the revoke waits for the pairing lock and answers 404; the delete had ended the player, and the revoke writes nothing', async () => {
    const display = await pairedDisplay('Deleted, then revoked');
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), revoke(display.id), {
      locktype: 'advisory',
    });
    expect(won.status).toBe(204);
    expect(await answered(lost)).toEqual(SCREEN_GONE);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('a player’s reset that is committing against a delete: the delete waits for the registration row the reset ended, finds no player left to end and deletes the screen; the reason stays player_reset', async () => {
    const display = await pairedDisplay('Reset, then deleted');
    const mark = await newestAuditRow();
    const { won, lost } = await race(reset(display.player), remove(display.id));
    expect(won.status).toBe(204);
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await deleteRecorded(display.id)).toMatchObject([{ revokedRegistrationId: null }]);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'player_reset' }]);
    expect(await auditRowsAfter(mark)).toEqual([
      'player.revoke:success:player_reset',
      'display.delete:success',
    ]);
  });

  it('a player’s reset against a delete that is committing: past its credential lookup, the reset waits for the registration row the delete ended, finds itself revoked, answers 204 and writes nothing', async () => {
    const display = await pairedDisplay('Deleted, then reset');
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), reset(display.player));
    expect(won.status).toBe(204);
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await deleteRecorded(display.id)).toMatchObject([
      { revokedRegistrationId: display.player.registrationId },
    ]);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('a player’s first report that is committing against a delete: the delete waits for the display row; the report is stored for a screen that is then deleted, and the player’s next request answers 401', async () => {
    const display = await pairedDisplay('Reported, then deleted');
    const mark = await newestAuditRow();
    const { won, lost } = await race(heartbeat(display.id, display.player), remove(display.id), {
      wrote: AT_HEARTBEAT_LOG,
    });
    expect(won.status).toBe(200);
    expect(await won.json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await reported(display.id)).toEqual([
      { registration: display.player.registrationId, seq: '1', desired: null },
    ]);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    // A heartbeat is telemetry (D3): only the delete is audited.
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('a player’s first report against a delete that is committing: past its credential lookup, it waits for the display row, stores nothing of a revoked registration and still answers accepted (D8; Michael, 25 Nov 2026); the next request answers 401', async () => {
    const display = await pairedDisplay('Deleted, then reported');
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), heartbeat(display.id, display.player));
    expect(won.status).toBe(204);
    expect(lost.status).toBe(200);
    expect(await lost.json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    // The delivery row the report made holds no report: its registration was no longer active.
    expect(await reported(display.id)).toEqual([{ registration: null, seq: null, desired: null }]);
    expect(await countOf('heartbeat_log', 'display_id', display.id)).toBe(0);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    await expectError(await heartbeat(display.id, display.player)(), 'device_revoked');
  });

  /**
   * A screen whose player has reported once, with that report's history row made older than the
   * sampling interval, so that the next report keeps a history row: the write by which a later
   * report meets the display row. Within the interval a later report keeps none, takes no lock a
   * delete holds and commits without waiting, as the D8 window allows.
   */
  async function reportedOnce(name: string): Promise<{ id: string; player: PairedPlayer }> {
    const display = await pairedDisplay(name);
    expect((await heartbeat(display.id, display.player)()).status).toBe(200);
    await admin.query(
      `UPDATE public.heartbeat_log SET received_at = received_at - interval '1 minute'
        WHERE display_id = $1`,
      [display.id],
    );
    return display;
  }

  it('a player’s later report that is committing against a delete: the delete waits for the display row the report’s history row shares; the report is stored for a screen that is then deleted, and the player’s next request answers 401', async () => {
    const display = await reportedOnce('Reported again, then deleted');
    const mark = await newestAuditRow();
    const { won, lost } = await race(heartbeat(display.id, display.player, 2), remove(display.id), {
      wrote: AT_HEARTBEAT_LOG,
    });
    expect(won.status).toBe(200);
    expect(await won.json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect(lost.status).toBe(204);
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    expect(await reported(display.id)).toEqual([
      { registration: display.player.registrationId, seq: '2', desired: null },
    ]);
    expect(await countOf('heartbeat_log', 'display_id', display.id)).toBe(2);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    expect(await manifestStatus(display.player)).toBe(401);
  });

  it('a player’s later report against a delete that is committing: past its credential lookup, it stores its report before it waits for the display row at its history row, and answers accepted (D8); the next request answers 401', async () => {
    const display = await reportedOnce('Deleted, then reported again');
    const mark = await newestAuditRow();
    const { won, lost } = await race(remove(display.id), heartbeat(display.id, display.player, 2));
    expect(won.status).toBe(204);
    expect(lost.status).toBe(200);
    expect(await lost.json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect(faults.databaseErrors()).toEqual([]);
    expect(await screen(display.id)).toEqual(DELETED);
    // PINNED, as found (Observation), not decided: unlike a first report, which waits before its
    // conditional UPDATE and then reads the revocation, a later report has made that UPDATE
    // before it waits, while the revocation was not yet committed, so it is stored with the
    // revoked registration. That is the window D8 states (a request past its credential lookup
    // finishes its transaction), and nothing reads it: the status view and the alert check count
    // only a report from the active registration.
    expect(await reported(display.id)).toEqual([
      { registration: display.player.registrationId, seq: '2', desired: null },
    ]);
    expect(await countOf('heartbeat_log', 'display_id', display.id)).toBe(2);
    expect(await registrations(display.id)).toEqual([{ active: false, reason: 'operator' }]);
    expect(await auditRowsAfter(mark)).toEqual(['display.delete:success']);
    await expectError(await heartbeat(display.id, display.player, 3)(), 'device_revoked');
  });
});
