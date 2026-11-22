/**
 * The runner's name and duplicate checks (plan rows AG-4.1 and AG-4.6). They run before the
 * runner connects, so these cases need no database: the connection string points at a port
 * nothing listens on, and reaching it would fail with a different error.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationNameMessage, runMigrations, validateMigrationNames } from './migrate.ts';

const UNREACHABLE = 'postgres://tinnox_migrator@127.0.0.1:1/never_connected';

describe('validateMigrationNames', () => {
  it('accepts numbered, lower-case names', () => {
    expect(validateMigrationNames(['0001_schema.sql', '0002_security_functions.sql'])).toEqual([]);
  });

  it('reports a name that does not look like 0001_description.sql (AG-4.1)', () => {
    expect(
      validateMigrationNames(['0001_schema.sql', '2_short.sql', '0003_Upper.sql', '0004-dash.sql']),
    ).toEqual([
      { kind: 'pattern', name: '2_short.sql' },
      { kind: 'pattern', name: '0003_Upper.sql' },
      { kind: 'pattern', name: '0004-dash.sql' },
    ]);
  });

  it('reports the second file of a repeated number (AG-4.6)', () => {
    expect(
      validateMigrationNames(['0001_schema.sql', '0002_a.sql', '0002_b.sql', '0002_c.sql']),
    ).toEqual([
      { kind: 'duplicate', name: '0002_b.sql', number: '0002' },
      { kind: 'duplicate', name: '0002_c.sql', number: '0002' },
    ]);
  });

  it('keeps the runner wording', () => {
    expect(migrationNameMessage({ kind: 'pattern', name: 'x.sql' })).toBe(
      'migration file name must look like 0001_description.sql: x.sql',
    );
    expect(migrationNameMessage({ kind: 'duplicate', name: '0002_b.sql', number: '0002' })).toBe(
      'duplicate migration number 0002',
    );
  });
});

describe('runMigrations refuses a bad directory before it connects', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function withFiles(names: readonly string[]): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'tinnox-migrate-names-'));
    for (const name of names) await writeFile(join(directory, name), 'SELECT 1;\n');
    return directory;
  }

  it('refuses a badly named file', async () => {
    const dir = await withFiles(['0001_schema.sql', '0002_Bad.sql']);
    await expect(runMigrations({ connectionString: UNREACHABLE, directory: dir })).rejects.toThrow(
      'migration file name must look like 0001_description.sql: 0002_Bad.sql',
    );
  });

  it('refuses a repeated number', async () => {
    const dir = await withFiles(['0001_schema.sql', '0002_a.sql', '0002_b.sql']);
    await expect(runMigrations({ connectionString: UNREACHABLE, directory: dir })).rejects.toThrow(
      'duplicate migration number 0002',
    );
  });

  it('reports the first problem in file-name order', async () => {
    const dir = await withFiles(['0002_b.sql', '0001_x.sql', '0002_a.sql', '0003_Bad.sql']);
    await expect(runMigrations({ connectionString: UNREACHABLE, directory: dir })).rejects.toThrow(
      'duplicate migration number 0002',
    );
  });

  it('ignores a file that does not end in .sql, as it always has', async () => {
    // The runner skips it silently; check:migrations is what reports it.
    const dir = await withFiles(['0001_schema.sql', 'README.txt']);
    await expect(
      runMigrations({ connectionString: UNREACHABLE, directory: dir }),
    ).rejects.not.toThrow(/migration file name|duplicate migration number/);
  });
});
