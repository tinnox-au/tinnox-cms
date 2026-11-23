// Which suite runs each test file (adoption plan section 4.1): a test file outside every
// include glob never runs and nothing says so, and one inside two runs twice. Read by
// scripts/lib/test-inventory.test.ts, which builds the suites from vitest.config.ts and every
// Playwright config in the repository.
import { posix, relative } from 'node:path';

/** A file that a test runner would pick up by its name. */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** A Vitest project or a Playwright config, seen as the set of files it runs. */
export interface Suite {
  readonly name: string;
  /** @param path a path from the repository root, with forward slashes */
  runs(path: string): boolean;
}

/** One problem per test file that no suite or more than one suite runs. */
export function inventoryProblems(files: readonly string[], suites: readonly Suite[]): string[] {
  const problems: string[] = [];
  for (const path of files.filter((file) => TEST_FILE.test(file)).sort()) {
    const owners = suites.filter((suite) => suite.runs(path)).map((suite) => suite.name);
    if (owners.length === 0) {
      problems.push(
        `${path} is run by no suite: move it under an include glob of a project in vitest.config.ts or under the testDir of a Playwright config (tests/e2e), or rename it if it is not a test`,
      );
    } else if (owners.length > 1) {
      problems.push(
        `${path} is run by ${owners.join(' and ')}: narrow the include or exclude globs in vitest.config.ts so that one project runs it`,
      );
    }
  }
  return problems;
}

/**
 * The files a Playwright config runs: everything under its test directory that matches
 * Playwright's default testMatch. A config with its own testMatch is not supported here.
 * @param testDir the config's testDir, from the repository root
 */
export function playwrightSuite(name: string, testDir: string, testMatch: unknown): Suite {
  if (testMatch !== undefined) {
    throw new Error(
      `${name} sets testMatch; teach playwrightSuite in scripts/lib/test-inventory.ts to read it`,
    );
  }
  return {
    name,
    runs: (path) => {
      const inside = relative(testDir, path);
      return !inside.startsWith('..') && TEST_FILE.test(inside);
    },
  };
}

/** A Playwright config as the inventory reads it. */
export interface PlaywrightConfig {
  /** the config file, from the repository root */
  readonly path: string;
  /** its testDir, relative to the config file as Playwright reads it */
  readonly testDir?: string | undefined;
  readonly testMatch?: unknown;
}

/**
 * One suite per test directory (CHK-11), named after the config that runs all of it. A config
 * that picks some files (testMatch) out of a directory another config runs whole adds no file,
 * so it adds no suite: tests/playwright.layout.config.ts runs a subset of tests/e2e.
 */
export function playwrightSuites(configs: readonly PlaywrightConfig[]): Suite[] {
  const byDir = new Map<string, PlaywrightConfig[]>();
  for (const config of configs) {
    const dir = posix.join(posix.dirname(config.path), config.testDir ?? '.');
    byDir.set(dir, [...(byDir.get(dir) ?? []), config]);
  }
  return [...byDir].map(([dir, sharing]) => {
    const whole = sharing.find((config) => config.testMatch === undefined) ?? sharing[0];
    return playwrightSuite(whole?.path ?? dir, dir, whole?.testMatch);
  });
}
