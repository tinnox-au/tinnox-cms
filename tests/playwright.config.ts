import { defineConfig, devices } from '@playwright/test';
import { API_URL, PLAYER_URL, PORTAL_URL } from './e2e/support/urls.ts';

/**
 * End-to-end tests: real Keycloak sign-in, real API process, real media worker
 * container, production builds of the portal and the player (the player's service
 * worker only exists in a build). Needs `npm run infra:up`, `db:migrate`, `db:seed -- --second-org`.
 * The API, portal (5173) and player (5174) are started here and must not already run.
 *
 * Traces and videos are off: they would record the sign-in form.
 */

// The builds must be production builds even when the shell has exported the repository
// .env (NODE_ENV=development). With NODE_ENV=development, `vite build` sets
// import.meta.env.PROD to false: the player then never registers its service worker (no
// offline reload) and the portal bundle keeps its development-only /styleguide page.
const BUILD_ENV = { NODE_ENV: 'production' };

// The player build writes its API origin into the bundle and its Content-Security-Policy, and
// reads it from VITE_API_BASE_URL in the shell or in apps/player-web/.env* (shell-plugin.mjs).
// Set here, it wins over both, so the browser player sends its device token to the E2E API only;
// global set-up checks API_URL is loopback (EAX-09), which it could not do for a value the
// build reads before global set-up runs.
const PLAYER_BUILD_ENV = { ...BUILD_ENV, VITE_API_BASE_URL: API_URL };

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: './.run/e2e-results.json' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run build -w @tinnox/portal && npm run preview -w @tinnox/portal',
      cwd: '..',
      env: BUILD_ENV,
      url: `${PORTAL_URL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run build -w @tinnox/player-web && npm run preview -w @tinnox/player-web',
      cwd: '..',
      env: PLAYER_BUILD_ENV,
      url: `${PLAYER_URL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
