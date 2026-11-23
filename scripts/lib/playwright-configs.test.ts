import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import {
  type NpmPackage,
  PLAYWRIGHT_CONFIG,
  configsRunBy,
  recordingProblems,
  unrunConfigProblems,
  workflowCommands,
} from './playwright-configs.ts';

const OFF = { trace: 'off', video: 'off', screenshot: 'off' };

describe('recordingProblems (OTH-05)', () => {
  it('passes a config with every recording off, in either form', () => {
    expect(recordingProblems('a.config.ts', { use: OFF })).toEqual([]);
    expect(
      recordingProblems('a.config.ts', {
        use: {
          trace: { mode: 'off' },
          video: { mode: 'off', size: { width: 1, height: 1 } },
          screenshot: 'off',
        },
        projects: [{ name: 'chromium', use: { viewport: { width: 1, height: 1 } } }],
      }),
    ).toEqual([]);
  });

  it('fails a recording that is on, and one left to the default', () => {
    expect(
      recordingProblems('tests/a.config.ts', { use: { trace: 'on-first-retry', video: 'off' } }),
    ).toEqual([
      "tests/a.config.ts: use.trace is not 'off'; set it to 'off' in tests/a.config.ts: a recording would hold the sign-in form and its one-time code (OTH-05)",
      "tests/a.config.ts: use.screenshot is not 'off'; set it to 'off' in tests/a.config.ts: a recording would hold the sign-in form and its one-time code (OTH-05)",
    ]);
  });

  it('fails a project that turns a recording back on', () => {
    expect(
      recordingProblems('a.config.ts', {
        use: OFF,
        projects: [{ name: 'chromium', use: { video: { mode: 'retain-on-failure' } } }],
      }),
    ).toEqual([
      "a.config.ts: project chromium sets use.video other than 'off'; set it to 'off' in a.config.ts: a recording would hold the sign-in form and its one-time code (OTH-05)",
    ]);
  });

  it('recognises Playwright config names', () => {
    expect(
      [
        'tests/playwright.config.ts',
        'tests/playwright.layout.config.ts',
        'playwright.config.mjs',
      ].every((path) => PLAYWRIGHT_CONFIG.test(path)),
    ).toBe(true);
    expect(PLAYWRIGHT_CONFIG.test('tests/playwright/helpers.ts')).toBe(false);
  });
});

describe('workflowCommands', () => {
  it('reads one-line, quoted and block run steps', () => {
    const workflow = [
      'jobs:',
      '  quality:',
      '    steps:',
      '      - run: npm ci',
      "      - run: 'npx playwright test -c a.config.ts' # quoted",
      '      - name: Two lines',
      '        run: |',
      '          npm run build',
      '          npm test',
      '        env:',
      '          CI: true',
      '      - run: >-',
      '          npx playwright test',
      '          --config b.config.ts',
      '      - uses: actions/checkout@0000000000000000000000000000000000000000',
    ].join('\n');
    expect(workflowCommands(workflow)).toEqual([
      'npm ci',
      'npx playwright test -c a.config.ts',
      'npm run build\nnpm test',
      'npx playwright test --config b.config.ts',
    ]);
  });
});

describe('configsRunBy (step 4)', () => {
  const configs = [
    'tests/playwright.config.ts',
    'tests/playwright.layout.config.ts',
    'playwright.config.mjs',
  ];
  const packages: NpmPackage[] = [
    {
      dir: '',
      name: 'root',
      scripts: {
        'test:e2e': 'npm run e2e -w @tinnox/tests',
        'test:layout': 'CI=1 playwright test --config=tests/playwright.layout.config.ts',
        test: 'vitest run',
        loop: 'npm run loop',
      },
    },
    { dir: 'tests', name: '@tinnox/tests', scripts: { e2e: 'playwright test' } },
  ];
  const runBy = (...commands: string[]): string[] =>
    [...configsRunBy(commands, packages, configs)].sort();

  it('reads -c, --config and --config= relative to the working directory', () => {
    expect(runBy('npx playwright test -c tests/playwright.layout.config.ts')).toEqual([
      'tests/playwright.layout.config.ts',
    ]);
    expect(runBy('npx --yes playwright test --config ./tests/playwright.config.ts')).toEqual([
      'tests/playwright.config.ts',
    ]);
    expect(runBy('npm run test:layout')).toEqual(['tests/playwright.layout.config.ts']);
  });

  it('finds the config in the working directory, or in a folder given as the config', () => {
    expect(runBy('npx playwright test')).toEqual(['playwright.config.mjs']);
    expect(runBy('npx playwright test -c tests')).toEqual(['tests/playwright.config.ts']);
  });

  it('follows npm scripts into workspaces, and arguments after --', () => {
    expect(runBy('npm run test:e2e')).toEqual(['tests/playwright.config.ts']);
    expect(runBy('npm run e2e --workspace=tests -- -c playwright.layout.config.ts')).toEqual([
      'tests/playwright.layout.config.ts',
    ]);
    expect(runBy('npm ci && npm run e2e --workspaces --if-present')).toEqual([
      'tests/playwright.config.ts',
    ]);
  });

  it('runs nothing for another tool, a command that only names a config, `playwright install`, a missing script or a loop', () => {
    expect(
      runBy(
        'npm test',
        'npm run loop',
        'cat tests/playwright.layout.config.ts',
        'npx playwright install --with-deps chromium',
        'npm run e2e',
      ),
    ).toEqual([]);
  });
});

describe('unrunConfigProblems (step 4)', () => {
  it('names each config no CI step runs, and how to run it', () => {
    expect(
      unrunConfigProblems(
        ['tests/playwright.layout.config.ts', 'tests/playwright.config.ts'],
        new Set(['tests/playwright.config.ts']),
      ),
    ).toEqual([
      'tests/playwright.layout.config.ts is run by no CI job: add a step to the job of .github/workflows/ci.yml that has what it needs (`npx playwright test -c tests/playwright.layout.config.ts`, or an npm script that runs it), or delete the config if nothing needs it',
    ]);
  });
});

describe('the repository', () => {
  const files = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  ).stdout.split('\0');
  const configs = files.filter((path) => PLAYWRIGHT_CONFIG.test(path));

  it('finds both Playwright configs', () => {
    expect(configs).toEqual(
      expect.arrayContaining(['tests/playwright.config.ts', 'tests/playwright.layout.config.ts']),
    );
  });

  it.each(configs)('keeps traces, videos and screenshots off in %s (OTH-05)', async (path) => {
    const config: unknown = ((await import(join(repoRoot, path))) as { default: unknown }).default;
    expect(recordingProblems(path, config)).toEqual([]);
  });

  it('runs every Playwright config in a CI job (step 4, CHK-11)', () => {
    const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
    const workflows = files.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));
    // The root package and every workspace (package.json "workspaces", one folder level).
    const root = JSON.parse(read('package.json')) as {
      workspaces: string[];
      scripts: Record<string, string>;
    };
    const inWorkspace = (dir: string): boolean =>
      root.workspaces.some((pattern) =>
        new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '[^/]+')}$`).test(dir),
      );
    const packages: NpmPackage[] = [{ dir: '', name: 'root', scripts: root.scripts }];
    for (const path of files.filter((file) => file.endsWith('/package.json'))) {
      const dir = posix.dirname(path);
      if (!inWorkspace(dir)) continue;
      const pkg = JSON.parse(read(path)) as { name: string; scripts?: Record<string, string> };
      packages.push({ dir, name: pkg.name, scripts: pkg.scripts ?? {} });
    }
    expect(workflows).toContain('.github/workflows/ci.yml');
    const run = configsRunBy(workflows.map(read).flatMap(workflowCommands), packages, configs);
    expect(unrunConfigProblems(configs, run)).toEqual([]);
  });
});

/**
 * The repository files `entry` loads through static imports and re-exports, followed through
 * workspace packages (their package.json exports) but not into installed libraries.
 */
function staticImportGraph(entry: string): string[] {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
  };
  const seen = new Set<string>();
  const queue = [join(repoRoot, entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      // A workspace package resolves to its real path in the repository, a library does not.
      const resolved = ts.resolveModuleName(fileName, file, options, ts.sys).resolvedModule;
      const path = resolved?.resolvedFileName;
      if (path !== undefined && !path.includes('/node_modules/') && /\.tsx?$/.test(path)) {
        queue.push(path);
      }
    }
  }
  return [...seen].map((file) => relative(repoRoot, file)).sort();
}

describe('the stackless layout checks (CHK-9)', { timeout: 30_000 }, () => {
  it("load the API's configuration but not its test harness", () => {
    // The one spec file tests/playwright.layout.config.ts matches. The harness loads buildApp,
    // sharp and the root .env: a break there would fail a check about layout.
    const loaded = staticImportGraph('tests/e2e/09-review-round-2.spec.ts');
    expect(loaded).toEqual(
      expect.arrayContaining(['tests/e2e/support/stack.ts', 'apps/api/src/config.ts']),
    );
    expect(
      loaded,
      "the layout spec must not load the API's test harness: import RUNTIME_ENV_NAMES from " +
        "'@tinnox/api/test-support/runtime-env', and keep tests/e2e/support/stack.ts and its " +
        "imports off '@tinnox/api/test-support'",
    ).not.toContain('apps/api/test/support.ts');
  });
});
