// Level 0005, portal v2 stage A: the library gains folders and tags. In organisation A of level
// 0004 an operator files the image in a folder with a name, a description and a default duration,
// tags it and the published display, and describes the first playlist.
import { id, inOrg, type Seeder, type SqlClient } from './sql.ts';
import { A as A4 } from './seed-0004.ts';

const L = '0005';

export const A = {
  folder: id(L, 1),
  mediaTag: id(L, 2),
  displayTag: id(L, 3),
} as const;

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  await inOrg(client, A4.org, async () => {
    await q("INSERT INTO folder (id, org_id, name) VALUES ($1, $2, 'Level 0005 folder')", [
      A.folder,
      A4.org,
    ]);
    await q(
      `INSERT INTO tag (id, org_id, scope, name, colour)
       VALUES ($1, $3, 'media', 'Level 0005 media', 'amber'), ($2, $3, 'display', 'Level 0005 lobby', 'teal')`,
      [A.mediaTag, A.displayTag, A4.org],
    );
    await q(
      `UPDATE media SET name = 'Pixel', description = 'One pixel, four times', folder_id = $2,
                        default_duration_ms = 8000
       WHERE id = $1`,
      [A4.media, A.folder],
    );
    await q('INSERT INTO media_tag (media_id, tag_id, org_id) VALUES ($1, $2, $3)', [
      A4.media,
      A.mediaTag,
      A4.org,
    ]);
    await q('INSERT INTO display_tag (display_id, tag_id, org_id) VALUES ($1, $2, $3)', [
      A4.published,
      A.displayTag,
      A4.org,
    ]);
    await q("UPDATE playlist SET description = 'The first playlist' WHERE id = $1", [A4.playlist1]);
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    'a folder, a media tag and a display tag in organisation A of 0004; its image named, described, filed and tagged; a display tagged; a playlist described',
  seed,
};
