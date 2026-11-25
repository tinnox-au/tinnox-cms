// Level 0011, stage B layouts: a layout with two zones. And the pairing sessions 0012 was
// written for (security review round 3, SCX-01): before 0010, revoking a screen's player or
// claiming the screen again left older claims in place, and an installation upgraded to 0011
// still holds them. They are written straight into the table, as code from before 0010 could
// leave them, next to sessions in every other state. migration-0012.integration.test.ts starts
// from this level and reads these rows.
import { asDefiner, bytes32, id, inOrg, type Seeder, type SqlClient } from './sql.ts';
import { A as A4 } from './seed-0004.ts';

const L = '0011';

export const LAYOUT = id(L, 1);

/** An organisation as the code before 0013 created it: one site, one member ('operator'), one display. */
export interface LevelOrg {
  readonly org: string;
  readonly site: string;
  readonly member: string;
  readonly display: string;
}

const org = (n: number): LevelOrg => ({
  org: id(L, n),
  site: id(L, n + 1),
  member: id(L, n + 2),
  display: id(L, n + 3),
});

/** A screen that never had a player, with two claims at once: possible only before 0010. */
export const UPGRADE_A = org(10);
/** In another organisation: a screen with one claim, and one that lapsed uncollected. */
export const UPGRADE_B = org(20);
/** A screen with a paired player. */
export const UPGRADE_C = org(30);

export interface LevelPairing {
  readonly id: string;
  readonly code: string;
  /** SQL hex of the polling token's hash, as bytes32 writes it. */
  readonly pollingTokenHash: string;
}

const pairing = (n: number, code: string, hexPair: string): LevelPairing => ({
  id: id(L, n),
  code,
  pollingTokenHash: bytes32(hexPair),
});

export const PAIRINGS = {
  firstOfTwo: pairing(41, 'FRST2345', '71'),
  // Longer than the default code lifetime of ten minutes: the lifetime is configurable.
  secondOfTwo: pairing(42, 'SCND2345', '72'),
  otherOrg: pairing(43, 'THRG2345', '73'),
  lapsed: pairing(44, 'XPRD2345', '74'),
  pending: pairing(45, 'WTNG2345', '75'),
  locked: pairing(46, 'KCKD2345', '76'),
  completed: pairing(47, 'DNPR2345', '77'),
} as const;

/** The registration the completed pairing handed out, and its token's hash. */
export const COMPLETED_REGISTRATION = { id: id(L, 48), tokenHash: bytes32('78') } as const;

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  await inOrg(client, A4.org, async () => {
    await q("INSERT INTO layout (id, org_id, name) VALUES ($1, $2, 'Level 0011 layout')", [
      LAYOUT,
      A4.org,
    ]);
    await q(
      `INSERT INTO layout_zone (layout_id, position, org_id, playlist_id, x_bp, y_bp, width_bp, height_bp)
       VALUES ($1, 0, $2, $3, 0, 0, 10000, 8500), ($1, 1, $2, $4, 0, 8500, 10000, 1500)`,
      [LAYOUT, A4.org, A4.playlist1, A4.playlist2],
    );
  });

  for (const [o, name] of [
    [UPGRADE_A, 'Upgrade A'],
    [UPGRADE_B, 'Upgrade B'],
    [UPGRADE_C, 'Upgrade C'],
  ] as const) {
    await inOrg(client, o.org, async () => {
      await q('INSERT INTO organization (id, name) VALUES ($1, $2)', [o.org, name]);
      await q(
        "INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, $3, 'Australia/Melbourne')",
        [o.site, o.org, `${name} site`],
      );
      await q('INSERT INTO membership (id, org_id, oidc_sub) VALUES ($1, $2, $3)', [
        o.member,
        o.org,
        `level-0011-${o.member}`,
      ]);
      await q(
        'INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height) VALUES ($1, $2, $3, $4, 640, 1344)',
        [o.display, o.org, o.site, `${name} display`],
      );
    });
  }
  await inOrg(client, UPGRADE_C.org, async () => {
    await q(
      'INSERT INTO player_registration (id, org_id, display_id, token_hash) VALUES ($1, $2, $3, $4)',
      [
        COMPLETED_REGISTRATION.id,
        UPGRADE_C.org,
        UPGRADE_C.display,
        COMPLETED_REGISTRATION.tokenHash,
      ],
    );
  });

  await asDefiner(client, async () => {
    const insert = (
      p: LevelPairing,
      status: string,
      claim: { readonly o: LevelOrg; readonly expiresIn: string } | null,
    ) =>
      q(
        `INSERT INTO public.pairing_session (id, code, polling_token_hash, status, client_key, expires_at,
                                             claimed_at, claimed_by_membership, org_id, display_id)
         VALUES ($1, $2, $3, $4, $5, now() + $6::interval,
                 CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END, $8, $7, $9)`,
        [
          p.id,
          p.code,
          p.pollingTokenHash,
          status,
          `client-${p.code}`,
          claim?.expiresIn ?? '10 minutes',
          claim?.o.org ?? null,
          claim?.o.member ?? null,
          claim?.o.display ?? null,
        ],
      );
    await insert(PAIRINGS.firstOfTwo, 'claimed', { o: UPGRADE_A, expiresIn: '5 minutes' });
    await insert(PAIRINGS.secondOfTwo, 'claimed', { o: UPGRADE_A, expiresIn: '50 minutes' });
    await insert(PAIRINGS.otherOrg, 'claimed', { o: UPGRADE_B, expiresIn: '5 minutes' });
    await insert(PAIRINGS.lapsed, 'claimed', { o: UPGRADE_B, expiresIn: '-1 minute' });
    await insert(PAIRINGS.pending, 'pending', null);
    await insert(PAIRINGS.locked, 'locked', null);
    await q(
      `INSERT INTO public.pairing_session (id, code, polling_token_hash, status, client_key, expires_at,
                                           claimed_at, claimed_by_membership, org_id, display_id,
                                           completed_at, registration_id)
       VALUES ($1, $2, $3, 'completed', $4, now() + interval '10 minutes', now(), $5, $6, $7, now(), $8)`,
      [
        PAIRINGS.completed.id,
        PAIRINGS.completed.code,
        PAIRINGS.completed.pollingTokenHash,
        `client-${PAIRINGS.completed.code}`,
        UPGRADE_C.member,
        UPGRADE_C.org,
        UPGRADE_C.display,
        COMPLETED_REGISTRATION.id,
      ],
    );
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    "a two-zone layout in 0004's organisation A; three organisations with pairing sessions in every state, among them claims from before 0010 that could still complete",
  seed,
};
