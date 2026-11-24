/**
 * Brief section 8 item 4: a second organisation with its own member and its own session
 * (and its own paired player) gets nothing from the first organisation, through direct
 * API requests with known ids and, underneath, through the database policies.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appClient,
  checkAlerts,
  createDisplay,
  createLayout,
  createOrg,
  createSchedule,
  ERROR_STATUS,
  expectError,
  heartbeatBody,
  layoutZones,
  newPairing,
  pairPlayer,
  publishImages,
  readyImage,
  registeredRoutes,
  requestMediaUrls,
  scheduleEvent,
  sendHeartbeat,
  signedMediaUrl,
  signIn,
  startTestApp,
  type AnsweredErrorCode,
  type Operator,
  type PairedPlayer,
  type TestApp,
  type TestOrg,
} from './support.ts';

describe('organisation isolation through the API', () => {
  let t: TestApp;
  let orgA: TestOrg;
  let orgB: TestOrg;
  let alice: Operator;
  let bob: Operator;
  interface World {
    displayId: string;
    mediaId: string;
    playlistId: string;
    publicationId: string;
    folderId: string;
    mediaTagId: string;
    displayTagId: string;
    appId: string;
    scheduleId: string;
    layoutId: string;
    inviteId: string;
    recipientId: string;
    player: PairedPlayer;
  }
  let a: World;
  let b: World;

  async function created(response: Response): Promise<string> {
    if (response.status !== 201) throw new Error(`arranging failed: ${response.status}`);
    return ((await response.json()) as { id: string }).id;
  }

  /**
   * One of everything an organisation can own: a display with a paired player, ready
   * media in a folder, a playlist published and so assigned to the display, and a tag
   * of each scope put on the media item and on the display, an app, a schedule
   * with one event on the playlist and a layout with the playlist in both zones (both
   * assigned to no display), a pending invite and an alert address waiting for confirmation.
   */
  async function world(operator: Operator, org: TestOrg): Promise<World> {
    const display = await createDisplay(operator, org, 'Isolation display');
    const media = await readyImage(t, operator);
    const published = await publishImages(operator, display.id, [media.id]);
    const player = await pairPlayer(t, operator, display.id);
    const folderId = await created(
      await operator.fetch('/api/folders', { method: 'POST', json: { name: 'Isolation folder' } }),
    );
    const tag = (scope: string): Promise<Response> =>
      operator.fetch('/api/tags', { method: 'POST', json: { scope, name: 'Isolation tag' } });
    const mediaTagId = await created(await tag('media'));
    const displayTagId = await created(await tag('display'));
    const filed = await operator.fetch(`/api/media/${media.id}`, {
      method: 'PATCH',
      json: { folderId, tagIds: [mediaTagId] },
    });
    const tagged = await operator.fetch(`/api/displays/${display.id}`, {
      method: 'PATCH',
      json: { tagIds: [displayTagId] },
    });
    if (filed.status !== 200 || tagged.status !== 200) throw new Error('arranging failed');
    const appId = await created(
      await operator.fetch('/api/apps', {
        method: 'POST',
        json: {
          name: 'Isolation clock',
          content: {
            type: 'clock',
            settings: {
              hourCycle: '12',
              showSeconds: false,
              textColour: '#ffffff',
              backgroundColour: '#000000',
            },
          },
        },
      }),
    );
    const schedule = await createSchedule(operator, 'Isolation week', published.playlistId, [
      scheduleEvent(published.playlistId),
    ]);
    const layout = await createLayout(
      operator,
      'Isolation split',
      layoutZones(published.playlistId, published.playlistId),
    );
    const inviteId = await created(
      await operator.fetch('/api/invites', {
        method: 'POST',
        json: { name: 'Isolation invitee', email: 'isolation@example.com', role: 'viewer' },
      }),
    );
    const recipientId = await created(
      await operator.fetch('/api/alert-recipients', {
        method: 'POST',
        json: { email: `isolation-${org.orgId}@example.com` },
      }),
    );
    return {
      displayId: display.id,
      mediaId: media.id,
      playlistId: published.playlistId,
      publicationId: published.publicationId,
      folderId,
      mediaTagId,
      displayTagId,
      appId,
      scheduleId: schedule.id,
      layoutId: layout.id,
      inviteId,
      recipientId,
      player,
    };
  }

  beforeAll(async () => {
    t = await startTestApp();
    orgA = await createOrg('Isolation A');
    orgB = await createOrg('Isolation B');
    alice = await signIn(t, orgA);
    bob = await signIn(t, orgB);
    a = await world(alice, orgA);
    b = await world(bob, orgB);
    // Give A's display some reported state and an audit trail to protect.
    const report = await sendHeartbeat(
      t,
      a.player,
      heartbeatBody(a.displayId, 10, {
        downloadedPublicationId: a.publicationId,
        activePublicationId: a.publicationId,
        activeItemIndex: 0,
        playerState: 'playing',
      }),
    );
    expect(report.status).toBe(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('answers every read of another organisation’s object like an unknown id', async () => {
    const unknown = randomUUID();
    const paths = (ids: {
      displayId: string;
      mediaId: string;
      playlistId: string;
      appId: string;
      scheduleId: string;
      layoutId: string;
    }): string[] => [
      `/api/displays/${ids.displayId}`,
      `/api/displays/${ids.displayId}/status`,
      `/api/media/${ids.mediaId}`,
      `/api/media/${ids.mediaId}/preview`,
      `/api/media/${ids.mediaId}/thumbnail`,
      `/api/media/${ids.mediaId}/usage`,
      `/api/playlists/${ids.playlistId}`,
      `/api/apps/${ids.appId}`,
      `/api/schedules/${ids.scheduleId}`,
      `/api/layouts/${ids.layoutId}`,
    ];
    const foreign = paths(a);
    const missing = paths({
      displayId: unknown,
      mediaId: unknown,
      playlistId: unknown,
      appId: unknown,
      scheduleId: unknown,
      layoutId: unknown,
    });
    for (let i = 0; i < foreign.length; i += 1) {
      const real = await bob.fetch(foreign[i] ?? '');
      const none = await bob.fetch(missing[i] ?? '');
      expect(real.status, foreign[i]).toBe(404);
      expect(none.status).toBe(404);
      const realBody = (await real.json()) as { error: { code: string; message: string } };
      const noneBody = (await none.json()) as { error: { code: string; message: string } };
      // Same code and same message: the response does not confirm that the object exists.
      expect(realBody.error.code).toBe(noneBody.error.code);
      expect(realBody.error.message).toBe(noneBody.error.message);
      // The owner still reads it.
      expect((await alice.fetch(foreign[i] ?? '')).status).toBe(200);
    }
  });

  it('keeps lists, storage totals and the audit trail to the caller’s organisation', async () => {
    for (const path of [
      '/api/sites',
      '/api/displays',
      '/api/displays/status',
      '/api/media',
      `/api/media/${b.mediaId}/usage`,
      '/api/tags',
      '/api/tags?scope=media',
      '/api/tags?scope=display',
      '/api/folders',
      '/api/apps',
      '/api/schedules',
      '/api/layouts',
      '/api/playlists',
      '/api/push',
      '/api/overview',
      '/api/audit?limit=200',
      '/api/audit?limit=200&category=tag',
      '/api/members',
      '/api/members/names',
      '/api/invites',
      '/api/alert-recipients',
    ]) {
      const response = await bob.fetch(path);
      expect(response.status, path).toBe(200);
      const text = await response.text();
      for (const id of [
        orgA.orgId,
        orgA.siteId,
        orgA.membershipId,
        a.displayId,
        a.mediaId,
        a.playlistId,
        a.publicationId,
        a.folderId,
        a.mediaTagId,
        a.displayTagId,
        a.appId,
        a.scheduleId,
        a.layoutId,
        a.inviteId,
        a.recipientId,
        `isolation-${orgA.orgId}@example.com`,
        a.player.registrationId,
      ]) {
        expect(text, `${path} leaks ${id}`).not.toContain(id);
      }
    }
    // Each organisation's lists and numbers describe exactly its own world: both
    // have the same things, so any row of the other would show up as a wrong count.
    for (const operator of [alice, bob]) {
      const json = async <T>(path: string): Promise<T> =>
        (await (await operator.fetch(path)).json()) as T;
      for (const path of [
        '/api/displays',
        '/api/displays/status',
        '/api/media',
        '/api/push',
        '/api/apps',
        '/api/schedules',
        '/api/layouts',
        '/api/members',
        '/api/members/names',
        '/api/invites',
        '/api/alert-recipients',
      ]) {
        expect((await json<{ items: unknown[] }>(path)).items, path).toHaveLength(1);
      }
      expect((await json<{ items: unknown[] }>('/api/tags')).items).toHaveLength(2);
      expect(await json('/api/folders')).toMatchObject({ items: [{ itemCount: 1 }] });
      expect(await json('/api/tags?scope=media')).toMatchObject({ items: [{ usageCount: 1 }] });
      expect(await json('/api/overview')).toMatchObject({
        displays: { total: 1, paired: 1 },
        media: { total: 1, ready: 1 },
        pendingPushCount: 0,
      });
    }
    const audit = (await (await bob.fetch('/api/audit?limit=200')).json()) as {
      items: { actorId: string | null }[];
    };
    expect(audit.items.length).toBeGreaterThan(0);
    for (const event of audit.items) {
      expect([orgB.membershipId, b.player.registrationId, null]).toContain(event.actorId);
    }
  });

  // After the audit check above: the Viewer's refusals are audited with the Viewer's id.
  it('refuses a role the same way for its own, another organisation’s and an unknown id', async () => {
    const viewer = await signIn(t, await addMember(orgB, 'viewer'));
    const answers = [];
    for (const id of [b.displayId, a.displayId, randomUUID()]) {
      const response = await viewer.fetch(`/api/displays/${id}`, {
        method: 'PATCH',
        json: { name: 'taken' },
      });
      expect(response.status, id).toBe(403);
      answers.push(((await response.json()) as { error: { code: string; message: string } }).error);
    }
    expect(answers).toEqual(
      Array.from({ length: 3 }, () => ({
        code: 'forbidden',
        message: "Your role doesn't allow this.",
        requestId: expect.any(String) as unknown,
      })),
    );
    expect(
      ((await (await bob.fetch(`/api/displays/${b.displayId}`)).json()) as { name: string }).name,
    ).toBe('Isolation display');
  });

  it('answers a change to another organisation’s member or invite like an unknown id', async () => {
    const unknown = randomUUID();
    const changes = (
      memberId: string,
      inviteId: string,
      recipientId: string,
    ): [string, RequestInit & { json?: unknown }][] => [
      [`/api/members/${memberId}`, { method: 'PATCH', json: { displayName: 'Taken' } }],
      [`/api/members/${memberId}`, { method: 'PATCH', json: { role: 'viewer' } }],
      [`/api/members/${memberId}/remove`, { method: 'POST' }],
      [`/api/members/${memberId}/sign-out`, { method: 'POST' }],
      [`/api/invites/${inviteId}/cancel`, { method: 'POST' }],
      [`/api/alert-recipients/${recipientId}`, { method: 'DELETE' }],
    ];
    const foreign = changes(orgA.membershipId, a.inviteId, a.recipientId);
    const missing = changes(unknown, unknown, unknown);
    for (let i = 0; i < foreign.length; i += 1) {
      const [path, init] = foreign[i] ?? ['', {}];
      const [unknownPath, unknownInit] = missing[i] ?? ['', {}];
      const real = await bob.fetch(path, init);
      const none = await bob.fetch(unknownPath, unknownInit);
      expect(real.status, path).toBe(404);
      expect(none.status, unknownPath).toBe(404);
      const realBody = (await real.json()) as { error: { code: string; message: string } };
      const noneBody = (await none.json()) as { error: { code: string; message: string } };
      expect(realBody.error.code).toBe(noneBody.error.code);
      expect(realBody.error.message).toBe(noneBody.error.message);
    }
    // Alice is still a signed-in Owner with her name unchanged, and A's invite is still waiting.
    const members = (await (await alice.fetch('/api/members')).json()) as { items: unknown[] };
    expect(members.items).toEqual([
      {
        id: orgA.membershipId,
        displayName: null,
        role: 'owner',
        firstSignedInAt: expect.any(String) as unknown,
        removedAt: null,
      },
    ]);
    const invites = (await (await alice.fetch('/api/invites')).json()) as {
      items: { id: string }[];
    };
    expect(invites.items.map((item) => item.id)).toEqual([a.inviteId]);
    const recipients = (await (await alice.fetch('/api/alert-recipients')).json()) as {
      items: { id: string }[];
    };
    expect(recipients.items.map((item) => item.id)).toEqual([a.recipientId]);
  });

  it('refuses every mutation of another organisation’s object and leaves it unchanged', async () => {
    const snapshot = async (): Promise<Record<string, string>> => ({
      display: await (await alice.fetch(`/api/displays/${a.displayId}`)).text(),
      playlist: await (await alice.fetch(`/api/playlists/${a.playlistId}`)).text(),
      playlists: await (await alice.fetch('/api/playlists')).text(),
      media: await (await alice.fetch(`/api/media/${a.mediaId}`)).text(),
      tags: await (await alice.fetch('/api/tags')).text(),
      folders: await (await alice.fetch('/api/folders')).text(),
      apps: await (await alice.fetch('/api/apps')).text(),
      schedule: await (await alice.fetch(`/api/schedules/${a.scheduleId}`)).text(),
      schedules: await (await alice.fetch('/api/schedules')).text(),
      layout: await (await alice.fetch(`/api/layouts/${a.layoutId}`)).text(),
      layouts: await (await alice.fetch('/api/layouts')).text(),
      push: await (await alice.fetch('/api/push')).text(),
      status: JSON.stringify({
        ...((await (await alice.fetch(`/api/displays/${a.displayId}/status`)).json()) as object),
        asOf: null,
      }),
    });
    const before = await snapshot();
    const ownBefore = (await (
      await bob.fetch(`/api/displays/${b.displayId}/status`)
    ).json()) as object;
    const attempts: [string, Promise<Response>][] = [
      [
        'PATCH display',
        bob.fetch(`/api/displays/${a.displayId}`, { method: 'PATCH', json: { name: 'taken' } }),
      ],
      [
        'PATCH media',
        bob.fetch(`/api/media/${a.mediaId}`, { method: 'PATCH', json: { name: 'taken' } }),
      ],
      [
        'PATCH tag',
        bob.fetch(`/api/tags/${a.mediaTagId}`, { method: 'PATCH', json: { name: 'taken' } }),
      ],
      ['DELETE media tag', bob.fetch(`/api/tags/${a.mediaTagId}`, { method: 'DELETE' })],
      ['DELETE display tag', bob.fetch(`/api/tags/${a.displayTagId}`, { method: 'DELETE' })],
      [
        'PATCH folder',
        bob.fetch(`/api/folders/${a.folderId}`, { method: 'PATCH', json: { name: 'taken' } }),
      ],
      ['DELETE folder', bob.fetch(`/api/folders/${a.folderId}`, { method: 'DELETE' })],
      [
        'PATCH app',
        bob.fetch(`/api/apps/${a.appId}`, { method: 'PATCH', json: { name: 'taken' } }),
      ],
      ['DELETE app', bob.fetch(`/api/apps/${a.appId}`, { method: 'DELETE' })],
      [
        'PUT schedule',
        bob.fetch(`/api/schedules/${a.scheduleId}`, {
          method: 'PUT',
          json: { name: 'taken', defaultPlaylistId: b.playlistId, events: [] },
        }),
      ],
      ['DELETE schedule', bob.fetch(`/api/schedules/${a.scheduleId}`, { method: 'DELETE' })],
      [
        'PUT layout',
        bob.fetch(`/api/layouts/${a.layoutId}`, {
          method: 'PUT',
          json: { name: 'taken', zones: layoutZones(b.playlistId, b.playlistId) },
        }),
      ],
      ['DELETE layout', bob.fetch(`/api/layouts/${a.layoutId}`, { method: 'DELETE' })],
      ['DELETE playlist', bob.fetch(`/api/playlists/${a.playlistId}`, { method: 'DELETE' })],
      [
        'duplicate playlist',
        bob.fetch(`/api/playlists/${a.playlistId}/duplicate`, { method: 'POST' }),
      ],
      [
        'push to A display',
        bob.fetch('/api/push', {
          method: 'POST',
          json: { displayIds: [a.displayId] },
          headers: { 'idempotency-key': randomUUID() },
        }),
      ],
      [
        'push to own and A display',
        bob.fetch('/api/push', {
          method: 'POST',
          json: { displayIds: [b.displayId, a.displayId] },
          headers: { 'idempotency-key': randomUUID() },
        }),
      ],
      // Pointing one's own objects at another organisation's is refused the same way.
      [
        'assign A playlist to own display',
        bob.fetch(`/api/displays/${b.displayId}`, {
          method: 'PATCH',
          json: { assignedPlaylistId: a.playlistId },
        }),
      ],
      [
        'assign A schedule to own display',
        bob.fetch(`/api/displays/${b.displayId}`, {
          method: 'PATCH',
          json: { assignedScheduleId: a.scheduleId },
        }),
      ],
      [
        'assign A layout to own display',
        bob.fetch(`/api/displays/${b.displayId}`, {
          method: 'PATCH',
          json: { assignedLayoutId: a.layoutId },
        }),
      ],
      [
        'put A display tag on own display',
        bob.fetch(`/api/displays/${b.displayId}`, {
          method: 'PATCH',
          json: { tagIds: [b.displayTagId, a.displayTagId] },
        }),
      ],
      [
        'move own media into A folder',
        bob.fetch(`/api/media/${b.mediaId}`, { method: 'PATCH', json: { folderId: a.folderId } }),
      ],
      [
        'put A media tag on own media',
        bob.fetch(`/api/media/${b.mediaId}`, {
          method: 'PATCH',
          json: { tagIds: [a.mediaTagId] },
        }),
      ],
      [
        'revoke player',
        bob.fetch(`/api/displays/${a.displayId}/revoke-player`, { method: 'POST' }),
      ],
      ['DELETE media', bob.fetch(`/api/media/${a.mediaId}`, { method: 'DELETE' })],
      [
        'PUT playlist',
        bob.fetch(`/api/playlists/${a.playlistId}`, {
          method: 'PUT',
          json: { name: 'taken', items: [] },
        }),
      ],
      [
        'publish A playlist to A display',
        bob.fetch(`/api/playlists/${a.playlistId}/publish`, {
          method: 'POST',
          json: { displayId: a.displayId },
          headers: { 'idempotency-key': randomUUID() },
        }),
      ],
      [
        'publish A playlist to own display',
        bob.fetch(`/api/playlists/${a.playlistId}/publish`, {
          method: 'POST',
          json: { displayId: b.displayId },
          headers: { 'idempotency-key': randomUUID() },
        }),
      ],
      [
        'publish own playlist to A display',
        bob.fetch(`/api/playlists/${b.playlistId}/publish`, {
          method: 'POST',
          json: { displayId: a.displayId },
          headers: { 'idempotency-key': randomUUID() },
        }),
      ],
    ];
    for (const [what, attempt] of attempts) {
      expect((await attempt).status, what).toBe(404);
    }
    // Putting A's media into B's own playlist is refused too.
    const smuggle = await bob.fetch(`/api/playlists/${b.playlistId}`, {
      method: 'PUT',
      json: { name: 'mine', items: [{ mediaId: a.mediaId, durationMs: 5000, fit: null }] },
    });
    const smuggled = await expectError(smuggle, 'validation_failed');
    expect(JSON.stringify(smuggled.details)).toContain('media_missing');
    const own = (await (await bob.fetch(`/api/playlists/${b.playlistId}`)).json()) as {
      items: { mediaId: string }[];
    };
    expect(own.items.map((item) => item.mediaId)).not.toContain(a.mediaId);
    // So is putting A's app into B's own playlist: to B it does not exist.
    const smuggleApp = await bob.fetch(`/api/playlists/${b.playlistId}`, {
      method: 'PUT',
      json: { name: 'mine', items: [{ appId: a.appId, durationMs: 5000 }] },
    });
    expect(smuggleApp.status).toBe(400);
    expect(JSON.stringify(await smuggleApp.json())).toContain('app_missing');
    // So is naming A's playlist in a schedule of B's own, as its default or in an event.
    for (const json of [
      { name: 'mine', defaultPlaylistId: a.playlistId, events: [] },
      { name: 'mine', defaultPlaylistId: b.playlistId, events: [scheduleEvent(a.playlistId)] },
    ]) {
      for (const smuggleSchedule of [
        await bob.fetch('/api/schedules', { method: 'POST', json }),
        await bob.fetch(`/api/schedules/${b.scheduleId}`, { method: 'PUT', json }),
      ]) {
        expect(smuggleSchedule.status).toBe(400);
        expect(JSON.stringify(await smuggleSchedule.json())).toContain(
          'The playlist was not found.',
        );
      }
    }
    // So is naming A's playlist in a layout of B's own, as its main zone or as the band:
    // exactly the answer to an unknown id.
    for (const zones of [
      layoutZones(a.playlistId, b.playlistId),
      layoutZones(b.playlistId, a.playlistId),
    ]) {
      const json = { name: 'mine', zones };
      for (const smuggleLayout of [
        await bob.fetch('/api/layouts', { method: 'POST', json }),
        await bob.fetch(`/api/layouts/${b.layoutId}`, { method: 'PUT', json }),
      ]) {
        expect(smuggleLayout.status).toBe(400);
        expect(JSON.stringify(await smuggleLayout.json())).toContain('The playlist was not found.');
      }
    }
    // Creating a display on A's site is refused.
    const onForeignSite = await bob.fetch('/api/displays', {
      method: 'POST',
      json: { siteId: orgA.siteId, name: 'planted', canvas: { width: 640, height: 360 } },
    });
    expect(onForeignSite.status).toBe(404);

    expect(await snapshot()).toEqual(before);
    // Bob's own objects were not half-changed by the refused requests either.
    const ownDisplay = (await (await bob.fetch(`/api/displays/${b.displayId}`)).json()) as {
      tagIds: string[];
      assignedPlaylist: { id: string } | null;
      assignedSchedule: { id: string } | null;
      assignedLayout: { id: string } | null;
    };
    expect(ownDisplay.tagIds).toEqual([b.displayTagId]);
    expect(ownDisplay.assignedPlaylist?.id).toBe(b.playlistId);
    expect(ownDisplay.assignedSchedule).toBeNull();
    expect(ownDisplay.assignedLayout).toBeNull();
    const ownLayout = (await (await bob.fetch(`/api/layouts/${b.layoutId}`)).json()) as {
      name: string;
      zones: { playlist: { id: string } }[];
    };
    expect(ownLayout.name).toBe('Isolation split');
    expect(ownLayout.zones.map((zone) => zone.playlist.id)).toEqual([b.playlistId, b.playlistId]);
    const ownSchedule = (await (await bob.fetch(`/api/schedules/${b.scheduleId}`)).json()) as {
      name: string;
      defaultPlaylist: { id: string };
    };
    expect(ownSchedule).toMatchObject({
      name: 'Isolation week',
      defaultPlaylist: { id: b.playlistId },
    });
    const ownMedia = (await (await bob.fetch(`/api/media/${b.mediaId}`)).json()) as {
      folderId: string | null;
      tagIds: string[];
    };
    expect(ownMedia).toMatchObject({ folderId: b.folderId, tagIds: [b.mediaTagId] });
    // The push that named A's display did not push Bob's own display either.
    expect({
      ...((await (await bob.fetch(`/api/displays/${b.displayId}/status`)).json()) as object),
      asOf: null,
    }).toEqual({ ...ownBefore, asOf: null });
    // A's player credential is still valid: the foreign revoke did nothing.
    expect((await fetch(`${t.url}/player/manifest`, { headers: a.player.headers })).status).toBe(
      200,
    );
  });

  it('does not let a pairing code be claimed onto another organisation’s display', async () => {
    const created = (await (await fetch(`${t.url}/player/pairing`, { method: 'POST' })).json()) as {
      code: string;
    };
    const claim = await bob.fetch(`/api/displays/${a.displayId}/claim`, {
      method: 'POST',
      json: { code: created.code },
    });
    expect(claim.status).toBe(404);
    // The code was not consumed by the refused attempt.
    const rightful = await bob.fetch(`/api/displays/${b.displayId}/claim`, {
      method: 'POST',
      json: { code: created.code },
    });
    expect(rightful.status).toBe(200);
    // That replaced B's player; pair again so later tests have a live credential.
    b = { ...b, player: await pairPlayer(t, bob, b.displayId) };
  });

  it('gives a player of one organisation nothing from another organisation', async () => {
    // Its manifest is its own display's.
    const manifest = (await (
      await fetch(`${t.url}/player/manifest`, { headers: b.player.headers })
    ).json()) as { manifest: { publicationId: string; displayId: string } };
    expect(manifest.manifest.publicationId).toBe(b.publicationId);
    expect(manifest.manifest.displayId).toBe(b.displayId);

    // Media URLs for A's publication or A's asset.
    expect((await requestMediaUrls(t, b.player, a.publicationId, [a.mediaId])).status).toBe(404);
    expect((await requestMediaUrls(t, b.player, b.publicationId, [a.mediaId])).status).toBe(404);

    // A valid URL issued to A's player, re-pointed at B's registration or B's asset.
    const issued = (await (
      await requestMediaUrls(t, a.player, a.publicationId, [a.mediaId])
    ).json()) as { urls: { url: string }[] };
    const good = new URL(issued.urls[0]?.url ?? '');
    const local = (url: URL): string => `${t.url}${url.pathname}${url.search}`;
    expect((await fetch(local(good))).status).toBe(200);
    const otherRegistration = new URL(good);
    otherRegistration.searchParams.set('reg', b.player.registrationId);
    expect((await fetch(local(otherRegistration))).status).toBe(403);
    const otherAsset = new URL(good);
    otherAsset.pathname = otherAsset.pathname.replace(a.mediaId, b.mediaId);
    expect((await fetch(local(otherAsset))).status).toBe(403);
    // A device credential is not a way into the media route either.
    const withBearer = new URL(good);
    withBearer.searchParams.delete('sig');
    await expectError(
      await fetch(local(withBearer), { headers: b.player.headers }),
      'url_signature_invalid',
    );

    // Reports about A's display or A's publication are rejected and change nothing.
    const statusBefore = (await (
      await alice.fetch(`/api/displays/${a.displayId}/status`)
    ).json()) as { asOf: string };
    // The heartbeat refuses a displayId other than the credential's with 403 `forbidden`, decided
    // by comparing it with the credential's, with no lookup: another organisation's display, an
    // id never issued and a second display of the player's own organisation get the same answer
    // (D1; docs/player-protocol-v1.md section 10 tells a player what to do on it).
    const ownSecond = await createDisplay(bob, orgB, 'Second isolation display');
    const refusals = [];
    for (const displayId of [a.displayId, randomUUID(), ownSecond.id]) {
      const refused = await sendHeartbeat(t, b.player, heartbeatBody(displayId, 999_999));
      refusals.push({ ...(await expectError(refused, 'forbidden')), requestId: null });
    }
    expect(refusals).toEqual(
      Array.from({ length: 3 }, () => ({
        code: 'forbidden',
        message: 'This credential cannot report for that display.',
        requestId: null,
      })),
    );
    const forPublication = await sendHeartbeat(
      t,
      b.player,
      heartbeatBody(b.displayId, 1_000_000, {
        downloadedPublicationId: a.publicationId,
        activePublicationId: a.publicationId,
        activeItemIndex: 0,
        playerState: 'playing',
      }),
    );
    await expectError(forPublication, 'conflict');
    const statusAfter = (await (
      await alice.fetch(`/api/displays/${a.displayId}/status`)
    ).json()) as {
      asOf: string;
    };
    expect({ ...statusAfter, asOf: null }).toEqual({ ...statusBefore, asOf: null });
    const ownStatus = (await (await bob.fetch(`/api/displays/${b.displayId}/status`)).json()) as {
      active: unknown;
    };
    expect(ownStatus.active).toBeNull();
  });

  it('ignores organisation ids supplied in the request', async () => {
    const withQuery = await bob.fetch(`/api/displays?orgId=${orgA.orgId}`);
    const text = await withQuery.text();
    expect(text).not.toContain(a.displayId);
    const withHeader = await bob.fetch('/api/displays', { headers: { 'x-org-id': orgA.orgId } });
    expect(await withHeader.text()).not.toContain(a.displayId);
    const withBody = await bob.fetch('/api/playlists', {
      method: 'POST',
      json: { name: 'planted', orgId: orgA.orgId },
    });
    // Strict schemas: an unknown key is a validation error, not a hint.
    expect(withBody.status).toBe(400);
  });

  /**
   * D1 (adoption plan step 23): on every route the application registers, another organisation's
   * id gets exactly the answer of an id that was never issued, apart from the request id. Each
   * probe sends one id a route takes, in its path or its body, once as an object of organisation
   * A and once as a fresh UUID, both as organisation B, and names the answer both must be. A
   * route that takes no such id says why. A route without a case fails the test, so a new route
   * cannot skip the question.
   */
  it('answers another organisation’s id exactly like an id that was never issued, on every route (D1)', async () => {
    interface Ids {
      readonly siteId: string;
      readonly displayId: string;
      readonly mediaId: string;
      readonly playlistId: string;
      readonly publicationId: string;
      readonly folderId: string;
      readonly mediaTagId: string;
      readonly displayTagId: string;
      readonly appId: string;
      readonly scheduleId: string;
      readonly layoutId: string;
      readonly memberId: string;
      readonly inviteId: string;
      readonly recipientId: string;
      readonly pairingId: string;
    }
    // A 400 says only that something in the body was refused: the details it must carry prove the
    // refusal came from the reference lookup and not from a body that no longer parses.
    type Detail = Readonly<Record<string, string>>;
    type Details = readonly Detail[];
    type Probe = readonly [AnsweredErrorCode, (x: Ids) => Promise<Response>, Details?];
    type CrossOrgCase = { readonly none: string } | { readonly probes: readonly Probe[] };

    // A code A's operator claimed for a screen of A and no player has collected: the one kind of
    // pairing session that belongs to an organisation. B polls it with a polling token of its own.
    const pairingTarget = await createDisplay(alice, orgA, 'Isolation pairing target');
    const claimedByA = await newPairing(t);
    const claimed = await alice.fetch(`/api/displays/${pairingTarget.id}/claim`, {
      method: 'POST',
      json: { code: claimedByA.code },
    });
    expect(claimed.status).toBe(200);
    const bPolling = await newPairing(t);

    const foreign: Ids = {
      siteId: orgA.siteId,
      displayId: a.displayId,
      mediaId: a.mediaId,
      playlistId: a.playlistId,
      publicationId: a.publicationId,
      folderId: a.folderId,
      mediaTagId: a.mediaTagId,
      displayTagId: a.displayTagId,
      appId: a.appId,
      scheduleId: a.scheduleId,
      layoutId: a.layoutId,
      memberId: orgA.membershipId,
      inviteId: a.inviteId,
      recipientId: a.recipientId,
      pairingId: claimedByA.pairingId,
    };
    const unknown = Object.fromEntries(
      Object.keys(foreign).map((key) => [key, randomUUID()]),
    ) as unknown as Ids;

    const as = (method: string, path: string, json?: unknown): Promise<Response> =>
      bob.fetch(path, {
        method,
        ...(json === undefined ? {} : { json }),
        ...(method === 'POST' && (path === '/api/push' || path.endsWith('/publish'))
          ? { headers: { 'idempotency-key': randomUUID() } }
          : {}),
      });
    const notFound = (send: (x: Ids) => Promise<Response>): Probe => ['not_found', send];
    const invalid = (details: Details, send: (x: Ids) => Promise<Response>): Probe => [
      'validation_failed',
      send,
      details,
    ];
    // The schedule and layout routes name the field whose playlist they did not find.
    const PLAYLIST_NOT_FOUND = (path: string): Detail => ({
      path,
      message: 'The playlist was not found.',
    });
    const probes = (...list: Probe[]): CrossOrgCase => ({ probes: list });
    const none = (reason: string): CrossOrgCase => ({ none: reason });
    const LIST = 'reads or adds to the caller’s own organisation and names no object';
    const NO_ORG = 'answers the same for everyone and names no object';
    const player = b.player;

    const cases: Readonly<Record<string, CrossOrgCase>> = {
      'GET /api/sites': none(LIST),
      'GET /api/displays': none(LIST),
      'POST /api/displays': probes(
        notFound((x) =>
          as('POST', '/api/displays', {
            siteId: x.siteId,
            name: 'planted',
            canvas: { width: 640, height: 360 },
          }),
        ),
      ),
      'GET /api/displays/status': none(LIST),
      'GET /api/displays/:id': probes(notFound((x) => as('GET', `/api/displays/${x.displayId}`))),
      'PATCH /api/displays/:id': probes(
        notFound((x) => as('PATCH', `/api/displays/${x.displayId}`, { name: 'taken' })),
        notFound((x) =>
          as('PATCH', `/api/displays/${b.displayId}`, { assignedPlaylistId: x.playlistId }),
        ),
        notFound((x) =>
          as('PATCH', `/api/displays/${b.displayId}`, { assignedScheduleId: x.scheduleId }),
        ),
        notFound((x) =>
          as('PATCH', `/api/displays/${b.displayId}`, { assignedLayoutId: x.layoutId }),
        ),
        notFound((x) => as('PATCH', `/api/displays/${b.displayId}`, { tagIds: [x.displayTagId] })),
      ),
      // A fresh code each time, so the display is what decides the answer.
      'POST /api/displays/:id/claim': probes(
        notFound(async (x) =>
          as('POST', `/api/displays/${x.displayId}/claim`, { code: (await newPairing(t)).code }),
        ),
      ),
      'POST /api/displays/:id/revoke-player': probes(
        notFound((x) => as('POST', `/api/displays/${x.displayId}/revoke-player`)),
      ),
      'GET /api/displays/:id/status': probes(
        notFound((x) => as('GET', `/api/displays/${x.displayId}/status`)),
      ),

      'GET /api/media': none(LIST),
      'POST /api/media': none('an upload carries a file and names no object'),
      'GET /api/media/:id': probes(notFound((x) => as('GET', `/api/media/${x.mediaId}`))),
      'PATCH /api/media/:id': probes(
        notFound((x) => as('PATCH', `/api/media/${x.mediaId}`, { name: 'taken' })),
        notFound((x) => as('PATCH', `/api/media/${b.mediaId}`, { folderId: x.folderId })),
        notFound((x) => as('PATCH', `/api/media/${b.mediaId}`, { tagIds: [x.mediaTagId] })),
      ),
      'DELETE /api/media/:id': probes(notFound((x) => as('DELETE', `/api/media/${x.mediaId}`))),
      'GET /api/media/:id/preview': probes(
        notFound((x) => as('GET', `/api/media/${x.mediaId}/preview`)),
      ),
      'GET /api/media/:id/thumbnail': probes(
        notFound((x) => as('GET', `/api/media/${x.mediaId}/thumbnail`)),
      ),
      'GET /api/media/:id/usage': probes(
        notFound((x) => as('GET', `/api/media/${x.mediaId}/usage`)),
      ),

      'GET /api/apps': none(LIST),
      'POST /api/apps': none('app content names no object (packages/contracts/src/app.ts)'),
      'GET /api/apps/:id': probes(notFound((x) => as('GET', `/api/apps/${x.appId}`))),
      'PATCH /api/apps/:id': probes(
        notFound((x) => as('PATCH', `/api/apps/${x.appId}`, { name: 'taken' })),
      ),
      'DELETE /api/apps/:id': probes(notFound((x) => as('DELETE', `/api/apps/${x.appId}`))),

      'GET /api/schedules': none(LIST),
      'POST /api/schedules': probes(
        invalid([PLAYLIST_NOT_FOUND('defaultPlaylistId')], (x) =>
          as('POST', '/api/schedules', {
            name: 'mine',
            defaultPlaylistId: x.playlistId,
            events: [],
          }),
        ),
        invalid([PLAYLIST_NOT_FOUND('events.0.playlistId')], (x) =>
          as('POST', '/api/schedules', {
            name: 'mine',
            defaultPlaylistId: b.playlistId,
            events: [scheduleEvent(x.playlistId)],
          }),
        ),
      ),
      'GET /api/schedules/:id': probes(
        notFound((x) => as('GET', `/api/schedules/${x.scheduleId}`)),
      ),
      'PUT /api/schedules/:id': probes(
        notFound((x) =>
          as('PUT', `/api/schedules/${x.scheduleId}`, {
            name: 'taken',
            defaultPlaylistId: b.playlistId,
            events: [],
          }),
        ),
        invalid([PLAYLIST_NOT_FOUND('defaultPlaylistId')], (x) =>
          as('PUT', `/api/schedules/${b.scheduleId}`, {
            name: 'mine',
            defaultPlaylistId: x.playlistId,
            events: [],
          }),
        ),
        invalid([PLAYLIST_NOT_FOUND('events.0.playlistId')], (x) =>
          as('PUT', `/api/schedules/${b.scheduleId}`, {
            name: 'mine',
            defaultPlaylistId: b.playlistId,
            events: [scheduleEvent(x.playlistId)],
          }),
        ),
      ),
      'DELETE /api/schedules/:id': probes(
        notFound((x) => as('DELETE', `/api/schedules/${x.scheduleId}`)),
      ),

      'GET /api/layouts': none(LIST),
      'POST /api/layouts': probes(
        invalid([PLAYLIST_NOT_FOUND('zones.0.playlistId')], (x) =>
          as('POST', '/api/layouts', {
            name: 'mine',
            zones: layoutZones(x.playlistId, b.playlistId),
          }),
        ),
        invalid([PLAYLIST_NOT_FOUND('zones.1.playlistId')], (x) =>
          as('POST', '/api/layouts', {
            name: 'mine',
            zones: layoutZones(b.playlistId, x.playlistId),
          }),
        ),
      ),
      'GET /api/layouts/:id': probes(notFound((x) => as('GET', `/api/layouts/${x.layoutId}`))),
      'PUT /api/layouts/:id': probes(
        notFound((x) =>
          as('PUT', `/api/layouts/${x.layoutId}`, {
            name: 'taken',
            zones: layoutZones(b.playlistId, b.playlistId),
          }),
        ),
        invalid([PLAYLIST_NOT_FOUND('zones.0.playlistId')], (x) =>
          as('PUT', `/api/layouts/${b.layoutId}`, {
            name: 'mine',
            zones: layoutZones(x.playlistId, b.playlistId),
          }),
        ),
        invalid([PLAYLIST_NOT_FOUND('zones.1.playlistId')], (x) =>
          as('PUT', `/api/layouts/${b.layoutId}`, {
            name: 'mine',
            zones: layoutZones(b.playlistId, x.playlistId),
          }),
        ),
      ),
      'DELETE /api/layouts/:id': probes(
        notFound((x) => as('DELETE', `/api/layouts/${x.layoutId}`)),
      ),

      'GET /api/tags': none(LIST),
      'POST /api/tags': none(LIST),
      'PATCH /api/tags/:id': probes(
        notFound((x) => as('PATCH', `/api/tags/${x.mediaTagId}`, { name: 'taken' })),
        notFound((x) => as('PATCH', `/api/tags/${x.displayTagId}`, { name: 'taken' })),
      ),
      'DELETE /api/tags/:id': probes(
        notFound((x) => as('DELETE', `/api/tags/${x.mediaTagId}`)),
        notFound((x) => as('DELETE', `/api/tags/${x.displayTagId}`)),
      ),

      'GET /api/folders': none(LIST),
      'POST /api/folders': none(LIST),
      'PATCH /api/folders/:id': probes(
        notFound((x) => as('PATCH', `/api/folders/${x.folderId}`, { name: 'taken' })),
      ),
      'DELETE /api/folders/:id': probes(
        notFound((x) => as('DELETE', `/api/folders/${x.folderId}`)),
      ),

      'GET /api/playlists': none(LIST),
      'POST /api/playlists': none(LIST),
      'GET /api/playlists/:id': probes(
        notFound((x) => as('GET', `/api/playlists/${x.playlistId}`)),
      ),
      'PUT /api/playlists/:id': probes(
        notFound((x) => as('PUT', `/api/playlists/${x.playlistId}`, { name: 'taken', items: [] })),
        invalid([{ path: 'items[0]', code: 'media_missing' }], (x) =>
          as('PUT', `/api/playlists/${b.playlistId}`, {
            name: 'mine',
            items: [{ mediaId: x.mediaId, durationMs: 5000, fit: null }],
          }),
        ),
        invalid([{ path: 'items[0]', code: 'app_missing' }], (x) =>
          as('PUT', `/api/playlists/${b.playlistId}`, {
            name: 'mine',
            items: [{ appId: x.appId, durationMs: 5000 }],
          }),
        ),
      ),
      'DELETE /api/playlists/:id': probes(
        notFound((x) => as('DELETE', `/api/playlists/${x.playlistId}`)),
      ),
      'POST /api/playlists/:id/duplicate': probes(
        notFound((x) => as('POST', `/api/playlists/${x.playlistId}/duplicate`)),
      ),
      'POST /api/playlists/:id/publish': probes(
        notFound((x) =>
          as('POST', `/api/playlists/${x.playlistId}/publish`, { displayId: b.displayId }),
        ),
        notFound((x) =>
          as('POST', `/api/playlists/${b.playlistId}/publish`, { displayId: x.displayId }),
        ),
      ),

      'GET /api/push': none(LIST),
      'POST /api/push': probes(
        notFound((x) => as('POST', '/api/push', { displayIds: [x.displayId] })),
        notFound((x) => as('POST', '/api/push', { displayIds: [b.displayId, x.displayId] })),
      ),
      'GET /api/overview': none(LIST),
      'GET /api/audit': none('its filters are a category, a result and a page; no object'),

      'GET /api/members': none(LIST),
      'GET /api/members/names': none(LIST),
      'PATCH /api/members/:id': probes(
        notFound((x) => as('PATCH', `/api/members/${x.memberId}`, { displayName: 'Taken' })),
        notFound((x) => as('PATCH', `/api/members/${x.memberId}`, { role: 'viewer' })),
      ),
      'POST /api/members/:id/remove': probes(
        notFound((x) => as('POST', `/api/members/${x.memberId}/remove`)),
      ),
      'POST /api/members/:id/sign-out': probes(
        notFound((x) => as('POST', `/api/members/${x.memberId}/sign-out`)),
      ),
      'GET /api/invites': none(LIST),
      'POST /api/invites': none('an invite names a person by e-mail address, not an object'),
      'POST /api/invites/:id/cancel': probes(
        notFound((x) => as('POST', `/api/invites/${x.inviteId}/cancel`)),
      ),
      'GET /api/alert-recipients': none(LIST),
      'POST /api/alert-recipients': none(LIST),
      'DELETE /api/alert-recipients/:id': probes(
        notFound((x) => as('DELETE', `/api/alert-recipients/${x.recipientId}`)),
      ),

      'GET /healthz': none(NO_ORG),
      'GET /readyz': none(NO_ORG),
      'GET /api/auth/login': none(NO_ORG),
      'GET /api/auth/callback': none('a login state and a provider code, not an object'),
      'GET /api/session': none('the caller’s own session'),
      'POST /api/auth/logout': none('the caller’s own session'),
      'POST /api/alert-recipients/confirm': none('a confirmation token, not an id'),

      'POST /player/pairing': none(NO_ORG),
      'GET /player/pairing/:id': probes(
        notFound((x) =>
          fetch(`${t.url}/player/pairing/${x.pairingId}`, {
            headers: { authorization: `Bearer ${bPolling.pollingToken}` },
          }),
        ),
      ),
      'DELETE /player/registration': none('the device credential names the registration'),
      'GET /player/manifest': none('the device credential names the display'),
      'POST /player/media-urls': probes(
        notFound((x) => requestMediaUrls(t, player, x.publicationId, [b.mediaId])),
        notFound((x) => requestMediaUrls(t, player, b.publicationId, [x.mediaId])),
      ),
      'GET /player/media/:assetId': probes(
        // A valid address of B's player with the asset swapped: the signature no longer holds.
        [
          'url_signature_invalid',
          async (x) => {
            const issued = (await (
              await requestMediaUrls(t, player, b.publicationId, [b.mediaId])
            ).json()) as { urls: { url: string }[] };
            const url = new URL(issued.urls[0]?.url ?? '');
            return fetch(`${t.url}${url.pathname.replace(b.mediaId, x.mediaId)}${url.search}`);
          },
        ],
        // Signed by the server (which only signs the current publication's assets, so no client
        // can make these): the lookup behind the signature still finds nothing of A's.
        // The `reg` claim is not probed: like the device token it stands for, it is the
        // credential that names the organisation, not an object asked for under one. A's live
        // registration makes the request A's (so B's publication then answers 404), and one never
        // issued answers 401 device_revoked (docs/player-protocol-v1.md section 6, check 3). Only
        // a holder of the signing secret can put either in a URL.
        notFound((x) =>
          fetch(
            signedMediaUrl(t, {
              registrationId: player.registrationId,
              publicationId: b.publicationId,
              assetId: x.mediaId,
            }),
          ),
        ),
        notFound((x) =>
          fetch(
            signedMediaUrl(t, {
              registrationId: player.registrationId,
              publicationId: x.publicationId,
              assetId: b.mediaId,
            }),
          ),
        ),
      ),
      'POST /player/heartbeat': probes(
        ['forbidden', (x) => sendHeartbeat(t, player, heartbeatBody(x.displayId, 2_000_000))],
        [
          'conflict',
          (x) =>
            sendHeartbeat(
              t,
              player,
              heartbeatBody(b.displayId, 2_000_000, {
                downloadedPublicationId: x.publicationId,
                activePublicationId: x.publicationId,
                activeItemIndex: 0,
                playerState: 'playing',
              }),
            ),
        ],
      ),
    };

    // Every registered route has a case, and every case a registered route.
    const routes = registeredRoutes(t.app);
    const gaps = [
      ...routes
        .filter((route) => !Object.hasOwn(cases, route))
        .map(
          (route) =>
            `No cross-organisation case for ${route}: add one to the cases of this test, a probe for each id the route takes in its path or body, or none(reason) when it takes none`,
        ),
      ...Object.keys(cases)
        .filter((route) => !routes.includes(route))
        .map((route) => `The cross-organisation case for ${route} matches no registered route`),
      ...Object.entries(cases)
        .filter(([route, c]) => 'none' in c && route.includes('/:'))
        .map(([route]) => `${route} takes an id in its path: give it a probe, not none()`),
    ];
    expect(gaps).toEqual([]);

    /** Status and body, without the request id: everything else must not depend on the id. */
    const answerOf = async (response: Response): Promise<{ status: number; body: unknown }> => {
      const text = await response.text();
      let body: unknown = text;
      try {
        const parsed = JSON.parse(text) as { error?: Record<string, unknown> };
        body =
          parsed.error === undefined ? parsed : { error: { ...parsed.error, requestId: null } };
      } catch {
        // Not JSON: compared as text.
      }
      return { status: response.status, body };
    };
    const wrong: string[] = [];
    let probed = 0;
    for (const [route, c] of Object.entries(cases)) {
      if ('none' in c) continue;
      for (const [index, [code, send, details]] of c.probes.entries()) {
        probed += 1;
        const what = `${route} probe ${index + 1}`;
        const real = await answerOf(await send(foreign));
        const none = await answerOf(await send(unknown));
        if (JSON.stringify(real) !== JSON.stringify(none)) {
          wrong.push(
            `${what}: another organisation's id answered ${JSON.stringify(real)}, an unknown id ${JSON.stringify(none)}`,
          );
        }
        const error = (real.body as { error?: { code?: string; details?: Detail[] } }).error;
        if (real.status !== ERROR_STATUS[code] || error?.code !== code) {
          wrong.push(`${what}: answered ${real.status} ${String(error?.code)}, expected ${code}`);
        }
        if (details !== undefined) {
          // Each expected detail names the keys it checks; the answer carries those and no more.
          const given = (error?.details ?? []).map((detail, n) =>
            Object.fromEntries(Object.keys(details[n] ?? {}).map((key) => [key, detail[key]])),
          );
          if (JSON.stringify(given) !== JSON.stringify(details)) {
            wrong.push(
              `${what}: details ${JSON.stringify(error?.details)}, expected ${JSON.stringify(details)}`,
            );
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(probed).toBeGreaterThan(60);

    // Nothing of A's was changed by the probes, and A's pairing is still waiting for its player.
    expect((await alice.fetch(`/api/displays/${a.displayId}`)).status).toBe(200);
    expect((await fetch(`${t.url}/player/manifest`, { headers: a.player.headers })).status).toBe(
      200,
    );
  });

  it('holds at the database: the runtime role sees nothing without a context and only its own rows with one', async () => {
    // Both organisations have a row in every tenant table, heartbeat log included, and an open
    // alert episode once both screens have been silent past the 30-minute default.
    expect((await sendHeartbeat(t, b.player, heartbeatBody(b.displayId, Date.now()))).status).toBe(
      200,
    );
    t.advanceClock(31 * 60 * 1000);
    try {
      expect((await checkAlerts(t)).failed).toBe(0);
    } finally {
      t.advanceClock(-31 * 60 * 1000);
    }
    const client = await appClient('asks the database what the runtime role can read');
    try {
      const role = await client.query<{ current_user: string; bypass: boolean; super: boolean }>(
        'SELECT current_user, rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = current_user',
      );
      expect(role.rows[0]).toEqual({ current_user: 'tinnox_app', bypass: false, super: false });

      // Every table the runtime role can read, asked of the database: a typed list once left
      // `app` out. packages/db/test/catalogue.integration.test.ts holds that these are exactly
      // the tenant tables.
      const readable = await client.query<{ name: string }>(
        `SELECT c.oid::regclass::text AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
           AND (has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT'))
         ORDER BY 1`,
      );
      const tables = readable.rows.map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(['organization', 'app', 'audit_event']));

      // No WHERE clause anywhere below: only the policies decide what comes back.
      for (const table of tables) {
        const none = await client.query(`SELECT * FROM ${table}`);
        expect(none.rowCount, `${table} without context`).toBe(0);
      }
      for (const [mine, theirs] of [
        [orgA, orgB],
        [orgB, orgA],
      ] as const) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.org_id', $1, true)", [mine.orgId]);
        for (const table of tables) {
          const column = table === 'organization' ? 'id' : 'org_id';
          const rows = await client.query<{ org: string }>(`SELECT ${column} AS org FROM ${table}`);
          expect(rows.rowCount, `${table} for its own organisation`).toBeGreaterThan(0);
          expect(
            rows.rows.every((row) => row.org === mine.orgId),
            table,
          ).toBe(true);
          expect(
            rows.rows.some((row) => row.org === theirs.orgId),
            table,
          ).toBe(false);
        }
        // Writes aimed at the other organisation's rows touch nothing.
        const update = await client.query("UPDATE playlist SET name = 'taken'");
        expect(update.rowCount).toBeGreaterThan(0);
        const names = await client.query<{ org_id: string }>('SELECT org_id FROM playlist');
        expect(names.rows.every((row) => row.org_id === mine.orgId)).toBe(true);
        await client.query('ROLLBACK');
      }
      // After the transactions the connection has no context again.
      expect((await client.query('SELECT * FROM display')).rowCount).toBe(0);
    } finally {
      await client.end();
    }
    // The other organisation's playlist names were not touched by the unfiltered UPDATE.
    const playlistA = (await (await alice.fetch(`/api/playlists/${a.playlistId}`)).json()) as {
      name: string;
    };
    expect(playlistA.name).toBe('Test playlist');
  });
});
