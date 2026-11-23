import { defineConfig, devices } from '@playwright/test';

/**
 * The checks of tests/e2e that need no running service: the player's information screens and
 * the app renderer, drawn from their sources. The full suite (playwright.config.ts) runs them
 * too; this config runs only them, without starting the API, the portal or the player.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '09-review-round-2.spec.ts',
  grep: /player and app renderer/,
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // The quality job's results gate reads the JSON report: a test skipped at run time leaves
  // Playwright exiting 0 (npm run check:test-results -- --counts layout, CHK-2).
  reporter: [['list'], ['json', { outputFile: './.run/layout-results.json' }]],
  use: { trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
