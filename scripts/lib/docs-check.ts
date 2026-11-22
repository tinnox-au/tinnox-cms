// Rules that keep the rule files and the documents' references true (scripts/check-docs.ts).
// Each rule returns findings as "path:line message"; a message says what to do instead.
//   - .cursor/BUGBOT.md is generated from the "## Code Review Rules" section of AGENTS.md;
//   - no AGENTS.override.md anywhere and no AGENTS.md or BUGBOT.md but the root two, because
//     Codex reads an override in place of AGENTS.md and both tools load nested files
//     inconsistently (DEC-38, D15); size limits leave room for a user's global file;
//   - every backticked repository path in the rule files, the README, the decision register
//     and the security documents exists;
//   - decision ranges quoted in README.md match the register;
//   - every action is pinned by a 40-character commit and every external image by digest;
//   - dated sections are frozen snapshots; in live text a hand-typed count of tests, cases,
//     routes, tables or `sec` functions needs a date or run link in its own sentence (D17).

export const AGENTS_PATH = 'AGENTS.md';
export const BUGBOT_PATH = '.cursor/BUGBOT.md';
export const REVIEW_HEADING = '## Code Review Rules';
const BUGBOT_HEADER = '# Bugbot review rules for TINNOX CMS\n\n';

// Codex stops reading project files at 32 KiB in all, a user's global file included.
export const AGENTS_MAX_BYTES = 16 * 1024;
// Bugbot's limit for one rule file.
export const BUGBOT_MAX_CHARS = 30_000;

/** Documents whose backticked paths must exist. */
export const PATH_DOCS = [
  AGENTS_PATH,
  BUGBOT_PATH,
  'README.md',
  'docs/decisions-2026-11.md',
  'docs/security/control-matrix.md',
  'docs/security/threat-model.md',
  'docs/security/operations-and-release-checklist.md',
];

/** Documents in which a hand-typed count needs its own date or run link (D17). */
export const COUNT_DOCS = [...PATH_DOCS, 'docs/dev-handoff.md', 'tests/README.md'];

export const REGISTER_PATH = 'docs/decisions-2026-11.md';
export const README_PATH = 'README.md';

export interface Doc {
  path: string;
  text: string;
}

const WRITE_HINT = 'edit AGENTS.md only and run `npm run check:docs -- --write`';

// ---------------------------------------------------------------------------------------------
// Rule files

/** The text `npm run check:docs -- --write` writes to .cursor/BUGBOT.md. */
export function bugbotFrom(agents: string): string {
  const start = agents.split('\n').findIndex((line) => line.trimEnd() === REVIEW_HEADING);
  if (start === -1) {
    throw new Error(`${AGENTS_PATH} has no "${REVIEW_HEADING}" heading to generate from`);
  }
  return BUGBOT_HEADER + agents.split('\n').slice(start).join('\n');
}

export function checkRuleFileSync(agents: string, bugbot: string | undefined): string[] {
  if (!agents.split('\n').some((line) => line.trimEnd() === REVIEW_HEADING)) {
    return [
      `${AGENTS_PATH}:1 has no "${REVIEW_HEADING}" heading; ${BUGBOT_PATH} is generated from it`,
    ];
  }
  const expected = bugbotFrom(agents);
  if (bugbot === undefined) return [`${BUGBOT_PATH} is missing: ${WRITE_HINT}`];
  if (bugbot === expected) return [];
  const want = expected.split('\n');
  const have = bugbot.split('\n');
  let line = 0;
  while (line < want.length && line < have.length && want[line] === have[line]) line += 1;
  return [
    `${BUGBOT_PATH}:${line + 1} differs from the "${REVIEW_HEADING}" section of ${AGENTS_PATH}: ${WRITE_HINT}`,
  ];
}

/** @param files every tracked or not-ignored file, from `git ls-files` */
export function checkRuleFilePlacement(files: readonly string[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const name = file.split('/').pop() ?? file;
    if (name === 'AGENTS.override.md') {
      findings.push(
        `${file}: Codex reads an AGENTS.override.md in place of AGENTS.md, so it would hide the review rules; delete it and put the rule in the root ${AGENTS_PATH}`,
      );
    } else if (
      (name === 'AGENTS.md' && file !== AGENTS_PATH) ||
      (name === 'BUGBOT.md' && file !== BUGBOT_PATH)
    ) {
      findings.push(
        `${file}: nested rule files load only for some working directories or changed paths; delete it and put the rule in the root ${AGENTS_PATH}`,
      );
    }
  }
  return findings;
}

export function checkRuleFileSizes(agentsBytes: number, bugbotChars: number | undefined): string[] {
  const findings: string[] = [];
  if (agentsBytes > AGENTS_MAX_BYTES) {
    findings.push(
      `${AGENTS_PATH} is ${agentsBytes} bytes, over ${AGENTS_MAX_BYTES} (Codex's 32 KiB limit also counts a user's global file): replace a rule a check enforces with the check's name`,
    );
  }
  if (bugbotChars !== undefined && bugbotChars > BUGBOT_MAX_CHARS) {
    findings.push(
      `${BUGBOT_PATH} is ${bugbotChars} characters, over Bugbot's ${BUGBOT_MAX_CHARS}: shorten the "${REVIEW_HEADING}" section of ${AGENTS_PATH}`,
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Live text and snapshots (D17)

const SNAPSHOT_DIRS = ['docs/reviews/'];
const SNAPSHOT_FILES = ['docs/prototype-validation.md'];
// A heading that ends in a date in brackets, such as "## 8. As built (integration review, 2026-11-14)".
const SNAPSHOT_HEADING = /\([^()]*\b\d{4}-\d{2}-\d{2}\)\s*$/;
const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;

export function isSnapshotFile(path: string): boolean {
  return SNAPSHOT_FILES.includes(path) || SNAPSHOT_DIRS.some((dir) => path.startsWith(dir));
}

export interface LiveLine {
  /** 1-based */
  line: number;
  text: string;
}

/**
 * The lines of a document that must be true now: not inside a fenced block, not in a snapshot
 * file, and not under a dated heading (until the next heading of the same or a higher level).
 */
export function liveLines(path: string, text: string): LiveLine[] {
  if (isSnapshotFile(path)) return [];
  const live: LiveLine[] = [];
  let fenced = false;
  let snapshotLevel = 0;
  text.split('\n').forEach((content, index) => {
    if (FENCE.test(content)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = HEADING.exec(content);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      if (snapshotLevel !== 0 && level <= snapshotLevel) snapshotLevel = 0;
      if (snapshotLevel === 0 && SNAPSHOT_HEADING.test(content)) snapshotLevel = level;
    }
    if (snapshotLevel === 0) live.push({ line: index + 1, text: content });
  });
  return live;
}

// ---------------------------------------------------------------------------------------------
// Paths

export interface Repo {
  /** Every tracked or not-ignored file, from `git ls-files`. */
  files: ReadonlySet<string>;
  /** Candidate paths that .gitignore matches (generated or local files a document may name). */
  ignored: ReadonlySet<string>;
}

const FILE_EXTENSION = /\.(ts|tsx|mts|js|mjs|cjs|json|md|sql|sh|yml|yaml|css|html|toml)$/;
// Placeholders and patterns, not paths: <org uuid>/<uuid>, packages/*, e2e/…, NNNN_description.sql.
const PLACEHOLDER = /[<>*…{}$|?=]|\.\.\.|NNNN|000N|YYYY/;
// Folders the control matrix abbreviates (`e2e/…` is `tests/e2e/…`, control-matrix.md, "How to read").
const SHORTHAND: Record<string, string> = {
  'e2e/': 'tests/e2e/',
  'integration/': 'tests/integration/',
};

export interface PathReference {
  line: number;
  /** The path as written, without a line suffix or anchor. */
  path: string;
  /** Where it may live, in order. */
  candidates: string[];
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash + 1);
}

function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '.' || part === '') continue;
    if (part !== '..') parts.push(part);
    else if (parts.pop() === undefined) return ''; // outside the repository
  }
  return parts.length === 0 ? '' : parts.join('/') + (path.endsWith('/') ? '/' : '');
}

/** The first folder or file name of every repository path, and the folders under docs/. */
function roots(files: ReadonlySet<string>): Set<string> {
  const names = new Set(Object.keys(SHORTHAND).map((s) => s.slice(0, -1)));
  for (const file of files) {
    names.add(file.split('/')[0] ?? '');
    if (file.startsWith('docs/')) names.add(file.split('/')[1] ?? '');
  }
  return names;
}

/**
 * The backticked repository paths a document names, outside fences and snapshots. A token
 * counts as a path when it has a file extension, ends in "/", starts with "./", or starts with
 * a folder of the repository; so a MIME type, a branch or an image name such as
 * `axllent/mailpit` is not taken for one.
 */
export function referencedPaths(doc: Doc, files: ReadonlySet<string>): PathReference[] {
  const references: PathReference[] = [];
  const known = roots(files);
  for (const { line, text } of liveLines(doc.path, doc.text)) {
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const raw = match[1] ?? '';
      if (/\s/.test(raw) || raw.includes('://') || PLACEHOLDER.test(raw)) continue;
      if (/^[@/~-]/.test(raw)) continue; // a package name, an API route, a home folder, a flag
      const path = raw.replace(/#.*$/, '').replace(/(:\d+(-\d+)?)+$/, '');
      const looksLikePath =
        FILE_EXTENSION.test(path) ||
        (path.includes('/') &&
          (path.endsWith('/') || /^\.\.?\//.test(path) || known.has(path.split('/')[0] ?? '')));
      if (!looksLikePath) continue;
      const candidates = [normalise(path), normalise(dirOf(doc.path) + path)];
      for (const [short, long] of Object.entries(SHORTHAND)) {
        if (path.startsWith(short)) candidates.push(long + path.slice(short.length));
      }
      // A document name is also tried under docs/, as the README's tables write them.
      if (path.endsWith('.md')) candidates.push(`docs/${path}`);
      references.push({ line, path, candidates: [...new Set(candidates)].filter((c) => c !== '') });
    }
  }
  return references;
}

function exists(candidate: string, repo: Repo): boolean {
  if (repo.ignored.has(candidate) || repo.ignored.has(`${candidate}/`)) return true;
  const folder = candidate.endsWith('/') ? candidate : `${candidate}/`;
  if (repo.files.has(candidate.replace(/\/$/, ''))) return true;
  for (const file of repo.files) if (file.startsWith(folder)) return true;
  return false;
}

export function checkPaths(docs: readonly Doc[], repo: Repo): string[] {
  const findings: string[] = [];
  for (const doc of docs) {
    for (const reference of referencedPaths(doc, repo.files)) {
      if (reference.candidates.some((candidate) => exists(candidate, repo))) continue;
      findings.push(
        `${doc.path}:${reference.line} names \`${reference.path}\`, which is not a repository path: write the path from the repository root (\`git ls-files\` lists them), or drop the backticks if it is not a file here`,
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Decision ranges

export interface Register {
  numbers: number[];
}

export function decisionRegister(register: string): Register {
  const numbers = [...register.matchAll(/^\|\s*DEC-(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  return { numbers: [...new Set(numbers)].sort((a, b) => a - b) };
}

function dec(n: number): string {
  return `DEC-${String(n).padStart(2, '0')}`;
}

export function checkDecisionRanges(readme: string, register: Register): string[] {
  const findings: string[] = [];
  const { numbers } = register;
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  if (first === undefined || last === undefined) {
    return [`${REGISTER_PATH}: no "| DEC-NN |" rows found in the decision register`];
  }
  const truth = `the register (${REGISTER_PATH}) runs from ${dec(first)} to ${dec(last)} and holds ${numbers.length} entries`;
  readme.split('\n').forEach((text, index) => {
    const at = `${README_PATH}:${index + 1}`;
    for (const m of text.matchAll(/\bDEC-(\d+) to DEC-(\d+)\b/g)) {
      if (Number(m[1]) !== first || Number(m[2]) !== last) {
        findings.push(`${at} says "${m[0]}", but ${truth}: write "${dec(first)} to ${dec(last)}"`);
      }
    }
    for (const m of text.matchAll(/\b(\d+) numbered decisions\b/g)) {
      if (Number(m[1]) !== numbers.length) {
        findings.push(
          `${at} says "${m[0]}", but ${truth}: write "${numbers.length} numbered decisions"`,
        );
      }
    }
    for (const m of text.matchAll(/\bno DEC-(\d+)\b/g)) {
      if (numbers.includes(Number(m[1]))) {
        findings.push(
          `${at} says "${m[0]}", but the register has ${dec(Number(m[1]))}: remove the claim`,
        );
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Pins

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
// An image named with a registry host in a quoted string of a script, such as the gitleaks image.
const SCRIPT_IMAGE =
  /['"`]((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[a-z0-9._/-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?)['"`]/g;
// `docker run`, `pull` or `create`, as a shell line or as spawn arguments ('docker', ['run', ...]).
const DOCKER_CALL = /\bdocker\b['"`]?[\s,[(]*['"`]?(?:run|pull|create)\b/;
// An image with a tag, with or without a registry host: node:24, library/postgres:17.12.
const IMAGE_WORD =
  /^(?:[a-z0-9.-]+(?::\d+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:\w[\w.-]{0,127}(?:@sha256:[0-9a-f]{64})?$/;

function isWorkflow(path: string): boolean {
  return (
    /^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(path) || /(^|\/)action\.ya?ml$/.test(path)
  );
}
function isCompose(path: string): boolean {
  return /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(path);
}
function isDockerfile(path: string): boolean {
  return /(^|\/)Dockerfile[^/]*$/.test(path) && !path.endsWith('.dockerignore');
}
function isScript(path: string): boolean {
  return /^scripts\/.+\.(ts|mjs|js|sh)$/.test(path) && !/\.test\.ts$/.test(path);
}

/** The files the pin rule reads, from `git ls-files`. */
export function pinSources(files: readonly string[]): string[] {
  return files.filter((f) => isWorkflow(f) || isCompose(f) || isDockerfile(f) || isScript(f));
}

interface Unpinned {
  path: string;
  line: number;
  reference: string;
  message: string;
}

interface ComposeImage {
  line: number;
  reference: string;
  /** The service is built here (it has `build:`), so its image is local, not one to pull. */
  built: boolean;
}

function composeImages(lines: readonly string[]): ComposeImage[] {
  const built = new Set<number>();
  let serviceStart = -1;
  lines.forEach((text, index) => {
    if (/^ {2}[\w.-]+:\s*$/.test(text)) serviceStart = index;
    if (/^\s+build:/.test(text) && serviceStart !== -1) built.add(serviceStart);
  });
  const images: ComposeImage[] = [];
  serviceStart = -1;
  lines.forEach((text, index) => {
    if (/^ {2}[\w.-]+:\s*$/.test(text)) serviceStart = index;
    const reference = /^\s+image:\s*['"]?([^'"\s#]+)/.exec(text)?.[1];
    if (reference !== undefined) {
      images.push({ line: index + 1, reference, built: built.has(serviceStart) });
    }
  });
  return images;
}

// Docker options whose value has an image's shape: host.docker.internal:host-gateway,
// seccomp:unconfined.
const VALUE_OPTIONS = new Set(['--add-host', '--security-opt']);

/** The words of a docker command line or argument list that may be images. */
function imageWords(words: readonly string[]): string[] {
  return words.filter((word, index) => {
    if (VALUE_OPTIONS.has(words[index - 1] ?? '')) return false;
    // A port mapping or user id (8080:80, 1000:1000), a bare digest (sha256:...) and the
    // host-gateway alias have the same shape.
    if (/^[\d.]+:/.test(word) || word.startsWith('sha256:') || word.endsWith(':host-gateway')) {
      return false;
    }
    return IMAGE_WORD.test(word);
  });
}

function unpinnedIn(doc: Doc, localImages: ReadonlySet<string>): Unpinned[] {
  const found: Unpinned[] = [];
  const lines = doc.text.split('\n');
  const imageMessage = (reference: string) =>
    `image ${reference} is pinned by tag only: add its digest (\`docker buildx imagetools inspect ${reference}\` prints it) as ${reference}@sha256:<digest>`;
  if (isWorkflow(doc.path)) {
    lines.forEach((text, index) => {
      // A job's `container:` (inline, or its nested `image:`) and a service's `image:` are pulled.
      const image = /^\s*-?\s*(?:image|container):\s*['"]?([\w$][^'"\s#]*)/.exec(text)?.[1];
      // An expression such as `${{ matrix.image }}` is resolved at run time and cannot be read here.
      if (image !== undefined && !image.startsWith('$') && !DIGEST.test(image)) {
        found.push({
          path: doc.path,
          line: index + 1,
          reference: image,
          message: imageMessage(image),
        });
        return;
      }
      const m = /^\s*-?\s*uses:\s*['"]?([^'"\s#]+)/.exec(text);
      const reference = m?.[1];
      if (reference === undefined || reference.startsWith('./')) return;
      if (reference.startsWith('docker://')) {
        if (!DIGEST.test(reference)) {
          found.push({
            path: doc.path,
            line: index + 1,
            reference,
            message: imageMessage(reference),
          });
        }
        return;
      }
      const ref = reference.split('@')[1] ?? '';
      if (!COMMIT.test(ref)) {
        found.push({
          path: doc.path,
          line: index + 1,
          reference,
          message: `action ${reference} is not pinned by a 40-character commit: pin the commit of the release and keep the tag as a comment, as the other steps do`,
        });
      }
    });
  } else if (isCompose(doc.path)) {
    for (const image of composeImages(lines)) {
      if (image.built || DIGEST.test(image.reference)) continue;
      found.push({
        path: doc.path,
        line: image.line,
        reference: image.reference,
        message: imageMessage(image.reference),
      });
    }
  } else if (isDockerfile(doc.path)) {
    const stages = new Set<string>(['scratch']);
    lines.forEach((text, index) => {
      const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(text);
      const reference = m?.[1];
      if (reference === undefined) return;
      if (!stages.has(reference.toLowerCase()) && !DIGEST.test(reference)) {
        found.push({
          path: doc.path,
          line: index + 1,
          reference,
          message: imageMessage(reference),
        });
      }
      if (m?.[2] !== undefined) stages.add(m[2].toLowerCase());
    });
  } else if (isScript(doc.path)) {
    const runsDocker = DOCKER_CALL.test(doc.text);
    lines.forEach((text, index) => {
      const references = new Set<string>();
      for (const m of text.matchAll(SCRIPT_IMAGE)) {
        const reference = m[1] ?? '';
        // A URL path such as 'github.com/owner/repo' is not an image; an image has a tag or digest.
        if (/:[\w.-]+$|@sha256:/.test(reference.replace(/^[^/]+\//, ''))) references.add(reference);
      }
      if (runsDocker) {
        // In a script that runs docker, an image without a registry host (node:24) is one too:
        // as a quoted argument or variable, or as a word of a `docker run` shell line.
        // A module specifier (node:fs) has the same shape, so imports are left out.
        const code = text.replace(/\b(?:from|import|require)\s*\(?\s*(['"`])[^'"`]*\1/g, '');
        const quoted = [...code.matchAll(/(['"`])([^'"`\s$]+)\1/g)].map((m) => m[2] ?? '');
        const call = DOCKER_CALL.exec(text);
        const shell = call === null ? [] : text.slice(call.index + call[0].length).split(/\s+/);
        for (const word of [...imageWords(quoted), ...imageWords(shell)]) references.add(word);
      }
      for (const reference of references) {
        // An image a compose service builds here is local and has no digest to pin.
        if (DIGEST.test(reference) || localImages.has(reference)) continue;
        found.push({
          path: doc.path,
          line: index + 1,
          reference,
          message: imageMessage(reference),
        });
      }
    });
  }
  return found;
}

export function checkPins(docs: readonly Doc[]): string[] {
  const localImages = new Set(
    docs
      .filter((doc) => isCompose(doc.path))
      .flatMap((doc) => composeImages(doc.text.split('\n')))
      .filter((image) => image.built)
      .map((image) => image.reference),
  );
  return docs
    .flatMap((doc) => unpinnedIn(doc, localImages))
    .map((u) => `${u.path}:${u.line} ${u.message}`);
}

// ---------------------------------------------------------------------------------------------
// Hand-typed counts (D17)

const COUNT_NOUN = String.raw`(?:tests?|cases?|routes?|tables?|\x60?sec(?:\.\*)?\x60?\s+functions?)\b`;
const NUMBER = String.raw`(?<![\w.\-/:#])\d+(?:,\d{3})*(?![\w.\-/:%])`;
// "26 tests", "the 62 routes", "25 browser end-to-end tests", "150 Playwright e2e tests",
// "17 `sec` functions", "21 `sec.*` functions". A qualifier may hold digits, as "e2e" does.
// A function word between them means the number belongs to something else: "Node 22 for all
// tests", "every 30 seconds and the tests".
const FUNCTION_WORD = String.raw`(?:a|all|an|and|as|at|by|each|every|for|from|in|into|of|on|or|per|than|that|the|then|to|which|with)\s`;
const NUMBER_THEN_NOUN = new RegExp(
  `${NUMBER}(?:\\s+(?!${FUNCTION_WORD})[A-Za-z0-9\`'-]+){0,3}?\\s+${COUNT_NOUN}`,
  'g',
);
// "every tenant table (22; ...", "unit tests (in the 366)".
const NOUN_THEN_NUMBER = new RegExp(`${COUNT_NOUN}\\s*\\((?:in\\s+)?(?:the\\s+)?${NUMBER}`, 'g');
// A product limit, not a count of the code: "at most 20 addresses", "up to 30 routes".
const LIMIT_BEFORE = /\b(at most|up to|at least|no more than)\s*$/i;
// A number that names something: "section 8 and the table", "release 2", "round 6".
const NAME_BEFORE =
  /\b(sections?|steps?|rounds?|stages?|slices?|releases?|versions?|migrations?|phases?|items?|rows?|lines?|parts?|chapters?|node(?:\.js)?|postgres(?:ql)?|chrome|chromium|keycloak|npm)\s*$/i;
const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';
const DATED = new RegExp(
  String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:${MONTHS}) \d{4}\b|actions/runs/\d+`,
);

interface Unit {
  text: string;
  /** Line of each character of `text`. */
  lineAt: (offset: number) => number;
}

/** Paragraphs, list items and table cells of the live lines; a count is judged inside one. */
function units(lines: readonly LiveLine[]): Unit[] {
  const result: Unit[] = [];
  let parts: LiveLine[] = [];
  const flush = () => {
    if (parts.length === 0) return;
    const starts: { offset: number; line: number }[] = [];
    let text = '';
    for (const part of parts) {
      starts.push({ offset: text.length, line: part.line });
      text += `${part.text} `;
    }
    result.push({
      text,
      lineAt: (offset) => [...starts].reverse().find((s) => s.offset <= offset)?.line ?? 0,
    });
    parts = [];
  };
  let previous = -1;
  for (const live of lines) {
    const text = live.text;
    if (live.line !== previous + 1 || text.trim() === '' || HEADING.test(text)) flush();
    previous = live.line;
    if (text.trim() === '' || HEADING.test(text)) continue;
    if (text.trimStart().startsWith('|')) {
      flush();
      for (const cell of text.split(/(?<!\\)\|/)) {
        if (cell.trim() !== '') parts.push({ line: live.line, text: cell });
        flush();
      }
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(text)) flush();
    parts.push(live);
  }
  flush();
  return result;
}

/** Sentences of a unit, with their offsets. */
function sentences(text: string): { start: number; text: string }[] {
  const result: { start: number; text: string }[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=\s+[A-Z`"*([])/g)) {
    const end = (m.index ?? 0) + 1;
    result.push({ start, text: text.slice(start, end) });
    start = end;
  }
  result.push({ start, text: text.slice(start) });
  return result;
}

export function checkCounts(docs: readonly Doc[]): string[] {
  const findings: string[] = [];
  for (const doc of docs) {
    for (const unit of units(liveLines(doc.path, doc.text))) {
      for (const sentence of sentences(unit.text)) {
        if (DATED.test(sentence.text)) continue;
        // Link targets are not prose; a run link was looked for above.
        const prose = sentence.text.replace(/\]\([^)]*\)/g, (s) => ' '.repeat(s.length));
        const hits = [...prose.matchAll(NUMBER_THEN_NOUN), ...prose.matchAll(NOUN_THEN_NUMBER)]
          .filter((m) => {
            const before = prose.slice(0, m.index);
            return !LIMIT_BEFORE.test(before) && !NAME_BEFORE.test(before);
          })
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const m of hits) {
          const line = unit.lineAt(sentence.start + (m.index ?? 0));
          findings.push(
            `${doc.path}:${line} "${m[0].replace(/\s+/g, ' ').trim()}" is a hand-typed count in live text: drop it and point at the test or command that gives it, or give its sentence the date or run link it was true on (DEC-38, D17)`,
          );
        }
      }
    }
  }
  return findings;
}
