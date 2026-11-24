// The SQLSTATE rules of eslint.config.js (adoption plan section 2.3, step 26), run against
// fixture text: API source and the migration runner read no SQLSTATE code, and API source
// imports no constraint reader. Each case takes the rules eslint.config.js resolves for a real
// path, so the file globs are tested with the selectors: a later block that took the rule away
// from one of the API's own blocks (the entry points, the reviewed clients, config.ts) fails here.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

const RULES = ['no-restricted-syntax', 'no-restricted-imports'] as const;
const repository = new ESLint({ cwd: repoRoot });

/** The messages of the restricted-syntax and restricted-imports rules for `code` at `path`. */
async function flagged(path: string, code: string): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const rules: Linter.RulesRecord = {};
  for (const rule of RULES) {
    const entry = resolved[rule];
    if (entry !== undefined) rules[rule] = entry;
  }
  // Without type information: these rules read syntax only.
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules }],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const SQLSTATE =
  /^Do not read a SQLSTATE code here \(step 26\): classifyDbError\(error\) from @tinnox\/db .* constraints option of changeAsOperator\(ctx, request, fn, \{ constraints: \{ name: \(\) => error \} \}\) \(apps\/api\/src\/auth\/permissions\.ts\)/;
const CONSTRAINT_READ =
  /^'violatedConstraint' import from '@tinnox\/db' is restricted .*Do not read the constraint of a database error in API source \(step 26\): .* constraints option of changeAsOperator/;

// Every kind of block that sets the API's list: a route file, a module outside routes/ (D6:
// tags.ts), the two 55P03 readers of the row, the entry points, a reviewed client, and the file
// excused from the credential-name and loopback rules.
const API_PATHS = [
  'apps/api/src/routes/fixture.ts',
  'apps/api/src/tags.ts',
  'apps/api/src/auth/permissions.ts',
  'apps/api/src/errors.ts',
  'apps/api/src/main.ts',
  'apps/api/src/alerts-once.ts',
  'apps/api/src/mail.ts',
  'apps/api/src/auth/oidc.ts',
  'apps/api/src/config.ts',
] as const;

// The first case loads eslint.config.js, which a busy CI runner can stretch towards the unit
// project's 5 s default (GAP-1).
describe(
  'no SQLSTATE code in API source or the migration runner (step 26)',
  { timeout: 30_000 },
  () => {
    for (const path of [...API_PATHS, 'packages/db/src/migrate.ts']) {
      it.each([
        "if (code === '23505') throw nameTaken();",
        "const pg = code(error); if (pg === '23503' || pg === '23001') return null;",
        "const LOCK_NOT_AVAILABLE = '55P03';",
        'if (code === `40P01`) retry();',
        "switch (code) { case '42501': break; case '57014': break; }",
        "const TRANSIENT = new Set(['40001']);",
      ])(`flags %s in ${path}`, async (code) => {
        const messages = await flagged(path, code);
        expect(messages.length).toBeGreaterThan(0);
        for (const message of messages) expect(message).toMatch(SQLSTATE);
      });
    }

    it.each(['EPIPE', '23505x', '2350', '12345', 'P0001', '0A000', 'route 23505 failed'])(
      'leaves other text alone: %s',
      async (text) => {
        expect(await flagged('apps/api/src/routes/fixture.ts', `const t = '${text}';`)).toEqual([]);
      },
    );

    it.each([
      // The classifier and the registry are where the codes live.
      'packages/db/src/outcome.ts',
      'packages/db/src/constraints.ts',
      // Tests build the errors the classifier reads.
      'apps/api/src/routes/fixture.test.ts',
      'apps/api/test/fixture.integration.test.ts',
      'tests/integration/fixture.test.ts',
    ])('leaves %s alone', async (path) => {
      expect(await flagged(path, "if (code === '23505') throw nameTaken();")).toEqual([]);
    });
  },
);

describe('no constraint reader in API source (step 26)', { timeout: 30_000 }, () => {
  it.each(API_PATHS)('flags violatedConstraint imported in %s', async (path) => {
    const messages = await flagged(path, "import { violatedConstraint } from '@tinnox/db';");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(CONSTRAINT_READ);
  });

  it('leaves the classifier and the offline tools their imports', async () => {
    const code = "import { classifyDbError, type ConstraintName } from '@tinnox/db';";
    expect(await flagged('apps/api/src/routes/fixture.ts', code)).toEqual([]);
    // Provisioning reads a constraint name; it is not API source (left for another step).
    expect(
      await flagged('scripts/lib/provision.ts', "import { violatedConstraint } from '@tinnox/db';"),
    ).toEqual([]);
  });
});
