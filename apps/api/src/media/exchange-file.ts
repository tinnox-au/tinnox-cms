// CU-02: the job directory is a contract between two uids (the API and the media worker), and
// the mode a file gets there must not depend on a umask. Both writeFile's and mkdir's `mode`
// are reduced by the process umask, so each helper here sets the mode again with chmod. Every
// file or folder the API creates in the job directory goes through this file, and
// tinnox/exchange-files refuses a `mode` option or a direct write anywhere else in
// apps/api/src/media. The worker has its own copy (apps/media-worker/src/exchange-file.ts): the
// two cannot share code, and the same rule holds there.
import { createWriteStream, type WriteStream } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';

/** What the other side needs to read a file: the owner writes, everybody reads. */
export const EXCHANGE_FILE_MODE = 0o644;
/** A file only this process reads, such as the readiness probe. */
const PRIVATE_FILE_MODE = 0o600;

/** Temp file, explicit mode, then rename: the reader sees either no file or a complete one. */
export async function publishExchangeFile(
  tempPath: string,
  finalPath: string,
  data: string | Buffer,
): Promise<void> {
  await writeFile(tempPath, data, { mode: EXCHANGE_FILE_MODE, flag: 'w' });
  await chmod(tempPath, EXCHANGE_FILE_MODE);
  await rename(tempPath, finalPath);
}

/**
 * A file written in place, with no rename. `exclusive` fails when the file exists; `private`
 * keeps it to this process (mode 0600) instead of readable by the other side.
 */
export async function writeExchangeFile(
  path: string,
  data: string | Buffer,
  options: { exclusive?: boolean; private?: boolean } = {},
): Promise<void> {
  const mode = options.private === true ? PRIVATE_FILE_MODE : EXCHANGE_FILE_MODE;
  await writeFile(path, data, { mode, flag: options.exclusive === true ? 'wx' : 'w' });
  await chmod(path, mode);
}

/**
 * A stream for a file that must not exist yet (an upload on its way in). The mode it is
 * created with is subject to the umask: `shareExchangeFile` sets it before the worker reads.
 */
export function createExchangeWriteStream(path: string): WriteStream {
  return createWriteStream(path, { flags: 'wx', mode: EXCHANGE_FILE_MODE });
}

/** Sets the readable mode on a file the API created, whatever its umask was. */
export async function shareExchangeFile(path: string): Promise<void> {
  await chmod(path, EXCHANGE_FILE_MODE);
}

/** Creates a folder (and its parents) with exactly `mode`, whatever the umask is. */
export async function makeExchangeDir(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
}
