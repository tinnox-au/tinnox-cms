// The history-scan verdict of scripts/scan-secrets.mjs. The logs are the stderr of the pinned
// gitleaks v8.30.1 image, captured on 2026-11-22 with its colours; only the host path is changed.
// The short uncoloured lines are written by hand in the same format.
import { describe, expect, it } from 'vitest';
import { gitleaksRunProblem, historyScanProblems, readHistoryLog } from './secret-scan-check.ts';

const log = (...lines: string[]): string => lines.map((line) => `${line}\n`).join('');
const info = (text: string): string =>
  `\x1b[90m1:53AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1m${text}\x1b[0m`;

// `gitleaks git /scan` with only the working tree of a git worktree mounted: its `.git` file
// names a directory outside the mount. gitleaks exited 0.
const WORKTREE_NOT_MOUNTED = log(
  '\x1b[90m1:48AM\x1b[0m \x1b[31mERR\x1b[0m \x1b[1m[git] fatal: not a git repository: /home/dev/tinnox-cms/.git/worktrees/x\x1b[0m',
  '\x1b[90m1:48AM\x1b[0m \x1b[31mERR\x1b[0m \x1b[1mskipping finding links: unable to parse remote URL\x1b[0m \x1b[36merror=\x1b[0m\x1b[31m\x1b[1m"command failed (128): exit status 128, stderr: fatal: not a git repository: /home/dev/tinnox-cms/.git/worktrees/x"\x1b[0m\x1b[0m',
  '\x1b[90m1:48AM\x1b[0m \x1b[31mERR\x1b[0m \x1b[36merror=\x1b[0m\x1b[31m\x1b[1m"stderr is not empty"\x1b[0m\x1b[0m',
  '\x1b[90m1:48AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1m0 commits scanned.\x1b[0m',
  '\x1b[90m1:48AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1mscanned ~0 bytes (0) in 32.2ms\x1b[0m',
  '\x1b[90m1:48AM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1mno leaks found\x1b[0m',
);

// A plain clone, its git directory mounted.
const CLONE = log(
  `${info('Unknown SCM platform. Use --platform to include links in findings.')} \x1b[36mhost=\x1b[0m`,
  info('166 commits scanned.'),
  info('scanned ~10868902 bytes (10.87 MB) in 1.66s'),
  info('no leaks found'),
);

// A clone with a planted token on a worktree HEAD that no branch contains (redacted: gitleaks
// prints the count only, without --verbose).
const LEAK = log(
  info('167 commits scanned.'),
  info('scanned ~10868953 bytes (10.87 MB) in 1.74s'),
  '\x1b[90m1:54AM\x1b[0m \x1b[33mWRN\x1b[0m \x1b[1mleaks found: 1\x1b[0m',
);

// `docker run` with the daemon unreachable: the Docker client's own error, and exit 1, the code
// gitleaks uses for a leak.
const DOCKER_DOWN =
  'failed to connect to the docker API at unix:///nonexistent/docker.sock; check if the path is correct and if the daemon is running: dial unix /nonexistent/docker.sock: connect: no such file or directory\n';

// gitleaks stopping before it scans (here its target path does not exist); it exits 1 too.
const GITLEAKS_FATAL = log(
  '\x1b[90m2:04AM\x1b[0m \x1b[31mFTL\x1b[0m \x1b[1mstat /nonexistent: no such file or directory\x1b[0m',
);

const NOT_RUN =
  'check that Docker is installed and running (`docker info`) and that the image pinned in scripts/scan-secrets.mjs can be pulled';

describe('readHistoryLog', () => {
  it('reads the commit count and the errors git wrote, with or without colours', () => {
    expect(readHistoryLog(CLONE)).toEqual({
      commits: 166,
      gitErrors: [],
      fatal: null,
      ranGitleaks: true,
    });
    expect(readHistoryLog(WORKTREE_NOT_MOUNTED)).toEqual({
      commits: 0,
      gitErrors: ['fatal: not a git repository: /home/dev/tinnox-cms/.git/worktrees/x'],
      fatal: null,
      ranGitleaks: true,
    });
    expect(
      readHistoryLog(
        '1:53AM INF 1 commit scanned.\n1:53AM ERR [git] error: object file is empty\n',
      ),
    ).toEqual({
      commits: 1,
      gitErrors: ['error: object file is empty'],
      fatal: null,
      ranGitleaks: true,
    });
  });

  it('counts no line from the working-tree scan or a warning from git as a failure', () => {
    expect(readHistoryLog(log(info('scanned ~9689863 bytes (9.69 MB) in 1.28s')))).toEqual({
      commits: null,
      gitErrors: [],
      fatal: null,
      ranGitleaks: true,
    });
    expect(
      readHistoryLog(
        log(info('2 commits scanned.'), '1:53AM ERR [git] warning: refname is ambiguous'),
      ),
    ).toEqual({
      commits: 2,
      gitErrors: [],
      fatal: null,
      ranGitleaks: true,
    });
  });
});

describe('historyScanProblems', () => {
  it('passes a scan that read commits, leak or no leak (gitleaks exits 1 for a leak)', () => {
    expect(historyScanProblems(CLONE, 0, false)).toEqual([]);
    expect(historyScanProblems(LEAK, 1, false)).toEqual([]);
  });

  it('fails a worktree scan that read no commit although gitleaks exited 0', () => {
    expect(historyScanProblems(WORKTREE_NOT_MOUNTED, 0, false)).toEqual([
      'git failed inside the gitleaks container (fatal: not a git repository: /home/dev/tinnox-cms/.git/worktrees/x): the history was not read; check that the directory `git rev-parse --path-format=absolute --git-common-dir` prints is the one scripts/scan-secrets.mjs mounts',
      'gitleaks scanned 0 commits: the history was not read; run the scan from a clone with its history (in CI, actions/checkout with fetch-depth: 0)',
    ]);
  });

  it('fails when gitleaks logs no count, so a changed log format cannot pass silently', () => {
    expect(historyScanProblems(log(info('no leaks found')), 0, false)).toEqual([
      'gitleaks logged no "N commits scanned." line: the pinned image may have changed its log format; read its output and update scripts/lib/secret-scan-check.ts',
    ]);
    expect(historyScanProblems(log(info('no leaks found')), 1, false)).toHaveLength(1);
  });

  it('fails a shallow clone, which holds its last commits only', () => {
    expect(historyScanProblems(log(info('1 commits scanned.')), 0, true)).toEqual([
      'the clone is shallow, so only its last commits were scanned: fetch the whole history (`git fetch --unshallow`; in CI, actions/checkout with fetch-depth: 0)',
    ]);
  });

  it('says Docker or the image is the problem when gitleaks never ran, not the log format', () => {
    expect(historyScanProblems(DOCKER_DOWN, 1, false)).toEqual([
      `gitleaks did not run (exit 1): ${NOT_RUN}`,
    ]);
    // docker missing from PATH: the script passes no log and exit 2.
    expect(historyScanProblems('', 2, false)).toEqual([
      `gitleaks did not run (exit 2): ${NOT_RUN}`,
    ]);
    // docker run exits 125 when it cannot pull or create the container.
    expect(
      historyScanProblems('docker: Error response from daemon: manifest unknown\n', 125, false),
    ).toEqual([`gitleaks did not run (exit 125): ${NOT_RUN}`]);
    expect(historyScanProblems(GITLEAKS_FATAL, 1, false)).toEqual([
      'gitleaks stopped before scanning (exit 1): stat /nonexistent: no such file or directory; read its output above',
    ]);
  });
});

describe('gitleaksRunProblem', () => {
  it('lets a gitleaks that ran exit 0 or 1, and nothing else', () => {
    expect(gitleaksRunProblem(CLONE, 0)).toBeNull();
    expect(gitleaksRunProblem(LEAK, 1)).toBeNull();
    expect(gitleaksRunProblem(CLONE, 2)).toBe(`gitleaks did not run (exit 2): ${NOT_RUN}`);
    expect(gitleaksRunProblem(DOCKER_DOWN, 1)).toBe(`gitleaks did not run (exit 1): ${NOT_RUN}`);
  });
});
