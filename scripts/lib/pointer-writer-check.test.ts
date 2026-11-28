// The one writer of a display's desired publication (D10, P2-05; adoption plan step 33): the
// rules over literal text, then over every tracked file of the repository.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import {
  deliveryWrites,
  isScanned,
  POINTER_WRITER,
  pointerWriterProblems,
} from './pointer-writer-check.ts';

// The statements are put together here, so a reader of this file sees what the scan sees.
const TABLE = 'display_delivery';
const INSERT = `INSERT INTO ${TABLE}`;
const UPDATE = `UPDATE ${TABLE}`;

describe('deliveryWrites', () => {
  it('finds the heartbeat upsert and update, which leave the pointer alone', () => {
    const text = [
      'await tx.query(',
      `  \`${INSERT} (display_id, org_id) VALUES ($1, app_org_id())`,
      '   ON CONFLICT (display_id) DO NOTHING`,',
      ');',
      `await tx.query(\`${UPDATE} SET last_seq = $2, player_state = $3 WHERE display_id = $1\`);`,
    ].join('\n');
    expect(deliveryWrites(text).map(({ line, namesPointer }) => ({ line, namesPointer }))).toEqual([
      { line: 2, namesPointer: false },
      { line: 5, namesPointer: false },
    ]);
  });

  it.each([
    [
      'an upsert that sets it',
      `${INSERT} (display_id, org_id) VALUES ($1, $2) ON CONFLICT (display_id) DO UPDATE SET desired_publication_id = $3`,
    ],
    [
      'an INSERT that names it',
      `${INSERT} (display_id, org_id, desired_publication_id) VALUES ($1, $2, $3)`,
    ],
    ['an UPDATE of desired_at alone', `${UPDATE} SET desired_at = now() WHERE display_id = $1`],
    [
      'an UPDATE with ONLY and the schema',
      `UPDATE ONLY public.${TABLE} dd SET desired_publication_id = NULL`,
    ],
    ['a quoted table name', `UPDATE "${TABLE}" SET desired_publication_id = NULL`],
    ['lower case', `update ${TABLE} set desired_publication_id = null`],
    [
      'a MERGE',
      `MERGE INTO ${TABLE} d USING x ON true WHEN MATCHED THEN UPDATE SET desired_at = now()`,
    ],
    ['an INSERT with no column list', `${INSERT} SELECT * FROM old_delivery`],
    ['an INSERT ... VALUES with no column list', `${INSERT} VALUES ($1, $2, $3)`],
  ])('flags %s', (_what, statement) => {
    expect(deliveryWrites(`${statement};`)).toEqual([{ line: 1, statement, namesPointer: true }]);
  });

  it.each([
    [
      'a condition',
      `${UPDATE} SET active_publication_id = $2 WHERE display_id = $1 AND desired_publication_id = $2`,
    ],
    [
      'a RETURNING list',
      `${UPDATE} SET last_seq = $2 WHERE display_id = $1 RETURNING desired_publication_id, desired_at`,
    ],
    ['the value of an assignment', `${UPDATE} SET active_publication_id = desired_publication_id`],
    [
      'a subquery in a value',
      `${UPDATE} SET last_seq = (SELECT count(*) FROM x WHERE x.desired_at < now()), player_state = 'idle'`,
    ],
    [
      'an upsert condition',
      `${INSERT} (display_id, org_id) VALUES ($1, $2) ON CONFLICT (display_id) DO UPDATE SET last_seq = 0 WHERE ${TABLE}.desired_publication_id IS NULL`,
    ],
    ['a string', `${UPDATE} SET player_state = 'desired_at = now(), x' WHERE display_id = $1`],
  ])('leaves the pointer alone where it is only read: in %s', (_what, statement) => {
    expect(deliveryWrites(`${statement};`)).toEqual([{ line: 1, statement, namesPointer: false }]);
  });

  it.each([
    [
      'after a CASE in an earlier value',
      `${UPDATE} SET player_state = CASE WHEN last_seq > 0 THEN 'playing' ELSE 'idle' END, desired_at = now()`,
    ],
    [
      'after a subquery in an earlier value',
      `${UPDATE} SET last_seq = (SELECT 1 FROM x WHERE y), desired_publication_id = $2`,
    ],
    ['in a list of targets', `${UPDATE} SET (last_seq, desired_at) = (1, now())`],
    [
      'in the INSERT of a MERGE',
      `MERGE INTO ${TABLE} d USING x ON false WHEN NOT MATCHED THEN INSERT (display_id, desired_at) VALUES (x.id, now())`,
    ],
    [
      'a MERGE INSERT with no column list',
      `MERGE INTO ${TABLE} d USING x ON false WHEN MATCHED THEN UPDATE SET last_seq = 0 WHEN NOT MATCHED THEN INSERT VALUES (x.id)`,
    ],
    [
      'after a line comment with an apostrophe',
      `${UPDATE}\n  -- the screen's pointer\n  SET desired_publication_id = NULL WHERE display_id = $1`,
    ],
    [
      'after a block comment with an apostrophe',
      `${UPDATE} /* it's /* nested */ still it's */ SET desired_at = now()`,
    ],
    [
      'after a semicolon in a comment',
      `${UPDATE} SET last_seq = 1, -- reset; then\n  desired_at = now()`,
    ],
    ['after a semicolon in a string', `${UPDATE} SET player_state = 'a;b', desired_at = now()`],
  ])('flags the pointer where it is written: %s', (_what, statement) => {
    expect(deliveryWrites(`${statement};`)).toEqual([{ line: 1, statement, namesPointer: true }]);
  });

  it('reads no column out of a comment', () => {
    const statement = `${UPDATE} SET last_seq = 1, -- not desired_at\n  player_state = 'x' /* desired_publication_id = 1 */`;
    expect(deliveryWrites(`${statement};`)).toEqual([{ line: 1, statement, namesPointer: false }]);
  });

  it('ends a statement at its semicolon or the end of its template literal', () => {
    const text = `${UPDATE} SET last_seq = 1; SELECT desired_publication_id FROM ${TABLE};`;
    expect(deliveryWrites(text)).toEqual([
      { line: 1, statement: `${UPDATE} SET last_seq = 1`, namesPointer: false },
    ]);
    expect(deliveryWrites(`q(\`${UPDATE} SET last_seq = 1\`, ['desired_at'])`)).toEqual([
      { line: 1, statement: `${UPDATE} SET last_seq = 1`, namesPointer: false },
    ]);
  });

  it('ignores reads, other tables and a table whose name only begins the same', () => {
    expect(
      deliveryWrites(
        [
          `SELECT desired_publication_id FROM ${TABLE} WHERE display_id = $1;`,
          'UPDATE public.display d SET assigned_playlist_id = p.playlist_id',
          `  FROM public.${TABLE} dd WHERE dd.desired_publication_id = p.id;`,
          `UPDATE ${TABLE}_archive SET desired_at = now();`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('pointerWriterProblems', () => {
  const write = `${UPDATE} SET desired_publication_id = $2 WHERE display_id = $1;`;

  it(`allows the pointer in ${POINTER_WRITER} only`, () => {
    expect(pointerWriterProblems([{ path: POINTER_WRITER, text: write }])).toEqual([]);
  });

  it('names the file, the line and the one writer to use instead (D10)', () => {
    expect(
      pointerWriterProblems([{ path: 'apps/api/src/routes/displays.ts', text: `\n\n${write}` }]),
    ).toEqual([
      `apps/api/src/routes/displays.ts:3: this write on display_delivery names desired_publication_id or desired_at (or, an INSERT with no column list, could write them). Only createPublication in ${POINTER_WRITER} moves a display's pointer, in the transaction that inserts the publication it points to (D10, P2-05): reach it through publish or push (POST /api/playlists/:id/publish, POST /api/push), and leave the two columns out of every other write.`,
    ]);
  });

  it.each([
    'db/migrations/0018_reset_pointers.sql',
    'scripts/seed.ts',
    'scripts/revoke-all-sessions.sql',
    'packages/db/src/testing.ts',
    'infra/aws/rds-roles.sql',
    'scripts/backup-restore-check.sh',
  ])('flags a migration, a sec.* function, the seed and the other tools: %s', (path) => {
    expect(pointerWriterProblems([{ path, text: write }])).toHaveLength(1);
  });

  it.each([
    'apps/api/test/support.ts',
    'packages/db/test/support.ts',
    'tests/integration/backup-restore-check.test.ts',
    'tests/e2e/15-alerts.spec.ts',
    'apps/api/src/publishing.test.ts',
    'docs/player-protocol-v1.md',
  ])('leaves test code and prose alone: %s', (path) => {
    expect(isScanned(path)).toBe(false);
    expect(pointerWriterProblems([{ path, text: write }])).toEqual([]);
  });
});

describe('the repository', () => {
  // Tracked files and new files that are not ignored, as check:docs lists them.
  const paths = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .stdout.split('\0')
    .filter((path) => path !== '' && isScanned(path) && existsSync(join(repoRoot, path)));
  const files = paths.map((path) => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }));

  it('names the desired pointer in a write on display_delivery in publishing.ts only (D10)', () => {
    expect(pointerWriterProblems(files)).toEqual([]);
  });

  it('reads the files that write display_delivery: the one writer, and the heartbeat that leaves the pointer alone', () => {
    const writes = (path: string) => deliveryWrites(files.find((f) => f.path === path)?.text ?? '');
    expect(writes(POINTER_WRITER).map((w) => w.namesPointer)).toEqual([true]);
    const heartbeat = writes('apps/api/src/routes/player.ts');
    expect(heartbeat.length).toBeGreaterThan(0);
    expect(heartbeat.every((w) => !w.namesPointer)).toBe(true);
    // Migrations and the seed are read too.
    expect(paths).toContain('db/migrations/0001_schema.sql');
    expect(paths).toContain('scripts/seed.ts');
  });
});
