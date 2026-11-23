/**
 * The three entries of the package (AG-1.10, adoption plan step 15): the runtime API at the root,
 * what only an offline tool as tinnox_migrator may use at `/migrate`, and what only tests may use
 * at `/testing`. Lint keeps the last two out of the API (the db entries of eslint.config.js);
 * this file holds the other half, that nothing of theirs can be had through the root entry.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as root from './index.ts';
import * as migrate from './migrate.ts';
import * as testing from './testing.ts';

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
        'connectMigrator',
        'resetTestDatabase',
        'runMigrations',
      ]),
    );
    expect(Object.keys(testing).sort()).toEqual([
      'AUDIT_DEBT_SQLSTATE',
      'auditRowsSince',
      'auditScanMark',
      'ensureAuditDebtGuard',
      'inTx',
      'installAuditDebtGuard',
      'removeAuditDebtGuard',
      'removeAuditFault',
      'unjudgedSql',
      'watchAuditDebt',
      'whileAuditFails',
      'whileUnauditedAllowed',
    ]);
    expect(Object.keys(root)).toEqual(
      expect.arrayContaining(['createPool', 'ping', 'withOrg', 'sql', 'deviceByRegistrationId']),
    );
  });

  it('the runtime entry has no MigratorPool type either (checked by npm run typecheck)', () => {
    // @ts-expect-error MigratorPool is exported from '@tinnox/db/migrate' only.
    expectTypeOf<root.MigratorPool>().toBeAny();
    expectTypeOf<migrate.MigratorPool>().toExtend<root.Pool>();
  });
});
