// The results gate (U-15, adoption plan section 4.1): a run is green only when every test it
// should hold ran and passed on its first try. A runner exits 0 with a test skipped at run time
// (testInfo.skip(), ctx.skip()), with tests that never ran behind a failure in a serial file, or
// with a whole spec file missing; the lint of eslint.config.js (NO_SKIPPED_TESTS) sees only the
// declared forms. Used by:
//   - scripts/check-test-results.ts, over the JSON report of a Playwright run: the full suite
//     (the e2e job) or the stackless layout checks (the quality job), PLAYWRIGHT_SUITES below;
//   - scripts/vitest-results-reporter.ts, over the unit, component and integration runs.
// A skip, declared or at run time, has no allow-list. tests/skip-allowlist.json covers a test
// that did not run or passed only on a retry, each entry with an owner, a reason and a review
// date at most 90 days ahead (the shape and window of scripts/audit-exceptions.json).
import { stripVTControlCharacters } from 'node:util';

/** What a run did with one test. */
export type Outcome =
  'passed' | 'failed' | 'skipped' | 'did-not-run' | 'flaky' | 'expected-to-fail' | 'interrupted';

export interface TestRecord {
  /** "<spec file> › <describe titles> › <title>", as Playwright's list reporter names it. */
  id: string;
  file: string;
  outcome: Outcome;
}

export interface AllowEntry {
  test: string;
  result: string;
  owner: string;
  reason: string;
  reviewBy: string;
}

export interface Verdict {
  blocking: string[];
  allowed: string[];
  summary: string;
}

/** A Playwright run the gate reads: its counts under tests/test-counts.json and its report. */
export interface PlaywrightSuite {
  /** The object of tests/test-counts.json that holds the number of tests per spec file. */
  section: string;
  /** The command that runs the suite and writes its report. */
  command: string;
  /** The report its json reporter writes, from the repository root. */
  report: string;
  /**
   * The run holds some tests of the spec files the full suite also runs. An allow-list entry
   * for a test outside it is the full suite's to check, so it neither applies nor is "stale".
   */
  subset: boolean;
}

const E2E_SUITE: PlaywrightSuite = {
  section: 'e2e',
  command: 'npm run test:e2e',
  report: 'tests/.run/e2e-results.json',
  subset: false,
};

export const PLAYWRIGHT_SUITES: Readonly<Record<string, PlaywrightSuite>> = {
  e2e: E2E_SUITE,
  // tests/playwright.layout.config.ts, in the quality job (CHK-2).
  layout: {
    section: 'layout',
    command: 'npx playwright test -c tests/playwright.layout.config.ts',
    report: 'tests/.run/layout-results.json',
    subset: true,
  },
};

const GATE_USAGE =
  'usage: npm run check:test-results -- [--counts <e2e|layout>] [<report.json>]; with no report, the one the suite writes';

/**
 * The arguments of scripts/check-test-results.ts: `--counts <suite>` picks a suite of
 * PLAYWRIGHT_SUITES (e2e by default), and a path, the report to read instead of its own.
 */
export function parseGateArguments(args: readonly string[]): {
  suite: PlaywrightSuite;
  report: string | undefined;
} {
  let name = 'e2e';
  let report: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--counts') {
      name = args[(index += 1)] ?? '';
    } else if (arg.startsWith('--counts=')) {
      name = arg.slice('--counts='.length);
    } else if (arg.startsWith('-') || report !== undefined) {
      throw new Error(`unknown argument "${arg}". ${GATE_USAGE}`);
    } else {
      report = arg;
    }
  }
  const suite = PLAYWRIGHT_SUITES[name];
  if (suite === undefined) {
    throw new Error(
      `no Playwright suite "${name}": use one of ${Object.keys(PLAYWRIGHT_SUITES).join(', ')}, or add it to PLAYWRIGHT_SUITES in scripts/lib/test-results-check.ts with its counts in tests/test-counts.json. ${GATE_USAGE}`,
    );
  }
  return { suite, report };
}

const ALLOW_FILE = 'tests/skip-allowlist.json';
const COUNTS_FILE = 'tests/test-counts.json';
const ALLOWABLE: readonly Outcome[] = ['did-not-run', 'flaky'];
const MAX_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The lint's words (NO_SKIPPED_TESTS in eslint.config.js), for the forms it cannot see. */
export const SKIPPED_MESSAGE =
  'a skipped or expected-to-fail test is a red run (U-15): it hides a failure. Fix the test or delete it in this change; there is no allow-list for a skip, declared or at run time (testInfo.skip(), ctx.skip(), a skip condition).';

const allowHint = (result: Outcome): string =>
  `If it cannot be fixed in this change, list it in ${ALLOW_FILE} with "result": "${result}", an owner, a reason and a reviewBy date at most ${MAX_WINDOW_DAYS} days ahead.`;

const MESSAGES: Record<Exclude<Outcome, 'passed'>, string> = {
  failed: 'failed; the runner output above says why.',
  skipped: SKIPPED_MESSAGE,
  'expected-to-fail': SKIPPED_MESSAGE,
  'did-not-run': `did not run, so it proves nothing (U-15). In a serial file it sits behind the first failure: fix that one. ${allowHint('did-not-run')}`,
  flaky: `failed, then passed on a retry: a flaky test is a red run (U-15). Fix the race or the wait. ${allowHint('flaky')}`,
  interrupted: 'was interrupted: the run stopped before the test finished, so nothing is proven.',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Playwright's own classification (generateSummary in playwright/lib/runner, 1.65), over the
 * JSON reporter's fields: `status` is the test's outcome, `expectedStatus` is 'skipped' after
 * test.skip() or testInfo.skip() and 'failed' after test.fail(), and a test that never started
 * has no result at all, or results without an expected skip.
 */
export function classify(test: unknown): Outcome {
  const status = isObject(test) ? test['status'] : undefined;
  const expected = isObject(test) ? test['expectedStatus'] : undefined;
  const results = list(isObject(test) ? test['results'] : undefined);
  const resultStatus = (result: unknown): unknown => (isObject(result) ? result['status'] : '');
  if (results.some((result) => resultStatus(result) === 'interrupted')) return 'interrupted';
  switch (status) {
    case 'expected':
      return expected === 'passed' ? 'passed' : 'expected-to-fail';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return results.length === 0 || expected !== 'skipped' ? 'did-not-run' : 'skipped';
    default:
      return 'failed';
  }
}

/**
 * Every test of a Playwright JSON report (`reporter: [['json', { outputFile }]]`), and the
 * errors it holds outside any test (global set-up or teardown, a worker, an afterAll hook).
 */
export function playwrightTests(report: unknown): { tests: TestRecord[]; errors: string[] } {
  if (!isObject(report) || !Array.isArray(report['suites']) || !isObject(report['stats'])) {
    throw new Error(
      'not a Playwright JSON report (no "suites" and "stats"): pass the file the json reporter of tests/playwright.config.ts writes',
    );
  }
  const tests: TestRecord[] = [];
  const walk = (suite: unknown, file: string, titles: string[]): void => {
    if (!isObject(suite)) return;
    for (const spec of list(suite['specs'])) {
      if (!isObject(spec)) continue;
      const id = [file, ...titles, text(spec['title'])].join(' › ');
      for (const test of list(spec['tests'])) tests.push({ id, file, outcome: classify(test) });
    }
    for (const child of list(suite['suites'])) {
      walk(child, file, [...titles, isObject(child) ? text(child['title']) : '']);
    }
  };
  // The top-level suites are the spec files; their title is the file's path under testDir.
  for (const suite of report['suites']) {
    walk(suite, isObject(suite) ? text(suite['file']) || text(suite['title']) : '', []);
  }
  // Playwright colours the messages it reports; the gate prints the first line, plain.
  const errors = list(report['errors']).map((error) => {
    const message = stripVTControlCharacters(isObject(error) ? text(error['message']) : '');
    return message.split('\n')[0]?.slice(0, 300) || '(no message)';
  });
  return { tests, errors };
}

/**
 * tests/test-counts.json: under "e2e", the number of tests each spec file holds; under
 * "vitest", the floor of tests each Vitest project holds.
 */
export function parseCounts(file: unknown, suite: string): Map<string, number> {
  const counts = isObject(file) ? file[suite] : undefined;
  if (!isObject(counts)) {
    throw new Error(`${COUNTS_FILE} must hold an object "${suite}" of name to test count`);
  }
  const parsed = new Map<string, number>();
  for (const [name, count] of Object.entries(counts)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      throw new Error(`${COUNTS_FILE}: "${suite}" › "${name}" must be a whole number above 0`);
    }
    parsed.set(name, count);
  }
  return parsed;
}

/**
 * The entries of tests/skip-allowlist.json (parsed JSON). A field that is missing or not a
 * string reads as '', which e2eVerdict() blocks with the message for that field.
 */
export function parseAllowlist(file: unknown): AllowEntry[] {
  if (!isObject(file) || !Array.isArray(file['entries'])) {
    throw new Error(`${ALLOW_FILE} must be an object with an "entries" array`);
  }
  return file['entries'].map((entry: unknown) => {
    const field = (name: keyof AllowEntry): string => text(isObject(entry) ? entry[name] : '');
    return {
      test: field('test'),
      result: field('result'),
      owner: field('owner'),
      reason: field('reason'),
      reviewBy: field('reviewBy'),
    };
  });
}

function parseDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value
    ? undefined
    : time;
}

function countProblems(
  tests: TestRecord[],
  expected: Map<string, number>,
  suite: PlaywrightSuite,
): string[] {
  const found = new Map<string, number>();
  for (const test of tests) found.set(test.file, (found.get(test.file) ?? 0) + 1);
  const files = [...new Set([...expected.keys(), ...found.keys()])].sort();
  const problems: string[] = [];
  for (const file of files) {
    const want = expected.get(file);
    const have = found.get(file) ?? 0;
    if (want === undefined) {
      problems.push(
        `${file} holds ${have} test(s) and ${COUNTS_FILE} lists no count for it: add "${file}": ${have} under "${suite.section}" in the same change`,
      );
    } else if (have === 0) {
      problems.push(
        `${file} is not in this run, ${COUNTS_FILE} expects ${want} test(s) from it: run the whole suite (${suite.command}) before this check, with no file, grep or project filter. If the file no longer declares any test (a describe or a loop that lost its tests), bring them back; if it was renamed or deleted, change ${COUNTS_FILE} in the same change`,
      );
    } else if (have !== want) {
      problems.push(
        `${file} holds ${have} test(s) in this run, ${COUNTS_FILE} expects ${want}: a test or file that should run was not loaded (a grep, a testMatch or a renamed file), or a test was added or deleted. If the change is deliberate, set the count under "${suite.section}" in ${COUNTS_FILE} in the same change`,
      );
    }
  }
  return problems;
}

/**
 * @param report the Playwright JSON report of a full run of `suite`
 * @param counts parseCounts(tests/test-counts.json, suite.section)
 * @param today YYYY-MM-DD in UTC
 */
export function e2eVerdict(
  report: unknown,
  counts: Map<string, number>,
  allowlist: AllowEntry[],
  today: string,
  suite: PlaywrightSuite = E2E_SUITE,
): Verdict {
  const todayTime = parseDay(today);
  if (todayTime === undefined) throw new Error(`today must be YYYY-MM-DD, got "${today}"`);
  const { tests, errors } = playwrightTests(report);
  const blocking: string[] = [];
  const allowed: string[] = [];

  for (const error of errors) {
    blocking.push(
      `Playwright reported an error outside any test (global set-up or teardown, a hook or a worker): ${error.replace(/\.$/, '')}. Fix it: the run did not finish clean.`,
    );
  }

  const valid: AllowEntry[] = [];
  const seen = new Set<string>();
  const ids = new Set(tests.map((test) => test.id));
  for (const entry of allowlist) {
    if (suite.subset && !ids.has(entry.test)) continue;
    const label = `${ALLOW_FILE} entry "${entry.test || '(no test)'}"`;
    const reviewTime = parseDay(entry.reviewBy);
    if (!ALLOWABLE.some((outcome) => outcome === entry.result)) {
      blocking.push(
        `${label}: "result" must be "did-not-run" or "flaky"; a skip has no allow-list (U-15)`,
      );
    } else if (!entry.test || !entry.owner.trim() || !entry.reason.trim()) {
      blocking.push(`${label}: test, owner and reason are required`);
    } else if (reviewTime === undefined) {
      blocking.push(`${label}: reviewBy must be a date as YYYY-MM-DD, got "${entry.reviewBy}"`);
    } else if (seen.has(`${entry.test} ${entry.result}`)) {
      blocking.push(`${label}: listed twice for "${entry.result}"`);
    } else if (reviewTime < todayTime) {
      blocking.push(
        `${label} passed its review date ${entry.reviewBy}: fix the test and remove the entry, or renew it with a new date`,
      );
    } else if (reviewTime - todayTime > MAX_WINDOW_DAYS * DAY_MS) {
      blocking.push(
        `${label}: reviewBy ${entry.reviewBy} is more than ${MAX_WINDOW_DAYS} days ahead`,
      );
    } else if (!ids.has(entry.test)) {
      blocking.push(
        `${label} names no test of this run: remove it, or correct it to "<spec file> › <describe titles> › <title>" as the run lists it`,
      );
    } else {
      valid.push(entry);
    }
    seen.add(`${entry.test} ${entry.result}`);
  }

  const tally = new Map<Outcome, number>();
  for (const test of tests) {
    tally.set(test.outcome, (tally.get(test.outcome) ?? 0) + 1);
    if (test.outcome === 'passed') continue;
    const entry = valid.find((e) => e.test === test.id && e.result === test.outcome);
    if (entry === undefined) {
      blocking.push(`${test.id}: ${MESSAGES[test.outcome]}`);
    } else {
      allowed.push(
        `${test.id}: ${test.outcome}, allowed until ${entry.reviewBy}, owner ${entry.owner}: ${entry.reason}`,
      );
    }
  }

  blocking.push(...countProblems(tests, counts, suite));

  const files = new Set(tests.map((test) => test.file)).size;
  const outcomes = [...tally.entries()].map(([outcome, n]) => `${n} ${outcome}`).join(', ');
  return {
    blocking,
    allowed,
    summary: `${tests.length} test(s) in ${files} file(s)${outcomes ? `: ${outcomes}` : ''}`,
  };
}

/** One test of a Vitest run, read from the reporter API (TestCase in vitest/node, 5.1). */
export interface VitestCase {
  project: string;
  /** The test file, relative to the repository. */
  file: string;
  /** Describe titles and the test title, as TestCase.fullName gives them. */
  name: string;
  /** TestCase.result().state: passed, failed, skipped or pending (never started). */
  state: string;
  /** TestCase.options.mode: run, only, skip or todo. */
  mode: string;
  /** A beforeAll of an enclosing suite, or the module itself, failed before the test ran. */
  hookFailed: boolean;
}

/** The filters of one test file in a Vitest run (TestSpecification in vitest/node, 5.1). */
export interface SpecificationFilters {
  testLines?: readonly number[] | undefined;
  testIds?: readonly string[] | undefined;
  testNames?: readonly string[] | undefined;
  testNamePattern?: RegExp | undefined;
  testTagsFilter?: readonly string[] | undefined;
}

/**
 * True when a Vitest run selects only some tests of its files: a test name pattern (-t, or the
 * watch mode's `t`), a file:line location, test ids or names (an IDE), or a tag filter. Vitest
 * marks every test such a run leaves out "skipped", so its skips are not a finding (CHK-1). The
 * forms of Vitest's own isPartialRun, apart from .only: the lint bans that, and CI forbids it.
 * @param namePattern Vitest.getGlobalTestNamePattern() at the start of the run
 * @param tagsFilter the resolved config's tagsFilter
 */
export function filteredRun(
  namePattern: RegExp | undefined,
  tagsFilter: readonly string[] | undefined,
  specifications: readonly SpecificationFilters[],
): boolean {
  const some = (items: readonly unknown[] | undefined): boolean => (items?.length ?? 0) > 0;
  return (
    namePattern !== undefined ||
    some(tagsFilter) ||
    specifications.some(
      (spec) =>
        some(spec.testLines) ||
        some(spec.testIds) ||
        some(spec.testNames) ||
        spec.testNamePattern !== undefined ||
        some(spec.testTagsFilter),
    )
  );
}

/**
 * A Vitest run's tests that were skipped or todo at run time, or never started. A failure is
 * not listed: Vitest fails the run for it already. A test held back by a failed hook is named
 * as not run, so the message does not tell the author to delete a test that is fine.
 */
export function vitestFindings(cases: readonly VitestCase[]): string[] {
  const findings: string[] = [];
  for (const test of cases) {
    const where = `[${test.project}] ${test.file} > ${test.name}`;
    if (test.state === 'skipped' && test.hookFailed) {
      findings.push(
        `${where} did not run: a beforeAll hook or the file failed before it (U-15). Fix that failure; the runner output above names it. The test itself needs no change.`,
      );
    } else if (test.state === 'skipped') {
      const what = test.mode === 'todo' ? 'is a todo' : 'was skipped';
      findings.push(`${where} ${what}: ${SKIPPED_MESSAGE}`);
    } else if (test.state === 'pending') {
      findings.push(
        `${where} did not run, so it proves nothing (U-15): fix the failure that stopped the run before it.`,
      );
    }
  }
  return findings;
}

/**
 * The floor of tests/test-counts.json "vitest" for each project that ran in full: a describe
 * dropped or a loop that yields no cases loses tests inside a file that still runs, which the
 * inventory test (scripts/lib/test-inventory.test.ts) cannot see.
 * @param ran the number of tests each project held, for the projects whose every file ran
 */
export function vitestCountFindings(
  ran: ReadonlyMap<string, number>,
  floors: ReadonlyMap<string, number>,
): string[] {
  const findings: string[] = [];
  for (const [project, have] of [...ran.entries()].sort()) {
    const floor = floors.get(project);
    if (floor === undefined) {
      findings.push(
        `[${project}] holds ${have} test(s) and ${COUNTS_FILE} lists no floor for it: add "${project}": ${have} under "vitest" in the same change`,
      );
    } else if (have < floor) {
      findings.push(
        `[${project}] holds ${have} test(s), ${COUNTS_FILE} expects at least ${floor} (U-15): a describe, a loop over no cases or a file that no longer loads dropped tests. Bring them back; if the drop is deliberate, lower "${project}" under "vitest" in ${COUNTS_FILE} in the same change`,
      );
    }
  }
  return findings;
}
