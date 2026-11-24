/**
 * The three entries of the package (AG-1.10, adoption plan step 15): the runtime API at the root,
 * what only an offline tool as tinnox_migrator may use at `/migrate`, and what only tests may use
 * at `/testing`. Lint keeps the last two out of the API (the db entries of eslint.config.js);
 * this file holds the other half, that nothing of theirs can be had through the root entry.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as root from './index.ts';
import * as migrate from './migrate.ts';
import * as orgId from './org-id.ts';
import * as preOrg from './pre-org.ts';
import * as sec from './sec.ts';
import * as sqlAudit from './sql-audit.ts';
import * as testing from './testing.ts';
import * as tx from './tx.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The files of this folder that `file` imports or re-exports. */
function imported(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers = [
    ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'/gm),
    ...text.matchAll(/^\s*import\s*'([^']+)'/gm),
    ...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
  ].map((match) => match[1] ?? '');
  return specifiers.filter((s) => s.startsWith('.')).map((s) => resolve(dirname(file), s));
}

/** Every file reachable from `entry` through imports and re-exports, type-only ones included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(SRC, entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...imported(file));
  }
  return seen;
}

describe('the entries of @tinnox/db (AG-1.10)', () => {
  it('are the runtime entry, the migrator entry and the testing entry', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
    expect(
      manifest,
      'a new entry needs its row in DB_ENTRIES of eslint.config.js, which says who may not import it',
    ).toHaveProperty('exports', {
      '.': './src/index.ts',
      './migrate': './src/migrate.ts',
      './testing': './src/testing.ts',
    });
  });

  it('the runtime entry reaches no module of the other two, nor the role switch', () => {
    const fromRoot = reachable('index.ts');
    // The walk follows the re-exports of index.ts, so it has really read the package.
    expect(fromRoot).toContain(join(SRC, 'tx.ts'));
    expect(fromRoot).toContain(join(SRC, 'sec.ts'));
    for (const file of [
      'migrate.ts',
      'definer.ts',
      'testing.ts',
      'audit-debt-guard.ts',
      'audit-fault.ts',
      'audit-rows.ts',
    ]) {
      expect(
        fromRoot.has(join(SRC, file)),
        `src/${file} is reachable from src/index.ts: the API would load what only an offline tool or a test may use. Import it from its own entry instead`,
      ).toBe(false);
    }
    // And the migrator entry is where the role switch is.
    expect(reachable('migrate.ts')).toContain(join(SRC, 'definer.ts'));
  });

  it('the runtime entry exports none of their names', () => {
    const fromRoot = new Set(Object.keys(root));
    expect(Object.keys(migrate).filter((name) => fromRoot.has(name))).toEqual([]);
    expect(Object.keys(testing).filter((name) => fromRoot.has(name))).toEqual([]);
    // The names the plan moves, by name, so an export that is renamed away is noticed too.
    expect(Object.keys(migrate)).toEqual(
      expect.arrayContaining([
        'asDefiner',
        'auditedInSql',
        'changeOrgAsMigrator',
        'connectMigrator',
        'newOrgId',
        'resetTestDatabase',
        'runMigrations',
        'seedStatement',
      ]),
    );
    expect(Object.keys(testing).sort()).toEqual([
      'AUDIT_DEBT_SQLSTATE',
      'auditRowsSince',
      'auditScanMark',
      'auditScoped',
      'auditUnscoped',
      'createPool',
      'databaseOn',
      'ensureAuditDebtGuard',
      'inTx',
      'installAuditDebtGuard',
      'removeAuditDebtGuard',
      'removeAuditFault',
      'stillWaiting',
      'testOrgId',
      'twoTransactions',
      'unjudgedSql',
      'watchAuditDebt',
      'whileAuditFails',
      'whileUnauditedAllowed',
      'withNoOrgSet',
      'withOrg',
      'withResolvedOrg',
      'withoutOrg',
      'wrappedMigratorPool',
    ]);
    expect(Object.keys(root)).toEqual(
      expect.arrayContaining([
        'createDatabase',
        'ping',
        'readOrg',
        'sql',
        'deviceByRegistrationId',
      ]),
    );
  });

  // AG-3.1, SCR-34 (adoption plan step 20): the change API of ./change.ts is built on the openers
  // of ./tx.ts and the audit writers of ./sec.ts, and the runtime entry hands out the change API
  // alone. So application code cannot open a transaction with no permit and no audit row, nor
  // write an audit row on a transaction of its choosing; tests reach the five through the
  // testing entry. index.ts lists the two modules name by name, so a new export is checked here.
  const BUILT_ON = ['auditScoped', 'auditUnscoped', 'withOrg', 'withResolvedOrg', 'withoutOrg'];

  it('the runtime entry does not export what the change API is built on', () => {
    const fromRoot = Object.keys(root);
    const valuesFromRoot = Object.values(root);
    const builtOn = { ...tx, ...sec } as Record<string, unknown>;
    for (const name of BUILT_ON) {
      const message = `${name} must not be exported by the runtime entry: a change runs on changeOrg or changePreOrg and returns its audit rows as { value, audit }, and a read runs on readOrg`;
      expect(fromRoot, message).not.toContain(name);
      // The function itself too, so that `export { withOrg as openOrg }` is caught as well.
      expect(builtOn[name]).toBeTypeOf('function');
      expect(valuesFromRoot, message).not.toContain(builtOn[name]);
    }
    expect([...Object.keys(tx), ...Object.keys(sec)]).toEqual(expect.arrayContaining(BUILT_ON));
    // auditStandalone stays: D2 names it, for a refusal no transaction carries.
    expect(fromRoot).toContain('auditStandalone');
  });

  it('the runtime entry exports everything else of ./tx.ts and ./sec.ts', () => {
    const fromRoot = new Set(Object.keys(root));
    expect(
      [...Object.keys(tx), ...Object.keys(sec)].filter(
        (name) => !BUILT_ON.includes(name) && !fromRoot.has(name),
      ),
      'src/index.ts lists the exports of src/tx.ts and src/sec.ts name by name: add the new one there',
    ).toEqual([]);
  });

  // AG-2.3, AG-2.2 (adoption plan step 18): two modules no entry exports. ./org-id.ts makes the
  // OrgId, and ./pre-org.ts sends a statement where no organisation is set. Each is imported by
  // the modules named here and no other, so a new importer is a change to this list.
  it('only the named modules reach the OrgId maker and the statements of a PreOrgTx', () => {
    const sources = readdirSync(SRC).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const importersOf = (module: string): string[] =>
      sources.filter((name) => imported(join(SRC, name)).includes(join(SRC, module))).sort();
    expect(
      importersOf('org-id.ts'),
      'src/org-id.ts makes an OrgId from any string. A lookup that names an organisation belongs in src/sec.ts; anything else gets its OrgId from one of those lookups',
    ).toEqual(['definer.ts', 'migrate.ts', 'sec.ts', 'testing.ts']);
    expect(
      importersOf('pre-org.ts'),
      'src/pre-org.ts sends a statement on a transaction with no organisation. Only the sec.* wrappers (src/sec.ts), asDefiner and the testing entry do that; a tenant statement goes on the OrgTx of changeOrg or enterOrg',
    ).toEqual(['definer.ts', 'sec.ts', 'testing.ts', 'tx.ts']);

    const fromRoot = Object.keys(root);
    for (const name of [
      ...Object.keys(orgId),
      ...Object.keys(preOrg),
      'newOrgId',
      'testOrgId',
      'withNoOrgSet',
    ]) {
      expect(fromRoot, `${name} must not be exported by the runtime entry`).not.toContain(name);
    }
    expect(Object.keys(orgId).sort()).toEqual(['mintOrgId', 'readAsDefiner']);
    expect(Object.keys(preOrg).sort()).toEqual(['keepStatements', 'statementsOf']);
  });

  // SCR-34 (adoption plan step 20): lint keeps issueWritePermit to the files of
  // WRITE_PERMIT_ISSUERS in the API and the offline tools, and does not read this package. Here
  // one module issues a permit, for the migrator's connection, and it is not in the runtime
  // entry; scripts/lib/legacy-transaction-lint.test.ts holds its entry in that list.
  it('only the migrator entry issues a permit inside the package', () => {
    const sources = readdirSync(SRC).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(
      sources.filter((name) => /\bissueWritePermit\b/.test(readFileSync(join(SRC, name), 'utf8'))),
      'a permit says what judged the caller of a change. Inside this package only changeOrgAsMigrator (src/migrate.ts) issues one, to the pool connectMigrator checked; src/change.ts defines the maker',
    ).toEqual(['change.ts', 'migrate.ts']);
    expect(reachable('index.ts').has(join(SRC, 'migrate.ts'))).toBe(false);
  });

  // Step 20 review: the same for an audit statement, which lint keeps to the files of
  // STATEMENT_ISSUERS. This package takes the statement it is given and makes one only: the
  // development seed's (seedStatement of src/migrate.ts, step 20), the last entry of that list.
  it('only the migrator entry makes an audit statement inside the package: the seed’s', () => {
    const sources = readdirSync(SRC).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(
      sources.filter((name) =>
        /\bissueAuditStatement\(/.test(readFileSync(join(SRC, name), 'utf8')),
      ),
      'a statement is read from the table of its route, job or command (STATEMENT_ISSUERS in eslint.config.js); this package only checks the one it is given, and makes the development seed’s alone (seedStatement, src/migrate.ts). src/change.ts defines the maker',
    ).toEqual(['change.ts', 'migrate.ts']);
    expect(reachable('index.ts').has(join(SRC, 'migrate.ts'))).toBe(false);
  });

  // D25 (adoption plan step 20): one statement writes its own audit rows, provisioning's
  // `pending`, and its change says so with auditedInSql in place of its events. That value
  // skips the wrapper's own audit rows, so only the definer switch makes it, from what the
  // database answered, and only the migrator entry hands it out.
  it('only the definer switch says that a statement wrote its own audit rows', () => {
    const sources = readdirSync(SRC).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(
      sources
        .filter((name) => imported(join(SRC, name)).includes(join(SRC, 'sql-audit.ts')))
        .sort(),
      'src/sql-audit.ts makes the value a change returns when its own statement wrote its audit rows. Only auditedInSql of src/definer.ts makes one, from the result of a statement it sent, and src/change.ts reads it; a change returns its events as { value, audit }',
    ).toEqual(['change.ts', 'definer.ts']);
    expect(
      sources.filter((name) => /\bissueSqlAudit\(/.test(readFileSync(join(SRC, name), 'utf8'))),
      'issueSqlAudit takes the count on its caller’s word. Only auditedInSql of src/definer.ts calls it, with what the database answered for the statement; src/sql-audit.ts defines it',
    ).toEqual(['definer.ts', 'sql-audit.ts']);

    const fromRoot = Object.keys(root);
    for (const name of [...Object.keys(sqlAudit), 'auditedInSql']) {
      expect(fromRoot, `${name} must not be exported by the runtime entry`).not.toContain(name);
    }
    expect(Object.keys(sqlAudit).sort()).toEqual(['isAuditedInSql', 'issueSqlAudit', 'receiptOf']);
    expect(Object.keys(migrate)).toContain('auditedInSql');
    expect(Object.keys(migrate)).not.toContain('issueSqlAudit');
  });

  it('the runtime entry has no MigratorPool type either (checked by npm run typecheck)', () => {
    // @ts-expect-error MigratorPool is exported from '@tinnox/db/migrate' only.
    expectTypeOf<root.MigratorPool>();
    expectTypeOf<migrate.MigratorPool>().toExtend<testing.Pool>();
    // A tool passes its pool to changePreOrg as the API passes AppContext.db (step 21).
    expectTypeOf<migrate.MigratorPool>().toExtend<root.Database>();
  });

  // Adoption plan step 21: the API holds the database as the handle of createDatabase, which has
  // no query and no connect. The pool, its maker and what reads the pool behind a handle are
  // not in the runtime entry; tests reach a pool through the testing entry.
  it('the runtime entry hands out the database handle, not the pool (step 21)', () => {
    const fromRoot = Object.keys(root);
    for (const name of ['createPool', 'databaseOn', 'poolOfDatabase', 'registerOwnHandle']) {
      expect(
        fromRoot,
        `${name} must not be exported by the runtime entry: the API and the alert job hold the Database that createDatabase(options) returns (AppContext.db), and a test makes its pool with createPool and its handle with databaseOn from @tinnox/db/testing`,
      ).not.toContain(name);
    }
    expect(fromRoot).toEqual(
      expect.arrayContaining(['createDatabase', 'ping', 'assertRuntimeRole']),
    );
    expect(Object.keys(testing)).toEqual(expect.arrayContaining(['createPool', 'databaseOn']));
    // @ts-expect-error The Pool type is exported from '@tinnox/db/testing' only.
    expectTypeOf<root.Pool>();
    // @ts-expect-error So is PoolClient.
    expectTypeOf<root.PoolClient>();
  });
});
