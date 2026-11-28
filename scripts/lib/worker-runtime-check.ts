// The media worker's isolation, from the one place it is written (OTH-15, adoption plan step 33):
// no network, a read-only root, no capabilities and no secrets, as a non-root user with the job
// folder as its only mount (prototype-m0.md D11). The compose files are that place: the
// development one (infra/docker-compose.yml) and the one a deployed server runs
// (infra/deploy/compose.yml, started by infra/deploy/release.sh). Their worker service, as
// `docker compose config --format json` renders it, is judged by `workerServiceProblems`, and the
// container the integration tests start is built from the development one by `workerRunArgs`
// (tests/integration/support.ts), so the tests and the compose files cannot drift apart.
// apps/media-worker/scripts/direct-check.mjs starts its container the same way, through
// scripts/worker-run-args.ts.
// tests/integration/worker-runtime.test.ts runs these over the real compose files;
// scripts/lib/worker-runtime-check.test.ts holds the rules, and checks the worker image's USER
// and that no other file defines how the worker runs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The development compose file, whose worker the integration tests start. */
export const DEVELOPMENT_COMPOSE_FILE = 'infra/docker-compose.yml';
/** Every file that defines how the worker runs, and the name of its service there. */
export const WORKER_COMPOSE_FILES = [DEVELOPMENT_COMPOSE_FILE, 'infra/deploy/compose.yml'];
export const WORKER_SERVICE = 'media-worker';
/** The worker image's build file, whose USER the compose files must repeat. */
export const WORKER_DOCKERFILE = 'apps/media-worker/Dockerfile';
/** Where the worker finds its jobs, inside the container. */
export const WORKER_JOBS_DIR = '/jobs';

const HERE = 'scripts/lib/worker-runtime-check.ts';

/** The worker's environment: two paths and a mode, never a credential. */
const ALLOWED_ENVIRONMENT = new Set(['MEDIA_JOBS_DIR', 'NODE_ENV']);

/**
 * Every key of the service that is judged here or carried into the test container's options, and those that
 * change nothing about its isolation. Anything else fails, so a new key is decided on, not
 * passed through unseen (`devices`, `ipc`, `pid`, `privileged`, `secrets` and the rest).
 */
const KNOWN_KEYS = new Set([
  // Judged by workerServiceProblems and carried by workerRunArgs.
  'network_mode',
  'read_only',
  'user',
  'cap_drop',
  'security_opt',
  'pids_limit',
  'mem_limit',
  'memswap_limit',
  'cpus',
  'init',
  'tmpfs',
  'environment',
  'volumes',
  // How the image is named and built, restarted, stopped, ordered and watched: no isolation.
  'image',
  'build',
  'profiles',
  'restart',
  'stop_grace_period',
  'depends_on',
  'healthcheck',
]);

/** A compose service as `docker compose config --format json` renders it, as far as read here. */
export type ComposeService = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A scalar of the rendered configuration, as a container option takes it. */
function scalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`expected a scalar in the worker service, got ${JSON.stringify(value)}`);
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
/** A limit that limits: a number above 0, or a size or count written as one ('768m', '1.0'). */
function isPositiveLimit(value: unknown): boolean {
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return false;
  const match = /^(\d+(?:\.\d+)?)[bkmg]?$/i.exec(value.trim());
  return match !== null && Number(match[1]) > 0;
}

/** The one problem per isolation property the service lacks, each saying what to write. Pure. */
export function workerServiceProblems(file: string, service: ComposeService): string[] {
  const at = `${file}, service ${WORKER_SERVICE}`;
  const problems: string[] = [];
  const need = (ok: boolean, what: string): void => {
    if (!ok) problems.push(`${at}: ${what} (prototype-m0.md D11; ${HERE})`);
  };
  for (const key of Object.keys(service).filter((k) => !KNOWN_KEYS.has(k))) {
    problems.push(
      `${at}: sets ${key}, which this check does not judge. Decide whether it weakens the worker's isolation; if it does not, add it to KNOWN_KEYS in ${HERE}, and to workerRunArgs if the test container must carry it too`,
    );
  }
  need(service['network_mode'] === 'none', 'set network_mode: none, so the worker has no network');
  need(service['read_only'] === true, 'set read_only: true, so its root file system is read-only');
  const user = typeof service['user'] === 'string' ? service['user'] : '';
  need(
    /^[1-9]\d*:[1-9]\d*$/.test(user),
    `set user to a numeric uid:gid other than root (it is ${JSON.stringify(user)})`,
  );
  need(
    JSON.stringify(strings(service['cap_drop'])) === '["ALL"]',
    'drop every capability with cap_drop: [ALL] and add none back',
  );
  // Exactly this one: an added seccomp:unconfined, apparmor:unconfined or label:disable would
  // take away a confinement Docker gives every container by default.
  need(
    JSON.stringify(strings(service['security_opt'])) === '["no-new-privileges:true"]',
    'keep security_opt: [no-new-privileges:true] and add no other option, none of which tightens it (seccomp:unconfined, apparmor:unconfined and label:disable loosen it)',
  );
  for (const key of ['pids_limit', 'mem_limit', 'cpus']) {
    need(
      isPositiveLimit(service[key]),
      `keep a positive ${key} limit (it is ${JSON.stringify(service[key])}; 0 or -1 means none)`,
    );
  }
  const environment = isRecord(service['environment']) ? service['environment'] : {};
  const extra = Object.keys(environment).filter((name) => !ALLOWED_ENVIRONMENT.has(name));
  need(
    extra.length === 0,
    `pass no other environment than ${[...ALLOWED_ENVIRONMENT].join(' and ')}: the worker holds no secret (it has ${extra.join(', ')})`,
  );
  need(
    environment['MEDIA_JOBS_DIR'] === WORKER_JOBS_DIR,
    `set MEDIA_JOBS_DIR to ${WORKER_JOBS_DIR}, where its one mount is`,
  );
  const volumes = Array.isArray(service['volumes']) ? (service['volumes'] as unknown[]) : [];
  need(
    volumes.length === 1 &&
      isRecord(volumes[0]) &&
      volumes[0]['target'] === WORKER_JOBS_DIR &&
      volumes[0]['read_only'] !== true,
    `mount the job folder at ${WORKER_JOBS_DIR}, read-write, and nothing else`,
  );
  return problems;
}

/** The isolation of a service: what two definitions of the worker must agree on. Pure. */
export function isolationOf(service: ComposeService): Record<string, unknown> {
  return Object.fromEntries(
    [...KNOWN_KEYS]
      .filter((key) => !['image', 'build', 'profiles', 'depends_on', 'volumes'].includes(key))
      .map((key) => [key, service[key]]),
  );
}

/**
 * The options of Docker's `run` command that start the worker as `service` says, with `jobsDir` of the host
 * as its one mount. Throws on a key it cannot carry, so a test container never runs with less
 * isolation than the compose file. Pure.
 */
export function workerRunArgs(service: ComposeService, jobsDir: string): string[] {
  const problems = workerServiceProblems('the worker service', service);
  if (problems.length > 0) throw new Error(problems.join('; '));
  const args = [
    '--network',
    scalar(service['network_mode']),
    '--read-only',
    '--user',
    scalar(service['user']),
  ];
  for (const cap of strings(service['cap_drop'])) args.push('--cap-drop', cap);
  for (const option of strings(service['security_opt'])) args.push('--security-opt', option);
  args.push('--pids-limit', scalar(service['pids_limit']));
  args.push('--memory', scalar(service['mem_limit']));
  if (service['memswap_limit'] !== undefined) {
    args.push('--memory-swap', scalar(service['memswap_limit']));
  }
  args.push('--cpus', scalar(service['cpus']));
  if (service['init'] === true) args.push('--init');
  for (const mount of strings(service['tmpfs'])) args.push('--tmpfs', mount);
  const environment = isRecord(service['environment']) ? service['environment'] : {};
  for (const [name, value] of Object.entries(environment)) {
    args.push('--env', `${name}=${scalar(value)}`);
  }
  args.push('--volume', `${jobsDir}:${WORKER_JOBS_DIR}:rw`);
  return args;
}

/**
 * The worker service of `file` from the output of `docker compose config --format json`, or the
 * reason there is none. Pure.
 */
export function workerServiceOf(file: string, rendered: string): ComposeService {
  const parsed: unknown = JSON.parse(rendered);
  const services = isRecord(parsed) && isRecord(parsed['services']) ? parsed['services'] : {};
  const service = services[WORKER_SERVICE];
  if (!isRecord(service)) {
    throw new Error(
      `${file} defines no ${WORKER_SERVICE} service: keep the worker under that name, or change WORKER_SERVICE and WORKER_COMPOSE_FILES in ${HERE}`,
    );
  }
  return service;
}

/** What to say when Docker Compose could not render `file`, with its own reason. Pure. */
export function composeFailure(file: string, reason: string): string {
  return `docker compose could not render ${file}: ${reason.trim() || 'it gave no reason'}. The worker's isolation is read from \`docker compose --profile worker config --no-interpolate --format json\`, which needs Docker and a Docker Compose v2 that has both options; fix the compose file if the reason is in it (${HERE})`;
}

/**
 * The worker service of a compose file (a path from `root`), as Docker Compose renders it. Not
 * pure: it runs Docker. Nothing is interpolated, so no `.env` is needed and no value of one is
 * read. On success Compose's stderr only warns that --no-interpolate renders every service, so
 * it is shown only when rendering fails.
 */
export function renderedWorkerService(root: string, file: string): ComposeService {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--file',
      join(root, file),
      '--profile',
      'worker',
      'config',
      '--no-interpolate',
      '--format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  if (result.error !== undefined) throw new Error(composeFailure(file, result.error.message));
  if (result.status !== 0) {
    throw new Error(composeFailure(file, `${result.stderr} (exit ${String(result.status)})`));
  }
  return workerServiceOf(file, result.stdout);
}

/** The user of the image's last USER line, or null. Pure. */
export function dockerfileUser(text: string): string | null {
  const users = [...text.matchAll(/^USER\s+(\S+)\s*$/gm)].map((match) => match[1] ?? '');
  return users.at(-1) ?? null;
}

// The worker image: by its name, or by the variables that hold it (TINNOX_WORKER_IMAGE in the
// scripts and tests, WORKER_IMAGE on a deployed server).
const IMAGE = String.raw`(?:media-worker|\b(?:TINNOX_)?WORKER_IMAGE\b)`;
const IMAGE_RE = new RegExp(IMAGE);
// A shell line that runs a container, with its continuation lines, naming the image.
const SHELL_RUN = new RegExp(String.raw`docker\s+run\b[^\n]*(?:\\\n[^\n]*)*${IMAGE}`, 'g');
// An argument array that starts with Docker's run command, as a script hands to spawn or
// execFile: ['run', ...] or ["run", ...].
const ARGV_RUN = /\[\s*['"]run['"]\s*,/g;
// A compose service with the worker's name, or whose image is the worker's under another name.
const COMPOSE_SERVICE = new RegExp(
  String.raw`^ {2}media-worker:|^ {4}image:\s*['"]?[^\n]*${IMAGE}`,
  'm',
);
// Runs only another program of the image (the fixture generator's ffmpeg), not the worker: in
// an argument array, or on a shell line.
const OTHER_PROGRAM = /['"]--entrypoint['"]\s*,\s*['"](?:ffmpeg|ffprobe)['"]/;
const SHELL_OTHER_PROGRAM = /--entrypoint[\s=]+['"]?(?:ffmpeg|ffprobe)\b/;
// The options from the compose file, through this file: a call of workerRunArgs (or of the
// tests' workerContainerArgs), or, outside scripts/ and tests/ (which alone may import it), the
// output of the command that prints them.
const DERIVED_CALL = /\bworker(?:Run|Container)Args\s*\(/;
const DERIVED = /\bworker(?:Run|Container)Args\s*\(|\bworker-run-args\.ts\b/;

/**
 * `text` (JavaScript or TypeScript) with its comments blanked out, the length and the line breaks
 * kept, so neither a word in a comment nor an apostrophe in one ("the image's own user") counts.
 * Strings are kept. A regular expression literal holding a quote or two slashes can fool it.
 * Pure.
 */
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const two = text.slice(i, i + 2);
    const char = text.charAt(i);
    let end = i + 1;
    let blank = false;
    if (two === '//' || two === '/*') {
      const close = two === '//' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      end = close < 0 ? text.length : close + (two === '//' ? 0 : 2);
      blank = true;
    } else if (char === "'" || char === '"' || char === '`') {
      end = i + 1;
      while (end < text.length && text.charAt(end) !== char)
        end += text.charAt(end) === '\\' ? 2 : 1;
      end = Math.min(end + 1, text.length);
    }
    const part = text.slice(i, end);
    out += blank ? part.replace(/[^\n]/g, ' ') : part;
    i = end;
  }
  return out;
}

/** The array literal that opens at `open` of `code`, to its closing bracket. Pure. */
function arrayAt(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const char = code.charAt(i);
    if (char === "'" || char === '"' || char === '`') {
      i += 1;
      while (i < code.length && code.charAt(i) !== char) i += code.charAt(i) === '\\' ? 2 : 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

/**
 * Whether the run array `argv` of `code` takes the worker's options from the compose file: it
 * spreads a call of workerRunArgs or workerContainerArgs, or a variable `code` binds to one or
 * to the output of scripts/worker-run-args.ts. Pure.
 */
function spreadsDerived(code: string, argv: string): boolean {
  for (const spread of argv.matchAll(/\.\.\.\s*(\w+)(\s*\()?/g)) {
    const name = spread[1] ?? '';
    if (spread[2] !== undefined) {
      if (DERIVED_CALL.test(`${name}(`)) return true;
      continue;
    }
    const binding = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=([^;]*)`).exec(code);
    if (binding !== null && DERIVED.test(binding[1] ?? '')) return true;
  }
  return false;
}

/**
 * The runs of the worker image in `text` that take their options from nowhere checked: each
 * shell line and each argument array is judged by itself, its comments left out, so a file that
 * only mentions workerRunArgs or scripts/worker-run-args.ts, or runs it for one container, does
 * not excuse another. Pure.
 */
function underivedRuns(path: string, text: string): string[] {
  const code = /\.[cm]?[jt]sx?$/.test(path) ? withoutComments(text) : text;
  const runs: string[] = [];
  for (const line of code.matchAll(SHELL_RUN)) {
    if (!DERIVED.test(line[0]) && !SHELL_OTHER_PROGRAM.test(line[0])) runs.push(line[0]);
  }
  // The image is mostly held in a variable named elsewhere in the file, so any array that runs a
  // container in a file that names the image is judged.
  if (!IMAGE_RE.test(code)) return runs;
  for (const run of code.matchAll(ARGV_RUN)) {
    const argv = arrayAt(code, run.index);
    if (!spreadsDerived(code, argv) && !OTHER_PROGRAM.test(argv)) runs.push(argv);
  }
  return runs;
}

/**
 * Files that look like they define how the worker runs but are not in WORKER_COMPOSE_FILES: a
 * compose file with a service of the worker's name or image, an ECS task definition that names
 * the worker image, or a container run of its image from a shell line or an argument array. A
 * run whose own options come from `workerRunArgs` (directly, through the tests'
 * workerContainerArgs, or through scripts/worker-run-args.ts) is not one, nor is a run of another
 * program of the image. Pure.
 */
export function undeclaredWorkerDefinitions(
  files: readonly { readonly path: string; readonly text: string }[],
): string[] {
  return files.flatMap(({ path, text }) => {
    // This file holds the patterns themselves.
    if (WORKER_COMPOSE_FILES.includes(path) || path === HERE) return [];
    const compose = /\.ya?ml$/.test(path) && /^services:/m.test(text) && COMPOSE_SERVICE.test(text);
    const task = /containerDefinitions/i.test(text) && IMAGE_RE.test(text);
    const run = underivedRuns(path, text).length > 0;
    return compose || task || run
      ? [
          `${path} defines how the media worker runs, which nothing checks: run it through one of ${WORKER_COMPOSE_FILES.join(' or ')}, take its container options from workerRunArgs(renderedWorkerService(root, DEVELOPMENT_COMPOSE_FILE), jobs) of ${HERE} (outside scripts/ and tests/, from the output of scripts/worker-run-args.ts, as apps/media-worker/scripts/direct-check.mjs does), or add the file to WORKER_COMPOSE_FILES there so tests/integration/worker-runtime.test.ts judges it`,
        ]
      : [];
  });
}
