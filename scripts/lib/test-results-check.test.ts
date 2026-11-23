// The results gate over Playwright and Vitest results (U-15, adoption plan section 4.1). The
// Playwright fixtures below are trimmed real reports, not hand-written shapes: the plan marked
// the JSON shape unverified, and these settle it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import ResultsReporter from '../vitest-results-reporter.ts';
import { repoRoot } from './env.ts';
import {
  type AllowEntry,
  SKIPPED_MESSAGE,
  classify,
  e2eVerdict,
  filteredRun,
  PLAYWRIGHT_SUITES,
  parseAllowlist,
  parseCounts,
  parseGateArguments,
  playwrightTests,
  vitestCountFindings,
  vitestFindings,
} from './test-results-check.ts';

// Trimmed from real reports of Playwright 1.65.1 on 2026-11-23 (see the header). Only the
// fields the gate reads and their neighbours are kept: no stdout, stack, attachment or path.
/** Spec 02 with four throwaway edits, run with --retries=1: flaky, skipped at run time (testInfo.skip()), failed, and did not run behind the failure. */
const SHAPES = {
  suites: [
    {
      title: '02-canvases.spec.ts',
      file: '02-canvases.spec.ts',
      column: 0,
      line: 0,
      specs: [
        {
          title: 'portrait 1080x1920: contain and cover are drawn where the geometry says',
          ok: true,
          tags: [],
          tests: [
            {
              timeout: 240000,
              annotations: [{ type: 'serial' }],
              expectedStatus: 'passed',
              projectId: 'chromium',
              projectName: 'chromium',
              results: [
                { workerIndex: 0, status: 'failed', duration: 1, errors: [], retry: 0 },
                { workerIndex: 1, status: 'passed', duration: 6426, errors: [], retry: 1 },
              ],
              status: 'flaky',
            },
          ],
          id: '6aff851d5726bec66d5d-f204462e674be4057dda',
          file: '02-canvases.spec.ts',
          line: 183,
          column: 3,
        },
        {
          title: 'tall strip 640x1344: contain and cover are drawn where the geometry says',
          ok: true,
          tags: [],
          tests: [
            {
              timeout: 240000,
              annotations: [
                { type: 'serial' },
                { type: 'skip', description: 'throwaway run-time skip' },
              ],
              expectedStatus: 'skipped',
              projectId: 'chromium',
              projectName: 'chromium',
              results: [
                { workerIndex: -1, status: 'skipped', duration: 0, errors: [], retry: 0 },
                { workerIndex: 1, status: 'skipped', duration: 0, errors: [], retry: 1 },
              ],
              status: 'skipped',
            },
          ],
          id: '6aff851d5726bec66d5d-1e28b629c6fbd37fb06f',
          file: '02-canvases.spec.ts',
          line: 183,
          column: 3,
        },
        {
          title:
            'wide panel 768x448 with a content rectangle: contain and cover are drawn where the geometry says',
          ok: false,
          tags: [],
          tests: [
            {
              timeout: 240000,
              annotations: [{ type: 'serial' }],
              expectedStatus: 'passed',
              projectId: 'chromium',
              projectName: 'chromium',
              results: [
                { workerIndex: -1, status: 'skipped', duration: 0, errors: [], retry: 0 },
                { workerIndex: 1, status: 'failed', duration: 0, errors: [], retry: 1 },
              ],
              status: 'unexpected',
            },
          ],
          id: '6aff851d5726bec66d5d-c40fc4bba38162f52881',
          file: '02-canvases.spec.ts',
          line: 183,
          column: 3,
        },
        {
          title: 'rotation 90: a portrait canvas is turned clockwise to fill a landscape screen',
          ok: true,
          tags: [],
          tests: [
            {
              timeout: 240000,
              annotations: [{ type: 'serial' }],
              expectedStatus: 'passed',
              projectId: 'chromium',
              projectName: 'chromium',
              results: [
                { workerIndex: -1, status: 'skipped', duration: 0, errors: [], retry: 0 },
                { workerIndex: -1, status: 'skipped', duration: 0, errors: [], retry: 1 },
              ],
              status: 'skipped',
            },
          ],
          id: '6aff851d5726bec66d5d-4e8007d522cb38531c4a',
          file: '02-canvases.spec.ts',
          line: 274,
          column: 1,
        },
      ],
    },
  ],
  errors: [],
  stats: {
    startTime: '2026-11-22T19:17:07.062Z',
    duration: 15519.051,
    expected: 0,
    skipped: 2,
    unexpected: 1,
    flaky: 1,
  },
};

/** Specs 12 and 13 alone, the first two tests: passed. */
const PASSED = {
  suites: [
    {
      title: '12-layouts-portal.spec.ts',
      file: '12-layouts-portal.spec.ts',
      column: 0,
      line: 0,
      specs: [
        {
          title: 'a layout is created through the dialog by keyboard',
          ok: true,
          tags: [],
          tests: [
            {
              timeout: 240000,
              annotations: [{ type: 'serial' }],
              expectedStatus: 'passed',
              projectId: 'chromium',
              projectName: 'chromium',
              results: [{ workerIndex: 0, status: 'passed', duration: 270, errors: [], retry: 0 }],
              status: 'expected',
            },
          ],
          id: '905fa7afe5b28fffc86a-63bff03fb799c8b27a92',
          file: '12-layouts-portal.spec.ts',
          line: 115,
          column: 1,
        },
        {
          title: 'a zone without a playlist is refused, and the summary leads to its select',
          ok: true,
          tags: [],
          tests: [
            {
              timeout: 240000,
              annotations: [{ type: 'serial' }],
              expectedStatus: 'passed',
              projectId: 'chromium',
              projectName: 'chromium',
              results: [{ workerIndex: 0, status: 'passed', duration: 141, errors: [], retry: 0 }],
              status: 'expected',
            },
          ],
          id: '905fa7afe5b28fffc86a-0e54c0c3a5fc0f27de93',
          file: '12-layouts-portal.spec.ts',
          line: 172,
          column: 1,
        },
      ],
    },
  ],
  errors: [],
  stats: {
    startTime: '2026-11-22T19:21:39.756Z',
    duration: 110617.034,
    expected: 18,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
  },
};

/** playwright test --list: every test listed, none started (results []), and nested describes. */
const LISTED = {
  suites: [
    {
      title: '09-review-round-2.spec.ts',
      file: '09-review-round-2.spec.ts',
      column: 0,
      line: 0,
      specs: [],
      suites: [
        {
          title: 'portal',
          file: '09-review-round-2.spec.ts',
          column: 6,
          line: 62,
          specs: [
            {
              title:
                'FCX-03: a save that is still running when its tab comes back keeps the form read-only',
              ok: true,
              tags: [],
              tests: [
                {
                  timeout: 240000,
                  annotations: [{ type: 'serial' }],
                  expectedStatus: 'passed',
                  projectId: 'chromium',
                  projectName: 'chromium',
                  results: [],
                  status: 'skipped',
                },
              ],
              id: 'bc0d6e49712cdfe33f1a-f7a45aa72cd442bcb52c',
              file: '09-review-round-2.spec.ts',
              line: 73,
              column: 3,
            },
          ],
        },
        {
          title: 'player and app renderer',
          file: '09-review-round-2.spec.ts',
          column: 6,
          line: 237,
          specs: [
            {
              title:
                'FCU-01: player information screens keep a 120-letter name and the pairing code on screen',
              ok: true,
              tags: [],
              tests: [
                {
                  timeout: 240000,
                  annotations: [],
                  expectedStatus: 'passed',
                  projectId: 'chromium',
                  projectName: 'chromium',
                  results: [],
                  status: 'skipped',
                },
              ],
              id: 'bc0d6e49712cdfe33f1a-f7fad4a71fbc68373268',
              file: '09-review-round-2.spec.ts',
              line: 238,
              column: 3,
            },
          ],
        },
      ],
    },
  ],
  errors: [],
  stats: {
    startTime: '2026-11-22T19:25:27.243Z',
    duration: 579.528,
    expected: 0,
    skipped: 150,
    unexpected: 0,
    flaky: 0,
  },
};

/** The error a failing global teardown leaves outside any test (spec 14 with an injected sign-out failure). */
const TEARDOWN_ERRORS = [
  {
    message:
      'Error: global teardown could not sign out 1 saved E2E session(s): throwaway: injected sign-out failure. Sign them out in Keycloak (Sessions of the tinnox-dev realm) and find why the sign-out failed.',
  },
];

const TODAY = '2026-11-23';
const SPEC_02 = new Map([['02-canvases.spec.ts', 4]]);
const FLAKY_ID =
  '02-canvases.spec.ts › portrait 1080x1920: contain and cover are drawn where the geometry says';
const SKIPPED_ID =
  '02-canvases.spec.ts › tall strip 640x1344: contain and cover are drawn where the geometry says';
const FAILED_ID =
  '02-canvases.spec.ts › wide panel 768x448 with a content rectangle: contain and cover are drawn where the geometry says';
const NOT_RUN_ID =
  '02-canvases.spec.ts › rotation 90: a portrait canvas is turned clockwise to fill a landscape screen';

const entry = (overrides: Partial<AllowEntry> = {}): AllowEntry => ({
  test: NOT_RUN_ID,
  result: 'did-not-run',
  owner: 'Michael Fu',
  reason: 'waits for the Text-app fit fix',
  reviewBy: '2026-12-20',
  ...overrides,
});

describe('playwrightTests and classify', () => {
  it("names each outcome as Playwright's own summary does (1 failed, 1 flaky, 1 skipped, 1 did not run)", () => {
    expect(playwrightTests(SHAPES).tests.map((t) => [t.id, t.outcome])).toEqual([
      [FLAKY_ID, 'flaky'],
      [SKIPPED_ID, 'skipped'],
      [FAILED_ID, 'failed'],
      [NOT_RUN_ID, 'did-not-run'],
    ]);
  });

  it('reads a listed test that never started as did not run, and joins describe titles', () => {
    expect(playwrightTests(LISTED).tests).toEqual([
      {
        id: '09-review-round-2.spec.ts › portal › FCX-03: a save that is still running when its tab comes back keeps the form read-only',
        file: '09-review-round-2.spec.ts',
        outcome: 'did-not-run',
      },
      {
        id: '09-review-round-2.spec.ts › player and app renderer › FCU-01: player information screens keep a 120-letter name and the pairing code on screen',
        file: '09-review-round-2.spec.ts',
        outcome: 'did-not-run',
      },
    ]);
  });

  it('reads test.fail() and an interrupted result', () => {
    expect(
      classify({ status: 'expected', expectedStatus: 'failed', results: [{ status: 'failed' }] }),
    ).toBe('expected-to-fail');
    expect(
      classify({
        status: 'skipped',
        expectedStatus: 'passed',
        results: [{ status: 'interrupted' }],
      }),
    ).toBe('interrupted');
  });

  it('keeps the first line of an error outside any test, without colour codes', () => {
    expect(playwrightTests({ ...PASSED, errors: TEARDOWN_ERRORS }).errors).toEqual([
      'Error: global teardown could not sign out 1 saved E2E session(s): throwaway: injected sign-out failure. Sign them out in Keycloak (Sessions of the tinnox-dev realm) and find why the sign-out failed.',
    ]);
    // Synthetic: Playwright colours some messages it reports.
    expect(
      playwrightTests({ ...PASSED, errors: [{ message: '\u001b[31mTimed out\u001b[39m\n  at x' }] })
        .errors,
    ).toEqual(['Timed out']);
  });

  it('refuses a file that is not a Playwright report', () => {
    expect(() => playwrightTests({ testResults: [] })).toThrow(/not a Playwright JSON report/);
  });
});

describe('e2eVerdict', () => {
  it('passes a run in which every expected test passed on its first try', () => {
    const verdict = e2eVerdict(PASSED, new Map([['12-layouts-portal.spec.ts', 2]]), [], TODAY);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.summary).toBe('2 test(s) in 1 file(s): 2 passed');
  });

  it('fails a test skipped at run time with the words of the skip lint, and has no allow-list for it (LINT-16)', () => {
    const verdict = e2eVerdict(
      SHAPES,
      SPEC_02,
      [entry({ test: SKIPPED_ID, result: 'skipped' })],
      TODAY,
    );
    expect(verdict.blocking).toContain(`${SKIPPED_ID}: ${SKIPPED_MESSAGE}`);
    expect(verdict.blocking).toContain(
      `tests/skip-allowlist.json entry "${SKIPPED_ID}": "result" must be "did-not-run" or "flaky"; a skip has no allow-list (U-15)`,
    );
  });

  it('fails a flaky test, a failed test and one that did not run, each with what to do', () => {
    const blocking = e2eVerdict(SHAPES, SPEC_02, [], TODAY).blocking;
    expect(blocking).toHaveLength(4);
    expect(blocking[0]).toMatch(
      new RegExp(`^${FLAKY_ID}: failed, then passed on a retry: .*tests/skip-allowlist\\.json`),
    );
    expect(blocking[2]).toBe(`${FAILED_ID}: failed; the runner output above says why.`);
    expect(blocking[3]).toMatch(
      new RegExp(
        `^${NOT_RUN_ID}: did not run, so it proves nothing \\(U-15\\)\\. In a serial file it sits behind the first failure`,
      ),
    );
  });

  it('lets a dated allow-list entry excuse a test that did not run, and only for that result', () => {
    const verdict = e2eVerdict(
      SHAPES,
      SPEC_02,
      [entry(), entry({ test: FLAKY_ID, result: 'did-not-run' })],
      TODAY,
    );
    expect(verdict.allowed).toEqual([
      `${NOT_RUN_ID}: did-not-run, allowed until 2026-12-20, owner Michael Fu: waits for the Text-app fit fix`,
    ]);
    expect(verdict.blocking.some((line) => line.startsWith(`${NOT_RUN_ID}:`))).toBe(false);
    expect(
      verdict.blocking.some((line) => line.startsWith(`${FLAKY_ID}: failed, then passed`)),
    ).toBe(true);
  });

  it.each([
    [{ owner: ' ' }, 'test, owner and reason are required'],
    [{ reviewBy: '20 Dec' }, 'reviewBy must be a date as YYYY-MM-DD, got "20 Dec"'],
    [{ reviewBy: '2026-11-22' }, 'passed its review date 2026-11-22'],
    [{ reviewBy: '2027-02-22' }, 'reviewBy 2027-02-22 is more than 90 days ahead'],
    [{ test: '02-canvases.spec.ts › gone' }, 'names no test of this run'],
  ])('refuses an allow-list entry with %j', (overrides, message) => {
    const verdict = e2eVerdict(SHAPES, SPEC_02, [entry(overrides)], TODAY);
    expect(verdict.blocking.some((line) => line.includes(message))).toBe(true);
    expect(verdict.allowed).toEqual([]);
  });

  it('refuses the same entry twice', () => {
    const blocking = e2eVerdict(SHAPES, SPEC_02, [entry(), entry()], TODAY).blocking;
    expect(blocking).toContain(
      `tests/skip-allowlist.json entry "${NOT_RUN_ID}": listed twice for "did-not-run"`,
    );
  });

  it('fails an error outside any test, such as a global teardown that could not sign out', () => {
    const blocking = e2eVerdict(
      { ...PASSED, errors: TEARDOWN_ERRORS },
      new Map([['12-layouts-portal.spec.ts', 2]]),
      [],
      TODAY,
    ).blocking;
    expect(blocking).toEqual([
      'Playwright reported an error outside any test (global set-up or teardown, a hook or a worker): Error: global teardown could not sign out 1 saved E2E session(s): throwaway: injected sign-out failure. Sign them out in Keycloak (Sessions of the tinnox-dev realm) and find why the sign-out failed. Fix it: the run did not finish clean.',
    ]);
  });

  it('fails a run whose spec files do not hold the tests tests/test-counts.json expects', () => {
    const counts = new Map([
      ['12-layouts-portal.spec.ts', 3],
      ['03-isolation.spec.ts', 1],
    ]);
    const blocking = e2eVerdict(
      {
        ...PASSED,
        suites: [
          ...PASSED.suites,
          { title: 'new.spec.ts', file: 'new.spec.ts', specs: PASSED.suites[0]?.specs.slice(0, 1) },
        ],
      },
      counts,
      [],
      TODAY,
    ).blocking;
    expect(blocking).toEqual([
      '03-isolation.spec.ts is not in this run, tests/test-counts.json expects 1 test(s) from it: run the whole suite (npm run test:e2e) before this check, with no file, grep or project filter. If the file no longer declares any test (a describe or a loop that lost its tests), bring them back; if it was renamed or deleted, change tests/test-counts.json in the same change',
      '12-layouts-portal.spec.ts holds 2 test(s) in this run, tests/test-counts.json expects 3: a test or file that should run was not loaded (a grep, a testMatch or a renamed file), or a test was added or deleted. If the change is deliberate, set the count under "e2e" in tests/test-counts.json in the same change',
      'new.spec.ts holds 1 test(s) and tests/test-counts.json lists no count for it: add "new.spec.ts": 1 under "e2e" in the same change',
    ]);
  });
});

describe('the layout suite (CHK-2)', () => {
  const LAYOUT = PLAYWRIGHT_SUITES['layout'];
  const counts = new Map([['12-layouts-portal.spec.ts', 2]]);

  it('names its own counts and command when a file is missing or new', () => {
    if (LAYOUT === undefined) throw new Error('no layout suite');
    const blocking = e2eVerdict(
      { ...PASSED, suites: [{ ...PASSED.suites[0], file: 'new.spec.ts', title: 'new.spec.ts' }] },
      counts,
      [],
      TODAY,
      LAYOUT,
    ).blocking;
    expect(blocking).toEqual([
      '12-layouts-portal.spec.ts is not in this run, tests/test-counts.json expects 2 test(s) from it: run the whole suite (npx playwright test -c tests/playwright.layout.config.ts) before this check, with no file, grep or project filter. If the file no longer declares any test (a describe or a loop that lost its tests), bring them back; if it was renamed or deleted, change tests/test-counts.json in the same change',
      'new.spec.ts holds 2 test(s) and tests/test-counts.json lists no count for it: add "new.spec.ts": 2 under "layout" in the same change',
    ]);
  });

  it('fails a test skipped at run time, as the full suite does', () => {
    if (LAYOUT === undefined) throw new Error('no layout suite');
    expect(e2eVerdict(SHAPES, SPEC_02, [], TODAY, LAYOUT).blocking).toContain(
      `${SKIPPED_ID}: ${SKIPPED_MESSAGE}`,
    );
  });

  it('leaves an allow-list entry for a test outside its run to the full suite, and still applies one inside it', () => {
    if (LAYOUT === undefined) throw new Error('no layout suite');
    const outside = entry({ test: '01-journey.spec.ts › a test the layout run never holds' });
    const verdict = e2eVerdict(SHAPES, SPEC_02, [outside, entry()], TODAY, LAYOUT);
    expect(verdict.blocking.some((line) => line.includes('01-journey.spec.ts'))).toBe(false);
    expect(verdict.allowed).toHaveLength(1);
    // The full suite still calls the same entry stale.
    expect(
      e2eVerdict(SHAPES, SPEC_02, [outside], TODAY).blocking.some((line) =>
        line.includes('names no test of this run'),
      ),
    ).toBe(true);
  });
});

describe('the full suite report (CHK-3)', () => {
  it('is removed before Playwright starts, so a run that never wrote one meets "no report", not the last run', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'tests', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // The script runs in tests/, the gate reads from the repository root.
    expect(PLAYWRIGHT_SUITES['e2e']?.report).toBe('tests/.run/e2e-results.json');
    expect(pkg.scripts['e2e']).toMatch(
      /^node -e "require\('node:fs'\)\.rmSync\('\.run\/e2e-results\.json', \{ force: true \}\)" && playwright test$/,
    );
  });
});

describe('parseGateArguments', () => {
  it('reads the full suite by default, and a counts section and a report path when given', () => {
    expect(parseGateArguments([])).toEqual({ suite: PLAYWRIGHT_SUITES['e2e'], report: undefined });
    expect(parseGateArguments(['--counts', 'layout'])).toEqual({
      suite: PLAYWRIGHT_SUITES['layout'],
      report: undefined,
    });
    expect(parseGateArguments(['--counts=layout', 'x.json'])).toEqual({
      suite: PLAYWRIGHT_SUITES['layout'],
      report: 'x.json',
    });
    expect(PLAYWRIGHT_SUITES['layout']?.report).toBe('tests/.run/layout-results.json');
  });

  it('refuses a suite it does not know and a second report, saying what to pass', () => {
    expect(() => parseGateArguments(['--counts', 'vitest'])).toThrow(
      /no Playwright suite "vitest": use one of e2e, layout/,
    );
    expect(() => parseGateArguments(['a.json', 'b.json'])).toThrow(/unknown argument "b\.json"/);
  });
});

describe('parseCounts and parseAllowlist', () => {
  it('reads the e2e counts and refuses a count that is not a whole number above 0', () => {
    expect(parseCounts({ e2e: { 'a.spec.ts': 3 } }, 'e2e')).toEqual(new Map([['a.spec.ts', 3]]));
    expect(() => parseCounts({ e2e: { 'a.spec.ts': 0 } }, 'e2e')).toThrow(/whole number above 0/);
    expect(() => parseCounts({}, 'e2e')).toThrow(/must hold an object "e2e"/);
  });

  it('reads a missing field as empty, which the verdict refuses', () => {
    expect(parseAllowlist({ entries: [{ test: 'x', owner: 3 }] })).toEqual([
      { test: 'x', result: '', owner: '', reason: '', reviewBy: '' },
    ]);
    expect(() => parseAllowlist({ exceptions: [] })).toThrow(/"entries" array/);
  });
});

describe('vitestFindings', () => {
  const base = {
    project: 'unit',
    file: 'scripts/lib/a.test.ts',
    name: 'group > case',
    mode: 'run',
    hookFailed: false,
  };

  it('names a test skipped or todo at run time, and one that never started', () => {
    expect(
      vitestFindings([
        { ...base, state: 'passed' },
        { ...base, state: 'failed' },
        { ...base, state: 'skipped' },
        { ...base, state: 'skipped', mode: 'todo' },
        { ...base, state: 'pending' },
      ]),
    ).toEqual([
      `[unit] scripts/lib/a.test.ts > group > case was skipped: ${SKIPPED_MESSAGE}`,
      `[unit] scripts/lib/a.test.ts > group > case is a todo: ${SKIPPED_MESSAGE}`,
      '[unit] scripts/lib/a.test.ts > group > case did not run, so it proves nothing (U-15): fix the failure that stopped the run before it.',
    ]);
  });

  it('names a test held back by a failed beforeAll as not run, not as a skip to delete', () => {
    expect(vitestFindings([{ ...base, state: 'skipped', hookFailed: true }])).toEqual([
      '[unit] scripts/lib/a.test.ts > group > case did not run: a beforeAll hook or the file failed before it (U-15). Fix that failure; the runner output above names it. The test itself needs no change.',
    ]);
  });
});

describe('filteredRun (CHK-1)', () => {
  it('is false for a run of whole files, with no filter of any kind', () => {
    expect(filteredRun(undefined, undefined, [{}, {}])).toBe(false);
    expect(filteredRun(undefined, [], [{ testLines: [], testIds: [], testTagsFilter: [] }])).toBe(
      false,
    );
  });

  it.each([
    ['a test name pattern (-t, or the watch mode t)', /one/, undefined, {}],
    ['a tag filter in the config', undefined, ['slow'], {}],
    ['a file:line location', undefined, undefined, { testLines: [2] }],
    ['test ids from an IDE', undefined, undefined, { testIds: ['abc_0_1'] }],
    ['full test names', undefined, undefined, { testNames: ['group > case'] }],
    ['a name pattern on one file', undefined, undefined, { testNamePattern: /two/ }],
    ['a tag filter on one file', undefined, undefined, { testTagsFilter: ['slow'] }],
  ] as const)('is true for %s', (_what, pattern, tags, spec) => {
    expect(filteredRun(pattern, tags, [{}, spec])).toBe(true);
  });
});

describe('vitestCountFindings', () => {
  it('fails a project below its floor or with no floor, and passes one at or above it', () => {
    const floors = new Map([
      ['unit', 10],
      ['component', 5],
    ]);
    expect(
      vitestCountFindings(
        new Map([
          ['unit', 9],
          ['component', 6],
          ['integration', 3],
        ]),
        floors,
      ),
    ).toEqual([
      '[integration] holds 3 test(s) and tests/test-counts.json lists no floor for it: add "integration": 3 under "vitest" in the same change',
      '[unit] holds 9 test(s), tests/test-counts.json expects at least 10 (U-15): a describe, a loop over no cases or a file that no longer loads dropped tests. Bring them back; if the drop is deliberate, lower "unit" under "vitest" in tests/test-counts.json in the same change',
    ]);
    expect(vitestCountFindings(new Map([['unit', 10]]), floors)).toEqual([]);
  });

  it('reads the floors of the repository file', () => {
    expect(parseCounts({ vitest: { unit: 2 } }, 'vitest')).toEqual(new Map([['unit', 2]]));
  });
});

// Runs a real Vitest instance over throwaway files, so the reporter is proven against the
// objects Vitest 5 really hands it. Starting Vitest is a cold start a busy CI runner can
// stretch past the 5 s default.
describe('the Vitest results reporter', { timeout: 30_000 }, () => {
  /**
   * Writes the files to a temporary folder, runs them (only `filters`, paths in that folder, if
   * given) with the reporter and returns its findings. Globals, so a file needs no import that would have to
   * resolve from the temporary folder. Its one project has the name "".
   */
  async function findingsOf(
    files: Record<string, string[]>,
    floors: ReadonlyMap<string, number>,
    filters: string[] = [],
    options: Parameters<typeof createVitest>[1] = {},
  ): Promise<string[]> {
    // The real path: on macOS the temporary folder is behind the /var link, and Vitest matches
    // a location filter against the resolved path.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tinnox-results-')));
    try {
      for (const [name, lines] of Object.entries(files)) {
        writeFileSync(join(dir, name), lines.join('\n'));
      }
      const found: string[] = [];
      const vitest = await createVitest(
        'test',
        {
          root: dir,
          config: false,
          globals: true,
          watch: false,
          reporters: [new ResultsReporter({ fail: (findings) => found.push(...findings), floors })],
          ...options,
        },
        {},
      );
      try {
        await vitest.start(filters.map((filter) => join(dir, filter)));
      } finally {
        await vitest.close();
      }
      return found;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const NOT_RUN =
    'did not run: a beforeAll hook or the file failed before it (U-15). Fix that failure; the runner output above names it. The test itself needs no change.';

  it('reports ctx.skip() and a todo at run time, and leaves a passing test alone', async () => {
    const found = await findingsOf(
      {
        'throwaway.test.js': [
          "test('runs', () => {});",
          "test('skips at run time', (ctx) => { ctx.skip(); });",
          "test.todo('is not written yet');",
        ],
      },
      new Map([['', 3]]),
    );
    expect(found).toEqual([
      `[] throwaway.test.js > skips at run time was skipped: ${SKIPPED_MESSAGE}`,
      `[] throwaway.test.js > is not written yet is a todo: ${SKIPPED_MESSAGE}`,
    ]);
  });

  it('reports the tests under a failed beforeAll as not run, and a ctx.skip() beside a failing test as a skip', async () => {
    const found = await findingsOf(
      {
        'hook.test.js': [
          "describe('set-up fails', () => {",
          "  beforeAll(() => { throw new Error('no database'); });",
          "  test('a', () => {});",
          '});',
          "describe('a test fails', () => {",
          "  test('fails', () => { throw new Error('wrong'); });",
          "  test('skips at run time', (ctx) => { ctx.skip(); });",
          '});',
        ],
        'module.test.js': [
          "beforeAll(() => { throw new Error('no browser'); });",
          "test('b', () => {});",
        ],
      },
      new Map([['', 4]]),
    );
    expect([...found].sort()).toEqual(
      [
        `[] hook.test.js > set-up fails > a ${NOT_RUN}`,
        `[] hook.test.js > a test fails > skips at run time was skipped: ${SKIPPED_MESSAGE}`,
        `[] module.test.js > b ${NOT_RUN}`,
      ].sort(),
    );
  });

  const TWO_FILES = {
    'a.test.js': ["test('a1', () => {});", "test('a2', () => {});"],
    'b.test.js': [
      "describe('lost', () => {",
      '  for (const n of []) test(`b${n}`, () => {});',
      '});',
    ],
  };

  it('fails a full run below the floor, as when a loop yields no cases', async () => {
    expect(await findingsOf(TWO_FILES, new Map([['', 3]]))).toEqual([
      '[] holds 2 test(s), tests/test-counts.json expects at least 3 (U-15): a describe, a loop over no cases or a file that no longer loads dropped tests. Bring them back; if the drop is deliberate, lower "" under "vitest" in tests/test-counts.json in the same change',
    ]);
  });

  it('does not count a run of some files only', async () => {
    expect(await findingsOf(TWO_FILES, new Map([['', 3]]), ['a.test.js'])).toEqual([]);
  });

  const THREE = {
    'a.test.js': [
      "test('one', () => {});",
      "test('two', (ctx) => { ctx.skip(); });",
      "test('three', () => {});",
    ],
  };

  it('does not report the tests a file:line location leaves out (CHK-1)', async () => {
    expect(
      await findingsOf(THREE, new Map([['', 3]]), ['a.test.js:1'], { includeTaskLocation: true }),
    ).toEqual([]);
  });

  it('decides for every run whether it is filtered, as when the watch mode t filter changes (CHK-1)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tinnox-results-')));
    try {
      writeFileSync(join(dir, 'a.test.js'), THREE['a.test.js'].join('\n'));
      const found: string[][] = [];
      const reporter = new ResultsReporter({
        fail: (findings) => found.push(findings),
        floors: new Map([['', 3]]),
      });
      const vitest = await createVitest(
        'test',
        { root: dir, config: false, globals: true, watch: false, reporters: [reporter] },
        {},
      );
      try {
        // The first run selects 'one' by name, the second runs every test of the same file.
        vitest.setGlobalTestNamePattern('one');
        const { testModules } = await vitest.start();
        expect(found).toEqual([]);
        vitest.resetGlobalTestNamePattern();
        await vitest.rerunTestSpecifications(
          testModules.map((module) => module.toTestSpecification()),
        );
      } finally {
        await vitest.close();
      }
      expect(found).toEqual([[`[] a.test.js > two was skipped: ${SKIPPED_MESSAGE}`]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A second config that runs the same files without the reporter lets a ctx.skip() there exit 0
// (CHK-4: apps/api/vitest.config.ts, `npm run test:integration -w @tinnox/api`).
describe('every Vitest config of the repository', { timeout: 30_000 }, () => {
  const configs = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' })
    .stdout.split('\0')
    .filter((path) => /(^|\/)vitest\.(config|workspace)\.[cm]?[jt]s$/.test(path));

  it('finds the repository config and the API one', () => {
    expect(configs).toEqual(
      expect.arrayContaining(['vitest.config.ts', 'apps/api/vitest.config.ts']),
    );
  });

  it.each(configs)('%s lists the results reporter (CHK-4)', async (path) => {
    const config = ((await import(join(repoRoot, path))) as { default: unknown }).default as {
      test?: { reporters?: unknown[] };
    };
    expect(
      (config.test?.reporters ?? []).filter(
        (reporter) =>
          typeof reporter === 'string' && reporter.endsWith('scripts/vitest-results-reporter.ts'),
      ),
    ).toHaveLength(1);
  });
});
