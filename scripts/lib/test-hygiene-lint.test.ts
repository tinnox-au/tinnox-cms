// The test-hygiene selectors of eslint.config.js, run against fixture text (adoption plan
// section 3.4: a selector is tested, not trusted by reading). Each case takes the rules that
// eslint.config.js resolves for a real path, so the file globs are tested with the selectors.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

const RULES = ['no-restricted-syntax', 'no-restricted-properties'] as const;
const repository = new ESLint({ cwd: repoRoot });

/** The messages of the restricted-syntax and restricted-properties rules for `code` at `path`. */
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
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules,
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const SKIPPED = /^A skipped, focused or expected-to-fail test is a red run \(U-15\)/;
const RANDOM = /^Do not call Math\.random\(\) in a test/;
const MOCKED = /Integration and e2e tests use real services \(OTH-13/;

describe('skipped and focused tests (U-15)', () => {
  it.each([
    "it.skip('a', () => {});",
    "test.only('a', () => {});",
    "describe.todo('a');",
    "it.skipIf(process.env.CI)('a', () => {});",
    "describe.runIf(true)('a', () => {});",
    "it.fails('a', () => {});",
    "suite.skip('a', () => {});",
    "it.concurrent.only('a', () => {});",
    "it('a', { skip: true }, () => {});",
    "test.concurrent('a', { only: true }, () => {});",
  ])('flags %s in a unit test', async (code) => {
    const messages = await flagged('apps/api/src/fixture.test.ts', code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(SKIPPED);
  });

  it.each([
    "test.skip('a', async () => {});",
    'test.skip(true, "not on this browser");',
    "test.fixme('a', async () => {});",
    "test.fail('a', async () => {});",
    "test.describe.skip('a', () => {});",
    "test.describe.only('a', () => {});",
    "test.describe.serial.only('a', () => {});",
    "test.step.skip('later', async () => {});",
  ])('flags %s in a Playwright spec', async (code) => {
    const messages = await flagged('tests/e2e/fixture.spec.ts', code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(SKIPPED);
  });

  it('flags a skip in a portal component test, which keeps the portal selectors too', async () => {
    const messages = await flagged(
      'apps/portal/src/fixture.test.tsx',
      "it.skip('a', () => {}); const x = <div dangerouslySetInnerHTML={{ __html: '' }} />;",
    );
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(SKIPPED),
        'dangerouslySetInnerHTML is not allowed.',
      ]),
    );
  });

  it('leaves plain tests, each, serial mode and configuration alone', async () => {
    const code = [
      "describe('a', () => { it('b', () => {}); it.each([1])('c %s', () => {}); });",
      "test.describe.serial('a', () => { test('b', async () => {}); });",
      "test.describe.configure({ mode: 'serial' });",
      'test.use({ viewport: { width: 1, height: 1 } });',
      "test('a', { tag: '@slow' }, async () => {});",
      'const options = { skip: 1 }; list.skip(2);',
    ].join('\n');
    expect(await flagged('tests/e2e/fixture.spec.ts', code)).toEqual([]);
    expect(await flagged('apps/api/src/fixture.test.ts', code)).toEqual([]);
  });

  it.each([
    'apps/portal/src/session/fixture.test-support.tsx',
    'apps/portal/src/componentTests.setup.ts',
    'scripts/vitest-integration-setup.ts',
    'packages/delivery/test/fixture.ts',
  ])('flags a skip in the test-support or setup file %s', async (path) => {
    const messages = await flagged(path, "it.skip('a', () => {});");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(SKIPPED);
  });

  it('keeps the portal selectors in a portal .test-support.tsx file', async () => {
    const messages = await flagged(
      'apps/portal/src/session/fixture.test-support.tsx',
      "const x = <div dangerouslySetInnerHTML={{ __html: '' }} />;",
    );
    expect(messages).toEqual(['dangerouslySetInnerHTML is not allowed.']);
  });

  it.each(['apps/portal/test/fixture.ts', 'apps/portal/src/componentTests.setup.ts'])(
    'keeps the portal selectors in %s',
    async (path) => {
      const resolved = (await repository.calculateConfigForFile(path)) as Linter.Config;
      expect(JSON.stringify(resolved.rules?.['no-restricted-syntax'])).toContain(
        'dangerouslySetInnerHTML',
      );
    },
  );

  it('applies to test files only', async () => {
    expect(await flagged('apps/api/src/fixture.ts', "it.skip('a', () => {});")).toEqual([]);
  });
});

describe('Math.random() in tests', () => {
  it.each([
    'apps/api/test/fixture.integration.test.ts',
    'tests/integration/fixture.test.ts',
    'tests/e2e/fixture.spec.ts',
    'apps/portal/src/fixture.test.tsx',
    'apps/portal/src/fixture.test-support.ts',
    'apps/portal/src/session/fixture.test-support.tsx',
    'apps/portal/src/componentTests.setup.ts',
    'scripts/vitest-integration-setup.ts',
  ])('flags a call in %s', async (path) => {
    const messages = await flagged(path, 'const n = Math.random();');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(RANDOM);
  });

  it('allows passing Math.random to the code under test, as playback.test.ts does', async () => {
    expect(
      await flagged(
        'apps/player-web/src/core/fixture.test.ts',
        'const opts = { random: Math.random }; walk(m, 7, Math.random);',
      ),
    ).toEqual([]);
  });

  it('leaves product code alone', async () => {
    expect(await flagged('apps/player-web/src/platform/fixture.ts', 'Math.random();')).toEqual([]);
  });
});

describe('module mocks in integration and e2e tests (OTH-13)', () => {
  it.each([
    'apps/api/test/fixture.integration.test.ts',
    'packages/db/test/fixture.integration.test.ts',
    'apps/api/test/support.ts',
    'tests/integration/fixture.test.ts',
    'tests/e2e/fixture.spec.ts',
  ])('flags vi.mock in %s', async (path) => {
    const messages = await flagged(
      path,
      "vi.mock('pg'); vi.doMock('pg'); vi.stubGlobal('fetch', f);",
    );
    expect(messages).toHaveLength(3);
    for (const message of messages) expect(message).toMatch(MOCKED);
  });

  it('leaves unit and component tests free to replace a module', async () => {
    expect(await flagged('apps/api/src/fixture.test.ts', "vi.mock('nodemailer');")).toEqual([]);
    expect(
      await flagged('apps/portal/src/fixture.test.tsx', "vi.mock('../api/index.ts');"),
    ).toEqual([]);
    // packages/*/test also holds unit tests, run by the unit project (vitest.config.ts).
    expect(await flagged('packages/delivery/test/fixture.test.ts', "vi.mock('node:fs');")).toEqual(
      [],
    );
  });

  it.each([
    'apps/player-web/test/fixture.ts',
    'apps/portal/src/fixture.integration.test.ts',
    'packages/app-render/src/fixture.integration.test.ts',
  ])('keeps the browser restricted properties in %s', async (path) => {
    const messages = await flagged(path, "vi.mock('pg'); el.innerHTML = s;");
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(MOCKED),
        expect.stringMatching(/'innerHTML' is restricted.*Do not assign HTML strings/),
      ]),
    );
  });
});
