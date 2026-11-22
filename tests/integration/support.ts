/**
 * Support for the repository-level integration and security-boundary tests.
 * The application under test is the real one (apps/api buildApp on a real listener,
 * real PostgreSQL as the runtime role tinnox_app); the harness itself lives next to
 * the API (apps/api/test/support.ts) and is re-exported here.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import type { Operator, PairedPlayer, TestApp } from '@tinnox/api/test-support';

export * from '@tinnox/api/test-support';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixturesDir = join(repoRoot, 'apps', 'api', 'test-fixtures', 'out');
export const WORKER_IMAGE = process.env['TINNOX_WORKER_IMAGE'] ?? 'tinnox-cms-media-worker:m0';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** One connection as the runtime role, with no organisation context unless a test sets one. */
export async function appClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: need('TEST_DATABASE_URL') });
  await client.connect();
  return client;
}

/** Arranging only: runs one statement as the owner of the security functions (bypasses row-level security). */
export async function arrangeAsDefiner(text: string, values: readonly unknown[]): Promise<void> {
  const client = new pg.Client({ connectionString: need('TEST_DATABASE_MIGRATOR_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE tinnox_definer');
    await client.query(text, [...values]);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

export interface Pairing {
  readonly pairingId: string;
  readonly code: string;
  readonly pollingToken: string;
  readonly expiresAt: string;
}

export async function newPairing(t: TestApp): Promise<Pairing> {
  const response = await fetch(`${t.url}/player/pairing`, { method: 'POST' });
  if (response.status !== 201) throw new Error(`pairing create failed: ${response.status}`);
  return (await response.json()) as Pairing;
}

export function pollPairing(t: TestApp, pairing: Pairing): Promise<Response> {
  return fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
    headers: { authorization: `Bearer ${pairing.pollingToken}` },
  });
}

export function heartbeatBody(
  displayId: string,
  seq: number,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    seq,
    sentAt: new Date().toISOString(),
    displayId,
    downloadedPublicationId: null,
    activePublicationId: null,
    activeItemIndex: null,
    playerState: 'idle',
    staging: null,
    errors: [],
    player: { version: 'integration-test', storagePersisted: null, online: true },
    ...fields,
  });
}

export function sendHeartbeat(t: TestApp, player: PairedPlayer, body: string): Promise<Response> {
  return fetch(`${t.url}/player/heartbeat`, {
    method: 'POST',
    headers: { ...player.headers, 'content-type': 'application/json' },
    body,
  });
}

export function requestMediaUrls(
  t: TestApp,
  player: PairedPlayer,
  publicationId: string,
  assetIds: readonly string[],
): Promise<Response> {
  return fetch(`${t.url}/player/media-urls`, {
    method: 'POST',
    headers: { ...player.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ publicationId, assetIds }),
  });
}

/** Adds an address to the operator's alert list; its confirmation e-mail lands in `t.sentMail`. */
export function addAlertAddress(operator: Operator, email: string): Promise<Response> {
  return operator.fetch('/api/alert-recipients', { method: 'POST', json: { email } });
}

/** Posts a confirmation token as the address's owner does: with no session. */
export function confirmAlertAddress(t: TestApp, token: string): Promise<Response> {
  return fetch(`${t.url}/api/alert-recipients/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

/** The token of the newest confirmation e-mail. */
export function lastConfirmationToken(t: TestApp): string {
  const match = /\/alerts\/confirm#([A-Za-z0-9_-]{43})/.exec(t.sentMail.at(-1)?.text ?? '');
  if (match?.[1] === undefined) throw new Error('no confirmation e-mail');
  return match[1];
}

/**
 * Starts the real validation worker image on the test application's job directory, with
 * the same isolation as infra/docker-compose.yml. Returns a function that removes it.
 */
export function startWorkerContainer(t: TestApp): () => void {
  // mkdtemp makes the parent 0700; the worker (uid 10001) must be able to enter it on Linux.
  chmodSync(dirname(t.jobsDir), 0o755);
  chmodSync(t.jobsDir, 0o755);
  const id = execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--user',
      '10001:10001',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '128',
      '--memory',
      '768m',
      '--cpus',
      '1',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
      '--volume',
      `${t.jobsDir}:/jobs:rw`,
      WORKER_IMAGE,
    ],
    { encoding: 'utf8' },
  ).trim();
  return () => {
    execFileSync('docker', ['rm', '--force', id], { stdio: 'ignore' });
  };
}

/** Lets the API ingest worker verdicts until the media leaves `processing`. */
export async function waitForVerdict(
  t: TestApp,
  operator: { fetch(path: string): Promise<Response> },
  mediaId: string,
  timeoutMs = 60_000,
): Promise<{ status: string; errorCode: string | null; codec: string | null; kind: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await t.ctx.media.tick();
    const media = (await (await operator.fetch(`/api/media/${mediaId}`)).json()) as {
      status: string;
      errorCode: string | null;
      codec: string | null;
      kind: string;
    };
    if (media.status !== 'processing') return media;
    if (Date.now() > deadline) throw new Error(`media ${mediaId} is still processing`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** A TCP port on loopback that nothing listens on at the moment of asking. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Runs a real entry point of the API (`src/main.ts`, `src/alerts-once.ts`) as a child process
 * with exactly `env` (and PATH) as its environment, and resolves with its exit code and output.
 * The entry point also reads the names it knows from the root `.env`, where `env` does not set
 * them (runtimeEnv in apps/api/src/config.ts). Rejects if it is still running after 20 s: every
 * caller expects it to refuse and exit.
 */
export function runApiEntryPoint(
  script: string,
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: join(repoRoot, 'apps', 'api'),
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} kept running with an unacceptable configuration:\n${output}`));
    }, 20_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** True when something answers HTTP on the loopback port. */
export async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The root `.env` (the generated development configuration), or nothing when it is missing.
 * It holds the administrator credentials too: give an entry point `apiEnvironment` of it.
 */
export function developmentEnv(): Record<string, string> {
  const envFile = join(repoRoot, '.env');
  return existsSync(envFile)
    ? (parseEnv(readFileSync(envFile, 'utf8')) as Record<string, string>)
    : {};
}
