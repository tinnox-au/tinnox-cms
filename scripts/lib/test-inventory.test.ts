import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import { repoRoot } from './env.ts';
import { type Suite, TEST_FILE, inventoryProblems, playwrightSuite } from './test-inventory.ts';

const byPrefix = (name: string, prefix: string): Suite => ({
  name,
  runs: (path) => path.startsWith(prefix),
});

describe('inventoryProblems', () => {
  const suites = [byPrefix('unit', 'apps/'), byPrefix('integration', 'apps/api/test/')];

  it('passes a test file that one suite runs, and ignores files that are not tests', () => {
    expect(
      inventoryProblems(
        ['apps/portal/src/a.test.ts', 'packages/x/src/b.ts', 'README.md'],
        [byPrefix('unit', 'apps/')],
      ),
    ).toEqual([]);
  });

  it('fails a test file that no suite runs (an orphan never runs and nothing says so)', () => {
    expect(inventoryProblems(['packages/db/src/x.integration.test.ts'], suites)).toEqual([
      'packages/db/src/x.integration.test.ts is run by no suite: move it under an include glob of a project in vitest.config.ts or under tests/e2e, or rename it if it is not a test',
    ]);
  });

  it('fails a test file that two suites run', () => {
    expect(inventoryProblems(['apps/api/test/a.integration.test.ts'], suites)).toEqual([
      'apps/api/test/a.integration.test.ts is run by unit and integration: narrow the include or exclude globs in vitest.config.ts so that one project runs it',
    ]);
  });

  it('recognises test and spec files of every script extension', () => {
    expect(
      ['a.test.ts', 'a.test.tsx', 'a.spec.ts', 'a.test.mjs', 'a.spec.js'].every((f) =>
        TEST_FILE.test(f),
      ),
    ).toBe(true);
    expect(['a.test-support.ts', 'test.ts', 'a.tests.ts'].some((f) => TEST_FILE.test(f))).toBe(
      false,
    );
  });

  it("matches Playwright's default testMatch under the test directory only", () => {
    const e2e = playwrightSuite('e2e', 'tests/e2e', undefined);
    expect(e2e.runs('tests/e2e/01-sign-in.spec.ts')).toBe(true);
    expect(e2e.runs('tests/e2e/support/stack.ts')).toBe(false);
    expect(e2e.runs('tests/integration/a.test.ts')).toBe(false);
    expect(() => playwrightSuite('e2e', 'tests/e2e', '*.spec.ts')).toThrow(/sets testMatch/);
  });
});

describe('the repository', () => {
  it('runs every test file in exactly one suite', async () => {
    // Tracked files and new files that are not ignored, as check:docs lists them.
    const files = spawnSync(
      'git',
      ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
      .stdout.split('\0')
      .filter((path) => path !== '' && existsSync(join(repoRoot, path)));

    // The full e2e suite. tests/playwright.layout.config.ts runs a subset of the same specs.
    const e2e = (
      (await import(join(repoRoot, 'tests/playwright.config.ts'))) as {
        default: { testDir?: string; testMatch?: unknown };
      }
    ).default;
    const suites: Suite[] = [
      playwrightSuite('e2e', posix.join('tests', e2e.testDir ?? '.'), e2e.testMatch),
    ];

    // Vitest's own matcher, so the globs are read exactly as `vitest run` reads them.
    const vitest = await createVitest('test', {
      watch: false,
      root: repoRoot,
      config: join(repoRoot, 'vitest.config.ts'),
    });
    try {
      for (const project of vitest.projects) {
        suites.push({
          name: project.name,
          runs: (path) => project.matchesTestGlob(join(repoRoot, path)),
        });
      }
      // A suite that runs nothing means a broken glob, or a listing that found no files.
      for (const suite of suites) {
        expect(
          files.some((path) => suite.runs(path)),
          `${suite.name} runs no file`,
        ).toBe(true);
      }
      expect(inventoryProblems(files, suites)).toEqual([]);
    } finally {
      await vitest.close();
    }
  });
});
