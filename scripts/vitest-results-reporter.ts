// Fails a unit, component or integration run when a test was skipped or todo at run time, or
// never started (U-15; rules in scripts/lib/test-results-check.ts). Vitest exits 0 for those,
// and the lint (NO_SKIPPED_TESTS in eslint.config.js) sees only the declared forms, not
// ctx.skip() or a skip decided inside a helper. vitest.config.ts lists it after the default
// reporters, so it runs for every project. A run filtered by test name (-t) skips the rest on
// purpose and is not checked. A project whose every file ran must also hold at least the
// tests its floor in tests/test-counts.json names; a run of some files only is not counted.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  Reporter,
  TestModule,
  TestProject,
  TestRunEndReason,
  TestSuite,
  Vitest,
} from 'vitest/node';
import { repoRoot } from './lib/env.ts';
import {
  parseCounts,
  type VitestCase,
  vitestCountFindings,
  vitestFindings,
} from './lib/test-results-check.ts';

export interface ResultsReporterOptions {
  /** Called with the findings of a run that has any; by default prints them and fails the run. */
  fail?: (findings: string[]) => void;
  /** The floor of tests per project; by default "vitest" of tests/test-counts.json. */
  floors?: ReadonlyMap<string, number>;
}

function repositoryFloors(): Map<string, number> {
  const file = JSON.parse(
    readFileSync(join(repoRoot, 'tests', 'test-counts.json'), 'utf8'),
  ) as unknown;
  return parseCounts(file, 'vitest');
}

// Vitest marks the tests under a failed beforeAll (or a module that failed) "skipped", like a
// ctx.skip(); the error sits on that suite or module. A failing test leaves none there.
function hookFailed(node: TestSuite | TestModule): boolean {
  if (node.errors().length > 0) return true;
  return node.type === 'suite' && hookFailed(node.parent);
}

function failRun(findings: string[]): void {
  for (const finding of findings) console.error(`BLOCKING: ${finding}`);
  console.error(
    `vitest results: ${findings.length} finding(s): tests skipped, todo, not run or missing (U-15)`,
  );
  // Vitest only ever raises the exit code, so this survives to the end of the run.
  process.exitCode = 1;
}

export default class ResultsReporter implements Reporter {
  readonly #fail: (findings: string[]) => void;
  readonly #floors: ReadonlyMap<string, number>;
  #filtered = false;

  constructor(options: ResultsReporterOptions = {}) {
    this.#fail = options.fail ?? failRun;
    this.#floors = options.floors ?? repositoryFloors();
  }

  onInit(vitest: Vitest): void {
    this.#filtered = vitest.config.testNamePattern !== undefined;
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: unknown,
    reason: TestRunEndReason,
  ): Promise<void> {
    // An interrupted run has failed already; a filtered run skips the rest by request.
    if (reason === 'interrupted' || this.#filtered) return;
    const cases: VitestCase[] = [];
    const filesRun = new Map<TestProject, Set<string>>();
    for (const module of testModules) {
      filesRun.set(
        module.project,
        (filesRun.get(module.project) ?? new Set()).add(module.moduleId),
      );
      const root = module.project.config.root;
      for (const test of module.children.allTests()) {
        cases.push({
          project: module.project.name,
          file: relative(root, module.moduleId),
          name: test.fullName,
          state: test.result().state,
          mode: test.options.mode,
          hookFailed: hookFailed(test.parent),
        });
      }
    }
    // Only a project whose every test file ran is counted: a run of some files (a path,
    // --changed, --shard) holds fewer tests by request.
    const ran = new Map<string, number>();
    for (const [project, ids] of filesRun) {
      const { testFiles } = await project.globTestFiles();
      if (testFiles.some((file) => !ids.has(file))) continue;
      ran.set(project.name, cases.filter((test) => test.project === project.name).length);
    }
    const findings = [...vitestFindings(cases), ...vitestCountFindings(ran, this.#floors)];
    if (findings.length > 0) this.#fail(findings);
  }
}
