import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Integration tests of the API against real PostgreSQL (database tinnox_test, role
 * tinnox_app for the application, tinnox_migrator only to arrange organisations).
 *   npm run test:integration -w @tinnox/api
 * Unit tests in src/ run with the repository's `npm test`.
 * The global setup applies pending migrations but does not wipe the database, so this
 * suite can run next to the repository-level integration suite; every test creates its
 * own organisations with random ids.
 */
export default defineConfig({
  test: {
    // As in the repository's vitest.config.ts: a test skipped, todo or never started, or a full
    // run below the "api-integration" floor in tests/test-counts.json, fails the run (U-15,
    // CHK-4). Resolved from this folder.
    reporters: [...configDefaults.reporters, '../../scripts/vitest-results-reporter.ts'],
    name: 'api-integration',
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // As the repository's integration project: installs the audit-debt guard when it is missing
    // and fails a test with the guard's message when it refused a commit (adoption plan
    // section 2.1 C). The global setup above only migrates, so this is what installs it here.
    setupFiles: ['../../scripts/vitest-integration-file-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
