// CU-02: the job directory is a contract between two uids (the API and this worker), and the
// mode a file gets there must not depend on the container's umask: writeFile's `mode` is
// reduced by it, so each helper here sets the mode again with chmod. Every file the worker
// writes in the job directory goes through this file, and tinnox/exchange-files refuses a
// `mode` option or a direct write anywhere else in apps/media-worker/src. The API has its own
// copy (apps/api/src/media/exchange-file.ts): the two cannot share code.
import { chmod, rename, stat, writeFile } from 'node:fs/promises';

/** What the API needs to read a file: the worker writes, everybody reads. */
export const EXCHANGE_FILE_MODE = 0o644;

/** Temp file, explicit mode, then rename: the API sees either no file or a complete one. */
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
 * A file written in place, with no rename (the attempt marker and the liveness file). The
 * mode is set only when this call creates the file, as writeFile's own `mode` is: a file that
 * is already there keeps its mode, and may belong to another uid, whose file chmod refuses
 * on Linux (EPERM) even when the file is writable.
 */
export async function writeExchangeFile(path: string, data: string | Buffer): Promise<void> {
  const existed = await stat(path).then(
    () => true,
    () => false,
  );
  await writeFile(path, data, { mode: EXCHANGE_FILE_MODE, flag: 'w' });
  if (!existed) await chmod(path, EXCHANGE_FILE_MODE);
}
