/**
 * CMS-41: deleting a screen. The row is kept with `deleted_at` for the publications that refer
 * to it and is invisible to every operator route; its tags and assignments are taken off. The
 * player side (cut off, claims cancelled) is in tests/integration/pairing-and-credentials.test.ts
 * and the alert episode in tests/integration/display-alerts.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { withOrg } from '@tinnox/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  assignLayout,
  assignPlaylist,
  assignSchedule,
  auditEvents,
  createDisplay,
  createLayout,
  createOrg,
  createPlaylist,
  createSchedule,
  expectError,
  layoutZones,
  publishImages,
  push,
  readyImage,
  signIn,
  startTestApp,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

describe('DELETE /api/displays/:id', () => {
  let t: TestApp;
  let orgA: TestOrg;
  let alice: Operator;
  let bob: Operator;

  beforeAll(async () => {
    t = await startTestApp();
    orgA = await createOrg('Screen delete A');
    alice = await signIn(t, orgA);
    bob = await signIn(t, await createOrg('Screen delete B'));
  });
  afterAll(async () => {
    await t.close();
  });

  const remove = (operator: Operator, id: string): Promise<Response> =>
    operator.fetch(`/api/displays/${id}`, { method: 'DELETE' });

  async function json<T>(operator: Operator, path: string): Promise<T> {
    const response = await operator.fetch(path);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  }

  const listedIds = async (): Promise<string[]> =>
    (await json<{ items: { id: string }[] }>(alice, '/api/displays')).items.map((d) => d.id);
  const statusIds = async (): Promise<string[]> =>
    (await json<{ items: { displayId: string }[] }>(alice, '/api/displays/status')).items.map(
      (s) => s.displayId,
    );
  const planIds = async (): Promise<string[]> =>
    (await json<{ items: { display: { id: string } }[] }>(alice, '/api/push')).items.map(
      (row) => row.display.id,
    );
  const overview = (): Promise<{ displays: { total: number } }> => json(alice, '/api/overview');

  it('deletes a screen: gone from the list, the statuses, the push plan and the overview; the row is kept', async () => {
    const tag = await alice.fetch('/api/tags', {
      method: 'POST',
      json: { scope: 'display', name: `Lobby ${randomUUID().slice(0, 8)}` },
    });
    expect(tag.status).toBe(201);
    const tagId = ((await tag.json()) as { id: string }).id;
    const kept = await createDisplay(alice, orgA, 'Kept screen');
    const display = await createDisplay(alice, orgA, 'Retired screen');
    const playlist = await createPlaylist(alice, 'Retired loop');
    await assignPlaylist(alice, display.id, playlist);
    const tagged = await alice.fetch(`/api/displays/${display.id}`, {
      method: 'PATCH',
      json: { tagIds: [tagId] },
    });
    expect(tagged.status).toBe(200);
    const before = await overview();
    expect(await planIds()).toContain(display.id);

    const removed = await remove(alice, display.id);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');

    expect(await listedIds()).toContain(kept.id);
    expect(await listedIds()).not.toContain(display.id);
    // The list and the statuses agree, or the Screens page reloads the list on every poll.
    expect(await statusIds()).toEqual(await listedIds());
    expect(await planIds()).not.toContain(display.id);
    const after = await overview();
    expect(after.displays.total).toBe(before.displays.total - 1);
    const tags = await json<{ items: { id: string; usageCount: number }[] }>(
      alice,
      '/api/tags?scope=display',
    );
    expect(tags.items.find((item) => item.id === tagId)?.usageCount).toBe(0);
    // The playlist it had is free to go.
    expect((await alice.fetch(`/api/playlists/${playlist}`, { method: 'DELETE' })).status).toBe(
      204,
    );

    const stored = await withOrg(t.pool, orgA.orgId, async (tx) => {
      const row = await tx.query<{
        deleted: boolean;
        assigned_playlist_id: string | null;
        assigned_schedule_id: string | null;
        assigned_layout_id: string | null;
      }>(
        `SELECT deleted_at IS NOT NULL AS deleted, assigned_playlist_id, assigned_schedule_id,
                assigned_layout_id
         FROM display WHERE id = $1`,
        [display.id],
      );
      const tagRows = await tx.query('SELECT 1 FROM display_tag WHERE display_id = $1', [
        display.id,
      ]);
      return { ...row.rows[0], tags: tagRows.rowCount };
    });
    expect(stored).toEqual({
      deleted: true,
      assigned_playlist_id: null,
      assigned_schedule_id: null,
      assigned_layout_id: null,
      tags: 0,
    });

    const [event] = (await auditEvents(alice, '&category=display')).filter(
      (e) => e.action === 'display.delete' && e.objectId === display.id,
    );
    expect(event).toMatchObject({
      result: 'success',
      actorId: orgA.membershipId,
      objectType: 'display',
      detail: { revokedRegistrationId: null, cancelledPairingIds: [], tagCount: 1 },
    });
  });

  it('answers 404 "The screen was not found." on every route for a deleted screen', async () => {
    const display = await createDisplay(alice, orgA, 'Gone screen');
    const playlist = await createPlaylist(alice, 'Loop for a gone screen');
    expect((await remove(alice, display.id)).status).toBe(204);

    const pairing = await fetch(`${t.url}/player/pairing`, { method: 'POST' });
    const { code } = (await pairing.json()) as { code: string };
    const attempts: [string, () => Promise<Response>][] = [
      ['read', () => alice.fetch(`/api/displays/${display.id}`)],
      ['status', () => alice.fetch(`/api/displays/${display.id}/status`)],
      [
        'rename',
        () =>
          alice.fetch(`/api/displays/${display.id}`, { method: 'PATCH', json: { name: 'Back' } }),
      ],
      [
        'revoke player',
        () => alice.fetch(`/api/displays/${display.id}/revoke-player`, { method: 'POST' }),
      ],
      [
        'claim',
        () => alice.fetch(`/api/displays/${display.id}/claim`, { method: 'POST', json: { code } }),
      ],
      ['push', () => push(alice, [display.id])],
      [
        'publish',
        () =>
          alice.fetch(`/api/playlists/${playlist}/publish`, {
            method: 'POST',
            json: { displayId: display.id },
            headers: { 'idempotency-key': randomUUID() },
          }),
      ],
      ['delete again', () => remove(alice, display.id)],
    ];
    for (const [what, attempt] of attempts) {
      const error = await expectError(await attempt(), 'not_found');
      expect(error.message, what).toBe('The screen was not found.');
    }
  });

  it('frees the schedule and the layout it had assigned', async () => {
    const [main, band] = [
      await createPlaylist(alice, 'Freed main'),
      await createPlaylist(alice, 'Freed band'),
    ];
    const schedule = await createSchedule(alice, 'Freed schedule', main);
    const layout = await createLayout(alice, 'Freed layout', layoutZones(main, band));
    const scheduled = await createDisplay(alice, orgA, 'Scheduled screen');
    const laidOut = await createDisplay(alice, orgA, 'Laid out screen');
    await assignSchedule(alice, scheduled.id, schedule.id);
    await assignLayout(alice, laidOut.id, layout.id);
    await expectError(
      await alice.fetch(`/api/schedules/${schedule.id}`, { method: 'DELETE' }),
      'schedule_in_use',
    );

    expect((await remove(alice, scheduled.id)).status).toBe(204);
    expect((await remove(alice, laidOut.id)).status).toBe(204);
    const schedules = await json<{ items: { id: string; assignedDisplayCount: number }[] }>(
      alice,
      '/api/schedules',
    );
    expect(schedules.items.find((s) => s.id === schedule.id)?.assignedDisplayCount).toBe(0);
    expect((await alice.fetch(`/api/schedules/${schedule.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await alice.fetch(`/api/layouts/${layout.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('no longer lists a deleted screen as using a media file', async () => {
    const display = await createDisplay(alice, orgA, 'Screen showing an image');
    const image = await readyImage(t, alice);
    await publishImages(alice, display.id, [image.id]);
    const usage = async (): Promise<string[]> =>
      (
        await json<{ displays: { id: string }[] }>(alice, `/api/media/${image.id}/usage`)
      ).displays.map((d) => d.id);
    expect(await usage()).toEqual([display.id]);

    expect((await remove(alice, display.id)).status).toBe(204);
    expect(await usage()).toEqual([]);
  });

  it('lets an Editor delete and refuses a Viewer before looking the screen up', async () => {
    const viewer = await signIn(t, await addMember(orgA, 'viewer'));
    const editor = await signIn(t, await addMember(orgA, 'editor'));
    const display = await createDisplay(alice, orgA, 'Role screen');
    for (const id of [display.id, randomUUID()]) {
      await expectError(await remove(viewer, id), 'forbidden');
    }
    expect(await listedIds()).toContain(display.id);
    expect((await remove(editor, display.id)).status).toBe(204);
  });

  it('answers 404 for an unknown screen and for a screen of another organisation', async () => {
    const display = await createDisplay(alice, orgA, 'Still here');
    for (const id of [display.id, randomUUID()]) {
      const error = await expectError(await remove(bob, id), 'not_found');
      expect(error.message).toBe('The screen was not found.');
    }
    expect((await json<{ name: string }>(alice, `/api/displays/${display.id}`)).name).toBe(
      'Still here',
    );
  });

  it('lets a delete and a concurrent edit settle one way: the edit first, or a 404', async () => {
    for (let round = 0; round < 6; round += 1) {
      const display = await createDisplay(alice, orgA, `Race screen ${round}`);
      const [removed, renamed] = await Promise.all([
        remove(alice, display.id),
        alice.fetch(`/api/displays/${display.id}`, {
          method: 'PATCH',
          json: { name: `Renamed ${round}` },
        }),
      ]);
      expect(removed.status, `round ${round}`).toBe(204);
      if (renamed.status === 200) {
        expect(((await renamed.json()) as { name: string }).name).toBe(`Renamed ${round}`);
      } else {
        const error = await expectError(renamed, 'not_found');
        expect(error.message).toBe('The screen was not found.');
      }
      await expectError(await alice.fetch(`/api/displays/${display.id}`), 'not_found');
    }
  });
});
