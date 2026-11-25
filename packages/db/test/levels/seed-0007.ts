// Level 0007, stage B apps: an app, and a playlist item that plays it instead of media.
import { id, inOrg, type Seeder, type SqlClient } from './sql.ts';
import { A as A4 } from './seed-0004.ts';

const L = '0007';

export const A = { clock: id(L, 1) } as const;

export const CLOCK_SETTINGS = {
  hourCycle: '24',
  showSeconds: true,
  textColour: '#ffffff',
  backgroundColour: '#000000',
};

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  await inOrg(client, A4.org, async () => {
    await q(
      "INSERT INTO app (id, org_id, type, name, settings) VALUES ($1, $2, 'clock', 'Level 0007 clock', $3)",
      [A.clock, A4.org, JSON.stringify(CLOCK_SETTINGS)],
    );
    await q(
      'INSERT INTO playlist_item (org_id, playlist_id, position, app_id, duration_ms) VALUES ($1, $2, 0, $3, 10000)',
      [A4.org, A4.playlist2, A.clock],
    );
  });
}

export const seeder: Seeder = {
  level: L,
  plants: "a clock app, played by the second playlist of 0004's organisation A",
  seed,
};
