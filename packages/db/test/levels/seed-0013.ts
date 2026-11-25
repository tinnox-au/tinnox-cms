// Level 0013, roles and members: two organisations as the 0013 code creates them, each with an
// Owner and a display, the first also with a named Editor and a pending invite request.
// migration-0014.integration.test.ts starts from this level and reads these rows.
import { id, inOrg, type Seeder, type SqlClient } from './sql.ts';

const L = '0013';

const org = (n: number) => ({
  org: id(L, n),
  site: id(L, n + 1),
  owner: id(L, n + 2),
  display: id(L, n + 3),
});

export const BEFORE_ALERTS_A = { ...org(10), editor: id(L, 15), invite: id(L, 16) } as const;
export const BEFORE_ALERTS_B = org(20);

export const INVITE_EMAIL = 'new.viewer@example.com';

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  for (const [o, name] of [
    [BEFORE_ALERTS_A, 'Before alerts A'],
    [BEFORE_ALERTS_B, 'Before alerts B'],
  ] as const) {
    await inOrg(client, o.org, async () => {
      await q('INSERT INTO organization (id, name) VALUES ($1, $2)', [o.org, name]);
      await q(
        "INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, $3, 'Australia/Melbourne')",
        [o.site, o.org, `${name} site`],
      );
      await q("INSERT INTO membership (id, org_id, oidc_sub, role) VALUES ($1, $2, $3, 'owner')", [
        o.owner,
        o.org,
        `level-0013-${o.owner}`,
      ]);
      await q(
        'INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height) VALUES ($1, $2, $3, $4, 1920, 1080)',
        [o.display, o.org, o.site, `${name} display`],
      );
    });
  }
  await inOrg(client, BEFORE_ALERTS_A.org, async () => {
    await q(
      "INSERT INTO membership (id, org_id, oidc_sub, role, display_name) VALUES ($1, $2, $3, 'editor', 'Level 0013 Editor')",
      [BEFORE_ALERTS_A.editor, BEFORE_ALERTS_A.org, `level-0013-${BEFORE_ALERTS_A.editor}`],
    );
    await q(
      `INSERT INTO member_invite (id, org_id, role, name, email, invited_by, expires_at)
       VALUES ($1, $2, 'viewer', 'New Viewer', $3, $4, now() + interval '7 days')`,
      [BEFORE_ALERTS_A.invite, BEFORE_ALERTS_A.org, INVITE_EMAIL, BEFORE_ALERTS_A.owner],
    );
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    'two organisations with an Owner and a display each; in the first, a named Editor and a pending invite request',
  seed,
};
