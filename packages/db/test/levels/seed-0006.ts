// Level 0006, stage B slice 1: playlists get a transition and shuffle, media an availability
// window, displays a rotation and working hours.
import { inOrg, type Seeder, type SqlClient } from './sql.ts';
import { A as A4 } from './seed-0004.ts';

const L = '0006';

/** Monday to Friday, eight to six; closed at the weekend. */
export const WORKING_HOURS = [
  { start: '08:00', end: '18:00' },
  { start: '08:00', end: '18:00' },
  { start: '08:00', end: '18:00' },
  { start: '08:00', end: '18:00' },
  { start: '08:00', end: '18:00' },
  null,
  null,
];
export const AVAILABLE_FROM = '2026-12-01 09:00:00';

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  await inOrg(client, A4.org, async () => {
    await q("UPDATE playlist SET transition = 'fade', shuffle = true WHERE id = $1", [
      A4.playlist2,
    ]);
    await q('UPDATE media SET available_from = $2 WHERE id = $1', [A4.media, AVAILABLE_FROM]);
    await q('UPDATE display SET rotation = 90, working_hours = $2 WHERE id = $1', [
      A4.republished,
      JSON.stringify(WORKING_HOURS),
    ]);
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    'a fading, shuffled playlist, an availability window on the image and a rotated display with working hours, in organisation A of 0004',
  seed,
};
