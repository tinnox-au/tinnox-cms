import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Three projects:
 * - unit: pure tests, no services. `npm test`
 * - component: portal components rendered in headless Chromium (the portal relies on browser
 *   features such as the popover attribute, so no simulated DOM). `npm run test:component`;
 *   needs `npx playwright install chromium` once.
 * - integration: needs PostgreSQL from infra/docker-compose.yml. `npm run test:integration`
 *   Files run one at a time because they share one test database.
 * Browser end-to-end tests are Playwright tests under tests/e2e (`npm run test:e2e`).
 */
export default defineConfig({
  test: {
    // Vitest's own reporters, then the results check: a test skipped or todo at run time, or
    // never started, or a full project below its floor in tests/test-counts.json, fails the run
    // of any project (U-15, scripts/vitest-results-reporter.ts).
    reporters: [...configDefaults.reporters, './scripts/vitest-results-reporter.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'component',
          include: ['apps/portal/src/**/*.test.tsx'],
          setupFiles: ['./apps/portal/src/componentTests.setup.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'packages/*/test/**/*.integration.test.ts',
            'apps/*/test/**/*.integration.test.ts',
            'tests/integration/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**'],
          globalSetup: ['./scripts/vitest-integration-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
