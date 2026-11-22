#!/usr/bin/env node
// Scans for committed secrets with gitleaks, run from its pinned container image with
// no network and the files mounted read-only.
//   1. the whole git history: every commit reachable from any branch, tag, remote branch, stash
//      or worktree HEAD (`git log --all`). The scan fails when gitleaks read no commit, git
//      failed inside the container, or the clone is shallow (scripts/lib/secret-scan-check.ts);
//   2. the files git tracks or would track (so work that is not committed yet is covered). The
//      scan fails when gitleaks read no bytes of them or logged an error;
// Gitignored files (.env, infra/.generated, data) hold generated development secrets by
// design and are not scanned; .gitignore is what keeps them out of the repository.
//   3. an exact-value check: the generated secrets on this machine must not appear in any
//      file of step 2 (catches a value copied into a doc, test or fixture).
//   npm run scan:secrets
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitleaksRunProblem,
  historyScanProblems,
  readHistoryLog,
  workingScanProblem,
} from './lib/secret-scan-check.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Pinned by digest (the multi-platform index of the tag), so a re-pushed tag cannot change it.
const IMAGE =
  'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
// Inside the repository (under the gitignored data/ directory) so Docker can mount it on every platform.
const staging = join(root, 'data', '.secret-scan');

// Returns the exit code and gitleaks' log (stderr), which it also prints.
function gitleaks(mount, args) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-v',
      `${mount}:/scan:ro`,
      IMAGE,
      ...args,
      '--redact',
      '--no-banner',
      '--exit-code',
      '1',
    ],
    { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    console.error(`Could not run docker: ${result.error.message}`);
    return { status: 2, log: '' };
  }
  process.stderr.write(result.stderr);
  return { status: result.status ?? 2, log: result.stderr };
}

function git(args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    process.exit(2);
  }
  return result.stdout.trim();
}

// The history is read from the git directory itself, mounted alone. In a worktree `.git` is a
// file naming a directory under the main checkout's `.git`, outside a mount of the working tree,
// so mounting the working tree scanned nothing (git failed and gitleaks still exited 0). The
// common directory holds every branch, tag and worktree HEAD, so one mount serves both kinds of
// checkout.
console.log('gitleaks: scanning git history');
const gitDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const scanned = gitleaks(gitDir, ['git', '/scan']);
const problems = historyScanProblems(
  scanned.log,
  scanned.status,
  git(['rev-parse', '--is-shallow-repository']) === 'true',
);
for (const problem of problems) console.error(`history scan: ${problem}`);

console.log('gitleaks: scanning tracked and not-yet-committed files');
const listed = spawnSync(
  'git',
  ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (listed.status !== 0) {
  console.error('git ls-files failed');
  process.exit(2);
}
const files = listed.stdout.split('\0').filter((f) => f !== '');
rmSync(staging, { recursive: true, force: true });
let copied = 0;
try {
  for (const file of files) {
    const source = join(root, file);
    if (!existsSync(source) || !lstatSync(source).isFile()) continue;
    const target = join(staging, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied += 1;
  }
  const workingRun = copied === 0 ? { status: 0, log: '' } : gitleaks(staging, ['dir', '/scan']);
  const workingProblem = workingScanProblem(workingRun.log, workingRun.status, copied);
  if (workingProblem !== null) console.error(`working-tree scan: ${workingProblem}`);
  const generated = findGeneratedSecrets(files);
  if (problems.length > 0) {
    // Whatever gitleaks' exit code: a scan that did not read the history has not passed.
    console.error('Secret scan FAILED: the git history was not scanned (see "history scan:").');
    process.exitCode = 1;
  }
  if (workingProblem !== null) {
    console.error(
      'Secret scan FAILED: the working tree was not fully scanned (see "working-tree scan:").',
    );
    process.exitCode = 1;
  }
  // Exit 1 from a gitleaks that ran is a leak. A gitleaks that did not run is reported above,
  // so it is not blamed on a secret.
  const historyLeak =
    scanned.status === 1 && gitleaksRunProblem(scanned.log, scanned.status) === null;
  const workingLeak = workingRun.status === 1 && workingProblem === null;
  if (historyLeak || workingLeak || generated !== 0) {
    console.error(
      'Secret scan FAILED. Remove the secret, rotate it, and never commit generated credentials.',
    );
    process.exitCode = 1;
  } else if (problems.length === 0 && workingProblem === null) {
    const commits = readHistoryLog(scanned.log).commits;
    console.log(
      `Secret scan passed: ${commits} commits of git history and ${copied} working-tree files.`,
    );
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

/**
 * Exact-value check: every secret this machine generated (.env and
 * infra/.generated/dev-credentials.json) must appear in no tracked or not-ignored file.
 * gitleaks matches patterns; this matches the actual values. Prints names, never values.
 */
function findGeneratedSecrets(fileList) {
  const values = new Map();
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, name, value] = match;
      if (/(SECRET|PASSWORD|TOKEN|KEY)/.test(name) && value.length >= 12) values.set(name, value);
      // Connection strings embed the role passwords.
      if (name.endsWith('_URL')) {
        const password = /:\/\/[^:/]+:([^@]+)@/.exec(value)?.[1];
        if (password && password.length >= 12) values.set(`${name} (password)`, password);
      }
    }
  }
  const credentialsPath = join(root, 'infra', '.generated', 'dev-credentials.json');
  if (existsSync(credentialsPath)) {
    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    for (const [user, entry] of Object.entries(credentials)) {
      if (!entry || typeof entry !== 'object') continue;
      for (const field of ['password', 'totpSecretBase32']) {
        const value = entry[field];
        if (typeof value === 'string' && value.length >= 12) values.set(`${user}.${field}`, value);
      }
    }
  }
  if (values.size === 0) {
    console.log('generated-secret check: no .env or dev-credentials.json; nothing to compare');
    return 0;
  }
  let hits = 0;
  for (const file of fileList) {
    const source = join(root, file);
    if (!existsSync(source) || !lstatSync(source).isFile()) continue;
    const text = readFileSync(source).toString('latin1');
    for (const [name, value] of values) {
      if (text.includes(value)) {
        console.error(`generated secret ${name} found in ${file}`);
        hits += 1;
      }
    }
  }
  console.log(
    `generated-secret check: ${values.size} generated values compared against ${fileList.length} files; ${hits} found`,
  );
  return hits === 0 ? 0 : 1;
}
