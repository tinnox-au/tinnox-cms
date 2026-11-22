// Keeps db/migrations append-only and numbered (rules in scripts/lib/migrations-check.ts, D12):
// names and contiguous numbers, merged files unchanged, new files numbered above origin/main,
// text rules over each file, and an entry in db/upgrade-tests.json for every file.
// On a branch or pull request it compares with the merge-base of HEAD and origin/main; on main
// it reads the first-parent history of HEAD. Both need the whole history (fetch-depth: 0 in CI).
//   npm run check:migrations              mode from GITHUB_REF in CI, else from the branch name
//   npm run check:migrations -- --main    main mode on any checkout
//   npm run check:migrations -- --branch  branch mode on any checkout
import { spawnSync } from 'node:child_process';
import { NOT_BLOCKING, checkRepository, chooseMode } from './lib/migrations-check.ts';
import { repoRoot } from './lib/env.ts';

const branch = spawnSync('git', ['-C', repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const mode = chooseMode(process.argv.slice(2), process.env, branch === '' ? undefined : branch);
const report = checkRepository(repoRoot, mode);

for (const finding of report.findings) console.error(finding);
if (report.findings.length > 0) {
  console.error(`check:migrations: ${report.findings.length} finding(s). ${NOT_BLOCKING}`);
  process.exit(1);
}
console.log(
  `check:migrations passed (${report.summary}): names and numbers, merged files unchanged, text rules, db/upgrade-tests.json complete`,
);
