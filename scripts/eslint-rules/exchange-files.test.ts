// CU-02 (adoption plan section 2.5): the exchange-files rule against fixture code. It reads
// names only, so one tester without type information is enough. The messages are pinned word
// for word (D16): they are what an author reads, and they must name what to use instead.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './exchange-files.ts';

// ESLint looks for global describe and it, which the unit project does not define. itOnly stays
// unset: a focused case is a red run (U-15).
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const MODE = {
  message:
    'A `mode` option is reduced by the process umask (CU-02), so the other uid may not be able to read what you write. Write the file with publishExchangeFile(tempPath, finalPath, data) or writeExchangeFile(path, data) and a folder with makeExchangeDir(path, mode), all from ./exchange-file.ts, which set the mode again with chmod.',
};
const writer = (name: string) => ({
  message: `${name} creates a file or folder in the job directory without the exchange helpers (CU-02): its mode is left to the umask. Use publishExchangeFile(tempPath, finalPath, data), writeExchangeFile(path, data), createExchangeWriteStream(path), shareExchangeFile(path) or makeExchangeDir(path, mode) from ./exchange-file.ts, which set the mode explicitly.`,
});
const namespace = (module: string) => ({
  message: `A namespace or default import of ${module} hides which writer is called, so the rule cannot see it (CU-02). Import the names you read with (open, lstat, readdir, rename) and write through ./exchange-file.ts.`,
});

const openCall = (name: string) => ({
  message: `${name} here may create or write a file whose mode is left to the umask (CU-02). Open only to read, with no mode argument and flags of fsConstants.O_RDONLY (with O_NOFOLLOW or O_NONBLOCK) or a literal 'r', and write through publishExchangeFile(tempPath, finalPath, data) or writeExchangeFile(path, data) from ./exchange-file.ts.`,
});

describe('exchange-files (CU-02)', { timeout: 30_000 }, () => {
  tester.run('exchange-files', rule, {
    valid: [
      {
        name: 'the helpers, and the readers and removers of node:fs',
        code: `
          import { lstat, open, readdir, rename, rm, unlink, utimes } from 'node:fs/promises';
          import { constants as fsConstants } from 'node:fs';
          import { makeExchangeDir, publishExchangeFile, writeExchangeFile } from './exchange-file.ts';
          await makeExchangeDir(inbox, 0o755);
          await publishExchangeFile(temp, final, JSON.stringify(spec));
          await writeExchangeFile(marker, '1', { exclusive: true });
          const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
          await open(path);
          await open(path, 'r');
          process.stdout.write('line');
          await handle.stat();
        `,
      },
      {
        name: 'an object with other keys, and a type-only import of a writer name',
        code: `
          import type { WriteStream } from 'node:fs';
          import { type writeFile } from 'node:fs/promises';
          const options = { flag: 'wx', recursive: true };
          const mode = 'draft';
          const o = { [mode]: 1 };
        `,
      },
    ],
    invalid: [
      {
        name: 'the mode option of writeFile, mkdir and a stream (the nine sites of CU-02)',
        code: `
          await helper(tempPath, data, { mode: 0o644, flag: 'w' });
          await helper(inbox, { recursive: true, mode: 0o755 });
          helper(partPath, { flags: 'wx', mode: 0o644 });
        `,
        errors: [MODE, MODE, MODE],
      },
      {
        name: 'a quoted key is the same option',
        code: "await helper(path, { 'mode': 0o600 });",
        errors: [MODE],
      },
      {
        name: 'every writer of node:fs and node:fs/promises, where it is imported',
        code: `
          import { createWriteStream } from 'node:fs';
          import { chmod, mkdir, writeFile as save } from 'node:fs/promises';
        `,
        errors: [
          writer('createWriteStream'),
          writer('chmod'),
          writer('mkdir'),
          writer('writeFile'),
        ],
      },
      {
        name: 'a namespace or default import, which hides the call',
        code: `
          import * as fs from 'node:fs/promises';
          import fsSync from 'fs';
        `,
        errors: [namespace('node:fs/promises'), namespace('fs')],
      },
      {
        name: 'the promises object of node:fs, which is node:fs/promises under one name',
        code: `
          import { promises } from 'node:fs';
          import { promises as fsp } from 'fs';
          await promises.writeFile(p, x);
        `,
        errors: [
          namespace('the promises object of node:fs'),
          namespace('the promises object of fs'),
          writer('promises.writeFile'),
        ],
      },
      {
        name: 'the Sync and file-descriptor writers',
        code: `
          import { copyFileSync, cpSync, linkSync, mkdtempSync, symlinkSync, truncateSync, writeSync } from 'node:fs';
        `,
        errors: [
          writer('copyFileSync'),
          writer('cpSync'),
          writer('linkSync'),
          writer('mkdtempSync'),
          writer('symlinkSync'),
          writer('truncateSync'),
          writer('writeSync'),
        ],
      },
      {
        name: 'an open that may create or write: a mode argument, a write flag or O_CREAT, also aliased',
        code: `
          import { constants as fsConstants, openSync as openFd } from 'node:fs';
          import { open } from 'node:fs/promises';
          await open(p, 'r', 0o600);
          await open(p, 'w');
          await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT);
          await open(p, flags);
          openFd(p, 'a+');
        `,
        errors: [
          openCall('open'),
          openCall('open'),
          openCall('open'),
          openCall('open'),
          openCall('openSync'),
        ],
      },
      {
        name: 'a FileHandle that writes or sets a mode',
        code: `
          await handle.writeFile(data);
          await handle.chmod(0o600);
        `,
        errors: [writer('handle.writeFile'), writer('handle.chmod')],
      },
    ],
  });
});
