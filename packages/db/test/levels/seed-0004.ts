// Level 0004, the first level main stood at (0001 to 0004 merged together in 1c30f10; D13): an
// M0 installation. Two organisations; members as M0 created them (no role named, so 'operator')
// with the session rows their sign-ins left; one image, two playlists, and displays published
// once, published twice, never published and never reported, so 0005's backfill meets every case;
// a player paired through a completed pairing, with a heartbeat; a pending pairing; an audit trail.
import { asDefiner, bytes32, id, inOrg, type Seeder, type SqlClient } from './sql.ts';

const L = '0004';
/** A fixed instant in the past, so an accidental `updated_at = now()` is unmistakable. */
export const LONG_AGO = '2026-11-01T00:00:00.000Z';

export const A = {
  org: id(L, 1),
  site: id(L, 2),
  owner: id(L, 3),
  /** A member who never signed in. */
  second: id(L, 4),
  media: id(L, 5),
  playlist1: id(L, 6),
  playlist2: id(L, 7),
  /** Published once (playlist 1), with a paired player that reports. */
  published: id(L, 8),
  /** Published with playlist 1, then playlist 2, which is desired. */
  republished: id(L, 9),
  /** A delivery row, but nothing was ever published. */
  neverPublished: id(L, 10),
  publication1: id(L, 11),
  publication2: id(L, 12),
  publication3: id(L, 13),
  registration: id(L, 14),
  pairingCompleted: id(L, 15),
  /** The earliest sign-in of the owner: a session that ended. */
  ownerFirstSignIn: '2026-11-01T08:00:00.000Z',
  ownerLaterSignIn: '2026-11-02T08:00:00.000Z',
} as const;

export const B = {
  org: id(L, 21),
  site: id(L, 22),
  owner: id(L, 23),
  /** Created and left alone: no delivery row. */
  display: id(L, 24),
  ownerFirstSignIn: '2026-11-03T08:00:00.000Z',
} as const;

/** A player waiting for its code to be entered. */
export const PENDING_PAIRING = { id: id(L, 31), code: 'PNDG2345' } as const;

const SHA = 'ab'.repeat(32);

/** A version-1 manifest as the M0 API built it (the shape the current contracts still take). */
export function manifestOf(publicationId: string, displayId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    publicationId,
    displayId,
    createdAt: LONG_AGO,
    canvas: { width: 640, height: 360 },
    contentRect: null,
    muted: true,
    assets: [
      {
        assetId: A.media,
        mediaType: 'image/png',
        kind: 'image',
        bytes: 10,
        sha256: SHA,
        durationMs: 5000,
        fit: 'contain',
        width: 4,
        height: 4,
      },
    ],
  });
}

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  const display = (displayId: string, orgId: string, siteId: string, name: string) =>
    q(
      `INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 640, 360, $5, $5)`,
      [displayId, orgId, siteId, name, LONG_AGO],
    );
  // A publication and its asset row in one transaction, as publication_asset_guard requires.
  const publish = (publicationId: string, displayId: string, playlistId: string, n: number) =>
    q(
      `INSERT INTO publication (id, org_id, display_id, playlist_id, manifest, idempotency_key, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz + make_interval(mins => $9))`,
      [
        publicationId,
        A.org,
        displayId,
        playlistId,
        manifestOf(publicationId, displayId),
        `level-0004-publish-${n}`,
        A.owner,
        LONG_AGO,
        n,
      ],
    ).then(() =>
      q(
        'INSERT INTO publication_asset (publication_id, position, org_id, media_id) VALUES ($1, 0, $2, $3)',
        [publicationId, A.org, A.media],
      ),
    );

  await inOrg(client, A.org, async () => {
    await q('INSERT INTO organization (id, name) VALUES ($1, $2)', [A.org, 'Level 0004 A']);
    await q(
      "INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, 'Level 0004 A site', 'Australia/Melbourne')",
      [A.site, A.org],
    );
    await q('INSERT INTO membership (id, org_id, oidc_sub) VALUES ($1, $3, $4), ($2, $3, $5)', [
      A.owner,
      A.second,
      A.org,
      'level-0004-a-owner',
      'level-0004-a-second',
    ]);
    await q(
      `INSERT INTO media (id, org_id, kind, status, mime_type, bytes, sha256, width, height, storage_key, original_name, created_by)
       VALUES ($1, $2, 'image', 'ready', 'image/png', 10, $3, 4, 4, $4, 'pixel.png', $5)`,
      [A.media, A.org, SHA, `${A.org}/${id(L, 41)}`, A.owner],
    );
    await q('INSERT INTO playlist (id, org_id, name) VALUES ($1, $3, $4), ($2, $3, $5)', [
      A.playlist1,
      A.playlist2,
      A.org,
      'Level 0004 first',
      'Level 0004 second',
    ]);
    await q(
      'INSERT INTO playlist_item (org_id, playlist_id, position, media_id, duration_ms) VALUES ($1, $2, 0, $3, 5000)',
      [A.org, A.playlist1, A.media],
    );
    await display(A.published, A.org, A.site, 'Level 0004 published');
    await display(A.republished, A.org, A.site, 'Level 0004 republished');
    await display(A.neverPublished, A.org, A.site, 'Level 0004 never published');
    await publish(A.publication1, A.published, A.playlist1, 1);
    await publish(A.publication2, A.republished, A.playlist1, 2);
    await publish(A.publication3, A.republished, A.playlist2, 3);
    await q(
      `INSERT INTO player_registration (id, org_id, display_id, token_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [A.registration, A.org, A.published, bytes32('a1'), LONG_AGO],
    );
    await q(
      `INSERT INTO display_delivery (display_id, org_id, desired_publication_id, desired_at,
                                     reporting_registration_id, last_seq, downloaded_publication_id,
                                     active_publication_id, active_item_index, player_state, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, 7, $3, $3, 0, 'playing', $4),
              ($6, $2, $7, $4, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
              ($8, $2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [
        A.published,
        A.org,
        A.publication1,
        LONG_AGO,
        A.registration,
        A.republished,
        A.publication3,
        A.neverPublished,
      ],
    );
    await q(
      `INSERT INTO heartbeat_log (org_id, display_id, registration_id, seq, accepted, received_at, payload)
       VALUES ($1, $2, $3, 7, true, $4, '{"playerState":"playing"}')`,
      [A.org, A.published, A.registration, LONG_AGO],
    );
    await q(
      `INSERT INTO audit_event (org_id, actor_type, actor_id, action, object_type, object_id, result)
       VALUES ($1, 'operator', $2, 'playlist.create', 'playlist', $3, 'success'),
              ($1, 'operator', $2, 'publication.create', 'publication', $4, 'success'),
              ($1, 'operator', $2, 'publication.create', 'publication', $5, 'success'),
              ($1, 'operator', $2, 'publication.create', 'publication', $6, 'failure'),
              ($1, 'player', $7, 'pairing.complete', 'display', $8, 'success')`,
      [
        A.org,
        A.owner,
        A.playlist1,
        A.publication1,
        A.publication2,
        A.publication3,
        A.registration,
        A.published,
      ],
    );
  });

  await inOrg(client, B.org, async () => {
    await q('INSERT INTO organization (id, name) VALUES ($1, $2)', [B.org, 'Level 0004 B']);
    await q(
      "INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, 'Level 0004 B site', 'Europe/Berlin')",
      [B.site, B.org],
    );
    await q('INSERT INTO membership (id, org_id, oidc_sub) VALUES ($1, $2, $3)', [
      B.owner,
      B.org,
      'level-0004-b-owner',
    ]);
    await display(B.display, B.org, B.site, 'Level 0004 B alone');
    await q(
      `INSERT INTO audit_event (org_id, actor_type, actor_id, action, object_type, object_id, result)
       VALUES ($1, 'operator', $2, 'display.create', 'display', $3, 'success')`,
      [B.org, B.owner, B.display],
    );
  });

  // The rows only the sec.* functions write: sessions and pairings.
  await asDefiner(client, async () => {
    // A's owner: a session that ended an hour after it began, then one still live. B's owner:
    // one live session. A's second member never signed in.
    await q(
      `INSERT INTO public.session (id_hash, membership_id, org_id, oidc_sub, csrf_token, created_at,
                                   last_seen_at, expires_at, revoked_at)
       VALUES ($1, $4, $5, 'level-0004-a-owner', $9, $7::timestamptz, $7::timestamptz,
               $7::timestamptz + interval '8 hours', $7::timestamptz + interval '1 hour'),
              ($2, $4, $5, 'level-0004-a-owner', $9, $8::timestamptz, now(), now() + interval '8 hours', NULL),
              ($3, $6, $10, 'level-0004-b-owner', $9, $11::timestamptz, now(), now() + interval '8 hours', NULL)`,
      [
        bytes32('51'),
        bytes32('52'),
        bytes32('53'),
        A.owner,
        A.org,
        B.owner,
        A.ownerFirstSignIn,
        A.ownerLaterSignIn,
        'c'.repeat(43),
        B.org,
        B.ownerFirstSignIn,
      ],
    );
    await q(
      `INSERT INTO public.pairing_session (id, code, polling_token_hash, status, client_key, created_at,
                                           expires_at, claimed_at, claimed_by_membership, org_id,
                                           display_id, completed_at, registration_id)
       VALUES ($1, 'CMPT2345', $2, 'completed', 'level-0004-completed', $3, $3::timestamptz + interval '10 minutes',
               $3, $4, $5, $6, $3, $7),
              ($8, $9, $10, 'pending', 'level-0004-pending', now(), now() + interval '10 minutes',
               NULL, NULL, NULL, NULL, NULL, NULL)`,
      [
        A.pairingCompleted,
        bytes32('61'),
        LONG_AGO,
        A.owner,
        A.org,
        A.published,
        A.registration,
        PENDING_PAIRING.id,
        PENDING_PAIRING.code,
        bytes32('62'),
      ],
    );
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    'two M0 organisations: members without a role and their sessions, an image, two playlists, displays published once, twice and never, a paired player with a heartbeat, a pending pairing and an audit trail',
  seed,
};
