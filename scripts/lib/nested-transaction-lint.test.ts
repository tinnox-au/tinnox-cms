// The nested-transaction rule (U-3, adoption plan step 13) as eslint.config.js gives it to real
// paths, run against fixture text. The rule's own cases are in
// scripts/eslint-rules/no-nested-transaction.test.ts; this file takes the entry the config
// resolves for each path, so a block that turned the rule off for a file group would fail here.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import tinnox from '../eslint-rules/index.ts';
import { repoRoot } from './env.ts';

const RULE = 'tinnox/no-nested-transaction';
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
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
        plugins: { tinnox },
        languageOptions: {
          sourceType: 'module',
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: entry === undefined ? {} : { [RULE]: entry },
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const NESTED = `
await withOrg(pool, orgId, async (tx) => {
  await withOrg(pool, orgId, (inner) => inner.query('SELECT 1'));
});
`;
const IN_HELPER = `
export async function record(tx: Tx, pool: Pool): Promise<void> {
  await withoutOrg(pool, (inner) => inner.query('SELECT 1'));
}
`;
const ONE_AFTER_ANOTHER = `
await withOrg(pool, orgId, (tx) => tx.query('SELECT 1'));
await withoutOrg(pool, (tx) => tx.query('SELECT 2'));
`;

const MESSAGE =
  /^with(out)?Org\(\) is called inside .*, where a transaction is already open\. This opens a second transaction on another connection that commits independently\. Pass the outer tx to the helper: give it a `tx: Tx` parameter/;

// The first case loads eslint.config.js, which a busy CI runner can stretch towards the unit
// project's 5 s default (GAP-1).
describe('a transaction inside another (U-3)', { timeout: 30_000 }, () => {
  it.each([
    // Product code that reaches the database, and the offline tools.
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/config.ts',
    'apps/api/src/mail.ts',
    'packages/db/src/fixture.ts',
    'packages/db/src/migrate.ts',
    'scripts/seed.ts',
    'scripts/lib/fixture.ts',
    'scripts/fixture.mjs',
    // Tests too: the runtime guard refuses the same thing there.
    'apps/api/src/fixture.test.ts',
    'apps/api/test/fixture.integration.test.ts',
    'packages/db/test/fixture.integration.test.ts',
    'tests/integration/fixture.test.ts',
    'tests/e2e/support/fixture.ts',
    // Files with a list of their own for other rules keep this one.
    'apps/portal/src/fixture.tsx',
    'apps/portal/src/fixture.test.tsx',
  ])('is reported in %s', async (path) => {
    const typed = !path.endsWith('.mjs');
    expect(await flagged(path, NESTED)).toEqual([expect.stringMatching(MESSAGE)]);
    // The helper form needs a type annotation, which a .mjs file cannot have.
    if (typed) expect(await flagged(path, IN_HELPER)).toEqual([expect.stringMatching(MESSAGE)]);
    expect(await flagged(path, ONE_AFTER_ANOTHER)).toEqual([]);
  });
});
