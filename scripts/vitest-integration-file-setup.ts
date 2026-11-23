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
import { afterAll, afterEach, beforeAll } from 'vitest';
import { ensureAuditDebtGuard, watchAuditDebt } from '@tinnox/db/testing';
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

beforeAll(async () => {
  loadEnv();
  await ensureAuditDebtGuard(requireEnv('TEST_DATABASE_MIGRATOR_URL'));
});
afterEach(() => {
  failOnRefusals('during this test');
});
// What a hook outside any test did (a beforeAll that arranges through a route, say).
afterAll(() => {
  failOnRefusals('in a hook of this file, outside its tests');
});
