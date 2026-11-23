// The lints of adoption plan steps 19 and 20 as eslint.config.js gives them to real paths, run
// against fixture text: the legacy transaction API and its list of files that only shrinks
// (AG-3.1, SCR-34), the import of the permit's maker and who issues a permit, the entry of the
// jobs, the maker of an audit statement, and the casts to WritePermit, VerifiedDevice and
// AuditStatement. Each case takes the entry the config resolves for a path, so a block that took
// a rule away from a file group would fail here. The rule's own cases are in
// scripts/eslint-rules/no-legacy-transaction.test.ts.
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
  'apps/api/src/auth/permissions.ts',
  'apps/api/src/db-helpers.ts',
  'apps/api/src/routes/auth.ts',
  'apps/api/src/routes/player.ts',
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
await changeAsOperator(ctx, request, async (tx) => ({ value: 1, audit: unaudited('nothing_changed') }));
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
  // Plan section 3.4: the message names what each kind of caller does instead.
  const refused = (name: string): RegExp =>
    new RegExp(
      `^'${name}' import from '@tinnox/db' is restricted from being used by a pattern\\. Only what judges the caller of a change issues its WritePermit \\(SCR-34; the files of WRITE_PERMIT_ISSUERS in eslint\\.config\\.js\\), .* An operator route calls changeAsOperator\\(ctx, request, fn\\) from apps/api/src/auth/permissions\\.ts and returns \\{ value, audit \\}; it never holds the permit\\. .* a player route calls changeAsDevice\\(ctx, request, device, fn\\) .* \\(apps/api/src/auth/device\\.ts\\), the alert check and the media pipeline call changeAsJob\\(pool, job, orgId, fn\\) \\(apps/api/src/jobs\\.ts\\), an offline tool calls changeOrgAsMigrator\\(pool, orgId, statement, fn\\) from @tinnox/db/migrate, and a refusal that changed nothing is written with recordRefusal\\(ctx, request, session, event\\) \\(apps/api/src/auth/refusal\\.ts\\)\\. .* a new entry of WRITE_PERMIT_ISSUERS\\.$`,
    );
  const ROLE_GUARD = 'apps/api/src/auth/permissions.ts';
  /** The issuers the import rule reads: the API's and the offline tools', not packages/db. */
  const LINTED_ISSUERS = [
    ROLE_GUARD,
    'apps/api/src/auth/refusal.ts',
    'apps/api/src/auth/device.ts',
    'apps/api/src/jobs.ts',
  ];
  const ISSUERS = [...LINTED_ISSUERS, 'packages/db/src/migrate.ts'];

  it.each([
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/routes/members.ts',
    'apps/api/src/routes/player.ts',
    'apps/api/src/routes/media.ts',
    'apps/api/src/fixture.ts',
    'apps/api/src/auth/session.ts',
    'apps/api/src/auth/permission-audit.ts',
    'apps/api/src/auth/fixture.ts',
    'apps/api/src/alerts.ts',
    'apps/api/src/media/pipeline.ts',
    'apps/api/src/route-audit.ts',
    'apps/api/src/main.ts',
    'scripts/seed.ts',
    'scripts/provision-member.ts',
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
    expect(namespace.join('\n')).toMatch(
      /Only what judges the caller of a change issues its WritePermit \(SCR-34/,
    );
  });

  it.each([
    ...LINTED_ISSUERS,
    'apps/api/src/auth/fixture.test.ts',
    'apps/api/src/change.test-support.ts',
    'apps/api/test/fixture.integration.test.ts',
    'tests/integration/fixture.test.ts',
  ])('may be imported in %s', async (path) => {
    expect(await flagged(path, MAKERS, IMPORTS)).toEqual([]);
  });

  it('keeps the other import rules of every issuer: no unscoped helper, no pg, no opener before the organisation', async () => {
    const code = `${MAKERS} import { changePreOrg, poolAsTx } from '@tinnox/db'; import pg from 'pg';`;
    for (const path of LINTED_ISSUERS) {
      expect(await flagged(path, code, IMPORTS), path).toEqual([
        expect.stringMatching(/^'changePreOrg' import from '@tinnox\/db' is restricted/),
        expect.stringMatching(/withoutOrg and poolAsTx run without an organisation/),
        expect.stringMatching(/^'pg' import is restricted/),
      ]);
    }
  });

  it('lists one issuer for each kind of caller, with its reason, and each still imports the maker', async () => {
    const list = await exported('WRITE_PERMIT_ISSUERS');
    expect(
      Object.keys(list as object),
      'a new issuer of permits is a new kind of caller that may change an organisation: say in the pull request what judges that caller, and add the file to this list too',
    ).toEqual(ISSUERS);
    for (const [file, reason] of Object.entries(list as object)) {
      expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
        true,
      );
      const imports = [...source(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']+';/g)]
        .map((match) => match[1] ?? '')
        .join(',');
      expect(
        /\bissueWritePermit\b/.test(imports),
        `${file} no longer imports issueWritePermit: remove it from WRITE_PERMIT_ISSUERS in eslint.config.js`,
      ).toBe(true);
      // legacyAudit lets a callback write its audit rows by hand: the role guard's bridge alone.
      expect(
        /\blegacyAudit\b/.test(source(file)),
        `${file}: legacyAudit is for withOrgAllowed of the role guard only, until the last file of LEGACY_TRANSACTION_FILES has moved`,
      ).toBe(file === ROLE_GUARD);
    }
  });

  it('every issuer keeps its permit to itself: none exports a permit or its maker', async () => {
    for (const file of Object.keys((await exported('WRITE_PERMIT_ISSUERS')) as object)) {
      const text = source(file);
      expect(
        /export\s*\{[^}]*\b(issueWritePermit|legacyAudit)\b/.test(text),
        `${file} re-exports the maker of a permit`,
      ).toBe(false);
      expect(
        /export\s+(async\s+)?function\s+\w+\([^)]*\)\s*:\s*(Promise<)?WritePermit\b/.test(text),
        `${file} exports a function that returns a WritePermit: issue the permit inside the function that runs the change, as changeAsOperator does`,
      ).toBe(false);
    }
  });
});

// SCR-34 (adoption plan step 20): changeAsJob takes no proof that its caller is a job, so who
// may import the entry of the jobs is the rule.
describe('the entry of the jobs (SCR-34)', { timeout: 30_000 }, () => {
  const JOBS = [
    "import { changeAsJob } from './jobs.ts';",
    "import { changeAsJob as change } from '../jobs.ts';",
    "export { changeAsJob } from '../../src/jobs.ts';",
  ];
  const REFUSED =
    /^'(\.\.?\/)+(src\/)?jobs\.ts' import is restricted from being used by a pattern\. apps\/api\/src\/jobs\.ts is the entry of the jobs that run with no request \(SCR-34\): changeAsJob changes an organisation with no role check and no credential, so only the alert check and the media pipeline may import it \(JOB_CHANGE_FILES in eslint\.config\.js\)\. An operator route calls changeAsOperator\(ctx, request, fn\) from apps\/api\/src\/auth\/permissions\.ts, which checks the role again first; a player route calls changeAsDevice\(ctx, request, device, fn\) from apps\/api\/src\/auth\/device\.ts; a read calls readOrg\(pool, orgId, fn\) from @tinnox\/db\. A new job gets its row in JOB_AUDIT \(apps\/api\/src\/route-audit\.ts\) and its file in JOB_CHANGE_FILES with its reason, in its pull request\.$/;
  const JOB_FILES = ['apps/api/src/alerts.ts', 'apps/api/src/media/pipeline.ts'];

  it.each([
    // An operator route, a player route, the role guard, the start of the process and a new file.
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/routes/members.ts',
    'apps/api/src/routes/player.ts',
    'apps/api/src/auth/permissions.ts',
    'apps/api/src/auth/device.ts',
    'apps/api/src/publishing.ts',
    'apps/api/src/housekeeping.ts',
    'apps/api/src/main.ts',
    'apps/api/src/fixture.ts',
  ])('is refused in %s', async (path) => {
    // A route file has a rule of its own for './' (D6), so there the module is one folder up.
    const inRoutes = path.includes('/routes/');
    for (const code of JOBS.filter((line) => !inRoutes || !line.includes("'./"))) {
      expect(await flagged(path, code, IMPORTS), code).toEqual([expect.stringMatching(REFUSED)]);
    }
  });

  it.each([
    ...JOB_FILES,
    'apps/api/src/jobs.test.ts',
    'apps/api/test/support.ts',
    'tests/integration/fixture.test.ts',
  ])('may be imported in %s', async (path) => {
    for (const code of JOBS) expect(await flagged(path, code, IMPORTS), code).toEqual([]);
  });

  it('keeps the other import rules of the job files: no permit maker, no opener before the organisation', async () => {
    const code = `${JOBS[0] ?? ''} import { changePreOrg, issueWritePermit } from '@tinnox/db';`;
    for (const path of JOB_FILES) {
      expect(await flagged(path, code, IMPORTS), path).toEqual([
        expect.stringMatching(/^'changePreOrg' import from '@tinnox\/db' is restricted/),
        expect.stringMatching(/^'issueWritePermit' import from '@tinnox\/db' is restricted/),
      ]);
    }
  });

  it('lists the two job files, each with its reason and a row of JOB_AUDIT, and no file that left', async () => {
    const list = await exported('JOB_CHANGE_FILES');
    expect(
      Object.keys(list as object),
      'a file that may import the entry of the jobs changes organisations with no role check: it is a job, with a row in JOB_AUDIT (apps/api/src/route-audit.ts) that names its file',
    ).toEqual(JOB_FILES);
    const jobAudit = source('apps/api/src/route-audit.ts');
    const legacy = await legacyFiles();
    for (const [file, reason] of Object.entries(list as object)) {
      expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
        true,
      );
      expect(jobAudit, `${file} has no row in JOB_AUDIT`).toContain(`file: '${file}'`);
      // A job file imports the entry once it has moved to the new API (step 20). Until then it
      // is on the legacy list, and its entry here waits for the move; after it, an entry whose
      // file no longer imports the entry is stale.
      expect(
        /from '(\.\.?\/)+jobs\.ts'/.test(source(file)) || legacy.includes(file),
        `${file} no longer imports apps/api/src/jobs.ts: remove it from JOB_CHANGE_FILES in eslint.config.js`,
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
      // A new route file, two operator route files, and the role guard itself.
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
        expect.stringMatching(/Only what judges the caller of a change issues its WritePermit/),
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

// SCR-34 (adoption plan step 20, review): changePreOrg and changeOrgAsMigrator hold a change to
// an AuditStatement, so who can make one is the rule, as it is for a permit.
describe('the maker of an AuditStatement (SCR-34)', { timeout: 30_000 }, () => {
  const MAKER =
    "import { changePreOrg, issueAuditStatement, type AuditStatement } from '@tinnox/db';";
  const REFUSED =
    /^'issueAuditStatement' import from '@tinnox\/db' is restricted from being used by a pattern\. Only the helpers that read a statement from its table make an AuditStatement \(SCR-34; the files of STATEMENT_ISSUERS in eslint\.config\.js\), so a change is never held to a statement its caller wrote\. A route outside the operator table passes routeStatement\(request\) to changePreOrg, .* a provisioning command passes provisionStatement\(command\) from scripts\/lib\/provision\.ts to changeOrgAsMigrator or changePreOrg\. A new table of statements is decided in its pull request, as a new entry of STATEMENT_ISSUERS\.$/;
  const ISSUERS = ['apps/api/src/route-audit.ts', 'scripts/lib/provision.ts'];

  it.each([
    'apps/api/src/routes/auth.ts',
    'apps/api/src/routes/player.ts',
    'apps/api/src/routes/alert-recipients.ts',
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/auth/permissions.ts',
    'apps/api/src/auth/refusal.ts',
    'apps/api/src/auth/device.ts',
    'apps/api/src/jobs.ts',
    'apps/api/src/alerts.ts',
    'scripts/seed.ts',
    'scripts/provision-member.ts',
    'scripts/lib/fixture.ts',
  ])('is refused in %s, which keeps the type', async (path) => {
    // Only the maker: what else the fixture imports is the business of the other rules.
    const messages = await flagged(path, MAKER, IMPORTS);
    expect(messages.filter((message) => message.includes('issueAuditStatement'))).toEqual([
      expect.stringMatching(REFUSED),
    ]);
  });

  it('is refused under another name and as a re-export', async () => {
    const path = 'apps/api/src/routes/player.ts';
    expect(
      await flagged(path, "import { issueAuditStatement as state } from '@tinnox/db';", IMPORTS),
    ).toEqual([expect.stringMatching(REFUSED)]);
    expect(
      await flagged(path, "export { issueAuditStatement } from '@tinnox/db';", IMPORTS),
    ).toEqual([expect.stringMatching(REFUSED)]);
  });

  it.each([
    ...ISSUERS,
    'apps/api/src/route-audit.test.ts',
    'apps/api/test/fixture.integration.test.ts',
    'tests/integration/fixture.test.ts',
  ])('may be imported in %s', async (path) => {
    const code = "import { issueAuditStatement, type AuditStatement } from '@tinnox/db';";
    expect(await flagged(path, code, IMPORTS)).toEqual([]);
  });

  it('lists the files that read a table of statements, with their reasons, and each still makes one', async () => {
    const list = await exported('STATEMENT_ISSUERS');
    expect(
      Object.keys(list as object),
      'a new maker of statements is a new table that changes are held to: say in the pull request which table it reads, and add the file to this list too',
    ).toEqual(ISSUERS);
    for (const [file, reason] of Object.entries(list as object)) {
      expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
        true,
      );
      expect(
        /\bissueAuditStatement\(/.test(source(file)),
        `${file} no longer makes a statement: remove it from STATEMENT_ISSUERS in eslint.config.js`,
      ).toBe(true);
      expect(
        /export\s*\{[^}]*\bissueAuditStatement\b/.test(source(file)),
        `${file} re-exports the maker of a statement`,
      ).toBe(false);
    }
  });

  const STATEMENT_CAST =
    /^Do not cast to AuditStatement: the type says the statement was read from the table of its route, job or command, .* A route outside the operator table passes routeStatement\(request\), .* and a provisioning command provisionStatement\(command\) \(scripts\/lib\/provision\.ts\)\. A test makes one with issueAuditStatement\(\{ stated, statedIn \}\) from @tinnox\/db\.$/;

  it.each([
    ['a plain cast', "export const statement = { stated, statedIn: 'x' } as AuditStatement;"],
    ['a double cast', 'export const statement = terms as unknown as AuditStatement;'],
    ['an angle-bracket assertion', 'export const statement = <AuditStatement>terms;'],
    ['a union', 'export const statement = terms as AuditStatement | undefined;'],
    ['a qualified name', 'export const statement = terms as db.AuditStatement;'],
  ])('flags a cast to it: %s', async (_name, code) => {
    for (const path of [
      'apps/api/src/routes/auth.ts',
      'apps/api/src/route-audit.ts',
      'scripts/lib/provision.ts',
      'packages/db/src/change.ts',
      'packages/db/src/change.test.ts',
      'tests/integration/fixture.test.ts',
    ]) {
      expect(await flagged(path, code, SYNTAX), path).toEqual([
        expect.stringMatching(STATEMENT_CAST),
      ]);
    }
  });

  it('leaves the type in annotations, and keeps the other brand bans beside it', async () => {
    const annotations = [
      'export function statementOf(request: Request): AuditStatement { return routeStatement(request); }',
      'export let held: AuditStatement | undefined;',
    ].join('\n');
    const both = 'export const s = terms as AuditStatement; export const p = held as WritePermit;';
    for (const path of ['apps/api/src/routes/player.ts', 'packages/db/src/change.test.ts']) {
      expect(await flagged(path, annotations, SYNTAX), path).toEqual([]);
      expect(await flagged(path, both, SYNTAX), path).toEqual([
        expect.stringMatching(STATEMENT_CAST),
        expect.stringMatching(/^Do not cast to WritePermit/),
      ]);
    }
  });
});

describe('casts to WritePermit (SCR-34)', { timeout: 30_000 }, () => {
  const PERMIT_CAST =
    /^Do not cast to WritePermit: the type says the role guard issued the permit, so the role is read again as the first statement of the change \(SCR-34\)\. An operator route calls changeAsOperator\(ctx, request, fn\) \(apps\/api\/src\/auth\/permissions\.ts\), .* a change with no operator behind it calls changeAsDevice \(apps\/api\/src\/auth\/device\.ts\), changeAsJob \(apps\/api\/src\/jobs\.ts\) or changeOrgAsMigrator \(@tinnox\/db\/migrate\), .* A test issues one with issueWritePermit\(\{ recheck, stated, statedIn \}\) from @tinnox\/db\.$/;

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

// SCR-34 (adoption plan step 20): the permit of a player's change is issued to the device the
// credential check returned, so nothing may say by a cast that a value is one.
describe('casts to VerifiedDevice (SCR-34)', { timeout: 30_000 }, () => {
  const DEVICE_CAST =
    /^Do not cast to VerifiedDevice: the type says the device-credential check accepted the credential of this request, and the permit of a player's change is issued to nothing else \(SCR-34\)\. Resolve the credential with verifyDeviceCredential\(unscoped, tokenHash\) from apps\/api\/src\/auth\/device\.ts and pass the device it returns to changeAsDevice\(ctx, request, device, fn\); a test gets one the same way, from a pool that answers the lookup\.$/;

  it.each([
    ['a plain cast', 'export const device = lookup as VerifiedDevice;'],
    ['a double cast', 'export const device = lookup as unknown as VerifiedDevice;'],
    ['an angle-bracket assertion', 'export const device = <VerifiedDevice>lookup;'],
    ['a union', 'export const device = lookup as VerifiedDevice | null;'],
    ['a generic argument', 'export const device = find() as Promise<VerifiedDevice>;'],
    ['a qualified name', 'export const device = lookup as auth.VerifiedDevice;'],
  ])('flags %s', async (_name, code) => {
    for (const path of [
      'apps/api/src/routes/player.ts',
      'apps/api/src/routes/fixture.ts',
      'apps/api/src/auth/device.ts',
      'apps/api/src/auth/device.test.ts',
      'apps/api/test/fixture.integration.test.ts',
      'tests/integration/fixture.test.ts',
    ]) {
      expect(await flagged(path, code, SYNTAX), path).toEqual([expect.stringMatching(DEVICE_CAST)]);
    }
  });

  it('leaves the type in annotations, and keeps the other brand bans beside it', async () => {
    const annotations = [
      'export async function authenticate(request: Request): Promise<VerifiedDevice> { return find(request); }',
      'export let device: VerifiedDevice | null;',
      'export const other = device as DeviceLookup;',
    ].join('\n');
    const both = 'export const d = lookup as VerifiedDevice; export const p = held as WritePermit;';
    for (const path of ['apps/api/src/routes/player.ts', 'apps/api/src/auth/device.test.ts']) {
      expect(await flagged(path, annotations, SYNTAX), path).toEqual([]);
      expect(await flagged(path, both, SYNTAX), path).toEqual([
        expect.stringMatching(DEVICE_CAST),
        expect.stringMatching(/^Do not cast to WritePermit/),
      ]);
    }
  });
});
