// The Playwright results gate (rules in scripts/lib/test-results-check.ts, U-15): after a
// Playwright run, fails when a test was skipped at run time, did not run, passed only on a retry
// or failed, when Playwright reported an error outside any test, or when the tests of a spec
// file are not the number tests/test-counts.json expects. tests/skip-allowlist.json may excuse a
// test that did not run or was flaky, never a skip. Run it on the report of a full run.
//   npm run check:test-results                       the full suite: tests/.run/e2e-results.json
//   npm run check:test-results -- --counts layout    the stackless layout checks (CHK-2):
//                                                    tests/.run/layout-results.json
//   npm run check:test-results -- [--counts <suite>] <report.json>
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot } from './lib/env.ts';
import {
  e2eVerdict,
  parseAllowlist,
  parseCounts,
  parseGateArguments,
} from './lib/test-results-check.ts';

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

let parsed: ReturnType<typeof parseGateArguments>;
try {
  parsed = parseGateArguments(process.argv.slice(2));
} catch (error) {
  console.error(`check:test-results: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const { suite, report } = parsed;
const reportPath = report === undefined ? join(repoRoot, suite.report) : resolve(report);
if (!existsSync(reportPath)) {
  console.error(
    `check:test-results: no report at ${reportPath}. Run the suite first (${suite.command}); its json reporter writes the report even when tests fail. No report means the run never started.`,
  );
  process.exit(1);
}

const verdict = e2eVerdict(
  readJson(reportPath),
  parseCounts(readJson(join(repoRoot, 'tests', 'test-counts.json')), suite.section),
  parseAllowlist(readJson(join(repoRoot, 'tests', 'skip-allowlist.json'))),
  new Date().toISOString().slice(0, 10),
  suite,
);

console.log(`${suite.section} results: ${verdict.summary}`);
for (const line of verdict.allowed) console.log(`allowed by tests/skip-allowlist.json: ${line}`);
for (const line of verdict.blocking) console.error(`BLOCKING: ${line}`);
if (verdict.blocking.length > 0) {
  console.error(`check:test-results: ${verdict.blocking.length} finding(s)`);
  process.exit(1);
}
console.log(
  'check:test-results passed: every expected test ran once and passed, and no error outside a test',
);
