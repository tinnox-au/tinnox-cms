// The media worker's isolation (OTH-15, adoption plan step 33): the rules over a service as
// `docker compose config --format json` renders it, then the repository's own files. The real
// compose files are rendered by Docker in tests/integration/worker-runtime.test.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import {
  composeFailure,
  dockerfileUser,
  isolationOf,
  undeclaredWorkerDefinitions,
  WORKER_COMPOSE_FILES,
  WORKER_DOCKERFILE,
  workerRunArgs,
  workerServiceOf,
  workerServiceProblems,
  type ComposeService,
} from './worker-runtime-check.ts';

/** The development service as `docker compose config --no-interpolate --format json` gave it. */
const SERVICE: ComposeService = {
  build: { context: '/repo', dockerfile: 'apps/media-worker/Dockerfile' },
  cap_drop: ['ALL'],
  cpus: 1,
  environment: { MEDIA_JOBS_DIR: '/jobs', NODE_ENV: 'production' },
  healthcheck: { interval: '15s', retries: 3, test: ['CMD-SHELL', 'true'], timeout: '5s' },
  image: 'tinnox-cms-media-worker:m0',
  init: true,
  mem_limit: '768m',
  memswap_limit: '768m',
  network_mode: 'none',
  pids_limit: 128,
  profiles: ['worker'],
  read_only: true,
  restart: 'unless-stopped',
  security_opt: ['no-new-privileges:true'],
  stop_grace_period: '5s',
  tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777'],
  user: '10001:10001',
  volumes: [{ type: 'bind', source: '/repo/data/jobs', target: '/jobs' }],
};

const FILE = 'infra/docker-compose.yml';
const problemsOf = (changes: Record<string, unknown>): string[] =>
  workerServiceProblems(FILE, { ...SERVICE, ...changes });

describe('workerServiceProblems', () => {
  it('passes the worker as the compose files define it', () => {
    expect(workerServiceProblems(FILE, SERVICE)).toEqual([]);
  });

  it.each([
    ['a network', { network_mode: 'bridge' }, 'set network_mode: none'],
    ['no network_mode at all', { network_mode: undefined }, 'set network_mode: none'],
    ['a writable root', { read_only: false }, 'set read_only: true'],
    ['root', { user: '0:0' }, 'set user to a numeric uid:gid other than root'],
    ['a user by name', { user: 'worker' }, 'set user to a numeric uid:gid other than root'],
    ['capabilities kept', { cap_drop: ['NET_RAW'] }, 'drop every capability'],
    ['new privileges', { security_opt: [] }, 'keep security_opt: [no-new-privileges:true]'],
    [
      'no seccomp profile',
      { security_opt: ['no-new-privileges:true', 'seccomp:unconfined'] },
      'add no other option',
    ],
    [
      'no AppArmor profile',
      { security_opt: ['no-new-privileges:true', 'apparmor:unconfined'] },
      'add no other option',
    ],
    [
      'no SELinux label',
      { security_opt: ['label:disable', 'no-new-privileges:true'] },
      'add no other option',
    ],
    ['no process limit', { pids_limit: undefined }, 'keep a positive pids_limit limit'],
    ['an unlimited process count', { pids_limit: -1 }, 'keep a positive pids_limit limit'],
    ['a process limit of 0', { pids_limit: 0 }, 'keep a positive pids_limit limit'],
    ['no memory limit', { mem_limit: '0' }, 'keep a positive mem_limit limit'],
    ['a memory limit that is not a size', { mem_limit: 'lots' }, 'keep a positive mem_limit limit'],
    ['no CPU limit', { cpus: 0 }, 'keep a positive cpus limit'],
    [
      'a secret in the environment',
      { environment: { ...(SERVICE['environment'] as object), DATABASE_URL: 'x' } },
      'pass no other environment than MEDIA_JOBS_DIR and NODE_ENV',
    ],
    [
      'a second mount',
      { volumes: [{ target: '/jobs' }, { target: '/data/media' }] },
      'mount the job folder at /jobs',
    ],
    [
      'a read-only job folder',
      { volumes: [{ target: '/jobs', read_only: true }] },
      'mount the job folder at /jobs',
    ],
  ])('flags %s', (_what, changes, message) => {
    expect(problemsOf(changes)).toEqual([expect.stringContaining(message)]);
  });

  it.each(['cap_add', 'privileged', 'ports', 'networks', 'env_file', 'secrets', 'devices', 'ipc'])(
    'flags %s, which it does not judge, with what to decide (OTH-15)',
    (key) => {
      expect(problemsOf({ [key]: ['x'] })).toEqual([
        `${FILE}, service media-worker: sets ${key}, which this check does not judge. Decide whether it weakens the worker's isolation; if it does not, add it to KNOWN_KEYS in scripts/lib/worker-runtime-check.ts, and to workerRunArgs if the test container must carry it too`,
      ]);
    },
  );

  it('reads a memory limit as Compose may render it', () => {
    expect(problemsOf({ mem_limit: 805306368, cpus: '1.0' })).toEqual([]);
  });

  it('compares two definitions on everything but how the image is named, built, ordered and mounted', () => {
    const deployed = {
      ...SERVICE,
      image: '${WORKER_IMAGE:?}',
      build: undefined,
      profiles: undefined,
      depends_on: { api: {} },
      volumes: [{ type: 'volume', source: 'jobs', target: '/jobs' }],
    };
    expect(isolationOf(deployed)).toEqual(isolationOf(SERVICE));
    expect(isolationOf({ ...SERVICE, pids_limit: 4096 })).not.toEqual(isolationOf(SERVICE));
  });
});

describe('workerRunArgs', () => {
  it('starts the test container with every isolation option of the service', () => {
    expect(workerRunArgs(SERVICE, '/tmp/jobs')).toEqual([
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
      '--memory-swap',
      '768m',
      '--cpus',
      '1',
      '--init',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
      '--env',
      'MEDIA_JOBS_DIR=/jobs',
      '--env',
      'NODE_ENV=production',
      '--volume',
      '/tmp/jobs:/jobs:rw',
    ]);
  });

  it('refuses a service it could not start with the same isolation', () => {
    expect(() => workerRunArgs({ ...SERVICE, cap_add: ['SYS_ADMIN'] }, '/tmp/jobs')).toThrow(
      /sets cap_add, which this check does not judge/,
    );
    expect(() => workerRunArgs({ ...SERVICE, network_mode: 'host' }, '/tmp/jobs')).toThrow(
      /set network_mode: none/,
    );
  });
});

describe('workerServiceOf and composeFailure', () => {
  it('takes the worker service from the rendered configuration', () => {
    expect(
      workerServiceOf(FILE, JSON.stringify({ services: { api: {}, 'media-worker': SERVICE } })),
    ).toEqual(SERVICE);
  });

  it('says what to do when the file has no worker service', () => {
    expect(() => workerServiceOf(FILE, JSON.stringify({ services: { worker: SERVICE } }))).toThrow(
      'infra/docker-compose.yml defines no media-worker service: keep the worker under that name, or change WORKER_SERVICE and WORKER_COMPOSE_FILES in scripts/lib/worker-runtime-check.ts',
    );
  });

  it("gives Compose's own reason and what the check needs when rendering fails", () => {
    const message = composeFailure(FILE, 'unknown flag: --no-interpolate\n (exit 1)\n');
    expect(message).toContain(
      'docker compose could not render infra/docker-compose.yml: unknown flag: --no-interpolate\n (exit 1).',
    );
    expect(message).toContain('config --no-interpolate --format json');
    expect(composeFailure(FILE, '  ')).toContain('it gave no reason');
  });
});

describe('dockerfileUser and undeclaredWorkerDefinitions', () => {
  it('reads the last USER line', () => {
    expect(
      dockerfileUser('FROM a AS deps\nUSER root\nFROM b\nUSER 10001:10001\nENTRYPOINT []\n'),
    ).toBe('10001:10001');
    expect(dockerfileUser('FROM a\n')).toBeNull();
  });

  it('flags a second compose definition, a task definition and a docker run of the worker', () => {
    const compose = 'services:\n  media-worker:\n    image: x\n';
    expect(
      undeclaredWorkerDefinitions([
        { path: 'infra/other/compose.yaml', text: compose },
        {
          path: 'infra/aws/worker.json',
          text: '{"containerDefinitions":[{"image":"tinnox-cms/media-worker"}]}',
        },
        {
          path: 'infra/deploy/run.sh',
          text: 'docker run --rm \\\n  "$REGISTRY/tinnox-cms/media-worker:$TAG"\n',
        },
      ]),
    ).toEqual([
      expect.stringMatching(/^infra\/other\/compose\.yaml defines how the media worker runs/),
      expect.stringMatching(/^infra\/aws\/worker\.json defines how the media worker runs/),
      expect.stringMatching(/^infra\/deploy\/run\.sh defines how the media worker runs/),
    ]);
  });

  it('flags a run of the image held in a variable, as a shell line or an argument array, and a service that runs the image under another name', () => {
    expect(
      undeclaredWorkerDefinitions([
        { path: 'infra/deploy/worker.sh', text: 'docker run --rm \\\n  "$WORKER_IMAGE"\n' },
        {
          path: 'apps/media-worker/scripts/check.mjs',
          text: "const image = process.env.TINNOX_WORKER_IMAGE;\nspawn('docker', [\n  'run',\n  '--network',\n  'none',\n  image,\n]);",
        },
        {
          path: 'infra/staging/compose.yml',
          text: 'services:\n  validator:\n    image: ${WORKER_IMAGE:?}\n',
        },
        {
          path: 'infra/other/compose.yaml',
          text: "services:\n  checker:\n    image: 'tinnox-cms-media-worker:m0'\n",
        },
      ]),
    ).toEqual([
      expect.stringMatching(/^infra\/deploy\/worker\.sh defines how the media worker runs/),
      expect.stringMatching(
        /^apps\/media-worker\/scripts\/check\.mjs defines how the media worker runs/,
      ),
      expect.stringMatching(/^infra\/staging\/compose\.yml defines how the media worker runs/),
      expect.stringMatching(/^infra\/other\/compose\.yaml defines how the media worker runs/),
    ]);
  });

  it('leaves a run that takes its options from workerRunArgs or scripts/worker-run-args.ts, and a run of the image ffmpeg', () => {
    expect(
      undeclaredWorkerDefinitions([
        {
          path: 'apps/media-worker/scripts/direct-check.mjs',
          text: "const image = process.env.TINNOX_WORKER_IMAGE;\nconst isolation = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'worker-run-args.ts'), jobs]));\nspawn('docker', ['run', '--rm', ...isolation, image]);",
        },
        {
          path: 'scripts/worker-check.ts',
          text: "spawnSync('docker', ['run', ...workerRunArgs(service, jobs), WORKER_IMAGE]);",
        },
        {
          path: 'apps/api/test-fixtures/generate.mjs',
          text: "const image = process.env.TINNOX_WORKER_IMAGE;\nexecFileSync('docker', [\n  'run',\n  '--rm',\n  '--entrypoint',\n  'ffmpeg',\n  image,\n]);",
        },
        {
          path: 'scripts/scan-secrets.mjs',
          text: "spawnSync('docker', ['run', '--rm', '--network', 'none', IMAGE]);",
        },
      ]),
    ).toEqual([]);
  });

  it('judges each run by itself: a mention of worker-run-args.ts or workerRunArgs elsewhere in the file, or in a comment, excuses no run (OTH-15)', () => {
    const header =
      '// The container has the isolation of the compose service, read by scripts/worker-run-args.ts.\n';
    const isolation =
      "const isolation = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'worker-run-args.ts'), jobs]));\n";
    const image =
      "const image = process.env.TINNOX_WORKER_IMAGE ?? 'tinnox-cms-media-worker:m0';\n";
    const flagged: [string, string][] = [
      // The options are printed but not spread: the container runs with no isolation.
      [
        'the options unused',
        `${header}${image}${isolation}spawn('docker', ['run', '--rm', image]);`,
      ],
      [
        'only a comment',
        `${header}${image}spawn('docker', ['run', '--rm', /* ...isolation, workerRunArgs(s, j) */ image]);`,
      ],
      [
        'a second run',
        `${image}${isolation}spawn('docker', ['run', ...isolation, image]);\nspawn('docker', ['run', '--rm', image]);`,
      ],
      [
        'ffmpeg in a comment only',
        `${image}spawn('docker', [\n  'run',\n  // not '--entrypoint', 'ffmpeg'\n  image,\n]);`,
      ],
      [
        'a spread of something else',
        `${image}${isolation}const other = ['--rm'];\nspawn('docker', ['run', ...other, image]);`,
      ],
      [
        'a shell line, the command named on another line',
        'docker run --rm "$WORKER_IMAGE"\n# worker-run-args.ts\n',
      ],
    ];
    for (const [what, text] of flagged) {
      expect(
        undeclaredWorkerDefinitions([{ path: 'apps/media-worker/scripts/check.mjs', text }]),
        what,
      ).toHaveLength(1);
    }
    // The same runs with their own options derived: an apostrophe in a comment inside the array
    // does not end it early.
    expect(
      undeclaredWorkerDefinitions([
        {
          path: 'apps/media-worker/scripts/check.mjs',
          text: `${header}${image}${isolation}spawn('docker', [\n  'run',\n  // the image's own user\n  ...isolation,\n  image,\n]);`,
        },
        {
          path: 'infra/deploy/check.sh',
          text: 'docker run --rm $(node scripts/worker-run-args.ts /srv/jobs) "$WORKER_IMAGE"\n',
        },
      ]),
    ).toEqual([]);
  });

  it('leaves the declared compose files, an image build and an image name alone', () => {
    expect(
      undeclaredWorkerDefinitions([
        { path: 'infra/docker-compose.yml', text: 'services:\n  media-worker:\n' },
        {
          path: '.github/workflows/deploy.yml',
          text: 'run: docker build media-worker --file apps/media-worker/Dockerfile',
        },
        {
          path: 'infra/deploy/release.sh',
          text: 'export WORKER_IMAGE="$R/tinnox-cms/media-worker:$TAG"\ndocker run --rm --name tinnox-cms-migrate "$RELEASE_IMAGE"',
        },
      ]),
    ).toEqual([]);
  });
});

describe('undeclaredWorkerDefinitions: the whole run of a derived container (OTH-15)', () => {
  const PATH = 'apps/media-worker/scripts/check.mjs';
  const head =
    "const image = process.env.TINNOX_WORKER_IMAGE;\nconst isolation = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'worker-run-args.ts'), jobs]));\n";
  const argv = (extra: string): string =>
    `${head}spawn('docker', ['run', '--rm', '--name', name, ...isolation, ${extra}image]);`;
  const scan = (text: string, path = PATH): string[] =>
    undeclaredWorkerDefinitions([{ path, text }]);

  it.each([
    ["'--network', 'host', ", '--network, which gives the worker a network'],
    ["'--network=bridge', ", '--network, which gives the worker a network'],
    ["'--privileged', ", '--privileged, which gives it every capability'],
    ["'--cap-add', 'SYS_ADMIN', ", '--cap-add, which gives it a capability back'],
    ["'--security-opt', 'seccomp=unconfined', ", '--security-opt, which changes its confinement'],
    ["'--security-opt', 'no-new-privileges:true', ", '--security-opt, which changes'],
    ["'--user', '0:0', ", '--user, which changes the user it runs as'],
    ["'-u', 'root', ", '-u, which changes the user it runs as'],
    ["'--pid', 'host', ", '--pid, which shares a process namespace'],
    ["'--ipc=host', ", '--ipc, which shares an IPC namespace'],
    ["'--device', '/dev/kvm', ", '--device, which gives it a device of the host'],
    ["'-v', '/:/host', ", '-v, which mounts more of the host'],
    ["'--volume', '/srv/jobs:/scratch', ", '--volume, which mounts more of the host'],
    ["'--mount', 'type=bind,src=/,dst=/h', ", '--mount, which mounts more of the host'],
    ["'--env', 'DATABASE_URL=x', ", '--env, which passes it environment'],
    ["'-e', 'A=b', ", '-e, which passes it environment'],
    ["'--env-file', '.env', ", '--env-file, which passes it environment'],
    ["'--tmpfs', '/data', ", '--tmpfs, which adds a writable file system'],
    ["'--read-only=false', ", '--read-only=false, which makes its root file system writable'],
    ["'--publish', '80:80', ", '--publish, which is not among the options a derived run may add'],
    ['...extra, ', '...extra, options this check cannot read'],
  ])('flags %s after the derived options, by name', (extra, what) => {
    const problems = scan(argv(extra));
    expect(problems).toEqual([
      expect.stringContaining(`${PATH}: a run of the media worker adds ${what}`),
    ]);
    expect(problems[0]).toMatch(/\. Put the option in the worker service of /);
  });

  it('says where the option belongs and the closed list of what a run may add', () => {
    expect(scan(argv("'--cap-add', 'SYS_ADMIN', "))).toEqual([
      `${PATH}: a run of the media worker adds --cap-add, which gives it a capability back. Put the option in the worker service of infra/docker-compose.yml and infra/deploy/compose.yml, where workerServiceProblems judges it; besides the options from workerRunArgs a run may add only --rm, --detach, -d, --name <value>, --read-only before the image, then the image and its command (scripts/lib/worker-runtime-check.ts)`,
    ]);
  });

  it('flags an option added before the spread, and one added to a derived shell line', () => {
    expect(
      scan(`${head}spawn('docker', ['run', '--privileged', ...isolation, image]);`),
    ).toHaveLength(1);
    expect(
      scan(
        'docker run --rm --cap-add SYS_ADMIN $(node scripts/worker-run-args.ts /srv/jobs) "$WORKER_IMAGE"\n',
        'infra/deploy/check.sh',
      ),
    ).toEqual([expect.stringContaining('adds --cap-add, which gives it a capability back')]);
  });

  it('leaves what the two runs of today add, a restatement of the compose file, and the command after the image', () => {
    expect(scan(argv(''))).toEqual([]);
    expect(
      scan(
        "spawnSync('docker', ['run', '--detach', '--rm', ...workerContainerArgs(t.jobsDir), WORKER_IMAGE]);",
        'scripts/worker-check.ts',
      ),
    ).toEqual([]);
    expect(scan(argv("'--network', 'none', '--read-only', '-d', "))).toEqual([]);
    expect(
      scan(`${head}spawn('docker', ['run', '--rm', ...isolation, image, '--env', 'verbose']);`),
    ).toEqual([]);
    expect(
      scan(
        'docker run --rm --name w $(node scripts/worker-run-args.ts /srv/jobs) "$WORKER_IMAGE"\n',
        'infra/deploy/check.sh',
      ),
    ).toEqual([]);
  });

  it('flags a run whose derived options come after the image, where they are its command', () => {
    expect(scan(`${head}spawn('docker', ['run', '--rm', image, ...isolation]);`)).toEqual([
      expect.stringMatching(/defines how the media worker runs, which nothing checks/),
    ]);
  });
});

describe('undeclaredWorkerDefinitions: the run forms it recognises (OTH-15)', () => {
  const head = 'const image = process.env.TINNOX_WORKER_IMAGE;\n';
  const isolation =
    "const isolation = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'worker-run-args.ts'), jobs]));\n";
  const flagged = (path: string, text: string): void => {
    expect(undeclaredWorkerDefinitions([{ path, text }]), text).toEqual([
      expect.stringMatching(/defines how the media worker runs, which nothing checks/),
    ]);
  };
  const left = (path: string, text: string): void => {
    expect(undeclaredWorkerDefinitions([{ path, text }]), text).toEqual([]);
  };

  it.each([
    'docker container run --rm "$WORKER_IMAGE"',
    'docker create --name w "$WORKER_IMAGE"',
    'docker container create "$WORKER_IMAGE"',
    'podman run --rm "$WORKER_IMAGE"',
    'nerdctl run --rm tinnox-cms-media-worker:m0',
    'podman container run \\\n  --rm \\\n  "$WORKER_IMAGE"',
  ])('flags the shell line %s', (line) => {
    flagged('infra/deploy/worker.sh', `${line}\n`);
  });

  it.each([
    'docker container run --rm $(node scripts/worker-run-args.ts /srv/jobs) "$WORKER_IMAGE"',
    'podman create $(node scripts/worker-run-args.ts /srv/jobs) "$WORKER_IMAGE"',
    'docker container ls --filter ancestor="$WORKER_IMAGE"',
    'docker image inspect "$WORKER_IMAGE"',
  ])('leaves the shell line %s', (line) => {
    left('infra/deploy/worker.sh', `${line}\n`);
  });

  it.each([
    ["['container', 'run', '--rm', image]", 'container then run'],
    ["['create', '--name', 'w', image]", 'create'],
    ["['container', 'create', image]", 'container then create'],
    ["[engineVerb, 'run', '--rm', image]", 'a variable first, then a literal run'],
    ["[prefix, '--quiet', 'create', image]", 'a variable first, then a literal create'],
    ["['run'].concat(['--rm', image])", 'arguments built by concat'],
  ])('flags the argument array %s (%s)', (args) => {
    flagged('apps/media-worker/scripts/check.mjs', `${head}spawn('docker', ${args});`);
  });

  it('flags arguments pushed in the call itself, which no one array holds', () => {
    flagged(
      'apps/media-worker/scripts/check.mjs',
      `${head}${isolation}spawnSync('podman', (a.push('run', ...isolation), a), image);`,
    );
  });

  it.each([
    ["['container', 'run', '--rm', ...isolation, image]", 'container then run, derived'],
    ["[engineVerb, 'run', ...isolation, image]", 'a variable first, derived'],
    ["['container', 'ls', '--filter', image]", 'container then ls'],
    ["[engineVerb, '--rm', image]", 'a variable first, with no literal run'],
    ["['image', 'inspect', image]", 'an image inspection'],
  ])('leaves the argument array %s (%s)', (args) => {
    left('apps/media-worker/scripts/check.mjs', `${head}${isolation}spawn('docker', ${args});`);
  });

  it('leaves concat in a call that runs nothing', () => {
    left(
      'apps/media-worker/scripts/check.mjs',
      `${head}spawnSync('docker', ['image', 'inspect'].concat([image]));`,
    );
  });

  it.each([
    [
      'another compose file',
      'docker compose -f infra/staging/compose.yml run --rm media-worker',
      'starts the worker from infra/staging/compose.yml, which is not infra/docker-compose.yml or infra/deploy/compose.yml',
    ],
    [
      'no compose file',
      'docker compose --profile worker up -d',
      'starts the worker with Docker Compose and names no compose file',
    ],
    [
      'an option added to run',
      'docker compose -f infra/docker-compose.yml run --cap-add SYS_ADMIN media-worker',
      'adds --cap-add to docker compose run',
    ],
    [
      'docker-compose, an environment added to run',
      'docker-compose --file infra/docker-compose.yml run -e A=b media-worker',
      'adds -e to docker compose run',
    ],
  ])('flags a Docker Compose run of the worker: %s', (_what, line, message) => {
    const problems = undeclaredWorkerDefinitions([
      { path: 'scripts/worker.sh', text: `${line}\n` },
    ]);
    expect(problems).toEqual([
      expect.stringContaining(`scripts/worker.sh: a run of the media worker ${message}`),
    ]);
    expect(problems[0]).toMatch(
      /\. Run the worker through infra\/docker-compose\.yml or infra\/deploy\/compose\.yml with --file, adding no option to the service, so workerServiceProblems judges what it runs with \(scripts\/lib\/worker-runtime-check\.ts\)$/,
    );
  });

  it('names the one file a Docker Compose run must use', () => {
    expect(
      undeclaredWorkerDefinitions([
        { path: 'scripts/worker.sh', text: 'docker compose --profile worker up -d\n' },
      ]),
    ).toEqual([
      `scripts/worker.sh: a run of the media worker starts the worker with Docker Compose and names no compose file: name infra/docker-compose.yml or infra/deploy/compose.yml with --file. Run the worker through infra/docker-compose.yml or infra/deploy/compose.yml with --file, adding no option to the service, so workerServiceProblems judges what it runs with (scripts/lib/worker-runtime-check.ts)`,
    ]);
  });

  it('flags a Docker Compose run in an argument array', () => {
    expect(
      undeclaredWorkerDefinitions([
        {
          path: 'apps/media-worker/scripts/check.mjs',
          text: `${head}spawn('docker', ['compose', '-f', 'other.yml', 'up', 'media-worker']);`,
        },
      ]),
    ).toEqual([expect.stringContaining('starts the worker from other.yml')]);
  });

  it('leaves Docker Compose runs through the declared files, and runs of other services', () => {
    left(
      'package.json',
      '"infra:up": "docker compose --env-file .env -f infra/docker-compose.yml --profile worker up -d --build --wait postgres media-worker",',
    );
    left(
      'infra/deploy/release.sh',
      'docker compose --project-name "$PROJECT" --file "$here/compose.yml" \\\n  up --detach media-worker\n',
    );
    left(
      'scripts/worker.sh',
      'docker compose -f infra/docker-compose.yml run --rm --no-deps --name w media-worker\n',
    );
    left('scripts/db.sh', 'docker compose -f infra/other.yml up -d postgres\n');
    left(
      'scripts/setup.mjs',
      'console.log(`docker compose -f infra/docker-compose.yml rm -sf keycloak && npm run infra:up`);',
    );
  });
});

describe('the repository', () => {
  const paths = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .stdout.split('\0')
    .filter(
      (path) =>
        /\.(?:ya?ml|json|sh|[cm]?[jt]s)$/.test(path) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|node_modules)\//.test(path) &&
        existsSync(join(repoRoot, path)),
    );

  it('defines how the worker runs in the declared compose files only', () => {
    expect(paths).toEqual(expect.arrayContaining(WORKER_COMPOSE_FILES));
    const files = paths.map((path) => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }));
    expect(undeclaredWorkerDefinitions(files)).toEqual([]);
  });

  it('builds the worker image to run as a numeric user other than root', () => {
    const user = dockerfileUser(readFileSync(join(repoRoot, WORKER_DOCKERFILE), 'utf8'));
    expect(user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
  });
});
