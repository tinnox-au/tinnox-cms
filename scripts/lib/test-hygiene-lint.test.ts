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
const REPLAY = /^Do not commit a fast-check seed or path \(D11\)/;
const FC_IMPORT = /^Import fast-check as `import fc from 'fast-check'`/;

// The first case loads eslint.config.js, which a busy CI runner can stretch towards the unit
// project's 5 s default (GAP-1).
describe('skipped and focused tests (U-15)', { timeout: 30_000 }, () => {
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
    'scripts/vitest-integration-file-setup.ts',
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

describe('fast-check replays (D11)', { timeout: 30_000 }, () => {
  it.each([
    ['packages/domain/src/fixture.property.test.ts', 'fc.assert(p, { seed: 1 });'],
    ['packages/domain/src/fixture.property.test.ts', 'fc.assert(p, { numRuns: 50, path: "3:0" });'],
    ['packages/domain/src/fixture.property.test.ts', "fc.check(p, { 'seed': 42 });"],
    ['packages/domain/src/fixture.property.test.ts', 'fc.assert(p, { seed: 1 } as any);'],
    ['packages/domain/src/fixture.property.test.ts', 'fc.assert(p, { seed: 1 } satisfies object);'],
    ['packages/domain/src/fixture.property.test.ts', "fc['assert'](p, { seed: 1 });"],
    ['apps/api/test/fixture.integration.test.ts', 'await fc.assert(p, { seed: 1 });'],
    ['packages/db/test/fixture.integration.test.ts', 'fc.configureGlobal({ seed: 7 });'],
    ['apps/portal/src/fixture.test.tsx', 'fc.assert(p, { path: "0:1" });'],
    ['apps/portal/src/componentTests.setup.ts', 'fc.configureGlobal({ seed: 7 });'],
  ])('flags a seed or path in %s: %s', async (path, code) => {
    const messages = await flagged(path, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(REPLAY);
    expect(messages[0]).toMatch(
      /plain example test .*packages\/domain\/src\/layout\.property\.test\.ts/,
    );
  });

  it.each([
    'fc.record({ path: fc.string() });',
    'fc.assert(fc.property(fc.record({ seed: fc.nat(), path: fc.string() }), () => true));',
    'fc.assert(p, { numRuns: 200, verbose: true });',
    'fc.configureGlobal({ numRuns: 200 });',
    'other.assert(p, { seed: 1 });',
  ])('leaves %s alone', async (code) => {
    expect(await flagged('packages/domain/src/fixture.property.test.ts', code)).toEqual([]);
  });

  it('flags fast-check imported under another name, which the seed rule cannot see', async () => {
    for (const code of [
      "import { assert } from 'fast-check';",
      "import check from 'fast-check';",
      "import fc, { property } from 'fast-check';",
      "import * as f from 'fast-check';",
    ]) {
      expect(await flagged('packages/domain/src/fixture.property.test.ts', code)).toEqual([
        expect.stringMatching(FC_IMPORT),
      ]);
    }
    for (const code of [
      "import fc from 'fast-check';",
      "import * as fc from 'fast-check';",
      "import type { Arbitrary } from 'fast-check';",
      "import fc, { type Arbitrary } from 'fast-check';",
    ]) {
      expect(await flagged('packages/domain/src/fixture.property.test.ts', code)).toEqual([]);
    }
  });

  it('keeps the other test rules where it flags a seed', async () => {
    const messages = await flagged(
      'packages/domain/src/fixture.property.test.ts',
      "it.skip('a', () => {}); Math.random(); fc.assert(p, { seed: 1 });",
    );
    expect(messages).toEqual([
      expect.stringMatching(SKIPPED),
      expect.stringMatching(RANDOM),
      expect.stringMatching(REPLAY),
    ]);
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

  // LINT-3: packages/db may not import the API's harness, so its tests are pointed at their own.
  it('names the helpers each group may import', async () => {
    expect(await flagged('apps/api/test/fixture.integration.test.ts', "vi.mock('pg');")).toEqual([
      expect.stringMatching(/startTestApp\(\.\.\., \{ wrapPool \}\).*apps\/api\/test\/support\.ts/),
    ]);
    const db = await flagged('packages/db/test/rls.integration.test.ts', "vi.mock('pg');");
    expect(db).toEqual([
      expect.stringMatching(
        /^(?!.*apps\/api).*Wrap or replace the pool .*packages\/db\/test\/support\.ts/,
      ),
    ]);
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

const RANGE_STATUS =
  /^Assert the exact status: .*expectError\(response, 'not_found'\).*\(RCX-03\)\.$/;
const NOT_OK =
  /^Assert the exact status: .*\(RCX-03\)\. An `ok` that is not an HTTP response's is asserted through its object: expect\(result\)\.toMatchObject\(\{ ok: false \}\)\.$/;

describe('a status asserted as a range or a negation (RCX-03)', { timeout: 30_000 }, () => {
  it.each([
    'expect(response.status).toBeGreaterThanOrEqual(400);',
    'expect(response.status).toBeLessThan(500);',
    "expect(saved.status, 'what').toBeGreaterThan(399);",
    'expect(reply.statusCode).toBeLessThanOrEqual(499);',
    'expect((await claim(bob, id, code)).status).toBeGreaterThanOrEqual(400);',
    'expect(response?.status).toBeGreaterThanOrEqual(400);',
    'expect(again.status()).toBeGreaterThanOrEqual(400);',
    'expect.soft(response.status).toBeLessThan(500);',
    'expect(response.status).not.toBe(401);',
    'expect(response.status).not.toEqual(200);',
    'expect(await manifestStatus(current)).not.toBe(401);',
    'expect(status).not.toBe(500);',
    'expect(responseStatus).toBeGreaterThanOrEqual(400);',
    'expect(response.status).toBeLessThan(serverError);',
    'expect(response.status).not.toBeLessThan(400);',
    'expect(response.status).not.toBeGreaterThanOrEqual(500);',
    'expect.soft(response.status).not.toBeGreaterThan(499);',
    'expect(status).not.toBeLessThan(400);',
    'expect(response.status >= 400).toBe(true);',
    'expect(500 > reply.statusCode).toBe(true);',
    'expect.soft(status < 500).toBe(true);',
    'expect(response.status >= 400 && response.status < 500).toBe(true);',
    'expect(response.status < 200 || response.status >= 300).toBe(true);',
    'expect(ok && 400 <= response.status && response.status < 500).toBe(true);',
    'expect(response.status >= serverError).toBe(true);',
    'expect(limit > reply.statusCode).toBe(true);',
    'expect(response.status).toSatisfy((s) => s >= 400);',
    'expect(status).not.toSatisfy(isServerError);',
    // CHK-4 (group C review): "not 401" as !==, a negated list, and a range behind `!`.
    'expect(response.status !== 401).toBe(true);',
    'expect(401 != reply.statusCode).toBe(true);',
    'expect(ok && response.status !== 401).toBe(true);',
    'expect([401, 403]).not.toContain(response.status);',
    "expect([401, 403], 'what').not.toContain(passed.status);",
    'expect(response.status).not.toBeOneOf([401]);',
    'expect(!(response.status < 400)).toBe(true);',
    'expect(!(status >= 500)).toBe(true);',
    // TST-5 (group C review): an exact comparison asserted false is "not 401" too.
    'expect(response.status === 401).toBe(false);',
    'expect(401 == reply.statusCode).toBeFalsy();',
    'expect(status === 500).not.toBe(true);',
    'expect.soft(response.status === 200).not.toBeTruthy();',
    'expect(response.status === 401).toEqual(false);',
  ])('flags %s', async (code) => {
    const messages = await flagged('tests/integration/fixture.test.ts', code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(RANGE_STATUS);
  });

  it.each([
    'apps/api/test/fixture.integration.test.ts',
    'apps/api/src/fixture.test.ts',
    'packages/db/test/fixture.integration.test.ts',
    'tests/e2e/fixture.spec.ts',
    'apps/portal/src/fixture.test.tsx',
    'apps/portal/src/testFrame.test-support.ts',
    'apps/api/test/support.ts',
  ])('applies in %s', async (path) => {
    expect(await flagged(path, 'expect(response.status).not.toBe(401);')).toEqual([
      expect.stringMatching(RANGE_STATUS),
    ]);
  });

  it('leaves exact statuses, other numbers and non-HTTP statuses alone', async () => {
    const code = [
      'expect(response.status).toBe(404);',
      'expect(response.status, what).toBe(200);',
      'expect([200, 204]).toContain(manifest.status);',
      'expect(run.status).not.toBe(0);',
      "expect(status).not.toBe('ready');",
      "expect(row?.statusKind).not.toBe('in_sync');",
      'expect(elapsedMs).toBeLessThan(500);',
      'expect(lifetimeMs).toBeGreaterThan(9 * 60 * 1000);',
      'expect(response.status).not.toBe(other);',
      'expect(run.status).toBeGreaterThan(0);',
      'expect(run.status).not.toBeLessThan(1);',
      'expect(run.status > 0).toBe(true);',
      'expect(run.status >= 0 && run.status <= 1).toBe(true);',
      'expect(status > limit).toBe(true);',
      'expect(elapsedMs < 500 && done).toBe(true);',
      'expect(response.status === 404).toBe(true);',
      'expect(response.status).toBeOneOf([200, 204]);',
      'expect(run.status !== 0).toBe(true);',
      "expect(row.status !== 'ready').toBe(true);",
      "expect(row.status).not.toBeOneOf(['ready']);",
      "expect(['failed']).not.toContain(row.status);",
      "expect(['400 validation_failed']).toContain(`${response.status} ${code}`);",
      'expect(!(elapsedMs < 500)).toBe(true);',
      "expect(row.status === 'ready').toBe(false);",
      'expect(run.status === 0).toBe(false);',
      'expect(response.status === other).toBe(false);',
      'expect(response.ok).toBe(true);',
    ].join('\n');
    expect(await flagged('tests/integration/fixture.test.ts', code)).toEqual([]);
  });

  it('leaves product code alone', async () => {
    expect(
      await flagged('apps/api/src/fixture.ts', 'expect(response.status).toBeLessThan(500);'),
    ).toEqual([]);
  });

  // TST-5 (group C review): a response's `ok` asserted false is "not 2xx".
  it.each([
    'expect(response.ok).toBe(false);',
    'expect((await fetch(url)).ok).toBeFalsy();',
    'expect(response.ok()).not.toBe(true);',
    'expect.soft(response?.ok).not.toBeTruthy();',
    "expect(response.ok, 'what').toStrictEqual(false);",
    'expect(await answer.ok()).toBe(false);',
  ])('flags %s where tests send real requests', async (code) => {
    for (const path of [
      'tests/integration/fixture.test.ts',
      'tests/e2e/fixture.spec.ts',
      'apps/api/test/fixture.integration.test.ts',
      'apps/api/test/support.ts',
      'packages/db/test/fixture.integration.test.ts',
    ]) {
      expect(await flagged(path, code), path).toEqual([expect.stringMatching(NOT_OK)]);
    }
  });

  it('keeps the other test rules where it flags ok', async () => {
    const messages = await flagged(
      'tests/integration/fixture.test.ts',
      "it.skip('a', () => {}); expect(response.status).not.toBe(401); Math.random();",
    );
    expect(messages).toHaveLength(3);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(SKIPPED),
        expect.stringMatching(RANGE_STATUS),
        expect.stringMatching(RANDOM),
      ]),
    );
  });

  it("leaves a result type's ok, and an ok asserted true, alone", async () => {
    for (const path of [
      'apps/portal/src/lib/fixture.test.ts',
      'apps/media-worker/src/fixture.test.ts',
      'apps/api/src/fixture.test.ts',
    ]) {
      expect(await flagged(path, 'expect(result.ok).toBe(false);'), path).toEqual([]);
    }
    expect(
      await flagged('tests/integration/fixture.test.ts', 'expect(response.ok).toBe(true);'),
    ).toEqual([]);
  });

  it("leaves a query row's ok column alone, and tells the author how to assert another ok", async () => {
    const rows = [
      'expect(taken.rows[0]?.ok).toBe(false);',
      'expect(taken.rows[0].ok).toBeFalsy();',
      'expect(taken.rows[0]!.ok).toBe(false);',
      'expect(rows[0]?.ok).not.toBe(true);',
    ].join('\n');
    expect(await flagged('packages/db/test/fixture.integration.test.ts', rows)).toEqual([]);
    expect(
      await flagged('packages/db/test/fixture.integration.test.ts', 'expect(row.ok).toBe(false);'),
    ).toEqual([expect.stringMatching(NOT_OK)]);
  });
});
