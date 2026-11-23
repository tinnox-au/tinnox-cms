// Rules over the repository's Playwright configs, read by scripts/lib/playwright-configs.test.ts
// over every Playwright config in the repository:
// - OTH-05: traces, videos and screenshots stay off, because they would record the sign-in form
//   and its one-time code.
// - Every config is run by a CI job (adoption plan step 4): a config that no workflow step runs,
//   directly or through an npm script, checks nothing and nobody notices
//   (tests/playwright.layout.config.ts until step 4). Any `run:` step of any workflow counts,
//   even one in a job or step gated by `if:` (the manual e2e job, the only runner of
//   tests/playwright.config.ts) or one that only lists tests (`--list`), so this does not prove
//   a config runs on every pull request. Once step 36 runs e2e on every pull request, the rule
//   should count only ungated steps.
import { posix } from 'node:path';

/** A Playwright config file, by name. */
export const PLAYWRIGHT_CONFIG = /(^|\/)playwright(\.[^/]+)?\.config\.[cm]?[jt]s$/;

const RECORDINGS = ['trace', 'video', 'screenshot'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Each option takes a mode string or an object with a mode ({ mode: 'off', size }).
function isOff(value: unknown): boolean {
  return value === 'off' || (isObject(value) && value['mode'] === 'off');
}

/**
 * One problem per recording option that is not off. The top-level `use` must say 'off' for
 * each, so the intent is visible; a project's `use` may leave one out and inherit it.
 * @param config the config's default export
 */
export function recordingProblems(path: string, config: unknown): string[] {
  const fix = `set it to 'off' in ${path}: a recording would hold the sign-in form and its one-time code (OTH-05)`;
  const top = isObject(config) && isObject(config['use']) ? config['use'] : {};
  const problems = RECORDINGS.filter((option) => !isOff(top[option])).map(
    (option) => `${path}: use.${option} is not 'off'; ${fix}`,
  );
  const projects = isObject(config) && Array.isArray(config['projects']) ? config['projects'] : [];
  for (const [index, project] of projects.entries()) {
    const use = isObject(project) && isObject(project['use']) ? project['use'] : {};
    const name =
      isObject(project) && typeof project['name'] === 'string' ? project['name'] : `#${index}`;
    for (const option of RECORDINGS) {
      if (option in use && !isOff(use[option])) {
        problems.push(`${path}: project ${name} sets use.${option} other than 'off'; ${fix}`);
      }
    }
  }
  return problems;
}

/**
 * The shell commands of a workflow's `run:` steps, one entry per step. Reads the subset of YAML
 * the workflows use: a plain or quoted one-line value, or a `|` or `>` block.
 */
export function workflowCommands(text: string): string[] {
  const lines = text.split('\n');
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(lines[index] ?? '');
    if (match === null) continue;
    const keyIndent = (match[1] ?? '').length;
    const value = (match[2] ?? '').trim();
    const block = /^([|>])[-+]?$/.exec(value);
    if (block === null) {
      commands.push(unquote(value.replace(/\s+#.*$/, '')));
      continue;
    }
    const body: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length <= keyIndent) break;
      body.push(next.trim());
      index += 1;
    }
    commands.push(body.join(block[1] === '|' ? '\n' : ' ').trim());
  }
  return commands;
}

function unquote(value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** A package.json of the repository: the root (dir '') or a workspace. */
export interface NpmPackage {
  /** from the repository root, with forward slashes; '' for the root package */
  readonly dir: string;
  readonly name: string;
  readonly scripts: Readonly<Record<string, string>>;
}

// npm's aliases for `npm run <script>`, and the commands that run the script of their own name.
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_LIFECYCLE: Readonly<Record<string, string>> = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
const CONFIG_EXTENSIONS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];

/**
 * The Playwright configs that the given commands run: `playwright test` with its `-c` or
 * `--config` option (a file or a folder), or the config Playwright finds in its working directory
 * without one; through `npx`, and through npm scripts of the root package or a workspace
 * (`npm run x`, `npm test`, `-w`, `--workspace`, `--workspaces`, arguments after `--`).
 * It sees commands only, not the `if:` of their step or job, so a gated step counts as run
 * (until step 36; see the header).
 * @param commands shell commands run from the repository root
 * @param configs every Playwright config in the repository, from the repository root
 */
export function configsRunBy(
  commands: readonly string[],
  packages: readonly NpmPackage[],
  configs: readonly string[],
): Set<string> {
  const run = new Set<string>();
  const known = new Set(configs);
  const defaultConfig = (dir: string): string[] =>
    CONFIG_EXTENSIONS.map((ext) => posix.join(dir, `playwright.config.${ext}`)).filter((path) =>
      known.has(path),
    );

  const visit = (command: string, cwd: string, depth: number): void => {
    // A script that calls itself would never end; npm itself would loop too.
    if (depth > 20) return;
    for (const simple of command.split(/&&|\|\||[;|\n]/)) {
      const words = simple
        .trim()
        .split(/\s+/)
        .map(unquote)
        .filter((word) => word !== '');
      // Leading environment assignments (CI=true npm test) do not change what runs.
      while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      if (words[0] === 'npm') npmScript(words.slice(1), cwd, depth);
      const at = playwrightTest(words);
      if (at === null) continue;
      const option = configOption(words.slice(at));
      if (option === null) {
        for (const path of defaultConfig(cwd)) run.add(path);
        continue;
      }
      const path = posix.normalize(posix.join(cwd, option));
      for (const found of known.has(path) ? [path] : defaultConfig(path)) run.add(found);
    }
  };

  const npmScript = (args: readonly string[], cwd: string, depth: number): void => {
    const [command, ...rest] = args;
    if (command === undefined) return;
    let script: string | undefined;
    let options: readonly string[];
    if (NPM_RUN.has(command)) {
      [script, ...options] = rest;
    } else {
      script = NPM_LIFECYCLE[command];
      options = rest;
    }
    if (script === undefined) return;
    const separator = options.indexOf('--');
    const extra = separator === -1 ? [] : options.slice(separator + 1);
    const flags = separator === -1 ? options : options.slice(0, separator);
    const named: string[] = [];
    let all = false;
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index] ?? '';
      if (flag === '-w' || flag === '--workspace') named.push(flags[(index += 1)] ?? '');
      else if (flag.startsWith('--workspace=')) named.push(flag.slice('--workspace='.length));
      else if (flag === '--workspaces' || flag === '-ws') all = true;
    }
    const targets = all
      ? packages.filter((pkg) => pkg.dir !== '')
      : named.length > 0
        ? packages.filter((pkg) =>
            named.some((name) => name === pkg.name || posix.normalize(name) === pkg.dir),
          )
        : packages.filter((pkg) => pkg.dir === cwd);
    for (const pkg of targets) {
      const body = pkg.scripts[script];
      if (body !== undefined) visit([body, ...extra].join(' '), pkg.dir, depth + 1);
    }
  };

  for (const command of commands) visit(command, '', 0);
  return run;
}

// The index just after `playwright test` (or `npx playwright test`), or null.
function playwrightTest(words: readonly string[]): number | null {
  let index = 0;
  if (words[0] === 'npx') {
    index = 1;
    while (words[index]?.startsWith('-') === true) index += 1;
  }
  const bin = words[index];
  const isPlaywright = bin === 'playwright' || bin?.endsWith('/playwright') === true;
  return isPlaywright && words[index + 1] === 'test' ? index + 2 : null;
}

function configOption(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-c' || arg === '--config') return args[index + 1] ?? null;
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return null;
}

/** One problem per Playwright config that no CI step runs. */
export function unrunConfigProblems(
  configs: readonly string[],
  run: ReadonlySet<string>,
): string[] {
  return configs
    .filter((path) => !run.has(path))
    .sort()
    .map(
      (path) =>
        `${path} is run by no CI job: add a step to the job of .github/workflows/ci.yml that has what it needs (\`npx playwright test -c ${path}\`, or an npm script that runs it), or delete the config if nothing needs it`,
    );
}
