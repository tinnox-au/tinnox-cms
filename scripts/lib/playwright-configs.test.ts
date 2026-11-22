import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import { PLAYWRIGHT_CONFIG, recordingProblems } from './playwright-configs.ts';

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

describe('the repository (OTH-05)', () => {
  const files = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .stdout.split('\0')
    .filter((path) => PLAYWRIGHT_CONFIG.test(path));

  it('finds both Playwright configs', () => {
    expect(files).toEqual(
      expect.arrayContaining(['tests/playwright.config.ts', 'tests/playwright.layout.config.ts']),
    );
  });

  it.each(files)('keeps traces, videos and screenshots off in %s', async (path) => {
    const config: unknown = ((await import(join(repoRoot, path))) as { default: unknown }).default;
    expect(recordingProblems(path, config)).toEqual([]);
  });
});
