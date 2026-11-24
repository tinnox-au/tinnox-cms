// CU-02: the worker's exchange helpers give a file its mode whatever the container's umask is.
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishExchangeFile, writeExchangeFile } from './exchange-file.ts';

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777;

describe('exchange files (CU-02)', () => {
  let dir = '';
  let previousUmask = 0;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'exchange-file-'));
    previousUmask = process.umask(0o077);
  });
  afterAll(async () => {
    process.umask(previousUmask);
    await rm(dir, { recursive: true, force: true });
  });

  it('publishes a verdict readable by the API, with no temp file left', async () => {
    const final = join(dir, 'job.json');
    await publishExchangeFile(join(dir, '.job.tmp'), final, Buffer.from('{"a":1}'));
    expect(await modeOf(final)).toBe(0o644);
    await expect(stat(join(dir, '.job.tmp'))).rejects.toThrow();
  });

  it('writes a marker in place readable by the API', async () => {
    const marker = join(dir, 'marker');
    await writeExchangeFile(marker, '1');
    expect(await modeOf(marker)).toBe(0o644);
  });

  it('rewrites a marker that is already there without touching its mode', async () => {
    // A marker left by another uid is writable but not the worker's to chmod (EPERM on Linux).
    const marker = join(dir, 'left-by-another');
    await writeFile(marker, '');
    await chmod(marker, 0o666);
    await writeExchangeFile(marker, '2');
    expect(await readFile(marker, 'utf8')).toBe('2');
    expect(await modeOf(marker)).toBe(0o666);
  });
});
