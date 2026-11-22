// Keeps the rule files and the documents' references true (rules in scripts/lib/docs-check.ts):
// .cursor/BUGBOT.md generated from AGENTS.md, no nested or override rule files, size limits,
// backticked paths that exist, decision ranges that match the register, pinned actions and
// images, and no undated hand-typed counts in live text.
//   npm run check:docs              check
//   npm run check:docs -- --write   regenerate .cursor/BUGBOT.md from AGENTS.md, then check
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_PATH,
  BUGBOT_PATH,
  COUNT_DOCS,
  type Doc,
  PATH_DOCS,
  README_PATH,
  REGISTER_PATH,
  bugbotFrom,
  checkCounts,
  checkDecisionRanges,
  checkPaths,
  checkPins,
  checkRuleFilePlacement,
  checkRuleFileSizes,
  checkRuleFileSync,
  decisionRegister,
  pinSources,
  referencedPaths,
} from './lib/docs-check.ts';
import { repoRoot } from './lib/env.ts';

function git(args: string[], input?: string): string {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  // check-ignore exits 1 when nothing matches.
  if (result.status !== 0 && !(args[0] === 'check-ignore' && result.status === 1)) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function read(path: string): string | undefined {
  const full = join(repoRoot, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

// Tracked files and new files that are not ignored, never a filesystem walk: the main checkout
// holds whole copies of the repository under .claude/worktrees/, hidden only by a local exclude.
const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  .split('\0')
  .filter(
    (f) => f !== '' && existsSync(join(repoRoot, f)) && lstatSync(join(repoRoot, f)).isFile(),
  );

if (process.argv.includes('--write')) {
  const generated = bugbotFrom(read(AGENTS_PATH) ?? '');
  writeFileSync(join(repoRoot, BUGBOT_PATH), generated);
  console.log(`wrote ${BUGBOT_PATH} from the Code Review Rules of ${AGENTS_PATH}`);
}

const agents = read(AGENTS_PATH) ?? '';
const bugbot = read(BUGBOT_PATH);
const docs = (paths: string[]): Doc[] =>
  paths.flatMap((path) => {
    const text = read(path);
    return text === undefined ? [] : [{ path, text }];
  });

const pathDocs = docs(PATH_DOCS);
const fileSet = new Set(files);
const candidates = [
  ...new Set(pathDocs.flatMap((d) => referencedPaths(d, fileSet).flatMap((r) => r.candidates))),
];
// A folder such as `data/` matches its ignore rule only when asked for with the slash.
const asked = candidates.flatMap((c) => (c.endsWith('/') || /\.\w+$/.test(c) ? [c] : [c, `${c}/`]));
const ignored = new Set(
  git(['check-ignore', '--stdin'], asked.join('\n'))
    .split('\n')
    .filter((p) => p !== ''),
);

const findings = [
  ...checkRuleFileSync(agents, bugbot),
  ...checkRuleFilePlacement(files),
  ...checkRuleFileSizes(
    Buffer.byteLength(agents),
    bugbot === undefined ? undefined : [...bugbot].length,
  ),
  ...checkPaths(pathDocs, { files: fileSet, ignored }),
  ...checkDecisionRanges(read(README_PATH) ?? '', decisionRegister(read(REGISTER_PATH) ?? '')),
  ...checkPins(docs(pinSources(files))),
  ...checkCounts(docs(COUNT_DOCS)),
];

for (const finding of findings) console.error(finding);
if (findings.length > 0) {
  console.error(`check:docs: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log(
  `check:docs passed: ${BUGBOT_PATH} matches ${AGENTS_PATH}, ${candidates.length} path candidates, decision ranges, pins and live counts`,
);
