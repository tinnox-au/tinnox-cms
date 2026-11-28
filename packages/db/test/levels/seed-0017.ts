// Level 0017, a screen can be deleted: a deleted display, never paired, in 0013's second
// organisation. Its row stays, with deleted_at set and nothing assigned, as the delete leaves it.
import { id, inOrg, type Seeder, type SqlClient } from './sql.ts';
import { BEFORE_ALERTS_B } from './seed-0013.ts';

const L = '0017';

export const DELETED_DISPLAY = id(L, 1);

async function seed(client: SqlClient): Promise<void> {
  await inOrg(client, BEFORE_ALERTS_B.org, async () => {
    await client.query(
      `INSERT INTO display (id, org_id, site_id, name, canvas_width, canvas_height, deleted_at)
       VALUES ($1, $2, $3, 'Level 0017 deleted', 1920, 1080, now())`,
      [DELETED_DISPLAY, BEFORE_ALERTS_B.org, BEFORE_ALERTS_B.site],
    );
  });
}

export const seeder: Seeder = {
  level: L,
  plants: "a deleted display, never paired, in 0013's second organisation",
  seed,
};
