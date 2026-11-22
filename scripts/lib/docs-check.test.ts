import { describe, expect, it } from 'vitest';
import {
  AGENTS_MAX_BYTES,
  BUGBOT_MAX_CHARS,
  type Doc,
  type Repo,
  bugbotFrom,
  checkCounts,
  checkDecisionRanges,
  checkListedDocs,
  checkPaths,
  checkPins,
  checkRuleFilePlacement,
  checkRuleFileSizes,
  checkRuleFileSync,
  decisionRegister,
  liveLines,
  pinSources,
} from './docs-check.ts';

const AGENTS = [
  '# AGENTS.md',
  '',
  'Orientation.',
  '',
  '## Code Review Rules',
  '',
  'Report findings as Critical or High.',
  '',
  '### 1. Roles',
  '',
  '- `tinnox_app` is the only runtime role.',
  '',
].join('\n');

describe('rule files (D15)', () => {
  it('generates BUGBOT.md from the Code Review Rules section, under its own title', () => {
    const bugbot = bugbotFrom(AGENTS);
    expect(
      bugbot.startsWith('# Bugbot review rules for TINNOX CMS\n\n## Code Review Rules\n'),
    ).toBe(true);
    expect(bugbot).not.toContain('Orientation.');
    expect(bugbot.endsWith('- `tinnox_app` is the only runtime role.\n')).toBe(true);
  });

  it('passes when BUGBOT.md is what --write writes', () => {
    expect(checkRuleFileSync(AGENTS, bugbotFrom(AGENTS))).toEqual([]);
  });

  it('fails when AGENTS.md is edited alone', () => {
    const edited = AGENTS.replace('Critical or High', 'Critical, High or Low');
    expect(checkRuleFileSync(edited, bugbotFrom(AGENTS))).toEqual([
      '.cursor/BUGBOT.md:5 differs from the "## Code Review Rules" section of AGENTS.md: edit AGENTS.md only and run `npm run check:docs -- --write`',
    ]);
  });

  it('fails when BUGBOT.md is edited alone, naming the first line that differs', () => {
    const edited = bugbotFrom(AGENTS).replace('only runtime role', 'runtime role');
    expect(checkRuleFileSync(AGENTS, edited)[0]).toMatch(/^\.cursor\/BUGBOT\.md:9 differs/);
  });

  it('fails when BUGBOT.md is missing or AGENTS.md has no section to generate from', () => {
    expect(checkRuleFileSync(AGENTS, undefined)[0]).toMatch(
      /BUGBOT\.md is missing: edit AGENTS\.md only/,
    );
    expect(checkRuleFileSync('# AGENTS.md\n', '')[0]).toMatch(/no "## Code Review Rules" heading/);
  });

  it('accepts the root AGENTS.md and .cursor/BUGBOT.md and other files', () => {
    expect(
      checkRuleFilePlacement(['AGENTS.md', '.cursor/BUGBOT.md', 'docs/agents.md', 'README.md']),
    ).toEqual([]);
  });

  it('refuses an AGENTS.override.md, the root included', () => {
    expect(checkRuleFilePlacement(['AGENTS.md', 'AGENTS.override.md'])).toEqual([
      'AGENTS.override.md: Codex reads an AGENTS.override.md in place of AGENTS.md, so it would hide the review rules; delete it and put the rule in the root AGENTS.md',
    ]);
    expect(checkRuleFilePlacement(['apps/api/AGENTS.override.md'])).toHaveLength(1);
  });

  it('refuses a nested AGENTS.md or BUGBOT.md', () => {
    expect(
      checkRuleFilePlacement(['apps/api/AGENTS.md', 'apps/portal/.cursor/BUGBOT.md', 'BUGBOT.md']),
    ).toEqual([
      'apps/api/AGENTS.md: nested rule files load only for some working directories or changed paths; delete it and put the rule in the root AGENTS.md',
      'apps/portal/.cursor/BUGBOT.md: nested rule files load only for some working directories or changed paths; delete it and put the rule in the root AGENTS.md',
      'BUGBOT.md: nested rule files load only for some working directories or changed paths; delete it and put the rule in the root AGENTS.md',
    ]);
  });

  it('holds AGENTS.md to 16 KiB and BUGBOT.md to 30,000 characters', () => {
    expect(checkRuleFileSizes(AGENTS_MAX_BYTES, BUGBOT_MAX_CHARS)).toEqual([]);
    const over = checkRuleFileSizes(AGENTS_MAX_BYTES + 1, BUGBOT_MAX_CHARS + 1);
    expect(over).toHaveLength(2);
    expect(over[0]).toMatch(/^AGENTS\.md is 16385 bytes, over 16384/);
    expect(over[1]).toMatch(/^\.cursor\/BUGBOT\.md is 30001 characters/);
  });
});

describe('live text and snapshots (D17)', () => {
  const text = [
    '# Page', // 1
    '', // 2
    'Live.', // 3
    '```sh', // 4
    '# not a heading', // 5
    '```', // 6
    '## 8. As built (integration review, 2026-11-14)', // 7
    'Frozen.', // 8
    '### 8.1 Detail', // 9
    'Still frozen.', // 10
    '## 9. Later', // 11
    'Live again.', // 12
  ].join('\n');

  it('skips fenced blocks and every section under a heading that ends in a date in brackets', () => {
    expect(liveLines('docs/x.md', text).map((l) => l.line)).toEqual([1, 2, 3, 11, 12]);
  });

  it('treats docs/reviews/** and docs/prototype-validation.md as snapshots throughout', () => {
    expect(liveLines('docs/reviews/2026-11-16-backend-round-1/README.md', text)).toEqual([]);
    expect(liveLines('docs/prototype-validation.md', text)).toEqual([]);
  });
});

describe('paths', () => {
  const repo: Repo = {
    files: new Set([
      'README.md',
      'docs/open-questions.md',
      'docs/research/round2/R99-critic.md',
      'docs/security/control-matrix.md',
      'packages/db/test/rls.integration.test.ts',
      'tests/e2e/01-journey.spec.ts',
      'apps/api/src/app.ts',
    ]),
    ignored: new Set(['.env', 'data/']),
  };
  const check = (path: string, ...lines: string[]) =>
    checkPaths([{ path, text: lines.join('\n') }], repo);

  it('passes paths from the root, folders, shorthand, line suffixes and gitignored paths', () => {
    expect(
      check(
        'docs/security/control-matrix.md',
        '`packages/db/test/rls.integration.test.ts:12-14` and `apps/api` and `docs/security/`',
        '`e2e/01-journey.spec.ts` "signs in"; `.env` and `./data` stay local; `control-matrix.md`',
      ),
    ).toEqual([]);
  });

  it('tries a document name under docs/ and next to the document', () => {
    expect(check('README.md', '`open-questions.md`, `research/round2/R99-critic.md`')).toEqual([]);
    expect(check('docs/decisions-2026-11.md', 'notes under `research/round2/`')).toEqual([]);
  });

  it('flags a bare test file name, which is not a repository path', () => {
    expect(
      check('docs/security/control-matrix.md', 'x', '(`rls.integration.test.ts` "keeps")'),
    ).toEqual([
      'docs/security/control-matrix.md:2 names `rls.integration.test.ts`, which is not a repository path: write the path from the repository root (`git ls-files` lists them), or drop the backticks if it is not a file here',
    ]);
  });

  it('flags a folder that is not in the repository', () => {
    expect(check('README.md', 'Some files mention a `scratchpad/` folder.')).toHaveLength(1);
  });

  it('ignores placeholders, commands, routes, packages, MIME types, branches and image names', () => {
    expect(
      check(
        'README.md',
        '`db/migrations/NNNN_description.sql`, `packages/*`, `<org uuid>/<uuid>`, `e2e/…`, `npm run x`,',
        '`/api/audit`, `@tinnox/db`, `image/png`, `feat/prototype-m0`, `axllent/mailpit`, `sec.*`,',
        '`MEDIA_ROOT=./data/media`, `https://example.com/a.md`, `~/Library/x`, `security.txt`',
      ),
    ).toEqual([]);
  });

  it('skips fenced blocks and dated sections', () => {
    expect(
      check('README.md', '```', '`gone/file.ts`', '```', '## Old (2026-11-14)', '`gone/file.ts`'),
    ).toEqual([]);
  });
});

describe('listed documents (CHK-5)', () => {
  it('passes when every listed document exists', () => {
    expect(checkListedDocs(() => true)).toEqual([]);
  });

  it('reports each listed document that is missing, saying to update the list', () => {
    const missing = new Set(['README.md', 'tests/README.md', 'docs/security/threat-model.md']);
    expect(checkListedDocs((path) => !missing.has(path))).toEqual([
      'README.md is listed in scripts/lib/docs-check.ts but does not exist: update the list (PATH_DOCS, COUNT_DOCS, README_PATH or REGISTER_PATH) to its new path, or take it off if it was removed',
      expect.stringMatching(
        /^docs\/security\/threat-model\.md is listed in scripts\/lib\/docs-check\.ts but does not exist/,
      ),
      expect.stringMatching(
        /^tests\/README\.md is listed in scripts\/lib\/docs-check\.ts but does not exist/,
      ),
    ]);
  });

  it('leaves the rule files to the sync rule, which has its own fix', () => {
    expect(checkListedDocs((path) => path !== 'AGENTS.md' && path !== '.cursor/BUGBOT.md')).toEqual(
      [],
    );
  });
});

describe('decision ranges', () => {
  const register = decisionRegister(
    ['| ID | Decision |', '|---|---|', '| DEC-01 | a |', '| DEC-02 | b |', '| DEC-04 | d |'].join(
      '\n',
    ),
  );

  it('reads the register rows', () => {
    expect(register.numbers).toEqual([1, 2, 4]);
  });

  it('passes ranges and counts that match the register', () => {
    expect(
      checkDecisionRanges(
        'It has 3 numbered decisions (DEC-01 to DEC-04; there is no DEC-03).',
        register,
      ),
    ).toEqual([]);
  });

  it('flags a stale range, a stale count and a gap that is not one', () => {
    expect(
      checkDecisionRanges(
        'x\n3 numbered decisions (DEC-01 to DEC-02), 2 numbered decisions, no DEC-02',
        register,
      ),
    ).toEqual([
      'README.md:2 says "DEC-01 to DEC-02", but the register (docs/decisions-2026-11.md) runs from DEC-01 to DEC-04 and holds 3 entries: write "DEC-01 to DEC-04"',
      'README.md:2 says "2 numbered decisions", but the register (docs/decisions-2026-11.md) runs from DEC-01 to DEC-04 and holds 3 entries: write "3 numbered decisions"',
      'README.md:2 says "no DEC-02", but the register has DEC-02: remove the claim',
    ]);
  });
});

describe('pins', () => {
  const sha = 'a'.repeat(40);
  const digest = `@sha256:${'b'.repeat(64)}`;
  const pins = (path: string, ...lines: string[]) => checkPins([{ path, text: lines.join('\n') }]);

  it('reads workflows, compose files, Dockerfiles and script or source files, but not tests', () => {
    expect(
      pinSources([
        '.github/workflows/ci.yml',
        'infra/docker-compose.yml',
        'apps/media-worker/Dockerfile',
        'apps/media-worker/Dockerfile.dockerignore',
        'scripts/scan-secrets.mjs',
        'scripts/lib/docs-check.test.ts',
        'tests/integration/support.ts',
        'apps/media-worker/scripts/direct-check.mjs',
        'README.md',
      ]),
    ).toEqual([
      '.github/workflows/ci.yml',
      'infra/docker-compose.yml',
      'apps/media-worker/Dockerfile',
      'scripts/scan-secrets.mjs',
      'tests/integration/support.ts',
      'apps/media-worker/scripts/direct-check.mjs',
    ]);
  });

  it('wants an image pinned in a file outside scripts/ that runs docker, and reads no other (CHK-6)', () => {
    expect(
      pins(
        'tests/integration/support.ts',
        "execFileSync('docker', [",
        "  'run',",
        "  '--rm',",
        "  'postgres:17',",
        ']);',
      ),
    ).toEqual([
      expect.stringMatching(
        /^tests\/integration\/support\.ts:4 image postgres:17 is pinned by tag only/,
      ),
    ]);
    expect(pins('apps/api/test-fixtures/generate.mjs', 'docker run --rm node:24 true')).toEqual([
      expect.stringMatching(/^apps\/api\/test-fixtures\/generate\.mjs:1 image node:24 is pinned/),
    ]);
    // A registry-host string in a file that runs no docker is not an image it pulls.
    expect(pins('apps/api/src/x.ts', "const IMAGE = 'ghcr.io/a/b:1';")).toEqual([]);
    // The exemption for an image a compose service builds here holds outside scripts/ too.
    expect(
      checkPins([
        {
          path: 'infra/docker-compose.yml',
          text: 'services:\n  worker:\n    build: ..\n    image: tinnox-cms-media-worker:m0',
        },
        {
          path: 'tests/integration/support.ts',
          text: "execFileSync('docker', ['run', '--rm', 'tinnox-cms-media-worker:m0']);",
        },
      ]),
    ).toEqual([]);
  });

  it('wants every action pinned by a 40-character commit', () => {
    expect(
      pins(
        '.github/workflows/ci.yml',
        `      - uses: actions/checkout@${sha} # v7.0.1`,
        '      - uses: ./.github/actions/local',
        '      - uses: actions/setup-node@v7',
      ),
    ).toEqual([
      '.github/workflows/ci.yml:3 action actions/setup-node@v7 is not pinned by a 40-character commit: pin the commit of the release and keep the tag as a comment, as the other steps do',
    ]);
  });

  it('wants every pulled compose image pinned by digest, not a service built here', () => {
    expect(
      pins(
        'infra/docker-compose.yml',
        'services:',
        '  postgres:',
        `    image: postgres:17.12-alpine3.24${digest}`,
        '  mailpit:',
        '    image: axllent/mailpit:v1.33.0',
        '  media-worker:',
        '    build:',
        '      context: ..',
        '    image: tinnox-cms-media-worker:m0',
      ),
    ).toEqual([
      'infra/docker-compose.yml:5 image axllent/mailpit:v1.33.0 is pinned by tag only: add its digest (`docker buildx imagetools inspect axllent/mailpit:v1.33.0` prints it) as axllent/mailpit:v1.33.0@sha256:<digest>',
    ]);
  });

  it('wants every Dockerfile base pinned by digest, not an earlier stage', () => {
    expect(
      pins(
        'apps/x/Dockerfile',
        `FROM node:24${digest} AS deps`,
        'FROM deps AS build',
        'FROM node:24 AS runtime',
      ),
    ).toEqual([
      expect.stringMatching(/^apps\/x\/Dockerfile:3 image node:24 is pinned by tag only/),
    ]);
  });

  it('wants an image a script runs pinned by digest', () => {
    expect(pins('scripts/scan.mjs', "const IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1';")).toEqual([
      'scripts/scan.mjs:1 image ghcr.io/gitleaks/gitleaks:v8.30.1 is pinned by tag only: add its digest (`docker buildx imagetools inspect ghcr.io/gitleaks/gitleaks:v8.30.1` prints it) as ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:<digest>',
    ]);
    expect(
      pins(
        'scripts/scan.mjs',
        `const IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1${digest}';`,
        "fetch('https://github.com/a/b');",
      ),
    ).toEqual([]);
  });

  it('wants an image without a registry host pinned in a script that runs docker', () => {
    expect(
      pins(
        'scripts/x.mjs',
        "spawnSync('docker', ['run', '--rm', '-p', '8080:80', '-u', '1000:1000', 'postgres:17']);",
        "import { spawnSync } from 'node:child_process'; const fs = await import('node:fs');",
        `spawnSync('docker', ['pull', 'node:24${digest}']);`,
      ),
    ).toEqual([
      expect.stringMatching(/^scripts\/x\.mjs:1 image postgres:17 is pinned by tag only/),
    ]);
    expect(
      pins(
        'scripts/x.sh',
        'docker run --rm -v "$PWD:/repo:ro" -v data:/data -e A=b:c node:24 sh -c true',
        `docker pull node:24${digest}`,
      ),
    ).toEqual([expect.stringMatching(/^scripts\/x\.sh:1 image node:24 is pinned by tag only/)]);
    // A script that does not run an image may name things of the same shape.
    expect(pins('scripts/x.mjs', "run('npm', ['run', 'infra:up']);")).toEqual([]);
    // The host-gateway alias, a bare digest and a security option are not images.
    expect(
      pins(
        'scripts/x.sh',
        'docker run --add-host host.docker.internal:host-gateway --security-opt seccomp:unconfined alpine:3.20',
      ),
    ).toEqual([
      expect.stringMatching(/^scripts\/x\.sh:1 image alpine:3\.20 is pinned by tag only/),
    ]);
    expect(
      pins(
        'scripts/x.mjs',
        "spawnSync('docker', ['run', '--add-host', 'host.docker.internal:host-gateway', 'x']);",
        `const DIGEST = 'sha256:${'a'.repeat(64)}'; spawnSync('docker', ['pull', 'x']);`,
      ),
    ).toEqual([]);
    // A user and group, another container's namespace or volumes, and a shell comment have an
    // image's shape too; the image beside them is still reported.
    expect(
      pins(
        'scripts/x.sh',
        'docker run --user node:node node:24',
        'docker run -u node:node --network container:db --pid container:db node:22 true',
        'docker run --rm --volumes-from db:ro --ipc=host postgres:17 # a:b',
        // A quoted # starts no comment.
        "docker run --rm -e 'A=b # c' alpine:3.20 true # e:f",
        // A quoted value is the option's value as much as a bare one.
        "docker run --user 'node:node' --user='node:node' node:20",
        // A quoted word in a comment is still in the comment.
        'docker run --rm postgres:16 # see \'a:b\' or "c:d"',
        "# docker run 'e:f'",
      ),
    ).toEqual([
      expect.stringMatching(/^scripts\/x\.sh:1 image node:24 is pinned by tag only/),
      expect.stringMatching(/^scripts\/x\.sh:2 image node:22 is pinned by tag only/),
      expect.stringMatching(/^scripts\/x\.sh:3 image postgres:17 is pinned by tag only/),
      expect.stringMatching(/^scripts\/x\.sh:4 image alpine:3\.20 is pinned by tag only/),
      expect.stringMatching(/^scripts\/x\.sh:5 image node:20 is pinned by tag only/),
      expect.stringMatching(/^scripts\/x\.sh:6 image postgres:16 is pinned by tag only/),
    ]);
    // The same options as spawn arguments, on one line or one per line as prettier writes them.
    expect(
      pins(
        'scripts/x.mjs',
        "spawnSync('docker', ['run', '--user', 'node:node', '--net', 'container:db', 'node:24']);",
        'spawnSync(',
        "  'docker',",
        '  [',
        "    'run',",
        "    '--user',",
        "    'node:node',",
        "    '--network',",
        "    'container:db',",
        "    'postgres:17',",
        '  ],',
        ');',
      ),
    ).toEqual([
      expect.stringMatching(/^scripts\/x\.mjs:1 image node:24 is pinned by tag only/),
      expect.stringMatching(/^scripts\/x\.mjs:10 image postgres:17 is pinned by tag only/),
    ]);
    // An option that ends a statement does not swallow the image on the next line.
    expect(
      pins(
        'scripts/x.mjs',
        "const flags = ['--rm', '-u'];",
        "const IMAGE = 'node:24';",
        "spawnSync('docker', ['run', ...flags, IMAGE]);",
      ),
    ).toEqual([expect.stringMatching(/^scripts\/x\.mjs:2 image node:24 is pinned by tag only/)]);
  });

  it('does not want a digest on an image a compose service builds here', () => {
    const findings = checkPins([
      {
        path: 'infra/docker-compose.yml',
        text: [
          'services:',
          '  worker:',
          '    build: ..',
          '    image: tinnox-cms-media-worker:m0',
        ].join('\n'),
      },
      {
        path: 'scripts/x.sh',
        text: 'docker run --rm tinnox-cms-media-worker:m0\ndocker run --rm other-worker:m0',
      },
    ]);
    expect(findings).toEqual([
      expect.stringMatching(/^scripts\/x\.sh:2 image other-worker:m0 is pinned by tag only/),
    ]);
  });

  it('wants a workflow job container and service image pinned by digest', () => {
    expect(
      pins(
        '.github/workflows/ci.yml',
        '    container: node:24',
        '    container:',
        '      image: node:24',
        '    services:',
        '      postgres:',
        `        image: postgres:17${digest}`,
        '      redis:',
        "        image: 'redis:8'",
        '    container: ${{ matrix.image }}',
      ),
    ).toEqual([
      expect.stringMatching(/^\.github\/workflows\/ci\.yml:1 image node:24 is pinned by tag only/),
      expect.stringMatching(/^\.github\/workflows\/ci\.yml:3 image node:24 is pinned by tag only/),
      expect.stringMatching(/^\.github\/workflows\/ci\.yml:8 image redis:8 is pinned by tag only/),
    ]);
  });
});

describe('hand-typed counts (D17)', () => {
  const counts = (...lines: string[]): string[] =>
    checkCounts([{ path: 'docs/x.md', text: lines.join('\n') } satisfies Doc]).map((f) =>
      f.replace(/ is a hand-typed count.*$/, ''),
    );

  it('flags a count of tests, cases, routes, tables or sec functions with no date', () => {
    expect(
      counts(
        '`rls.integration.test.ts` (26 tests as `tinnox_app`).',
        '',
        'Unit: the 62 routes; every tenant table (22; checked); 17 `sec` functions; 19 cases.',
        '',
        'TESTED: contract and domain unit tests (in the 366).',
        '',
        'The suite has 150 e2e tests. It lists 150 Playwright e2e tests. There are 21 `sec.*` functions.',
      ),
    ).toEqual([
      'docs/x.md:1 "26 tests"',
      'docs/x.md:3 "62 routes"',
      'docs/x.md:3 "table (22"',
      'docs/x.md:3 "17 `sec` functions"',
      'docs/x.md:3 "19 cases"',
      'docs/x.md:5 "tests (in the 366"',
      'docs/x.md:7 "150 e2e tests"',
      'docs/x.md:7 "150 Playwright e2e tests"',
      'docs/x.md:7 "21 `sec.*` functions"',
    ]);
  });

  it('passes a count whose sentence carries its date or run link', () => {
    expect(
      counts(
        '395 unit and 25 browser end-to-end tests passed on 2026-11-14 after the review fixes.',
        '',
        'The workflow ran (run [43835309136](https://github.com/o/r/actions/runs/43835309136): integration with 266 tests).',
        '',
        'On 22 November 2026 the suite listed 150 tests.',
      ),
    ).toEqual([]);
  });

  it('wants the date in the sentence of the count, not elsewhere in a long cell', () => {
    expect(
      counts(
        '| B17 | x | **TESTED** at integration on 2026-11-21. `display-alerts.test.ts` (19 cases: once). | gap |',
      ),
    ).toEqual(['docs/x.md:1 "19 cases"']);
  });

  it('does not take a date from another cell of the same row', () => {
    expect(counts('| 2026-11-20 | 7 tests |')).toEqual(['docs/x.md:1 "7 tests"']);
  });

  it('passes a product limit ("at most 20 addresses") and numbers that name something', () => {
    expect(
      counts(
        'Each organisation keeps one list of alert addresses, at most 20 addresses, and at most 30 routes a minute.',
        'Where section 8 and the table disagree, section 8 wins; release 2, on TINNOX-player routes; round 6 tests.',
        'Up to 5 wrong codes; 128 PIDs; 16 KiB; migration 0004 tables.',
        'CI uses Node 22 for all tests.',
        'Use PostgreSQL 17 for integration tests.',
        'The player polls every 30 seconds and the tests check it.',
        'It runs on Node 24 unit tests and Chromium 140 browser tests.',
      ),
    ).toEqual([]);
  });

  it('skips dated sections, and gives the line of a count in a wrapped paragraph', () => {
    expect(
      counts(
        '## 8. As built (2026-11-14)',
        'The 26 tests passed.',
        '## 9. Now',
        'Stage C added the roles spec (runs in the full',
        'suite of 143; all 59 operator routes as each role).',
      ),
    ).toEqual(['docs/x.md:5 "59 operator routes"']);
  });
});
