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
import { basename, join } from 'node:path';

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

// The scan for other places that run the worker (undeclaredWorkerDefinitions).
//
// What it sees, in every file it is given (comments left out of JavaScript and TypeScript):
// - a shell line, with its continuation lines, where docker, podman or nerdctl runs or creates
//   a container (`run`, `create`, `container run`, `container create`) and the worker image is
//   named on the same line;
// - in a file that names the worker image, an argument array that runs or creates a container:
//   one that starts with 'run' or 'create', with 'container' then one of them, or with a
//   variable followed somewhere by a literal 'run' or 'create';
// - a spawn or execFile of docker, podman or nerdctl whose arguments are built by concat or push
//   in the same call, which it cannot judge and so refuses;
// - a Docker Compose line (`docker compose` or `docker-compose`) that runs or starts the worker
//   service (`run` or `up` naming media-worker or the worker profile);
// - a compose file with a service of the worker's name or image, and an ECS task definition
//   that names the image.
// A run whose options come from workerRunArgs is judged as a whole: besides those options it may
// add only RUN_EXTRAS before the image (anything after the image is the worker's own command).
//
// What it cannot see: a command put together at run time from parts in different files (a verb
// or an argument array defined in one file and run in another), a wrapper script or alias that
// runs the engine under another name, an image name held in a variable defined in another file
// or under a name other than WORKER_IMAGE, a shell line that names neither the image nor the
// worker service, a Compose file chosen by COMPOSE_FILE or held whole in a variable (a path
// that starts with a variable and ends in the file name of a declared compose file is taken as
// that file), and a regular expression literal
// holding a quote or two slashes, which can make it misread the rest of a file.

// The worker image: by its name, or by the variables that hold it (TINNOX_WORKER_IMAGE in the
// scripts and tests, WORKER_IMAGE on a deployed server).
const IMAGE = String.raw`(?:media-worker|\b(?:TINNOX_)?WORKER_IMAGE\b)`;
const IMAGE_RE = new RegExp(IMAGE);
// A shell line that runs or creates a container, with its continuation lines, naming the image.
const SHELL_RUN = new RegExp(
  String.raw`\b(?:docker|podman|nerdctl)\s+(?:container\s+)?(?:run|create)\b[^\n]*(?:\\\n[^\n]*)*${IMAGE}`,
  'g',
);
// A compose service with the worker's name, or whose image is the worker's under another name.
const COMPOSE_SERVICE = new RegExp(
  String.raw`^ {2}media-worker:|^ {4}image:\s*['"]?[^\n]*${IMAGE}`,
  'm',
);
// A shell line of Docker Compose, with its continuation lines.
const SHELL_COMPOSE = /\bdocker[\s-]compose\b[^\n]*(?:\\\n[^\n]*)*/g;
// A call that hands a container engine its arguments.
const ENGINE_CALL =
  /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"](?:docker|podman|nerdctl)['"]\s*,/g;
const RUN_VERBS = new Set(['run', 'create']);
// A compose file in a command line, as a path that ends in the one of a declared file, or in its
// file name when a variable holds the folder (release.sh's "$here/compose.yml").
const declaredComposeFile = (file: string): boolean =>
  WORKER_COMPOSE_FILES.some(
    (declared) =>
      file === declared ||
      file.endsWith(`/${declared}`) ||
      (file.startsWith('$') && file.endsWith(`/${basename(declared)}`)),
  );
// Runs only another program of the image (the fixture generator's ffmpeg), not the worker: in
// an argument array, or on a shell line.
const OTHER_PROGRAM = /['"]--entrypoint['"]\s*,\s*['"](?:ffmpeg|ffprobe)['"]/;
const SHELL_OTHER_PROGRAM = /--entrypoint[\s=]+['"]?(?:ffmpeg|ffprobe)\b/;
// The options from the compose file, through this file: a call of workerRunArgs (or of the
// tests' workerContainerArgs), or, outside scripts/ and tests/ (which alone may import it), the
// output of the command that prints them.
const DERIVED_CALL = /^worker(?:Run|Container)Args\s*\(/;
const DERIVED = /\bworker(?:Run|Container)Args\s*\(|\bworker-run-args\.ts\b/;

interface Extra {
  readonly takesValue: boolean;
  /** Why it leaves the isolation of the compose file as it is. */
  readonly why: string;
}

/**
 * What a run that takes its options from the compose file may add before the image: what the two
 * runs of today add (tests/integration/support.ts: --detach and --rm;
 * apps/media-worker/scripts/direct-check.mjs: --rm and --name), and a restatement of two options
 * the compose file already sets. No mount is among them: workerRunArgs mounts the one job folder
 * the caller names, and a second one would reach more of the host.
 */
const RUN_EXTRAS: ReadonlyMap<string, Extra> = new Map([
  ['--rm', { takesValue: false, why: 'removes the container when it exits' }],
  ['--detach', { takesValue: false, why: 'returns once the container has started' }],
  ['-d', { takesValue: false, why: 'returns once the container has started' }],
  ['--name', { takesValue: true, why: 'names the container, so its caller can stop it' }],
  ['--read-only', { takesValue: false, why: 'restates read_only: true' }],
]);

/** The options that would undo the compose file's isolation, by name, with what each undoes. */
const LOOSENING: ReadonlyMap<string, string> = new Map([
  ['--network', 'gives the worker a network'],
  ['--net', 'gives the worker a network'],
  ['--privileged', 'gives it every capability and every device of the host'],
  ['--cap-add', 'gives it a capability back'],
  ['--security-opt', 'changes its confinement (seccomp, AppArmor, SELinux, no-new-privileges)'],
  ['--user', 'changes the user it runs as'],
  ['-u', 'changes the user it runs as'],
  ['--pid', 'shares a process namespace with it'],
  ['--ipc', 'shares an IPC namespace with it'],
  ['--device', 'gives it a device of the host'],
  ['--volume', 'mounts more of the host than the job folder'],
  ['-v', 'mounts more of the host than the job folder'],
  ['--mount', 'mounts more of the host than the job folder'],
  ['--env', 'passes it environment, where a secret could ride'],
  ['-e', 'passes it environment, where a secret could ride'],
  ['--env-file', 'passes it environment, where a secret could ride'],
  ['--tmpfs', 'adds a writable file system'],
]);

/** What `docker compose run` of the worker may add: no option of the service is changed. */
const COMPOSE_RUN_EXTRAS: ReadonlyMap<string, boolean> = new Map([
  ['--rm', false],
  ['--detach', false],
  ['-d', false],
  ['--no-deps', false],
  ['--name', true],
]);

/** What to do about an option a derived run adds. */
const ADDED = `Put the option in the worker service of ${WORKER_COMPOSE_FILES.join(' and ')}, where workerServiceProblems judges it; besides the options from workerRunArgs a run may add only ${[
  ...RUN_EXTRAS,
]
  .map(([name, extra]) => (extra.takesValue ? `${name} <value>` : name))
  .join(', ')} before the image, then the image and its command (${HERE})`;
/** What to do about a Docker Compose run of the worker the compose files do not hold. */
const COMPOSED = `Run the worker through ${WORKER_COMPOSE_FILES.join(' or ')} with --file, adding no option to the service, so workerServiceProblems judges what it runs with (${HERE})`;

/** One argument of a run: the derived options, another spread, a literal word, or anything else. */
interface Arg {
  readonly kind: 'derived' | 'spread' | 'literal' | 'expression';
  readonly text: string;
}

/**
 * `text` (JavaScript or TypeScript) with its comments blanked out, the length and the line breaks
 * kept, so neither a word in a comment nor an apostrophe in one ("the image's own user") counts.
 * Strings are kept. Pure.
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
      end = stringEnd(text, i) + 1;
    }
    const part = text.slice(i, end);
    out += blank ? part.replace(/[^\n]/g, ' ') : part;
    i = end;
  }
  return out;
}

/** The index of the quote that closes the string opening at `open` of `code`. Pure. */
function stringEnd(code: string, open: number): number {
  const quote = code.charAt(open);
  let i = open + 1;
  while (i < code.length && code.charAt(i) !== quote) i += code.charAt(i) === '\\' ? 2 : 1;
  return Math.min(i, code.length - 1);
}

/** The bracketed text that opens at `open` of `code`, to the bracket that closes it. Pure. */
function balancedAt(code: string, open: number): string {
  const opening = code.charAt(open);
  const closing = opening === '[' ? ']' : ')';
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const char = code.charAt(i);
    if (char === "'" || char === '"' || char === '`') {
      i = stringEnd(code, i);
    } else if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

/** Every array literal of `code` (strings skipped), nested ones too. Pure. */
function arraysOf(code: string): string[] {
  const arrays: string[] = [];
  for (let i = 0; i < code.length; i += 1) {
    const char = code.charAt(i);
    if (char === "'" || char === '"' || char === '`') i = stringEnd(code, i);
    else if (char === '[') arrays.push(balancedAt(code, i));
  }
  return arrays;
}

/** The top-level elements of the array literal `array`, as text. Pure. */
function elementsOf(array: string): string[] {
  const inner = array.slice(1, array.endsWith(']') ? -1 : undefined);
  const elements: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner.charAt(i);
    if (char === "'" || char === '"' || char === '`') i = stringEnd(inner, i);
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      elements.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last !== '') elements.push(last);
  return elements;
}

/**
 * One element of an argument array of `code`: a spread is the derived options when it spreads a
 * call of workerRunArgs or workerContainerArgs, or a variable `code` binds to one or to the
 * output of scripts/worker-run-args.ts. Pure.
 */
function argOf(code: string, element: string): Arg {
  const spread = /^\.\.\.\s*([\s\S]*)$/.exec(element);
  if (spread !== null) {
    const spreadOf = spread[1] ?? '';
    if (DERIVED_CALL.test(spreadOf)) return { kind: 'derived', text: element };
    if (/^\w+$/.test(spreadOf)) {
      const binding = new RegExp(String.raw`\b(?:const|let|var)\s+${spreadOf}\s*=([^;]*)`).exec(
        code,
      );
      if (binding !== null && DERIVED.test(binding[1] ?? '')) {
        return { kind: 'derived', text: element };
      }
    }
    return { kind: 'spread', text: element };
  }
  const literal = /^(['"`])([\s\S]*)\1$/.exec(element);
  if (literal !== null && !(literal[1] === '`' && literal[2]?.includes('${'))) {
    return { kind: 'literal', text: literal[2] ?? '' };
  }
  return { kind: 'expression', text: element };
}

/** The arguments after the verb, when `args` runs or creates a container; else null. Pure. */
function runArgsOf(args: readonly Arg[]): readonly Arg[] | null {
  const word = (i: number): string | undefined =>
    args[i]?.kind === 'literal' ? args[i]?.text : undefined;
  if (RUN_VERBS.has(word(0) ?? '')) return args.slice(1);
  if (word(0) === 'container' && RUN_VERBS.has(word(1) ?? '')) return args.slice(2);
  if (args[0]?.kind === 'expression') {
    const verb = args.findIndex((arg) => arg.kind === 'literal' && RUN_VERBS.has(arg.text));
    if (verb > 0) return args.slice(verb + 1);
  }
  return null;
}

/**
 * Whether the arguments of a run (after its verb) take the worker's options from the compose
 * file, and what else they add before the image that is not in RUN_EXTRAS. Pure.
 */
function judgeRun(args: readonly Arg[]): { derived: boolean; added: string[] } {
  let derived = false;
  const added: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg.kind === 'derived') {
      derived = true;
      continue;
    }
    if (arg.kind === 'spread') {
      added.push(`${arg.text}, options this check cannot read`);
      continue;
    }
    // The first word that is not an option is the image; what follows is the worker's command.
    if (arg.kind !== 'literal' || !arg.text.startsWith('-')) break;
    const equals = arg.text.indexOf('=');
    const name = equals < 0 ? arg.text : arg.text.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.text.slice(equals + 1);
    const extra = RUN_EXTRAS.get(name);
    const loosening = LOOSENING.get(name);
    const value = inline ?? (args[i + 1]?.kind === 'literal' ? args[i + 1]?.text : undefined);
    if (name === '--read-only' && inline !== undefined && inline !== 'true') {
      added.push(`${arg.text}, which makes its root file system writable`);
    } else if (extra !== undefined) {
      if (extra.takesValue && inline === undefined) i += 1;
    } else if ((name === '--network' || name === '--net') && value === 'none') {
      // A restatement of network_mode: none.
      if (inline === undefined) i += 1;
    } else if (loosening !== undefined) {
      added.push(`${name}, which ${loosening}`);
      if (name !== '--privileged' && inline === undefined) i += 1;
    } else {
      added.push(`${name}, which is not among the options a derived run may add`);
    }
  }
  return { derived, added };
}

/** The words of a shell command line, its continuations joined and one level of quotes taken off. */
function shellWords(line: string): string[] {
  return line
    .replace(/\\\n/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.replace(/^['"]+|['"]+,?$/g, ''));
}

/** The arguments of a shell run line after its verb, a substitution of the options marked. */
function shellRunArgs(line: string): Arg[] {
  // A substitution is one word: the derived options when it prints them, else unknown options.
  const marked = line
    .replace(/\\\n/g, ' ')
    .replace(/\$\([^)]*\)|\$\{[^}]*\}/g, (part) =>
      DERIVED.test(part) ? ' \0derived ' : part.startsWith('$(') ? ' \0spread ' : ' \0value ',
    );
  const words = shellWords(marked);
  const verb = words.findIndex((word) => RUN_VERBS.has(word));
  return words.slice(verb + 1).map((word): Arg => {
    if (word === '\0derived') return { kind: 'derived', text: word };
    if (word === '\0spread') return { kind: 'spread', text: 'a command substitution' };
    if (word === '\0value') return { kind: 'expression', text: word };
    return { kind: 'literal', text: word };
  });
}

/**
 * What is wrong with a Docker Compose command line `words` that runs or starts the worker: a
 * compose file other than the declared ones, none named, or an option added to `run`. Pure.
 */
function composeProblems(words: readonly string[]): string[] {
  const verb = words.findIndex((word) => word === 'run' || word === 'up');
  if (verb < 0) return [];
  const worker =
    words.includes(WORKER_SERVICE) ||
    words.some(
      (word, i) =>
        word === '--profile=worker' || (word === '--profile' && words[i + 1] === 'worker'),
    );
  if (!worker) return [];
  const files = words.flatMap((word, i) => {
    if (word === '-f' || word === '--file') return [words[i + 1] ?? ''];
    return word.startsWith('--file=') ? [word.slice('--file='.length)] : [];
  });
  const declared = WORKER_COMPOSE_FILES.join(' or ');
  const problems: string[] = [];
  if (files.length === 0) {
    problems.push(
      `starts the worker with Docker Compose and names no compose file: name ${declared} with --file`,
    );
  }
  for (const file of files.filter((f) => !declaredComposeFile(f))) {
    problems.push(`starts the worker from ${file}, which is not ${declared}`);
  }
  if (words[verb] === 'run') {
    for (let i = verb + 1; i < words.length; i += 1) {
      const word = words[i] ?? '';
      if (!word.startsWith('-')) break;
      const name = word.split('=')[0] ?? word;
      const takesValue = COMPOSE_RUN_EXTRAS.get(name);
      if (takesValue === undefined) {
        problems.push(
          `adds ${name} to docker compose run, which may change the service's isolation: only ${[...COMPOSE_RUN_EXTRAS.keys()].join(', ')} may be added`,
        );
      } else if (takesValue && !word.includes('=')) {
        i += 1;
      }
    }
  }
  return problems;
}

/**
 * The runs of the worker image in `text`, each judged by itself, its comments left out (so a
 * file that only mentions workerRunArgs or scripts/worker-run-args.ts, or runs it for one
 * container, does not excuse another): whether one takes its options from nowhere checked, and
 * what is wrong with the others (options added to the derived ones, a Compose run outside the
 * declared files). Pure.
 */
function workerRuns(path: string, text: string): { underived: boolean; problems: string[] } {
  const code = /\.[cm]?[jt]sx?$/.test(path) ? withoutComments(text) : text;
  let underived = false;
  const problems: string[] = [];
  const judge = (args: readonly Arg[]): void => {
    const { derived, added } = judgeRun(args);
    if (!derived) underived = true;
    else problems.push(...added.map((what) => `adds ${what}. ${ADDED}`));
  };
  for (const line of code.matchAll(SHELL_RUN)) {
    if (!SHELL_OTHER_PROGRAM.test(line[0])) judge(shellRunArgs(line[0]));
  }
  for (const line of code.matchAll(SHELL_COMPOSE)) {
    // One command: the line up to the next one it chains.
    const words = shellWords(line[0].split(/&&|\|\||;|\|/)[0] ?? '');
    problems.push(...composeProblems(words).map((what) => `${what}. ${COMPOSED}`));
  }
  // The image is mostly held in a variable named elsewhere in the file, so any array that runs a
  // container in a file that names the image is judged.
  if (!IMAGE_RE.test(code)) return { underived, problems };
  for (const array of arraysOf(code)) {
    const args = elementsOf(array).map((element) => argOf(code, element));
    if (args[0]?.kind === 'literal' && args[0].text === 'compose') {
      problems.push(
        ...composeProblems(
          args.map((arg) => (arg.kind === 'literal' ? arg.text : '<expression>')),
        ).map((what) => `${what}. ${COMPOSED}`),
      );
      continue;
    }
    const runArgs = runArgsOf(args);
    if (runArgs !== null && !OTHER_PROGRAM.test(array)) judge(runArgs);
  }
  // Arguments built by concat or push in the call itself: no one array holds them to be judged.
  for (const call of code.matchAll(ENGINE_CALL)) {
    const argsText = balancedAt(code, code.indexOf('(', call.index));
    if (/\.(?:concat|push)\s*\(/.test(argsText) && /['"](?:run|create)['"]/.test(argsText)) {
      underived = true;
    }
  }
  return { underived, problems };
}

/**
 * Files that look like they define how the worker runs but are not in WORKER_COMPOSE_FILES: a
 * compose file with a service of the worker's name or image, an ECS task definition that names
 * the worker image, or a container run of its image from a shell line or an argument array
 * (see the header of this part for the forms). A run whose own options come from `workerRunArgs`
 * (directly, through the tests' workerContainerArgs, or through scripts/worker-run-args.ts) is
 * not one, nor is a run of another program of the image, but each option such a run adds beyond
 * RUN_EXTRAS is a problem of its own, as is a Docker Compose run of the worker outside the
 * declared files. Pure.
 */
export function undeclaredWorkerDefinitions(
  files: readonly { readonly path: string; readonly text: string }[],
): string[] {
  return files.flatMap(({ path, text }) => {
    // This file holds the patterns themselves.
    if (WORKER_COMPOSE_FILES.includes(path) || path === HERE) return [];
    const compose = /\.ya?ml$/.test(path) && /^services:/m.test(text) && COMPOSE_SERVICE.test(text);
    const task = /containerDefinitions/i.test(text) && IMAGE_RE.test(text);
    const { underived, problems } = workerRuns(path, text);
    return [
      ...(compose || task || underived
        ? [
            `${path} defines how the media worker runs, which nothing checks: run it through one of ${WORKER_COMPOSE_FILES.join(' or ')}, take its container options from workerRunArgs(renderedWorkerService(root, DEVELOPMENT_COMPOSE_FILE), jobs) of ${HERE} (outside scripts/ and tests/, from the output of scripts/worker-run-args.ts, as apps/media-worker/scripts/direct-check.mjs does), as one array literal that spreads them, or add the file to WORKER_COMPOSE_FILES there so tests/integration/worker-runtime.test.ts judges it`,
          ]
        : []),
      ...problems.map((problem) => `${path}: a run of the media worker ${problem}`),
    ];
  });
}
