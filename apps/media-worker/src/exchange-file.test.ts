// CU-02: the worker's exchange helpers give a file its mode whatever the container's umask is.
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
});
