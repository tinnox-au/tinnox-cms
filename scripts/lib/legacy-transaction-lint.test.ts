// The lints of adoption plan step 19 as eslint.config.js gives them to real paths, run against
// fixture text: the legacy transaction API and its list of files that only shrinks (AG-3.1,
// SCR-34), the import of the permit's maker, and the cast to WritePermit. Each case takes the
// entry the config resolves for a path, so a block that took a rule away from a file group
// would fail here. The rule's own cases are in scripts/eslint-rules/no-legacy-transaction.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import tinnox from '../eslint-rules/index.ts';
import { repoRoot } from './env.ts';

const LEGACY = 'tinnox/no-legacy-transaction';
const SYNTAX = 'no-restricted-syntax';
const IMPORTS = 'no-restricted-imports';
const repository = new ESLint({ cwd: repoRoot });

/** The entry of `rule` that eslint.config.js resolves for `path`. */
async function entryFor(path: string, rule: string): Promise<Linter.RuleEntry | undefined> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  return resolved[rule];
}

/** True when `entry` leaves a rule off: absent, 'off' or 0. */
function isOff(entry: Linter.RuleEntry | undefined): boolean {
  const severity: unknown = Array.isArray(entry) ? entry[0] : entry;
  return severity === undefined || severity === 'off' || severity === 0;
}

/** The messages of `rule`, as eslint.config.js resolves it for `path`, for `code` at `path`. */
async function flagged(path: string, code: string, rule: string): Promise<string[]> {
  const entry = await entryFor(path, rule);
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
        plugins: { tinnox },
        languageOptions: {
          sourceType: 'module',
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: entry === undefined ? {} : { [rule]: entry },
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  // The rule's own messages: a real source file also carries directives for other rules.
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === rule)
    .map((message) => message.message);
}

/** A list or table that eslint.config.js exports. */
async function exported(name: string): Promise<unknown> {
  // A computed specifier keeps the type checker away from the untyped config file.
  const config = pathToFileURL(join(repoRoot, 'eslint.config.js')).href;
  const loaded: unknown = await import(config);
  if (typeof loaded !== 'object' || loaded === null || !(name in loaded)) {
    throw new Error(`eslint.config.js exports no ${name}`);
  }
  return (loaded as Record<string, unknown>)[name];
}

async function legacyFiles(): Promise<string[]> {
  const list = await exported('LEGACY_TRANSACTION_FILES');
  if (!Array.isArray(list) || !list.every((file) => typeof file === 'string')) {
    throw new Error('LEGACY_TRANSACTION_FILES is not a list of paths');
  }
  return list;
}

const source = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

/**
 * The files that used the legacy API when step 19 landed the new one. NEVER ADD TO THIS LIST:
 * it is what "only shrinks" is measured against. A file that leaves LEGACY_TRANSACTION_FILES
 * leaves this list in the same change (step 20, one file per pull request), and the day both
 * are empty the rule, its two lists and this test's allow-list cases can go.
 */
const FOUND_BY_STEP_19 = [
  'apps/api/src/alerts.ts',
  'apps/api/src/auth/permission-audit.ts',
  'apps/api/src/auth/permissions.ts',
  'apps/api/src/auth/session.ts',
  'apps/api/src/db-helpers.ts',
  'apps/api/src/media/pipeline.ts',
  'apps/api/src/publishing.ts',
  'apps/api/src/routes/alert-recipients.ts',
  'apps/api/src/routes/apps.ts',
  'apps/api/src/routes/audit.ts',
  'apps/api/src/routes/auth.ts',
  'apps/api/src/routes/displays.ts',
  'apps/api/src/routes/folders.ts',
  'apps/api/src/routes/layouts.ts',
  'apps/api/src/routes/media.ts',
  'apps/api/src/routes/members.ts',
  'apps/api/src/routes/overview.ts',
  'apps/api/src/routes/player.ts',
  'apps/api/src/routes/playlists.ts',
  'apps/api/src/routes/push.ts',
  'apps/api/src/routes/schedules.ts',
  'apps/api/src/routes/tags.ts',
  'scripts/lib/provision.ts',
  'scripts/seed.ts',
];

const LEGACY_CODE = `
import { auditScoped, withOrg, type OrgTx } from '@tinnox/db';
import { withOrgAllowed } from '../auth/permissions.ts';
await withOrg(pool, orgId, (tx) => auditScoped(tx, event));
`;
const NEW_CODE = `
import { changePreOrg, readOrg, unaudited, type OrgReadTx } from '@tinnox/db';
import { changeAsOperator } from '../auth/permissions.ts';
await readOrg(pool, orgId, (tx) => tx.query('SELECT 1'));
await changeAsOperator(ctx, request, async (tx) => ({ value: 1, audit: unaudited('read_only') }));
`;
// Plan section 3.4, with the names as they are built: there is no `db` handle yet, so the
// functions take the pool.
const MESSAGE =
  /^(auditScoped|withOrg|withOrgAllowed) is the legacy transaction API: it .*\. Use readOrg\(pool, orgId, fn\) for reads and changeOrg\(pool, orgId, permit, fn\) returning \{ value, audit \} for changes; the permit comes from the role guard: an operator route calls changeAsOperator\(ctx, request, fn\) \(apps\/api\/src\/auth\/permissions\.ts\), .* This file is not in LEGACY_TRANSACTION_FILES of eslint\.config\.js, and that list only shrinks: do not add to it\.$/;
const STALE =
  /^This file no longer uses the legacy transaction API .*: remove it from LEGACY_TRANSACTION_FILES in eslint\.config\.js\. The list only shrinks/;

// The first case loads eslint.config.js, which a busy CI runner can stretch towards the unit
// project's 5 s default (GAP-1).
describe('the legacy transaction API (AG-3.1, SCR-34)', { timeout: 30_000 }, () => {
  it.each([
    // A new route file, a new module of the API, and files with lists of their own for other rules.
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/alerts-once.ts',
    'apps/api/src/housekeeping.ts',
    'apps/api/src/config.ts',
    'apps/api/src/mail.ts',
    'apps/api/src/auth/oidc.ts',
    'apps/api/src/media/rows.ts',
    // D25: the offline tools, with no exception.
    'scripts/provision-member.ts',
    'scripts/migrate.ts',
    'scripts/lib/fixture.ts',
    'scripts/fixture.ts',
  ])('is refused in %s, which is not on the list', async (path) => {
    expect(await flagged(path, LEGACY_CODE, LEGACY)).toEqual([
      expect.stringMatching(MESSAGE),
      expect.stringMatching(MESSAGE),
      expect.stringMatching(MESSAGE),
    ]);
    expect(await flagged(path, NEW_CODE, LEGACY)).toEqual([]);
  });

  it('is left to every file of the list, and each is told when it needs its entry no more', async () => {
    const files = await legacyFiles();
    expect(files).not.toEqual([]);
    for (const path of files) {
      expect(await entryFor(path, LEGACY), path).toEqual([2, { listed: true }]);
      expect(await flagged(path, LEGACY_CODE, LEGACY), path).toEqual([]);
      expect(await flagged(path, NEW_CODE, LEGACY), path).toEqual([expect.stringMatching(STALE)]);
    }
  });

  it('the list only shrinks: every entry is a file step 19 found, once, and nothing was added', async () => {
    const files = await legacyFiles();
    expect(new Set(files).size, 'an entry is listed twice').toBe(files.length);
    expect(
      files.filter((file) => !FOUND_BY_STEP_19.includes(file)),
      'LEGACY_TRANSACTION_FILES of eslint.config.js only shrinks. Write the new file on readOrg, changeAsOperator (or changeOrg) and changePreOrg, which return { value, audit }; do not add it to the list',
    ).toEqual([]);
    expect(
      FOUND_BY_STEP_19.filter((file) => !files.includes(file)),
      'a file left LEGACY_TRANSACTION_FILES: remove it from FOUND_BY_STEP_19 in this test too, in the same change',
    ).toEqual([]);
  });

  it('keeps no entry whose file is gone or no longer uses the legacy API', async () => {
    for (const path of await legacyFiles()) {
      expect(existsSync(join(repoRoot, path)), `${path} is gone: remove its entry`).toBe(true);
      // With the entry the config resolves (listed), the rule speaks only when the file has no
      // legacy use left. `npm run lint` says the same; this says it in the unit run.
      expect(await flagged(path, source(path), LEGACY), path).toEqual([]);
    }
  });

  it.each([
    // Tests arrange data with withOrg and call the audit writers to test them.
    'apps/api/src/fixture.test.ts',
    'apps/api/test/support.ts',
    'apps/api/test/fixture.integration.test.ts',
    'packages/db/test/fixture.integration.test.ts',
    'tests/integration/fixture.test.ts',
    'tests/e2e/support/database.ts',
    'scripts/lib/fixture.test.ts',
    // packages/db defines both APIs.
    'packages/db/src/tx.ts',
    'packages/db/src/change.ts',
    'packages/db/src/testing.ts',
    // No database handle can reach these at all (the import boundaries).
    'apps/portal/src/fixture.tsx',
    'packages/domain/src/fixture.ts',
  ])('is off in %s', async (path) => {
    expect(isOff(await entryFor(path, LEGACY))).toBe(true);
  });
});

// SCR-34: changeOrg runs no change without a WritePermit, so who can make one is the rule.
describe('the maker of a WritePermit (SCR-34)', { timeout: 30_000 }, () => {
  const MAKERS =
    "import { changeOrg, issueWritePermit, legacyAudit, type WritePermit } from '@tinnox/db';";
  const refused = (name: string): RegExp =>
    new RegExp(
      `^'${name}' import from '@tinnox/db' is restricted from being used by a pattern\\. Only the role guard issues a WritePermit \\(SCR-34\\): .* An operator route calls changeAsOperator\\(ctx, request, fn\\) from apps/api/src/auth/permissions\\.ts and returns \\{ value, audit \\}; it never holds the permit\\. .*$`,
    );

  it.each([
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/routes/members.ts',
    'apps/api/src/fixture.ts',
    'apps/api/src/auth/session.ts',
    'apps/api/src/auth/permission-audit.ts',
    'apps/api/src/alerts.ts',
    'apps/api/src/media/pipeline.ts',
    'apps/api/src/main.ts',
    'scripts/seed.ts',
    'scripts/lib/provision.ts',
    'scripts/lib/fixture.ts',
    'scripts/fixture.mjs',
  ])('is refused in %s, which keeps changeOrg and the type', async (path) => {
    expect(await flagged(path, MAKERS, IMPORTS)).toEqual([
      expect.stringMatching(refused('issueWritePermit')),
      expect.stringMatching(refused('legacyAudit')),
    ]);
  });

  it('is refused under another name, as a re-export and as a namespace', async () => {
    const path = 'apps/api/src/routes/fixture.ts';
    expect(
      await flagged(path, "import { issueWritePermit as permit } from '@tinnox/db';", IMPORTS),
    ).toEqual([expect.stringMatching(refused('issueWritePermit'))]);
    expect(await flagged(path, "export { legacyAudit } from '@tinnox/db';", IMPORTS)).toEqual([
      expect.stringMatching(refused('legacyAudit')),
    ]);
    const namespace = await flagged(path, "import * as db from '@tinnox/db';", IMPORTS);
    expect(namespace.join('\n')).toMatch(/Only the role guard issues a WritePermit \(SCR-34\)/);
  });

  it.each([
    'apps/api/src/auth/permissions.ts',
    'apps/api/src/auth/fixture.test.ts',
    'apps/api/test/fixture.integration.test.ts',
    'tests/integration/fixture.test.ts',
  ])('may be imported in %s', async (path) => {
    expect(await flagged(path, MAKERS, IMPORTS)).toEqual([]);
  });

  it('keeps the other import rules of the role guard: no unscoped helper, no pg', async () => {
    const code = `${MAKERS} import { poolAsTx } from '@tinnox/db'; import pg from 'pg';`;
    expect(await flagged('apps/api/src/auth/permissions.ts', code, IMPORTS)).toEqual([
      expect.stringMatching(/withoutOrg and poolAsTx run without an organisation/),
      expect.stringMatching(/^'pg' import is restricted/),
    ]);
  });

  it('lists the role guard alone, with its reason, and it still imports the maker', async () => {
    const list = await exported('WRITE_PERMIT_ISSUERS');
    expect(Object.keys(list as object)).toEqual(['apps/api/src/auth/permissions.ts']);
    for (const [file, reason] of Object.entries(list as object)) {
      expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
        true,
      );
      const imports = /import\s*\{([^}]*)\}\s*from\s*'@tinnox\/db';/.exec(source(file))?.[1] ?? '';
      expect(
        /\bissueWritePermit\b/.test(imports),
        `${file} no longer imports issueWritePermit: remove it from WRITE_PERMIT_ISSUERS in eslint.config.js`,
      ).toBe(true);
    }
  });
});

// SCR-34: enterOrg of changePreOrg (and of withResolvedOrg) gives a handle that writes for any
// OrgId with no permit, so an operator write could skip the role guard through it. Only the
// files whose transactions start before the organisation is known may import the two.
describe(
  'the openers that enter an organisation without a permit (SCR-34)',
  { timeout: 30_000 },
  () => {
    const OPENERS =
      "import { changeOrg, changePreOrg, readOrg, withResolvedOrg } from '@tinnox/db';";
    const PRE_ORG = [
      'apps/api/src/routes/alert-recipients.ts',
      'apps/api/src/routes/auth.ts',
      'apps/api/src/routes/player.ts',
      'scripts/lib/provision.ts',
    ];
    const refused = (name: string): RegExp =>
      new RegExp(
        `^'${name}' import from '@tinnox/db' is restricted from being used by a pattern\\. changePreOrg and withResolvedOrg are for a transaction that starts before the organisation is known \\(SCR-34\\): .* An operator change calls changeAsOperator\\(ctx, request, fn\\) from apps/api/src/auth/permissions\\.ts, .* a read calls readOrg\\(pool, orgId, fn\\) from @tinnox/db\\. .* add it to PRE_ORG_CHANGE_FILES in eslint\\.config\\.js with its reason, and say why in the pull request\\.$`,
      );

    it.each([
      // A new route file, an operator route file of the legacy list, and the role guard itself.
      'apps/api/src/routes/fixture.ts',
      'apps/api/src/routes/folders.ts',
      'apps/api/src/routes/members.ts',
      'apps/api/src/auth/permissions.ts',
      'apps/api/src/fixture.ts',
      'apps/api/src/alerts.ts',
      'apps/api/src/media/pipeline.ts',
      'scripts/seed.ts',
      'scripts/lib/fixture.ts',
      'scripts/fixture.mjs',
    ])('are refused in %s, which keeps changeOrg and readOrg', async (path) => {
      expect(await flagged(path, OPENERS, IMPORTS)).toEqual([
        expect.stringMatching(refused('changePreOrg')),
        expect.stringMatching(refused('withResolvedOrg')),
      ]);
    });

    it('are refused under another name, as a re-export and as a namespace', async () => {
      const path = 'apps/api/src/routes/fixture.ts';
      expect(
        await flagged(path, "import { changePreOrg as open } from '@tinnox/db';", IMPORTS),
      ).toEqual([expect.stringMatching(refused('changePreOrg'))]);
      expect(await flagged(path, "export { withResolvedOrg } from '@tinnox/db';", IMPORTS)).toEqual(
        [expect.stringMatching(refused('withResolvedOrg'))],
      );
      const namespace = await flagged(path, "import * as db from '@tinnox/db';", IMPORTS);
      expect(namespace.join('\n')).toMatch(
        /'changePreOrg' and 'withResolvedOrg' from '@tinnox\/db' are restricted .* changePreOrg and withResolvedOrg are for a transaction that starts before the organisation is known/,
      );
    });

    it.each([
      ...PRE_ORG,
      'apps/api/src/routes/fixture.test.ts',
      'apps/api/test/fixture.integration.test.ts',
      'tests/integration/fixture.test.ts',
    ])('may be imported in %s', async (path) => {
      expect(await flagged(path, OPENERS, IMPORTS)).toEqual([]);
    });

    it('keeps the other import rules of those files: no permit maker, no pg', async () => {
      const code = `${OPENERS} import { issueWritePermit } from '@tinnox/db'; import pg from 'pg';`;
      expect(await flagged('apps/api/src/routes/auth.ts', code, IMPORTS)).toEqual([
        expect.stringMatching(/Only the role guard issues a WritePermit/),
        expect.stringMatching(/^'pg' import is restricted/),
      ]);
    });

    it('lists four files, each with its reason, and each still imports one of the two', async () => {
      const list = await exported('PRE_ORG_CHANGE_FILES');
      expect(Object.keys(list as object).sort()).toEqual(PRE_ORG);
      for (const [file, reason] of Object.entries(list as object)) {
        expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
          true,
        );
        const imports =
          /import\s*\{([^}]*)\}\s*from\s*'@tinnox\/db';/.exec(source(file))?.[1] ?? '';
        expect(
          /\b(changePreOrg|withResolvedOrg)\b/.test(imports),
          `${file} no longer imports changePreOrg or withResolvedOrg: remove it from PRE_ORG_CHANGE_FILES in eslint.config.js`,
        ).toBe(true);
      }
    });
  },
);

describe('casts to WritePermit (SCR-34)', { timeout: 30_000 }, () => {
  const PERMIT_CAST =
    /^Do not cast to WritePermit: the type says the role guard issued the permit, so the role is read again as the first statement of the change \(SCR-34\)\. An operator route calls changeAsOperator\(ctx, request, fn\) \(apps\/api\/src\/auth\/permissions\.ts\), .* a test issues one with issueWritePermit\(\{ recheck, stated, statedIn \}\) from @tinnox\/db\.$/;

  it.each([
    ['a plain cast', 'export const permit = {} as WritePermit;'],
    ['a double cast', 'export const permit = terms as unknown as WritePermit<Role>;'],
    ['an angle-bracket assertion', 'export const permit = <WritePermit>terms;'],
    ['a union', 'export const permit = held as WritePermit<Role> | undefined;'],
    ['a generic argument', 'export const permit = issue() as Promise<WritePermit<Role>>;'],
    ['a qualified name', 'export const permit = held as db.WritePermit<Role>;'],
  ])('flags %s', async (_name, code) => {
    for (const path of [
      'apps/api/src/routes/fixture.ts',
      'apps/api/src/auth/permissions.ts',
      'scripts/lib/fixture.ts',
      'packages/db/src/change.ts',
      'packages/db/src/fixture.test.ts',
      'apps/api/test/fixture.integration.test.ts',
      'tests/integration/fixture.test.ts',
    ]) {
      expect(await flagged(path, code, SYNTAX), path).toEqual([expect.stringMatching(PERMIT_CAST)]);
    }
  });

  it('leaves the type in annotations, and keeps the other brand bans beside it', async () => {
    const annotations = [
      'export function permitOf(request: Request): WritePermit<Role> { return issue(request); }',
      'export let held: WritePermit | undefined;',
      'export const other = permit as Pool;',
    ].join('\n');
    const both = 'export const p = held as WritePermit; export const tx = read as OrgTx;';
    for (const path of ['apps/api/src/fixture.ts', 'tests/integration/fixture.test.ts']) {
      expect(await flagged(path, annotations, SYNTAX), path).toEqual([]);
      expect(await flagged(path, both, SYNTAX), path).toEqual([
        expect.stringMatching(PERMIT_CAST),
        expect.stringMatching(/^Do not cast to a transaction handle/),
      ]);
    }
  });

  it('refuses a cast from the read-only handle to one that writes', async () => {
    for (const code of [
      'export const tx = read as OrgReadTx;',
      'export const tx = read as unknown as OrgTx;',
    ]) {
      expect(await flagged('apps/api/src/routes/fixture.ts', code, SYNTAX), code).toEqual([
        expect.stringMatching(
          /^Do not cast to a transaction handle \(Tx, OrgTx, OrgReadTx, PreOrgTx, DefinerTx\)/,
        ),
      ]);
    }
  });
});
