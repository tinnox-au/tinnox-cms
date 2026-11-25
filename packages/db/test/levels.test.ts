// The level list of the migrate-forward chain and its seeder check (D13), without a database: a
// migration added without a seeder fails here in the unit project, before the integration job.
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SEEDERS, releasedLevels, seederOf, seederProblems } from './levels.ts';

describe('the levels of the migrate-forward chain (D13)', () => {
  it('are 0004 and every later migration file, in order', () => {
    expect(
      releasedLevels([
        '0003_api_lookups.sql',
        '0005_b.sql',
        '0004_a.sql',
        'README.md',
        '0017_probe.sql',
      ]),
    ).toEqual([
      { level: '0004', file: '0004_a.sql' },
      { level: '0005', file: '0005_b.sql' },
      { level: '0017', file: '0017_probe.sql' },
    ]);
  });

  it('refuses a level without a seeder, saying where to add it and what a no-op seeder looks like', () => {
    const [problem, ...rest] = seederProblems(releasedLevels(['0004_a.sql', '0017_probe.sql']), [
      'sql.ts',
      'seed-0004.ts',
    ]);
    expect(rest).toEqual([]);
    expect(problem).toContain('db/migrations/0017_probe.sql is level 0017');
    expect(problem).toContain('Add packages/db/test/levels/seed-0017.ts');
    expect(problem).toContain("reason: 'only replaces sec.example(); no table or column changes'");
  });

  it('refuses a seeder whose level has no migration file', () => {
    expect(
      seederProblems(releasedLevels(['0004_a.sql']), ['seed-0004.ts', 'seed-0099.ts']),
    ).toEqual([expect.stringContaining('levels/seed-0099.ts seeds level 0099')]);
  });

  it('finds a seeder for every file of db/migrations today, each naming its level', async () => {
    const levels = releasedLevels(await readdir(MIGRATIONS));
    expect(seederProblems(levels, await readdir(SEEDERS))).toEqual([]);
    for (const { level } of levels) {
      const seeder = await seederOf(level);
      expect('seed' in seeder ? seeder.plants : seeder.reason, level).not.toBe('');
    }
  });
});
