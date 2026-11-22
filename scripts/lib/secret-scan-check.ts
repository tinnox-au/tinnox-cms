// Decides whether the scans of scripts/scan-secrets.mjs really read the history and the files.
// `gitleaks git` (v8.30.1) runs `git log -p -U0 --full-history --all` and logs to stderr; when
// git fails (in a worktree whose git directory is not mounted, say) gitleaks logs git's error,
// "0 commits scanned." and "no leaks found", and exits 0. Its report file lists findings only,
// so the log is the one place that says what was scanned. The script passes this module the
// log, never a finding: gitleaks runs with --redact.
import { stripVTControlCharacters } from 'node:util';

// "INF 170 commits scanned." Commits that add no line (merges, pure deletions) are not counted.
const COMMITS_SCANNED = /\bINF\b.*?\b(\d+) commits? scanned\b/;
// gitleaks prefixes each line git writes to stderr with "[git]".
const GIT_FAILURE = /\[git\]\s*((?:fatal|error):.*)$/;
// Every line gitleaks logs: "2:04AM INF ...". The Docker client's own errors have no level.
const GITLEAKS_LINE = /^\S+ (?:TRC|DBG|INF|WRN|ERR|FTL) /;
// "2:04AM FTL stat /scan: no such file or directory": gitleaks stopped before scanning.
const FATAL = /^\S+ FTL (.*)$/;
// "INF scanned ~24934 bytes (24.93 KB) in 18.4ms", logged by `gitleaks git` and `gitleaks dir`.
const BYTES_SCANNED = /\bINF\b.*?\bscanned ~(\d+) bytes\b/;
// Any error gitleaks logs, from git or its own.
const ERROR = /^\S+ ERR (.*)$/;

export interface HistoryScan {
  /** The number gitleaks logged, or null when it logged no count. */
  commits: number | null;
  /** The fatal and error lines git wrote inside the container. */
  gitErrors: string[];
  /** The message of gitleaks' own fatal line, or null. */
  fatal: string | null;
  /** The bytes gitleaks logged as scanned, or null when it logged no count. */
  bytes: number | null;
  /** The message of every error line, git's included. */
  errors: string[];
  /** Whether any line came from gitleaks: none when Docker could not start it. */
  ranGitleaks: boolean;
}

export function readHistoryLog(log: string): HistoryScan {
  let commits: number | null = null;
  const gitErrors: string[] = [];
  let fatal: string | null = null;
  let bytes: number | null = null;
  const errors: string[] = [];
  let ranGitleaks = false;
  // gitleaks colours its log even when stderr is not a terminal.
  for (const line of stripVTControlCharacters(log).split('\n')) {
    if (GITLEAKS_LINE.test(line)) ranGitleaks = true;
    const count = COMMITS_SCANNED.exec(line)?.[1];
    if (count !== undefined) commits = Number(count);
    const failure = GIT_FAILURE.exec(line)?.[1];
    if (failure !== undefined) gitErrors.push(failure.trim());
    fatal ??= FATAL.exec(line)?.[1]?.trim() ?? null;
    const scannedBytes = BYTES_SCANNED.exec(line)?.[1];
    if (scannedBytes !== undefined) bytes = Number(scannedBytes);
    const error = ERROR.exec(line)?.[1];
    if (error !== undefined) errors.push(error.trim());
  }
  return { commits, gitErrors, fatal, bytes, errors, ranGitleaks };
}

/**
 * Why a gitleaks run did not scan at all, or null when it did. Docker exits 125 to 127 when it
 * cannot start the container and its client exits 1 when the daemon is unreachable, the code
 * gitleaks uses for a leak; so the log decides, not the code alone.
 */
export function gitleaksRunProblem(log: string, status: number): string | null {
  const scan = readHistoryLog(log);
  if (scan.fatal !== null) {
    return `gitleaks stopped before scanning (exit ${status}): ${scan.fatal}; read its output above`;
  }
  if (!scan.ranGitleaks || (status !== 0 && status !== 1)) {
    return `gitleaks did not run (exit ${status}): check that Docker is installed and running (\`docker info\`) and that the image pinned in scripts/scan-secrets.mjs can be pulled`;
  }
  return null;
}

/**
 * Why the working-tree scan of `files` staged files cannot count as a pass, or null when it read
 * them (CHK-10). A gitleaks that ran but read nothing (an empty or unreadable mount) logs
 * "scanned ~0 bytes" and exits 0. With nothing staged there is nothing to read.
 */
export function workingScanProblem(log: string, status: number, files: number): string | null {
  if (files === 0) return null;
  const runProblem = gitleaksRunProblem(log, status);
  if (runProblem !== null) return runProblem;
  const scan = readHistoryLog(log);
  const error = scan.errors[0];
  if (error !== undefined) {
    return `gitleaks logged an error while scanning the staged files (${error}): read its output above and fix the cause, so that every file is read`;
  }
  if (scan.bytes === null) {
    return 'gitleaks logged no "scanned ~N bytes" line: the pinned image may have changed its log format; read its output and update scripts/lib/secret-scan-check.ts';
  }
  if (scan.bytes === 0) {
    return `gitleaks scanned 0 bytes of the ${files} staged files: the mount was empty or unreadable; check that Docker can read data/.secret-scan, which scripts/scan-secrets.mjs mounts`;
  }
  return null;
}

/**
 * Why the history scan cannot count as a pass, whatever gitleaks' exit code; empty when it read
 * history and git reported no error. A leak is not decided here: gitleaks exits 1 for that.
 */
export function historyScanProblems(log: string, status: number, shallow: boolean): string[] {
  const scan = readHistoryLog(log);
  const problems = scan.gitErrors.map(
    (error) =>
      `git failed inside the gitleaks container (${error}): the history was not read; check that the directory \`git rev-parse --path-format=absolute --git-common-dir\` prints is the one scripts/scan-secrets.mjs mounts`,
  );
  const runProblem = gitleaksRunProblem(log, status);
  if (runProblem !== null) {
    // Nothing was scanned, so the advice about the log format or the history does not apply.
    problems.push(runProblem);
  } else if (scan.commits === null) {
    problems.push(
      'gitleaks logged no "N commits scanned." line: the pinned image may have changed its log format; read its output and update scripts/lib/secret-scan-check.ts',
    );
  } else if (scan.commits === 0) {
    problems.push(
      'gitleaks scanned 0 commits: the history was not read; run the scan from a clone with its history (in CI, actions/checkout with fetch-depth: 0)',
    );
  }
  // A shallow clone (actions/checkout's default depth of 1) scans its last commits only.
  if (shallow) {
    problems.push(
      'the clone is shallow, so only its last commits were scanned: fetch the whole history (`git fetch --unshallow`; in CI, actions/checkout with fetch-depth: 0)',
    );
  }
  return problems;
}
