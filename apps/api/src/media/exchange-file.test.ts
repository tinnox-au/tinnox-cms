// CU-02: the exchange helpers give a file its mode whatever the umask is. A umask of 077 would
// turn writeFile's 0644 into 0600, which the worker (another uid) could not read.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExchangeWriteStream,
  makeExchangeDir,
  publishExchangeFile,
  shareExchangeFile,
  writeExchangeFile,
} from './exchange-file.ts';

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

  it('publishes a file readable by the other side, with no temp file left', async () => {
    const final = join(dir, 'job.json');
    await publishExchangeFile(`${final}.tmp`, final, '{"a":1}');
    expect(await modeOf(final)).toBe(0o644);
    await expect(stat(`${final}.tmp`)).rejects.toThrow();
  });

  it('writes in place readable, or private, and refuses an existing file when exclusive', async () => {
    const shared = join(dir, 'shared');
    const priv = join(dir, 'private');
    await writeExchangeFile(shared, 'x');
    await writeExchangeFile(priv, '', { exclusive: true, private: true });
    expect(await modeOf(shared)).toBe(0o644);
    expect(await modeOf(priv)).toBe(0o600);
    await expect(writeExchangeFile(priv, '', { exclusive: true })).rejects.toThrow();
  });

  it('makes a folder with exactly its mode, sticky bit included', async () => {
    const folder = join(dir, 'a', 'outbox');
    await makeExchangeDir(folder, 0o1777);
    expect(await modeOf(folder)).toBe(0o1777);
  });

  it('shares a streamed upload by chmod after the stream wrote it', async () => {
    const path = join(dir, 'upload.part');
    const stream = createExchangeWriteStream(path);
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.end('bytes', resolve);
    });
    await shareExchangeFile(path);
    expect(await modeOf(path)).toBe(0o644);
  });
});
