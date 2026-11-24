// The exchange-files rule (CU-02, adoption plan step 22) as eslint.config.js gives it to real
// paths, run against fixture text. The rule's own cases are in
// scripts/eslint-rules/exchange-files.test.ts; this file takes the entry the config resolves for
// each path, so a block that turned the rule off for the media folders would fail here.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import tinnox from '../eslint-rules/index.ts';
import { repoRoot } from './env.ts';

const RULE = 'tinnox/exchange-files';
const repository = new ESLint({ cwd: repoRoot });

/** The rule's messages for `code` at `path`, with the entry eslint.config.js resolves there. */
async function flagged(path: string, code: string): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const entry = resolved[RULE];
  // Without type information: the rule reads syntax only.
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        plugins: { tinnox },
        languageOptions: { sourceType: 'module', parser: tseslint.parser },
        rules: entry === undefined ? {} : { [RULE]: entry },
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const BY_MODE = "await writeFile(path, data, { mode: 0o644, flag: 'w' });";
const BY_IMPORT = "import { writeFile } from 'node:fs/promises';";

describe('exchange files carry their mode through the helper (CU-02)', { timeout: 30_000 }, () => {
  it.each([
    'apps/api/src/media/pipeline.ts',
    'apps/api/src/media/new-file.ts',
    'apps/media-worker/src/main.ts',
    'apps/media-worker/src/new-file.ts',
  ])('flags a mode option and a direct writer in %s', async (path) => {
    expect(await flagged(path, BY_MODE)).toHaveLength(1);
    const messages = await flagged(path, BY_IMPORT);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/exchange helpers \(CU-02\)/);
  });

  it.each(['apps/api/src/media/exchange-file.ts', 'apps/media-worker/src/exchange-file.ts'])(
    'leaves the helper %s, the one place that writes',
    async (path) => {
      expect(await flagged(path, BY_MODE)).toEqual([]);
      expect(await flagged(path, BY_IMPORT)).toEqual([]);
    },
  );

  it.each([
    'apps/api/src/routes/playlists.ts',
    'packages/storage/src/local.ts',
    'apps/media-worker/src/inspect.test.ts',
  ])('is not about %s', async (path) => {
    expect(await flagged(path, BY_MODE)).toEqual([]);
  });
});
