// Runs in every integration test file, before its own hooks (the setupFiles of the integration
// project in vitest.config.ts and of apps/api/vitest.config.ts).
//
// The audit-debt guard (packages/db/src/audit-debt-guard.ts; adoption plan section 2.1 C, D3)
// is installed once by the global setup, but a file that rebuilds the schema (the migration
// tests) or removes the guard (the catalogue test) leaves the database without it. So each file
// starts by putting it back when it is missing or stale.
//
// A refusal of the guard reaches the test as a 500, or not at all when product code catches the
// error, so every test also fails with the guard's own message when a commit was refused while
// it ran.
//
// The audit row scan (AG-3.4, adoption plan step 17): when the file is done, every audit row
// written while it ran is read and judged by scripts/lib/audit-row-scan.ts. A row that holds a
// URL, a query string, a token-shaped string or an e-mail address fails the file, whichever test
// wrote it and whatever the test itself asserted.
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  auditRowsSince,
  auditScanMark,
  ensureAuditDebtGuard,
  watchAuditDebt,
} from '@tinnox/db/testing';
import { auditScanProblems } from './lib/audit-row-scan.ts';
import { loadEnv, requireEnv } from './lib/env.ts';

const refusals = watchAuditDebt();

function failOnRefusals(when: string): void {
  const seen = refusals.take();
  if (seen.length === 0) return;
  throw new Error(
    `the audit-debt guard refused ${seen.length === 1 ? 'a commit' : `${seen.length} commits`} ${when}:\n` +
      [...new Set(seen)].map((message) => `  - ${message}`).join('\n'),
  );
}

/**
 * The database administrator's connection to the test database: audit_event forces row-level
 * security on its owner, so only the administrator reads the rows of every organisation.
 */
function administratorUrl(): string {
  const url = new URL(requireEnv('TEST_DATABASE_MIGRATOR_URL'));
  url.username = 'postgres';
  url.password = encodeURIComponent(requireEnv('POSTGRES_SUPERUSER_PASSWORD'));
  return url.toString();
}

let scanFrom: string | undefined;

beforeAll(async () => {
  loadEnv();
  await ensureAuditDebtGuard(requireEnv('TEST_DATABASE_MIGRATOR_URL'));
  scanFrom = await auditScanMark(administratorUrl());
});
afterEach(() => {
  failOnRefusals('during this test');
});
// What a hook outside any test did (a beforeAll that arranges through a route, say).
afterAll(() => {
  failOnRefusals('in a hook of this file, outside its tests');
});
// This file's hooks are registered before the test file's own, and after-hooks run in reverse
// order, so the scan runs once the file's afterAll hooks have written their last rows.
afterAll(async () => {
  if (scanFrom === undefined) return;
  const problems = auditScanProblems(await auditRowsSince(administratorUrl(), scanFrom));
  if (problems.length === 0) return;
  throw new Error(
    `the audit row scan found ${problems.length === 1 ? 'a row' : `${String(problems.length)} values`} this file's tests wrote that an audit row must not hold (AG-3.4):\n` +
      problems.map((problem) => `  - ${problem}`).join('\n'),
  );
});
