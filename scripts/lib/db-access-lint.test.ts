// The database-access lints of eslint.config.js (adoption plan steps 15 and 17), run against
// fixture text: no query off a transaction (AG-2.1), SQL fragments (OTH-12), raw sec.* SQL and
// the unscoped helpers (AG-2.2), the role switch (D25), raw audit inserts (AG-3.1, D25), and the
// entries of @tinnox/db (AG-1.10).
// Each case takes the entry that eslint.config.js resolves for a real path, so the file globs
// and the lists the config exports are tested with the rules: a block that took a rule away from
// a file group would fail here. The fixtures are linted without type information, so the two
// custom rules use their fallback; how they judge by type is in their own RuleTester cases
// (scripts/eslint-rules/no-query-off-transaction.test.ts, sql-fragments.test.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import tinnox from '../eslint-rules/index.ts';
import { repoRoot } from './env.ts';

const QUERY = 'tinnox/no-query-off-transaction';
const AUDIT_INSERT = 'tinnox/no-raw-audit-insert';
const FRAGMENTS = 'tinnox/sql-fragments';
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
  return (result?.messages ?? []).map((message) => message.message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A list or table that eslint.config.js exports. */
async function exported(name: string): Promise<Record<string, unknown>> {
  // A computed specifier keeps the type checker away from the untyped config file.
  const config = pathToFileURL(join(repoRoot, 'eslint.config.js')).href;
  const loaded: unknown = await import(config);
  const value = isRecord(loaded) ? loaded[name] : undefined;
  if (!isRecord(value)) throw new Error(`eslint.config.js exports no ${name}`);
  return value;
}

const source = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

// Product code that can hold a database handle: the API's source and the offline tools.
const DB_CALLERS = [
  'apps/api/src/routes/fixture.ts',
  'apps/api/src/fixture.ts',
  // Files with a list of their own for other rules keep these.
  'apps/api/src/main.ts',
  'apps/api/src/alerts-once.ts',
  'apps/api/src/config.ts',
  'apps/api/src/mail.ts',
  'apps/api/src/auth/oidc.ts',
  'apps/api/src/media/pipeline.ts',
  // D25: scripts with no exception.
  'scripts/seed.ts',
  'scripts/migrate.ts',
  'scripts/provision-member.ts',
  'scripts/lib/provision.ts',
  'scripts/lib/fixture.ts',
  'scripts/fixture.ts',
] as const;
// Tests arrange data on clients of their own and call sec.* raw to test it.
const TESTS = [
  'apps/api/src/fixture.test.ts',
  'apps/api/test/support.ts',
  'apps/api/test/fixture.integration.test.ts',
  'packages/db/src/fixture.test.ts',
  'packages/db/test/support.ts',
  'tests/integration/fixture.test.ts',
  'tests/e2e/support/database.ts',
  'scripts/lib/fixture.test.ts',
  'scripts/vitest-integration-setup.ts',
] as const;

const OFF_TRANSACTION =
  /^Do not call query\(\) on .+: only a transaction handle with an organisation takes a statement \(the tx that the callback of readOrg or changeOrg receives, or that enterOrg returns inside changePreOrg; withOrg and withResolvedOrg give the same in a file of LEGACY_TRANSACTION_FILES\)\. .* Use readOrg\(pool, orgId, \(tx\) => tx\.query\(\.\.\.\)\) for a read, changeAsOperator\(ctx, request, fn\) from apps\/api\/src\/auth\/permissions\.ts for an operator change, a typed sec\.\* wrapper from @tinnox\/db .*, or ping\(pool\) for a liveness probe\. An offline tool that reads across organisations sends the statement on the handle asDefiner gives its work \(@tinnox\/db\/migrate\)\.$/;

// The first case of each describe may be the one that loads eslint.config.js, which a busy CI
// runner can stretch towards the unit project's 5 s default (GAP-1).
describe('query() off a transaction (AG-2.1)', { timeout: 30_000 }, () => {
  const CODE = `
    await pool.query('SELECT 1');
    await withOrg(pool, orgId, (tx) => tx.query('SELECT 1'));
  `;

  it.each(DB_CALLERS)('is reported in %s', async (path) => {
    expect(await flagged(path, CODE, QUERY)).toEqual([expect.stringMatching(OFF_TRANSACTION)]);
  });

  it.each([
    ...TESTS,
    // packages/db is where the handles are made, and the browser apps have no database:
    // `.query()` there is something else (a locator, a permission).
    'packages/db/src/pool.ts',
    'packages/db/src/migrate.ts',
    'apps/portal/src/fixture.tsx',
    'apps/player-web/src/app.ts',
    'apps/media-worker/src/main.ts',
  ])('is off in %s', async (path) => {
    expect(isOff(await entryFor(path, QUERY))).toBe(true);
  });

  const SESSION_LOCK = 'session lock; removed by `withSessionLock` in step 22';

  it('lists the two session-lock statements of the alert check, with the reason, and nothing else', async () => {
    expect(await exported('QUERY_OFF_TRANSACTION')).toEqual({
      'apps/api/src/alerts.ts': [
        {
          sql: '^SELECT pg_try_advisory_lock\\(hashtextextended\\(\\$1, 0\\)\\) AS ok$',
          reason: SESSION_LOCK,
        },
        {
          sql: '^SELECT pg_advisory_unlock\\(hashtextextended\\(\\$1, 0\\)\\) AS ok$',
          reason: SESSION_LOCK,
        },
      ],
    });
  });

  it('keeps no entry whose statement its file no longer sends', async () => {
    for (const [file, entries] of Object.entries(await exported('QUERY_OFF_TRANSACTION'))) {
      // Every single-quoted string of the file; the statements are among them.
      const strings = [...source(file).matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1] ?? '');
      for (const entry of allowedStatements(entries)) {
        expect(
          strings.some((text) => new RegExp(entry.sql).test(text)),
          `${file} no longer sends a statement that matches ${entry.sql}: remove the entry from QUERY_OFF_TRANSACTION in eslint.config.js`,
        ).toBe(true);
      }
    }
  });

  it('lets the alert check send those two statements on its lock connection, and nothing else', async () => {
    const path = 'apps/api/src/alerts.ts';
    const allowed = `
      await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [KEY]);
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok', [KEY]);
    `;
    expect(await flagged(path, allowed, QUERY)).toEqual([]);
    const other = `
      await client.query('SELECT id FROM display');
      await deps.pool.query('SELECT 1');
      await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok; DELETE FROM display');
    `;
    expect(await flagged(path, other, QUERY)).toEqual([
      expect.stringMatching(OFF_TRANSACTION),
      expect.stringMatching(OFF_TRANSACTION),
      expect.stringMatching(OFF_TRANSACTION),
    ]);
    // The entries belong to that file only.
    expect(await flagged('apps/api/src/housekeeping.ts', allowed, QUERY)).toHaveLength(2);
    expect(await flagged('scripts/lib/provision.ts', allowed, QUERY)).toHaveLength(2);
  });
});

/** The entries of one file of QUERY_OFF_TRANSACTION or RAW_AUDIT_INSERTS. */
function allowedStatements(value: unknown): { sql: string; reason: string }[] {
  if (!Array.isArray(value)) throw new Error('an entry of QUERY_OFF_TRANSACTION is no list');
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry['sql'] !== 'string' ||
      typeof entry['reason'] !== 'string'
    ) {
      throw new Error('an entry of QUERY_OFF_TRANSACTION needs sql and reason');
    }
    return { sql: entry['sql'], reason: entry['reason'] };
  });
}

describe('SQL fragments (OTH-12)', { timeout: 30_000 }, () => {
  const INTERPOLATION =
    /^SQL text may interpolate only an UPPER_CASE module constant or a SqlFragment, and `name` is neither\. Pass a value as a parameter \(\$1, \$2; see OrgTx in packages\/db\/src\/tx\.ts\)\. .* make a SqlFragment with sql`\.\.\.`, sqlParameter\(position\) or joinSql\(parts, separator\) from @tinnox\/db/;
  const STATEMENT =
    /^The statement given to query\(\) must be text from the source: .*`(text|sql)` is none of these\. Write the statement at the call and pass values as parameters/;
  const CODE = `
    const COLUMNS = 'id, name';
    await tx.query(\`SELECT \${COLUMNS} FROM folder WHERE id = $1\`, [id]);
    await tx.query(\`SELECT \${COLUMNS} FROM folder WHERE name = '\${name}'\`);
  `;

  it.each([
    ...DB_CALLERS,
    // packages/db holds the sec.* wrappers and the runner.
    'packages/db/src/fixture.ts',
    'packages/db/src/sec.ts',
    'packages/db/src/schema-invariants.ts',
    'packages/db/src/tx.ts',
    'packages/db/src/migrate.ts',
  ])('is reported in %s', async (path) => {
    expect(await flagged(path, CODE, FRAGMENTS)).toEqual([expect.stringMatching(INTERPOLATION)]);
  });

  it.each(TESTS)('is off in %s', async (path) => {
    expect(isOff(await entryFor(path, FRAGMENTS))).toBe(true);
  });

  it('names the three files of packages/db that pass a statement on, and the name it has there', async () => {
    expect(await exported('SQL_PASS_THROUGH')).toEqual({
      'packages/db/src/tx.ts': ['text'],
      'packages/db/src/migrate.ts': ['sql'],
      // Step 18: the handle asDefiner gives its work sends what the offline tool wrote.
      'packages/db/src/definer.ts': ['text'],
    });
  });

  it('lets each of them pass on that name only, and no other file any', async () => {
    const forwards = 'await client.query(text); await client.query(sql);';
    expect(await flagged('packages/db/src/tx.ts', forwards, FRAGMENTS)).toEqual([
      expect.stringMatching(/`sql` is none of these/),
    ]);
    expect(await flagged('packages/db/src/migrate.ts', forwards, FRAGMENTS)).toEqual([
      expect.stringMatching(/`text` is none of these/),
    ]);
    expect(await flagged('packages/db/src/definer.ts', forwards, FRAGMENTS)).toEqual([
      expect.stringMatching(/`sql` is none of these/),
    ]);
    for (const path of [
      'packages/db/src/sec.ts',
      'apps/api/src/publishing.ts',
      'scripts/seed.ts',
    ]) {
      expect(await flagged(path, forwards, FRAGMENTS)).toEqual([
        expect.stringMatching(STATEMENT),
        expect.stringMatching(STATEMENT),
      ]);
    }
  });

  it('keeps no pass-through name its file no longer hands to query()', async () => {
    for (const [file, names] of Object.entries(await exported('SQL_PASS_THROUGH'))) {
      for (const name of Array.isArray(names) ? names : []) {
        expect(
          new RegExp(`\\.query(<[^(]*>)?\\(${String(name)}[,)]`).test(source(file)),
          `${file} no longer calls query(${String(name)}): remove the name from SQL_PASS_THROUGH in eslint.config.js`,
        ).toBe(true);
      }
    }
  });
});

// Every file group that has a no-restricted-syntax list of its own and is not a test.
const PRODUCT_AND_SCRIPTS = [
  'apps/api/src/routes/fixture.ts',
  'apps/api/src/main.ts',
  'apps/api/src/alerts-once.ts',
  'apps/api/src/config.ts',
  'apps/api/src/mail.ts',
  'apps/api/src/auth/oidc.ts',
  'apps/media-worker/src/fixture.ts',
  'packages/db/src/pool.ts',
  'packages/delivery/src/fixture.ts',
  'packages/storage/src/fixture.ts',
  'scripts/seed.ts',
  'scripts/migrate.ts',
  'scripts/provision-member.ts',
  'scripts/lib/provision.ts',
  'scripts/lib/fixture.ts',
  'scripts/fixture.mjs',
  'scripts/setup-dev.mjs',
] as const;
// The files of packages/db that are the one place for something: each is excused from one list
// and must keep the others.
const ONE_PLACES = [
  'packages/db/src/sec.ts',
  'packages/db/src/definer.ts',
  'packages/db/src/sql.ts',
  'packages/db/src/migrate.ts',
] as const;

describe('raw sec.* SQL (AG-2.2)', { timeout: 30_000 }, () => {
  const RAW_SEC =
    /^Call sec\.\* through a typed wrapper in packages\/db\/src\/sec\.ts \(exported from @tinnox\/db\); add the wrapper if it is missing\./;

  it.each([
    ['a string', "export const q = 'SELECT org_id FROM sec.display_alert_orgs()';"],
    ['a template', 'export const q = `SELECT media_id FROM sec.media_processing_jobs($1)`;'],
    ['a template after an interpolation', 'export const q = `SELECT ${COLUMNS} FROM sec.x ($1)`;'],
    ['a call without FROM', "export const q = 'SELECT sec.session_purge_expired() AS n';"],
  ])('flags %s', async (_name, code) => {
    expect(await flagged('apps/api/src/routes/fixture.ts', code, SYNTAX)).toEqual([
      expect.stringMatching(RAW_SEC),
    ]);
  });

  it.each([...PRODUCT_AND_SCRIPTS, ...ONE_PLACES.filter((path) => !path.endsWith('/sec.ts'))])(
    'flags it in %s',
    async (path) => {
      const code = "export const q = 'SELECT 1 FROM sec.device_by_registration_id($1)';";
      expect(await flagged(path, code, SYNTAX)).toEqual([expect.stringMatching(RAW_SEC)]);
    },
  );

  it('leaves alone a sentence that names a function, and a comment', async () => {
    const code = [
      "export const m = 'sec.session_create did not return exactly one row';",
      '// SELECT 1 FROM sec.session_revoke($1)',
      'export const n = secrets.read(1);',
    ].join('\n');
    expect(await flagged('apps/api/src/routes/fixture.ts', code, SYNTAX)).toEqual([]);
  });

  it.each(TESTS)('leaves the test file %s alone', async (path) => {
    const code = "export const q = 'SELECT sec.session_revoke_membership($1)';";
    expect(await flagged(path, code, SYNTAX)).toEqual([]);
  });

  it('lets packages/db/src/sec.ts write the wrappers, and keeps that file the rest of its list', async () => {
    const path = 'packages/db/src/sec.ts';
    expect(
      await flagged(path, "export const q = 'SELECT 1 FROM sec.session_revoke($1)';", SYNTAX),
    ).toEqual([]);
    const rest = "export const v = a!; export const r = 'SET LOCAL ROLE tinnox_definer';";
    expect(await flagged(path, rest, SYNTAX)).toEqual([
      expect.stringMatching(/^Do not assert a value is not null/),
      expect.stringMatching(/^Do not switch the database role here/),
    ]);
  });
});

describe('the role switch (D25)', { timeout: 30_000 }, () => {
  const ROLE_SWITCH =
    /^Do not switch the database role here \(D25\): the only SET ROLE text is in asDefiner \(packages\/db\/src\/definer\.ts, exported from @tinnox\/db\/migrate\)\. An offline tool that holds a MigratorPool calls asDefiner\(pool, tx, work\)/;

  it.each([
    "'SET LOCAL ROLE tinnox_definer'",
    "'SET ROLE tinnox_definer'",
    "'set session role tinnox_definer'",
    "'  SET  LOCAL  ROLE tinnox_definer'",
    "'RESET ROLE'",
    "'BEGIN; SET LOCAL ROLE tinnox_definer'",
    "'SET SESSION AUTHORIZATION postgres'",
    "'RESET SESSION AUTHORIZATION'",
    '"SELECT set_config(\'role\', $1, true)"',
    '`SET LOCAL ROLE ${ROLE}`',
    '`SET LOCAL ROLE tinnox_definer`',
    '`SELECT 1 FROM ${TABLE}; SET LOCAL ROLE tinnox_definer`',
  ])('flags %s', async (text) => {
    const code = `export const q = ${text};`;
    expect(await flagged('scripts/lib/fixture.ts', code, SYNTAX)).toEqual([
      expect.stringMatching(ROLE_SWITCH),
    ]);
  });

  it('leaves alone a column called role, and a sentence that mentions the statement', async () => {
    const code = [
      "export const a = 'UPDATE membership SET role = $2 WHERE id = $1';",
      'export const b = `UPDATE membership\n           SET role = $2, display_name = $3 WHERE id = $1`;',
      "export const c = 'switches role without LOCAL. Use `SET LOCAL ROLE tinnox_definer;` so the switch ends, and close it with `RESET ROLE;`.';",
      'export const d = `between SET LOCAL ROLE ${DEFINER_ROLE} and RESET ROLE, as ${EXAMPLE} does`;',
      'export const f = `UPDATE ${TABLE} SET role = $2 WHERE id = $1`;',
      'export const e = /^SET LOCAL ROLE\\b/;',
      '// SET LOCAL ROLE tinnox_definer',
    ].join('\n');
    expect(await flagged('scripts/lib/fixture.ts', code, SYNTAX)).toEqual([]);
  });

  it.each([...PRODUCT_AND_SCRIPTS, ...ONE_PLACES.filter((path) => !path.endsWith('/definer.ts'))])(
    'flags it in %s',
    async (path) => {
      const code = "export const q = 'SET LOCAL ROLE tinnox_definer';";
      expect(await flagged(path, code, SYNTAX)).toEqual([expect.stringMatching(ROLE_SWITCH)]);
    },
  );

  it.each(TESTS)('leaves the test file %s alone', async (path) => {
    const code = "await migrator.query('SET LOCAL ROLE tinnox_definer');";
    expect(await flagged(path, code, SYNTAX)).toEqual([]);
  });

  it('lets packages/db/src/definer.ts switch, and keeps that file the rest of its list', async () => {
    const path = 'packages/db/src/definer.ts';
    const code = "await tx.query('SET LOCAL ROLE tinnox_definer'); await tx.query('RESET ROLE');";
    expect(await flagged(path, code, SYNTAX)).toEqual([]);
    const rest =
      "export const v = a!; export const q = 'SELECT 1 FROM sec.session_revoke($1)'; export const p = pool as MigratorPool;";
    expect(await flagged(path, rest, SYNTAX)).toEqual([
      expect.stringMatching(/^Do not assert a value is not null/),
      expect.stringMatching(/^Call sec\.\* through a typed wrapper/),
      expect.stringMatching(/^Do not cast to MigratorPool/),
    ]);
  });
});

describe('raw audit inserts (AG-3.1, D25)', { timeout: 30_000 }, () => {
  const RAW_INSERT =
    /^Do not write an audit row with a statement of your own: use auditScoped\(tx, event\), or auditUnscoped\(tx, event\) when no organisation is known yet \(both from @tinnox\/db\), on the tx of the change it records\./;
  const CODE = `
    await tx.query("INSERT INTO audit_event (org_id, action) VALUES (app_org_id(), 'x.y')");
    await auditScoped(tx, event);
  `;
  const PROVISION = 'scripts/lib/provision.ts';

  it.each([
    ...DB_CALLERS,
    // packages/db outside the one file that holds the writers.
    'packages/db/src/pool.ts',
    'packages/db/src/migrate.ts',
    'packages/db/src/definer.ts',
    'packages/db/src/audit-debt-guard.ts',
  ])('are reported in %s', async (path) => {
    expect(await flagged(path, CODE, AUDIT_INSERT)).toEqual([expect.stringMatching(RAW_INSERT)]);
  });

  it.each(['apps/api/src/routes/media.ts', 'scripts/lib/provision.ts'])(
    'are reported in %s with the table or schema quoted, and with the schema interpolated',
    async (path) => {
      const spellings = `
        await tx.query('INSERT INTO "audit_event" (action) VALUES ($1)', [action]);
        await tx.query('INSERT INTO public."audit_event" (action) VALUES ($1)', [action]);
        await tx.query(\`INSERT INTO \${SCHEMA}.audit_event (action) VALUES ($1)\`, [action]);
      `;
      expect(await flagged(path, spellings, AUDIT_INSERT)).toEqual([
        expect.stringMatching(RAW_INSERT),
        expect.stringMatching(RAW_INSERT),
        expect.stringMatching(RAW_INSERT),
      ]);
    },
  );

  it.each([
    ...TESTS,
    // The audit writers themselves.
    'packages/db/src/sec.ts',
    // No database handle exists in these.
    'apps/portal/src/fixture.tsx',
    'apps/player-web/src/app.ts',
    'apps/media-worker/src/main.ts',
  ])('are off in %s', async (path) => {
    expect(isOff(await entryFor(path, AUDIT_INSERT))).toBe(true);
  });

  /** The one entry of RAW_AUDIT_INSERTS. */
  async function onlyEntry(): Promise<{ sql: string; reason: string }> {
    const table = await exported('RAW_AUDIT_INSERTS');
    expect(Object.keys(table)).toEqual([PROVISION]);
    const entries = allowedStatements(table[PROVISION]);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined) throw new Error('RAW_AUDIT_INSERTS has no entry');
    return entry;
  }

  /** Every template of the file `text` with nothing interpolated. */
  function plainTemplates(text: string): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true));
    return found;
  }

  it('has one entry: the set-based expiry of provisioning, with its reason (D25)', async () => {
    const entry = await onlyEntry();
    expect(entry.reason).toMatch(
      /^provisioning's `pending`: one statement as tinnox_definer expires/,
    );
    expect(entry.reason).toContain('D25');
    // Anchored at both ends: the entry names one whole statement, not a file.
    expect(entry.sql.startsWith('^')).toBe(true);
    expect(entry.sql.endsWith('$')).toBe(true);
  });

  it('keeps no entry whose statement the file no longer holds', async () => {
    const entry = await onlyEntry();
    expect(
      plainTemplates(source(PROVISION)).filter((text) => new RegExp(entry.sql).test(text)),
      `${PROVISION} no longer holds the statement RAW_AUDIT_INSERTS names: remove the entry from eslint.config.js`,
    ).toHaveLength(1);
  });

  it('lets provisioning keep that one statement, and nothing else', async () => {
    const entry = await onlyEntry();
    const [statement] = plainTemplates(source(PROVISION)).filter((text) =>
      new RegExp(entry.sql).test(text),
    );
    if (statement === undefined) throw new Error('the expiry statement was not found');
    const expiry = `await tx.query(\`${statement}\`, [args.executedBy]);`;
    expect(await flagged(PROVISION, expiry, AUDIT_INSERT)).toEqual([]);
    const others = [
      // Another audit row written by hand in the same file.
      `await tx.query("INSERT INTO public.audit_event (action) VALUES ('membership.create')");`,
      // The same statement with another action, and with something after it.
      `await tx.query(\`${statement.replace("'invite.cancel'", "'invite.create'")}\`);`,
      `await tx.query(\`${statement}; DELETE FROM public.member_invite\`);`,
    ].join('\n');
    expect(await flagged(PROVISION, others, AUDIT_INSERT)).toEqual([
      expect.stringMatching(RAW_INSERT),
      expect.stringMatching(RAW_INSERT),
      expect.stringMatching(RAW_INSERT),
    ]);
    // The entry belongs to that file only.
    for (const path of ['scripts/seed.ts', 'apps/api/src/alerts.ts', 'packages/db/src/pool.ts']) {
      expect(await flagged(path, expiry, AUDIT_INSERT)).toEqual([
        expect.stringMatching(RAW_INSERT),
      ]);
    }
  });
});

describe('casts to SqlFragment (OTH-12)', { timeout: 30_000 }, () => {
  const FRAGMENT_CAST =
    /^Do not cast to SqlFragment: .* Make one with sql`\.\.\.`, sqlParameter\(position\) or joinSql\(parts, separator\) from @tinnox\/db/;

  it.each([
    ['a plain cast', 'export const f = text as SqlFragment;'],
    ['a double cast', 'export const f = text as unknown as SqlFragment;'],
    ['an angle-bracket assertion', 'export const f = <SqlFragment>text;'],
    ['a list', 'export const f = parts as SqlFragment[];'],
    ['a qualified name', 'export const f = text as db.SqlFragment;'],
  ])('flags %s', async (_name, code) => {
    expect(await flagged('apps/api/src/routes/fixture.ts', code, SYNTAX)).toEqual([
      expect.stringMatching(FRAGMENT_CAST),
    ]);
  });

  it.each([
    ...PRODUCT_AND_SCRIPTS.filter((path) => path.endsWith('.ts')),
    ...ONE_PLACES.filter((path) => !path.endsWith('/sql.ts')),
    // Tests too, as for Tx and MigratorPool: nothing needs to make one by a cast.
    ...TESTS,
    'apps/portal/src/fixture.tsx',
  ])('flags it in %s', async (path) => {
    expect(await flagged(path, 'export const f = text as SqlFragment;', SYNTAX)).toEqual([
      expect.stringMatching(FRAGMENT_CAST),
    ]);
  });

  it('lets packages/db/src/sql.ts make it, and keeps that file the rest of its list', async () => {
    const path = 'packages/db/src/sql.ts';
    expect(await flagged(path, 'export const f = text as SqlFragment;', SYNTAX)).toEqual([]);
    const rest = "export const v = a!; export const r = 'RESET ROLE'; export const t = h as Tx;";
    expect(await flagged(path, rest, SYNTAX)).toEqual([
      expect.stringMatching(/^Do not assert a value is not null/),
      expect.stringMatching(/^Do not switch the database role here/),
      expect.stringMatching(/^Do not cast to a transaction handle/),
    ]);
  });
});

describe('the unscoped helpers (AG-2.2)', { timeout: 30_000 }, () => {
  const unscoped = (name: string): RegExp =>
    new RegExp(
      `^'${name}' import from '@tinnox/db' is restricted from being used by a pattern\\. withoutOrg and poolAsTx run without an organisation \\(AG-2\\.2\\)\\. Use readOrg\\(pool, orgId, fn\\) for a read, or changeAsOperator\\(ctx, request, fn\\) from apps/api/src/auth/permissions\\.ts for an operator change .*; withOrg\\(pool, session\\.orgId, fn\\) is left to the files of LEGACY_TRANSACTION_FILES\\. .* add this file to UNSCOPED_HELPER_FILES in eslint\\.config\\.js with its reason, and say why in the pull request\\.$`,
    );
  const BOTH = "import { poolAsTx, withOrg, withoutOrg, type Pool } from '@tinnox/db';";
  const ALLOW_LIST = [
    'apps/api/src/alerts.ts',
    'apps/api/src/auth/session.ts',
    'apps/api/src/housekeeping.ts',
    'apps/api/src/media/pipeline.ts',
    'apps/api/src/routes/auth.ts',
    'apps/api/src/routes/player.ts',
    'scripts/lib/provision.ts',
  ];

  it.each([
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/routes/displays.ts',
    'apps/api/src/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/alerts-once.ts',
    'apps/api/src/mail.ts',
    'apps/api/src/auth/oidc.ts',
    'apps/api/scripts/fixture.mjs',
    'scripts/seed.ts',
    'scripts/provision-member.ts',
    'scripts/lib/fixture.ts',
    'scripts/fixture.mjs',
  ])('are refused in %s', async (path) => {
    expect(await flagged(path, BOTH, IMPORTS)).toEqual([
      expect.stringMatching(unscoped('poolAsTx')),
      expect.stringMatching(unscoped('withoutOrg')),
    ]);
  });

  it('are refused under another name, as a re-export and as a namespace', async () => {
    const path = 'apps/api/src/routes/fixture.ts';
    expect(
      await flagged(path, "import { withoutOrg as open } from '@tinnox/db';", IMPORTS),
    ).toEqual([expect.stringMatching(unscoped('withoutOrg'))]);
    expect(await flagged(path, "export { poolAsTx } from '@tinnox/db';", IMPORTS)).toEqual([
      expect.stringMatching(unscoped('poolAsTx')),
    ]);
    expect(await flagged(path, "import * as db from '@tinnox/db';", IMPORTS)).toEqual([
      expect.stringMatching(
        /^\* import is invalid because 'withoutOrg' and 'poolAsTx' from '@tinnox\/db' are restricted from being used by a pattern\. withoutOrg and poolAsTx run without an organisation/,
      ),
      // A namespace also carries the maker of a WritePermit, which only the role guard imports
      // (step 19; scripts/lib/legacy-transaction-lint.test.ts).
      expect.stringMatching(
        /^\* import is invalid because 'issueWritePermit' and 'legacyAudit' from '@tinnox\/db' are restricted from being used by a pattern\. Only what judges the caller of a change issues its WritePermit \(SCR-34; the files of WRITE_PERMIT_ISSUERS in eslint\.config\.js\)/,
      ),
      // ...the maker of an audit statement, which only the files that read the tables import
      // (step 20 review; the same file)...
      expect.stringMatching(
        /^\* import is invalid because 'issueAuditStatement' from '@tinnox\/db' is restricted from being used by a pattern\. Only the helpers that read a statement from its table make an AuditStatement \(SCR-34; the files of STATEMENT_ISSUERS in eslint\.config\.js\)/,
      ),
      // ...and the openers that enter an organisation with no permit, which only the files
      // whose transactions start before the organisation is known import (the same file).
      expect.stringMatching(
        /^\* import is invalid because 'changePreOrg' and 'withResolvedOrg' from '@tinnox\/db' are restricted from being used by a pattern\. changePreOrg and withResolvedOrg are for a transaction that starts before the organisation is known/,
      ),
    ]);
  });

  it('leaves the scoped openers and the rest of the entry alone', async () => {
    // withResolvedOrg is held to PRE_ORG_CHANGE_FILES (scripts/lib/legacy-transaction-lint.test.ts).
    const code = "import { auditScoped, changeOrg, readOrg, withOrg, type Tx } from '@tinnox/db';";
    expect(await flagged('apps/api/src/routes/fixture.ts', code, IMPORTS)).toEqual([]);
  });

  it.each([...ALLOW_LIST, ...TESTS.filter((path) => !path.startsWith('packages/'))])(
    'may be imported in %s',
    async (path) => {
      expect(await flagged(path, BOTH, IMPORTS)).toEqual([]);
    },
  );

  it('lists seven files, each with its reason', async () => {
    const list = await exported('UNSCOPED_HELPER_FILES');
    expect(Object.keys(list).sort()).toEqual(ALLOW_LIST);
    for (const [file, reason] of Object.entries(list)) {
      expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
        true,
      );
    }
    // AG-2.2: three of the seven are not "before the organisation is known", and say so.
    const acrossAll = Object.entries(list)
      .filter(([, reason]) => String(reason).startsWith('not before the organisation is known'))
      .map(([file]) => file);
    expect(acrossAll.sort()).toEqual([
      'apps/api/src/alerts.ts',
      'apps/api/src/housekeeping.ts',
      'apps/api/src/media/pipeline.ts',
    ]);
  });

  it('keeps no file that no longer imports one of them', async () => {
    for (const file of Object.keys(await exported('UNSCOPED_HELPER_FILES'))) {
      expect(existsSync(join(repoRoot, file)), `${file} is gone`).toBe(true);
      const imports = /import\s*\{([^}]*)\}\s*from\s*'@tinnox\/db';/.exec(source(file))?.[1] ?? '';
      expect(
        /\b(withoutOrg|poolAsTx)\b/.test(imports),
        `${file} no longer imports withoutOrg or poolAsTx: remove it from UNSCOPED_HELPER_FILES in eslint.config.js`,
      ).toBe(true);
    }
  });
});

// D25 (adoption plan step 18): newOrgId turns any string into an OrgId, for an organisation that
// is being created. Two offline tools create one; every other script is refused the name.
describe('newOrgId (D25)', { timeout: 30_000 }, () => {
  const NEW_ORG_ID =
    /newOrgId names an organisation that is being created: only org-create in scripts\/lib\/provision\.ts and the seed call it \(D25\)\. For an organisation that exists, read the org_id of its member or invite inside asDefiner\(pool, tx, \(definer\) => definer\.query\(\.\.\.\)\) from @tinnox\/db\/migrate.* is added to NEW_ORG_ID_FILES in eslint\.config\.js with its reason\.$/;
  const CODE = "import { asDefiner, connectMigrator, newOrgId } from '@tinnox/db/migrate';";
  const MAKERS = ['scripts/lib/provision.ts', 'scripts/seed.ts'];

  it.each([
    'scripts/provision-member.ts',
    'scripts/migrate.ts',
    'scripts/audit.ts',
    'scripts/lib/idp.ts',
    'scripts/lib/fixture.ts',
    'scripts/fixture.ts',
    'scripts/fixture.mjs',
  ])('is refused in %s, which keeps the rest of the entry', async (path) => {
    const messages = await flagged(path, CODE, IMPORTS);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^'newOrgId' import from '@tinnox\/db\/migrate' is restricted/);
    expect(messages[0]).toMatch(NEW_ORG_ID);
  });

  it('is refused under another name, as a re-export and as a namespace', async () => {
    const path = 'scripts/lib/fixture.ts';
    for (const code of [
      "import { newOrgId as org } from '@tinnox/db/migrate';",
      "export { newOrgId } from '@tinnox/db/migrate';",
      "import * as migrate from '@tinnox/db/migrate';",
    ]) {
      expect(await flagged(path, code, IMPORTS), code).toEqual([expect.stringMatching(NEW_ORG_ID)]);
    }
  });

  it.each([...MAKERS, 'tests/integration/fixture.test.ts', 'scripts/lib/fixture.test.ts'])(
    'may be imported in %s',
    async (path) => {
      expect(await flagged(path, CODE, IMPORTS)).toEqual([]);
    },
  );

  it('keeps the other import rules of the two tools: the seed still gets no unscoped helper', async () => {
    const code = `${CODE} import { poolAsTx, withOrg } from '@tinnox/db'; import pg from 'pg';`;
    expect(await flagged('scripts/seed.ts', code, IMPORTS)).toEqual([
      expect.stringMatching(/withoutOrg and poolAsTx run without an organisation/),
      expect.stringMatching(/^'pg' import is restricted/),
    ]);
    expect(await flagged('scripts/lib/provision.ts', code, IMPORTS)).toEqual([
      expect.stringMatching(/^'pg' import is restricted/),
    ]);
  });

  it('the API cannot import the entry it comes from at all', async () => {
    const messages = await flagged('apps/api/src/routes/fixture.ts', CODE, IMPORTS);
    expect(messages).toEqual([
      expect.stringMatching(
        /^'@tinnox\/db\/migrate' import is restricted .* for the offline tools/,
      ),
    ]);
  });

  it('lists two files, each with its reason, and none that no longer imports it', async () => {
    const list = await exported('NEW_ORG_ID_FILES');
    expect(Object.keys(list).sort()).toEqual(MAKERS);
    for (const [file, reason] of Object.entries(list)) {
      expect(typeof reason === 'string' && reason.length >= 60, `${file} needs its reason`).toBe(
        true,
      );
      const imports =
        /import\s*\{([^}]*)\}\s*from\s*'@tinnox\/db\/migrate';/.exec(source(file))?.[1] ?? '';
      expect(
        /\bnewOrgId\b/.test(imports),
        `${file} no longer imports newOrgId: remove it from NEW_ORG_ID_FILES in eslint.config.js`,
      ).toBe(true);
    }
  });
});

describe('the entries of @tinnox/db (AG-1.10)', { timeout: 30_000 }, () => {
  const MIGRATE =
    /^'@tinnox\/db\/migrate' import is restricted from being used by a pattern\. @tinnox\/db\/migrate is for the offline tools that connect as tinnox_migrator: .* The API holds only the tinnox_app connection: use createPool, readOrg, changeOrg \(through changeAsOperator in apps\/api\/src\/auth\/permissions\.ts\) and the typed sec\.\* wrappers from @tinnox\/db\./;
  const TESTING =
    /^'@tinnox\/db\/testing' import is restricted from being used by a pattern\. @tinnox\/db\/testing is for test files only\. Outside a test, open the transaction with readOrg or changeOrg from @tinnox\/db \(an operator route calls changeAsOperator\(ctx, request, fn\) from apps\/api\/src\/auth\/permissions\.ts\), or with changePreOrg while a credential is still being resolved to its organisation \(the files of PRE_ORG_CHANGE_FILES in eslint\.config\.js\)\./;
  const importOf = (specifier: string) => `import { x } from '${specifier}';`;

  it('has one row in DB_ENTRIES for every entry of packages/db/package.json beside the root', async () => {
    const manifest: unknown = JSON.parse(source('packages/db/package.json'));
    const exports = isRecord(manifest) && isRecord(manifest['exports']) ? manifest['exports'] : {};
    expect(Object.keys(exports).sort()).toEqual(['.', './migrate', './testing']);
    expect(Object.keys(await exported('DB_ENTRIES')).sort()).toEqual(
      Object.keys(exports)
        .filter((entry) => entry !== '.')
        .map((entry) => entry.slice('./'.length))
        .sort(),
    );
    for (const target of Object.values(exports)) {
      expect(existsSync(join(repoRoot, 'packages/db', String(target)))).toBe(true);
    }
  });

  it.each([
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/alerts-once.ts',
    'apps/api/src/config.ts',
    'apps/api/src/mail.ts',
    'apps/api/src/alerts.ts',
    'apps/api/src/media/pipeline.ts',
    'apps/api/scripts/fixture.mjs',
  ])('refuses the migrator entry in the API file %s', async (path) => {
    expect(await flagged(path, importOf('@tinnox/db/migrate'), IMPORTS)).toEqual([
      expect.stringMatching(MIGRATE),
    ]);
  });

  it.each([
    'scripts/seed.ts',
    'scripts/migrate.ts',
    'scripts/lib/provision.ts',
    'scripts/lib/migrations-check.ts',
    'scripts/vitest-integration-setup.ts',
    'apps/api/test/global-setup.ts',
    'apps/api/src/fixture.test.ts',
    'tests/integration/fixture.test.ts',
    'tests/e2e/support/database.ts',
  ])('lets the offline tool or test %s import the migrator entry', async (path) => {
    expect(await flagged(path, importOf('@tinnox/db/migrate'), IMPORTS)).toEqual([]);
  });

  it.each([
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/mail.ts',
    'apps/api/src/alerts.ts',
    'scripts/seed.ts',
    'scripts/lib/provision.ts',
    'scripts/lib/fixture.ts',
    'scripts/fixture.mjs',
  ])('refuses the testing entry in %s, which is not a test', async (path) => {
    expect(await flagged(path, importOf('@tinnox/db/testing'), IMPORTS)).toEqual([
      expect.stringMatching(TESTING),
    ]);
  });

  it.each([
    'apps/api/src/fixture.test.ts',
    'apps/api/test/support.ts',
    'tests/integration/fixture.test.ts',
    'tests/e2e/support/database.ts',
    'scripts/lib/fixture.test.ts',
    'scripts/vitest-integration-setup.ts',
    'scripts/vitest-integration-file-setup.ts',
  ])('lets the test file %s import the testing entry', async (path) => {
    expect(await flagged(path, importOf('@tinnox/db/testing'), IMPORTS)).toEqual([]);
  });

  it('gives a workspace that may not import @tinnox/db its layer message, once', async () => {
    for (const entry of ['@tinnox/db/migrate', '@tinnox/db/testing']) {
      expect(await flagged('apps/portal/src/fixture.tsx', importOf(entry), IMPORTS)).toEqual([
        expect.stringMatching(/apps\/portal may import only @tinnox\/contracts/),
      ]);
      expect(await flagged('packages/delivery/src/fixture.ts', importOf(entry), IMPORTS)).toEqual([
        expect.stringMatching(/packages\/delivery may import only @tinnox\/contracts/),
      ]);
    }
  });
});
