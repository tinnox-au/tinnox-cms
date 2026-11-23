/**
 * Process control for the end-to-end run. The API runs as a real process (the same entry
 * point as `npm run start -w @tinnox/api`) so a test can stop and start it; its pid lives
 * in tests/.run (gitignored). Portal and player are served by Playwright's `webServer`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { RUNTIME_ENV_NAMES } from '@tinnox/api/test-support/runtime-env';
import {
  allowListedEnv,
  hostsOf,
  localhostProblem,
  loopbackProblems,
  type Target,
} from '../../../scripts/lib/loopback-targets.ts';
import { e2eMediaRoot, e2eUrls } from './database.ts';
import { API_URL, MAILPIT_URL, PLAYER_URL, PORTAL_URL } from './urls.ts';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const runDir = join(repoRoot, 'tests', '.run');
/**
 * Screenshots and measurements of this run. By default under tests/.run (gitignored), so a
 * run never overwrites the evidence cited in docs/prototype-validation.md. To refresh that
 * evidence deliberately: E2E_EVIDENCE_DIR=docs/evidence npm run test:e2e
 */
export const evidenceDir =
  process.env['E2E_EVIDENCE_DIR'] !== undefined && process.env['E2E_EVIDENCE_DIR'] !== ''
    ? resolve(repoRoot, process.env['E2E_EVIDENCE_DIR'])
    : join(runDir, 'evidence');
export const fixturesDir = join(repoRoot, 'apps', 'api', 'test-fixtures', 'out');

export { API_URL, MAILPIT_URL, PLAYER_URL, PORTAL_URL };

const pidFile = join(runDir, 'api.pid');
const apiLog = join(runDir, 'api.log');

function composeArgs(...rest: string[]): string[] {
  return [
    'compose',
    '--env-file',
    join(repoRoot, '.env'),
    '-f',
    join(repoRoot, 'infra', 'docker-compose.yml'),
    '--profile',
    'worker',
    ...rest,
  ];
}

async function apiReady(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/readyz`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string };
    return body.status === 'ready';
  } catch {
    return false;
  }
}

async function apiListening(): Promise<boolean> {
  try {
    await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Where this file sets a value, for the refusal's instruction.
const SET_HERE = 'set in tests/e2e/support/stack.ts';
const SET_IN_URLS = 'set in tests/e2e/support/urls.ts';
const FROM_DOTENV = 'from the root .env';
// support/database.ts derives the E2E database's connections from these two.
const APP_DATABASE_SOURCE =
  'the E2E database on the host of DATABASE_URL, from the shell or the root .env';
const MIGRATOR_DATABASE_SOURCE =
  'the E2E database on the host of DATABASE_MIGRATOR_URL, from the shell or the root .env';

/** The values the e2e API gets whatever the shell or the root .env say. */
function fixedApiSettings(): Record<string, string> {
  return {
    // The addresses this file and the Playwright config use.
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    API_PUBLIC_ORIGIN: API_URL,
    PORTAL_ORIGIN: PORTAL_URL,
    PLAYER_ORIGIN: PLAYER_URL,
    // Its own database and media directory (support/database.ts).
    DATABASE_URL: e2eUrls().app,
    MEDIA_ROOT: e2eMediaRoot,
    // One address creates every pairing session in this run; the limit itself is
    // covered by the integration tests.
    LIMIT_PAIRING_MAX_SESSIONS_PER_IP: '500',
    // Always the local Mailpit (15-alerts.spec.ts reads it). The empty values blank out
    // credentials (loadConfig treats '' as unset).
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_SECURE: 'false',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    MAIL_FROM: 'alerts@tinnox-dev.invalid',
  };
}

/**
 * The names the e2e API takes from the root .env as `npm run setup` writes it: the secrets and
 * the local Keycloak client, which differ per machine. Not from the shell: a developer's exported
 * setting must not reach a test run.
 */
const API_SETTINGS_FROM_DOTENV = [
  'NODE_ENV',
  'LOG_LEVEL',
  'SESSION_SECRET',
  'SESSION_TTL_SECONDS',
  'SESSION_IDLE_TIMEOUT_SECONDS',
  'MEDIA_URL_HMAC_SECRET',
  'PAIRING_CLIENT_KEY_SECRET',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_POST_LOGOUT_REDIRECT_URI',
  'OIDC_MFA_ACR_VALUES',
  'OIDC_MFA_AMR_VALUES',
  // The exchange folder the media-worker container watches.
  'MEDIA_JOBS_DIR',
];

/**
 * The e2e API's whole configuration (EAX-09): the fixed values, the names above from the root
 * .env, and every other name the API reads (RUNTIME_ENV_NAMES) empty, so that the API, which
 * reads the root .env itself (runtimeEnv in apps/api/src/config.ts), fills in none of them.
 */
export function e2eApiEnvironment(): Record<string, string> {
  return allowListedEnv(
    {
      names: RUNTIME_ENV_NAMES,
      fixed: fixedApiSettings(),
      fromSource: API_SETTINGS_FROM_DOTENV,
    },
    parseEnv(readFileSync(join(repoRoot, '.env'), 'utf8')),
  );
}

/**
 * Every host and URL the run is about to use: the API's configuration, the database set-up's
 * connection (the superuser's connection uses the same host), the previews, Mailpit, and the
 * API origin. The player build's API origin is API_URL too: tests/playwright.config.ts sets
 * VITE_API_BASE_URL to it, which wins over the shell and apps/player-web/.env* files.
 */
function stackTargets(apiEnv: Readonly<Record<string, string>>): Target[] {
  const fixed = fixedApiSettings();
  return [
    ...Object.entries(apiEnv).map(([name, value]) => ({
      name,
      value,
      source:
        name === 'DATABASE_URL'
          ? APP_DATABASE_SOURCE
          : Object.hasOwn(fixed, name)
            ? SET_HERE
            : FROM_DOTENV,
    })),
    {
      name: 'DATABASE_MIGRATOR_URL',
      value: e2eUrls().migrator,
      source: MIGRATOR_DATABASE_SOURCE,
    },
    { name: 'PORTAL_URL', value: PORTAL_URL, source: SET_IN_URLS },
    { name: 'PLAYER_URL', value: PLAYER_URL, source: SET_IN_URLS },
    { name: 'API_URL', value: API_URL, source: SET_IN_URLS },
    { name: 'MAILPIT_URL', value: MAILPIT_URL, source: SET_IN_URLS },
  ];
}

/**
 * Refuses to go on unless every host and URL of the run is on this machine (EAX-09): a loopback
 * address, or localhost when it resolves to loopback addresses only. Runs before global-setup.ts
 * starts anything and again before each API start.
 */
export async function assertLoopbackStack(apiEnv = e2eApiEnvironment()): Promise<void> {
  const targets = stackTargets(apiEnv);
  const problems = loopbackProblems(targets);
  if (targets.some(({ value }) => value !== '' && hostsOf(value)?.includes('localhost'))) {
    const addresses = await lookup('localhost', { all: true }).then(
      (found) => found.map(({ address }) => address),
      () => [],
    );
    const problem = localhostProblem(addresses);
    if (problem !== null) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to start the end-to-end stack:\n- ${problems.join('\n- ')}`);
  }
}

/**
 * Starts the API from source with e2eApiEnvironment and PATH, and nothing else of this process's
 * environment: global-setup.ts loaded the whole root .env into it for the database set-up,
 * administrator credentials included, and the API refuses to start with one in its environment
 * (D5 of the poteto pyramid plan). Fails if something already listens on its port.
 */
export async function startApi(): Promise<void> {
  const apiEnv = e2eApiEnvironment();
  await assertLoopbackStack(apiEnv);
  mkdirSync(runDir, { recursive: true });
  if (await apiListening()) {
    throw new Error(
      'something already listens on port 4000; stop it (npm run dev?) before the E2E run',
    );
  }
  const out = openSync(apiLog, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repoRoot, 'apps', 'api'),
    detached: true,
    stdio: ['ignore', out, out],
    env: { PATH: process.env['PATH'] ?? '', ...apiEnv },
  });
  child.unref();
  if (child.pid === undefined) throw new Error('the API process did not start');
  writeFileSync(pidFile, String(child.pid));
  await waitFor('the API to report ready', apiReady, 60_000);
}

export async function stopApi(): Promise<void> {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitFor('the API to stop', async () => !(await apiListening()), 20_000);
}

/**
 * Restarts the PostgreSQL container and waits until it is healthy again. This is the
 * shared development container: anything else connected to it is disconnected too.
 */
export function restartDatabase(): void {
  execFileSync('docker', composeArgs('restart', 'postgres'), { stdio: 'ignore' });
  execFileSync('docker', composeArgs('up', '-d', '--wait', 'postgres'), { stdio: 'ignore' });
}

export function requireInfrastructure(): void {
  const names = execFileSync('docker', composeArgs('ps', '--status', 'running', '--services'), {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line !== '');
  for (const service of ['postgres', 'keycloak', 'media-worker', 'mailpit']) {
    if (!names.includes(service)) {
      throw new Error(`docker service "${service}" is not running; run "npm run infra:up" first`);
    }
  }
}
