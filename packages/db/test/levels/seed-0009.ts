// Level 0009, stage B schedules: a schedule with one event, assigned to the display that was
// never published (a display has a playlist or a schedule, never both).
import { id, inOrg, type Seeder, type SqlClient } from './sql.ts';
import { A as A4 } from './seed-0004.ts';

const L = '0009';

export const A = { schedule: id(L, 1) } as const;
export const WEEKDAYS = [true, true, true, true, true, false, false];

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  await inOrg(client, A4.org, async () => {
    await q(
      "INSERT INTO schedule (id, org_id, name, default_playlist_id) VALUES ($1, $2, 'Level 0009 schedule', $3)",
      [A.schedule, A4.org, A4.playlist1],
    );
    await q(
      `INSERT INTO schedule_event (schedule_id, position, org_id, playlist_id, days, start_time, end_time)
       VALUES ($1, 0, $2, $3, $4, '09:00', '17:00')`,
      [A.schedule, A4.org, A4.playlist2, WEEKDAYS],
    );
    await q('UPDATE display SET assigned_schedule_id = $2 WHERE id = $1', [
      A4.neverPublished,
      A.schedule,
    ]);
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    "a schedule with a weekday event, assigned to the never-published display of 0004's organisation A",
  seed,
};
