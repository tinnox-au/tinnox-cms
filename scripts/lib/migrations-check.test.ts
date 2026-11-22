// The rules of check:migrations (D12). The pure rules run over literal inputs; the two modes run
// over fixture histories that each test builds in a temporary git repository under the system
// temp directory, never over this repository's own history, and with no network.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_MARKER,
  checkAddedNumbers,
  checkAppendOnly,
  checkHistory,
  checkNames,
  checkRepository,
  checkSql,
  checkUpgradeTests,
  chooseMode,
  nextNumber,
  scanSql,
} from './migrations-check.ts';

const names = (n: number): string[] =>
  Array.from({ length: n }, (_, k) => `${String(k + 1).padStart(4, '0')}_m${k + 1}.sql`);

describe('rule 1: names and numbers (AG-4.1, AG-4.6, AG-4.7)', () => {
  it('passes numbered names that run from 0001 with no gap', () => {
    expect(checkNames(names(3))).toEqual([]);
  });

  it('reports a badly named .sql file and suggests a name', () => {
    expect(checkNames(['0001_schema.sql', '0002_Add-Thing.sql'])).toEqual([
      expect.stringMatching(
        /^db\/migrations\/0002_Add-Thing\.sql: a migration is named NNNN_description\.sql .* Rename it, for example to 0002_add_thing\.sql\.$/,
      ),
    ]);
  });

  it('reports a file that is not a migration, which the runner would skip silently', () => {
    expect(checkNames(['0001_schema.sql', 'notes.md'])).toEqual([
      expect.stringContaining('db/migrations/notes.md: db/migrations holds migrations only'),
    ]);
  });

  it('reports a repeated number, naming both files and the next free number', () => {
    expect(checkNames(['0001_schema.sql', '0002_a.sql', '0002_b.sql'])).toEqual([
      'db/migrations/0002_b.sql: number 0002 is taken by 0002_a.sql too, and the runner refuses a repeated number. Keep the one that is on main and renumber the other to 0003 (and its entry in db/upgrade-tests.json).',
    ]);
  });

  it('reports a skipped number', () => {
    expect(checkNames(['0001_schema.sql', '0002_a.sql', '0004_c.sql'])).toEqual([
      expect.stringMatching(/^db\/migrations\/0004_c\.sql: there is no 0003 before it\..*0003\.$/),
    ]);
    expect(checkNames(['0002_a.sql'])).toEqual([
      expect.stringContaining('0002_a.sql: there is no 0001 before it'),
    ]);
    expect(checkNames(['0001_a.sql', '0005_e.sql'])).toEqual([
      expect.stringContaining('there is no 0002 to 0004 before it'),
    ]);
  });

  it('computes the next free number over several lists', () => {
    expect(nextNumber(['0001_a.sql', '0003_c.sql'], ['0007_x.sql'])).toBe('0008');
    expect(nextNumber([])).toBe('0001');
  });
});

describe('rule 2: append-only (AG-4.4, D12)', () => {
  const base = new Map([
    ['0001_schema.sql', 'aaa'],
    ['0007_stage_b_apps.sql', 'bbb'],
  ]);

  it('passes when every merged file is unchanged and files are only added', () => {
    expect(checkAppendOnly(base, new Map([...base, ['0008_new.sql', 'ccc']]), '0009')).toEqual([]);
  });

  it('reports a modified merged migration with the message of plan section 3.3', () => {
    const current = new Map([...base, ['0007_stage_b_apps.sql', 'changed']]);
    expect(checkAppendOnly(base, current, '0008')).toEqual([
      'db/migrations/0007_stage_b_apps.sql is already on main and was modified. Merged migrations are immutable: every existing database rejects a changed checksum. Put the fix in db/migrations/0008_<description>.sql, with the next free number.',
    ]);
  });

  it('reports a deleted merged migration and how to restore it', () => {
    const current = new Map([['0001_schema.sql', 'aaa']]);
    expect(checkAppendOnly(base, current, '0008')).toEqual([
      expect.stringContaining(
        'db/migrations/0007_stage_b_apps.sql is already on main and was deleted. A database that applied it refuses to run without it: restore it with `git checkout origin/main -- db/migrations/0007_stage_b_apps.sql`.',
      ),
    ]);
  });

  it('reports a renamed merged migration', () => {
    const current = new Map([
      ['0001_schema.sql', 'aaa'],
      ['0008_stage_b_apps.sql', 'bbb'],
    ]);
    expect(checkAppendOnly(base, current, '0009')).toEqual([
      expect.stringContaining(
        'db/migrations/0007_stage_b_apps.sql is already on main and was renamed to 0008_stage_b_apps.sql.',
      ),
    ]);
  });

  it('reports each change on the first-parent history of main, naming the commit', () => {
    const findings = checkHistory([
      {
        commit: 'c'.repeat(40),
        subject: 'fix a typo',
        status: 'M',
        path: 'db/migrations/0007.sql',
      },
      {
        commit: 'd'.repeat(40),
        subject: 'renumber',
        status: 'R100',
        path: 'db/migrations/0008_x.sql',
        renamedTo: 'db/migrations/0009_x.sql',
      },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatch(
      /^db\/migrations\/0007\.sql: commit cccccccccccc \("fix a typo"\) on main's first-parent history modified this merged migration\. Merged migrations are immutable/,
    );
    expect(findings[1]).toContain('renamed this merged migration to db/migrations/0009_x.sql');
  });

  it('skips a commit listed with its reason in the exceptions', () => {
    const change = { commit: 'e'.repeat(40), subject: 's', status: 'D', path: 'db/migrations/x' };
    expect(checkHistory([change], { ['e'.repeat(40)]: 'restored in the next commit' })).toEqual([]);
  });
});

describe('rule 3: a new file numbers above main (AG-4.5, D12)', () => {
  it('passes a file numbered above the highest on origin/main', () => {
    expect(checkAddedNumbers(names(3), names(2), names(2))).toEqual([]);
  });

  it('reports a branch file whose number main took after the branch point', () => {
    const main = [...names(2), '0003_from_main.sql'];
    const current = [...names(2), '0003_mine.sql'];
    expect(checkAddedNumbers(current, names(2), main)).toEqual([
      "db/migrations/0003_mine.sql is new on this branch, but origin/main already has migrations up to 0003_from_main.sql. A new migration numbers above everything on main, or databases that applied main's files refuse it. Merge origin/main, then renumber it to 0004 (and its entry in db/upgrade-tests.json).",
    ]);
  });

  it('does not count a file that came from main as new', () => {
    const main = [...names(2), '0003_from_main.sql'];
    expect(checkAddedNumbers(main, names(2), main)).toEqual([]);
  });
});

describe('rule 4: text rules (AG-4.3, AG-4.8, AG-4.9, AG-4.10, AG-4.11)', () => {
  const header = '-- 0015: a change.\n-- Locks: none.\n';
  const one = (sql: string, name = '0015_change.sql'): string[] => checkSql(name, header + sql);

  it('passes ordinary DDL and data statements', () => {
    expect(
      one(
        "CREATE TABLE public.thing (id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'x');\nALTER TABLE public.thing ENABLE ROW LEVEL SECURITY;\nCREATE INDEX thing_name_idx ON public.thing (name);\n",
      ),
    ).toEqual([]);
  });

  it('ignores comments, dollar-quoted bodies and quoted text', () => {
    expect(
      one(
        [
          '-- COMMIT; VACUUM; CREATE ROLE x; UPDATE audit_event SET x = 1;',
          '/* nested /* COMMIT; */ VACUUM; */',
          'DO $$ BEGIN PERFORM 1; COMMIT; END $$;',
          "DO $guard$ BEGIN RAISE NOTICE '00000000-0000-4000-8000-000000000001'; END $guard$;",
          "COMMENT ON TABLE public.t IS 'we never VACUUM; or COMMIT here';",
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('treats a BEGIN ATOMIC function body as one statement, like a dollar-quoted body', () => {
    expect(
      one(
        [
          'CREATE FUNCTION public.f(a integer) RETURNS integer LANGUAGE sql',
          'BEGIN ATOMIC',
          '  SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END;',
          "  SELECT count(*) FROM public.t WHERE id = '00000000-0000-4000-8000-000000000001';",
          'END;',
          'CREATE PROCEDURE public.p() LANGUAGE sql BEGIN ATOMIC END;',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
    // Statements after the body are still checked.
    expect(
      one(
        'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;\nCOMMIT;\n',
      ),
    ).toEqual([expect.stringContaining(':4 controls the transaction (COMMIT)')]);
  });

  it('blanks what it skips but keeps line numbers', () => {
    const scanned = scanSql("-- a\nSELECT 'x\ny' $$\n;\n$$;\n");
    expect(scanned.code.split('\n')).toHaveLength(6);
    expect(scanned.code).not.toContain('x');
    expect(scanned.strings).toEqual([{ line: 2, value: 'x\ny' }]);
  });

  it('reports CONCURRENTLY and VACUUM, which cannot run in the runner transaction', () => {
    const findings = one(
      'CREATE INDEX CONCURRENTLY t_idx ON public.t (a);\nVACUUM ANALYZE public.t;\n',
    );
    expect(findings).toEqual([
      expect.stringMatching(/^db\/migrations\/0015_change\.sql:3 uses CONCURRENTLY/),
      expect.stringMatching(/^db\/migrations\/0015_change\.sql:4 runs VACUUM/),
    ]);
  });

  it('reports top-level transaction control', () => {
    const findings = one('BEGIN;\nSELECT 1;\nCOMMIT;\nSTART TRANSACTION;\nROLLBACK;\n');
    expect(findings.map((f) => f.split(' ').slice(0, 4).join(' '))).toEqual([
      'db/migrations/0015_change.sql:3 controls the transaction',
      'db/migrations/0015_change.sql:5 controls the transaction',
      'db/migrations/0015_change.sql:6 controls the transaction',
      'db/migrations/0015_change.sql:7 controls the transaction',
    ]);
  });

  it('reports role DDL and points at the init script', () => {
    expect(one('CREATE ROLE intruder;\nALTER ROLE tinnox_app BYPASSRLS;\n')).toEqual([
      expect.stringContaining(
        ':3 creates, alters or drops a role. Roles are cluster-wide and are created in infra/postgres/init/01-roles.sh',
      ),
      expect.stringContaining(':4 creates, alters or drops a role.'),
    ]);
  });

  it('reports a UUID literal, the shape of a development-only seed id', () => {
    expect(
      one("UPDATE public.t SET a = 1 WHERE org_id = '0B0E0000-0000-4000-8000-00000000000A';\n"),
    ).toEqual([
      expect.stringContaining(":3 has the UUID literal '0B0E0000-0000-4000-8000-00000000000A'."),
    ]);
  });

  it('passes sec.* function DDL inside the role switch, as 0014 writes it', () => {
    expect(
      one(
        [
          'SET LOCAL ROLE tinnox_definer;',
          'CREATE FUNCTION sec.thing() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER',
          '  SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;',
          'REVOKE ALL ON FUNCTION sec.thing() FROM PUBLIC;',
          'GRANT EXECUTE ON FUNCTION sec.thing() TO tinnox_app;',
          'RESET ROLE;',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('reports sec.* function DDL outside the switch, a non-local switch, a switch to another role and an unclosed one', () => {
    expect(
      one(
        [
          'CREATE OR REPLACE FUNCTION sec.thing() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
          'GRANT EXECUTE ON FUNCTION sec.thing() TO tinnox_app;',
          'SET ROLE tinnox_definer;',
          'DROP FUNCTION IF EXISTS sec.old();',
          'SET LOCAL ROLE tinnox_definer;',
          // A LOCAL switch to another role inside the switch ends it, so sec.y() is outside.
          'SET LOCAL ROLE tinnox_app;',
          'CREATE FUNCTION sec.y() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
          'RESET ROLE;',
          'SET LOCAL ROLE tinnox_migrator;',
          'SET LOCAL ROLE tinnox_definer;',
          'ALTER FUNCTION sec.thing() OWNER TO tinnox_definer;',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      expect.stringContaining(':3 changes a sec.* function outside the role switch'),
      expect.stringContaining(':4 changes a sec.* function outside the role switch'),
      expect.stringContaining(':5 switches role without LOCAL'),
      expect.stringContaining(':6 changes a sec.* function outside the role switch'),
      expect.stringMatching(
        /:8 switches to a role other than tinnox_definer\..*`SET LOCAL ROLE tinnox_definer;` \.\.\. `RESET ROLE;`/,
      ),
      expect.stringContaining(':9 changes a sec.* function outside the role switch'),
      expect.stringContaining(':11 switches to a role other than tinnox_definer.'),
      expect.stringContaining(':12 opens `SET LOCAL ROLE tinnox_definer;` and never closes it'),
    ]);
  });

  it('reports writes and grants on audit_event unless the marker line is directly above', () => {
    const findings = one(
      [
        'UPDATE public.audit_event SET result = NULL;',
        'DELETE FROM audit_event;',
        'TRUNCATE public.audit_event;',
        'GRANT SELECT, INSERT, UPDATE ON public.audit_event TO tinnox_app;',
        'GRANT SELECT ON ALL TABLES IN SCHEMA public TO tinnox_app;',
        `${AUDIT_EVENT_MARKER} the category backfill of the plan, reviewed in the pull request`,
        'UPDATE public.audit_event SET category = NULL WHERE false;',
        'CREATE TRIGGER t BEFORE UPDATE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION f();',
        'GRANT EXECUTE ON FUNCTION public.audit_event_stamp() TO tinnox_app;',
        '',
      ].join('\n'),
    );
    expect(findings.map((f) => /:(\d+) /.exec(f)?.[1])).toEqual(['3', '4', '5', '6', '7']);
    expect(findings[0]).toContain(`put the comment line \`${AUDIT_EVENT_MARKER} <why>\``);
  });

  it('grandfathers 0001 and 0002 by name, for their own rule only', () => {
    const grant = 'GRANT SELECT, INSERT ON public.audit_event TO tinnox_app;\n';
    const secDdl = 'CREATE FUNCTION sec.x() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n';
    expect(checkSql('0001_schema.sql', grant)).toEqual([]);
    expect(checkSql('0002_security_functions.sql', secDdl)).toEqual([]);
    expect(checkSql('0001_schema.sql', secDdl)).toHaveLength(1);
    expect(checkSql('0002_security_functions.sql', grant)).toHaveLength(1);
    expect(checkSql('0003_api_lookups.sql', grant)).toHaveLength(1);
  });

  it('asks a new file that alters an existing table for a -- Locks: header line, once', () => {
    const sql =
      '-- 0015: display columns.\nALTER TABLE public.display ADD COLUMN a int;\nALTER TABLE public.media ADD COLUMN b int;\n';
    expect(checkSql('0015_display.sql', sql)).toEqual([
      expect.stringMatching(
        /^db\/migrations\/0015_display\.sql:2 alters the existing table display, and the file's header has no `-- Locks:` line\./,
      ),
    ]);
    expect(
      checkSql('0015_display.sql', `-- Locks: ACCESS EXCLUSIVE on display, no rewrite.\n${sql}`),
    ).toEqual([]);
    // A table the file creates is not an existing one; files before the rule are not new.
    expect(
      checkSql(
        '0015_t.sql',
        'CREATE TABLE public.t (id int);\nALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n',
      ),
    ).toEqual([]);
    expect(checkSql('0014_display_alerts.sql', sql)).toEqual([]);
  });
});

describe('rule 5: db/upgrade-tests.json (AG-4.13)', () => {
  const files = ['0001_schema.sql', '0002_x.sql'];
  const exists = (path: string): boolean =>
    path === 'packages/db/test/migration-0002.integration.test.ts';
  const json = (entries: unknown[]): string => JSON.stringify({ migrations: entries }, null, 2);

  it('passes one sorted entry per migration, each with a test or a reason', () => {
    const text = json([
      { file: '0001_schema.sql', reason: 'first schema' },
      { file: '0002_x.sql', test: 'packages/db/test/migration-0002.integration.test.ts' },
    ]);
    expect(checkUpgradeTests(files, text, exists)).toEqual([]);
  });

  it('reports a migration with no entry, saying what to add', () => {
    expect(
      checkUpgradeTests(files, json([{ file: '0001_schema.sql', reason: 'r' }]), exists),
    ).toEqual([
      expect.stringMatching(
        /^db\/migrations\/0002_x\.sql has no entry in db\/upgrade-tests\.json\. Add one in file-name order\. Each entry is/,
      ),
    ]);
  });

  it('reports a test file that does not exist, and a test outside the integration project', () => {
    const text = json([
      { file: '0001_schema.sql', test: 'packages/db/src/tx.test.ts' },
      { file: '0002_x.sql', test: 'packages/db/test/migration-0099.integration.test.ts' },
    ]);
    expect(checkUpgradeTests(files, text, exists)).toEqual([
      expect.stringContaining('0001_schema.sql: "test" must name an integration test file'),
      expect.stringMatching(
        /^db\/upgrade-tests\.json:\d+ 0002_x\.sql names packages\/db\/test\/migration-0099\.integration\.test\.ts, which does not exist\./,
      ),
    ]);
  });

  it('reports entries out of order, twice, stale, empty or with unknown keys', () => {
    const text = json([
      { file: '0002_x.sql', reason: 'r' },
      { file: '0001_schema.sql', reason: ' ' },
      { file: '0001_schema.sql', reason: 'r', note: 'n' },
      { file: '0003_gone.sql', reason: 'r' },
    ]);
    const findings = checkUpgradeTests(files, text, exists);
    expect(findings).toEqual([
      expect.stringContaining(
        '0001_schema.sql comes after 0002_x.sql. Keep the entries sorted by file name',
      ),
      expect.stringContaining('0001_schema.sql: "reason" must be a sentence, not empty.'),
      expect.stringContaining('0001_schema.sql has unknown keys (note)'),
      expect.stringContaining('0001_schema.sql is listed twice'),
      expect.stringContaining('0003_gone.sql is not in db/migrations'),
    ]);
  });

  it('reports a missing file, bad JSON and an entry with neither test nor reason', () => {
    expect(checkUpgradeTests(files, undefined, exists)[0]).toMatch(
      /^db\/upgrade-tests\.json is missing\./,
    );
    expect(checkUpgradeTests(files, '{', exists)[0]).toMatch(
      /^db\/upgrade-tests\.json is not valid JSON/,
    );
    expect(
      checkUpgradeTests(['0001_schema.sql'], json([{ file: '0001_schema.sql' }]), exists),
    ).toEqual([expect.stringContaining('0001_schema.sql has neither "test" nor "reason"')]);
  });
});

describe('mode', () => {
  it('is main on a push to main and branch on a pull request or another branch', () => {
    const ci = { GITHUB_ACTIONS: 'true' };
    expect(chooseMode([], { ...ci, GITHUB_REF: 'refs/heads/main' }, undefined)).toBe('main');
    expect(chooseMode([], { ...ci, GITHUB_REF: 'refs/pull/7/merge' }, undefined)).toBe('branch');
    expect(chooseMode([], { ...ci, GITHUB_REF: 'refs/heads/feat/x' }, 'feat/x')).toBe('branch');
  });

  it('follows the checked-out branch locally, unless a flag says otherwise', () => {
    expect(chooseMode([], {}, 'main')).toBe('main');
    expect(chooseMode([], {}, 'feat/x')).toBe('branch');
    expect(chooseMode([], {}, undefined)).toBe('branch');
    expect(chooseMode(['--main'], {}, 'feat/x')).toBe('main');
    expect(chooseMode(['--branch'], {}, 'main')).toBe('branch');
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture histories

const savedEnv: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeAll(() => {
  // A git hook can export GIT_DIR or GIT_INDEX_FILE, which would point every command below at
  // this repository; and a user's config may sign commits. Run git with neither.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  const isolated: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  for (const [key, value] of Object.entries(isolated)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[], allowFail = false): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const sql = (n: number, body = ''): string =>
  `-- ${String(n).padStart(4, '0')}: fixture.\nCREATE TABLE public.t${n} (id int);\n${body}`;

function upgradeTests(files: readonly string[]): string {
  return `${JSON.stringify({ migrations: files.map((file) => ({ file, reason: `${file} adds an empty table` })) }, null, 2)}\n`;
}

/** Writes migrations 1..n (or the names given) with their upgrade-tests entries. */
function addMigrations(root: string, files: readonly string[]): void {
  for (const file of files) write(root, `db/migrations/${file}`, sql(Number(file.slice(0, 4))));
  const all = git(root, ['ls-files', '--others', '--cached', '--exclude-standard', 'db/migrations'])
    .split('\n')
    .filter((p) => p !== '')
    .map((p) => p.slice('db/migrations/'.length));
  write(root, 'db/upgrade-tests.json', upgradeTests([...new Set(all)].sort()));
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-gpg-sign', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/** A repository whose main has migrations 0001 and 0002; origin/main points at its tip. */
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tinnox-check-migrations-')));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  // Never this repository: the fixture must be its own top level.
  expect(realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim())).toBe(root);
  addMigrations(root, ['0001_m1.sql', '0002_m2.sql']);
  commit(root, 'migrations 0001 and 0002');
  git(root, ['update-ref', 'refs/remotes/origin/main', 'main']);
  return root;
}

describe('branch mode over fixture histories (D12)', () => {
  it('passes a branch that adds the next migration', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'feat']);
    addMigrations(root, ['0003_m3.sql']);
    commit(root, 'add 0003');
    expect(checkRepository(root, 'branch').findings).toEqual([]);
  });

  it('fails an uncommitted edit of a merged migration, and a committed one', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'feat']);
    write(root, 'db/migrations/0001_m1.sql', sql(1, '-- edited\n'));
    expect(checkRepository(root, 'branch').findings).toEqual([
      expect.stringContaining('db/migrations/0001_m1.sql is already on main and was modified.'),
    ]);
    commit(root, 'edit 0001');
    expect(checkRepository(root, 'branch').findings).toEqual([
      expect.stringContaining('db/migrations/0001_m1.sql is already on main and was modified.'),
    ]);
  });

  it('fails a branch whose new number main took after the branch point', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'feat']);
    addMigrations(root, ['0003_mine.sql']);
    commit(root, 'add my 0003');
    git(root, ['switch', '-q', 'main']);
    addMigrations(root, ['0003_theirs.sql']);
    commit(root, 'add their 0003');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(root, ['switch', '-q', 'feat']);
    expect(checkRepository(root, 'branch').findings).toEqual([
      expect.stringContaining(
        'db/migrations/0003_mine.sql is new on this branch, but origin/main already has migrations up to 0003_theirs.sql.',
      ),
    ]);
  });

  it('fails a duplicate and a skipped number in the working tree', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'feat']);
    addMigrations(root, ['0002_again.sql', '0004_skip.sql']);
    const findings = checkRepository(root, 'branch').findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'db/migrations/0002_m2.sql: number 0002 is taken by 0002_again.sql too',
        ),
        expect.stringContaining('db/migrations/0004_skip.sql: there is no 0003 before it.'),
      ]),
    );
  });

  it('says what to do when origin/main is missing', () => {
    const root = fixture();
    git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
    expect(checkRepository(root, 'branch').findings).toEqual([
      "check:migrations compares this branch with origin/main, and this checkout has no origin/main. Run `git fetch origin main`; in CI the quality job's checkout needs `fetch-depth: 0` (.github/workflows/ci.yml).",
    ]);
  });
});

describe('main mode over fixture histories (D12)', () => {
  it('passes edits made on a branch before its merge: the merge adds the file', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'feat']);
    addMigrations(root, ['0003_m3.sql']);
    commit(root, 'add 0003');
    write(root, 'db/migrations/0003_m3.sql', sql(3, '-- reviewed\n'));
    commit(root, 'revise 0003 before merge');
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge feat', 'feat']);
    expect(checkRepository(root, 'main').findings).toEqual([]);
  });

  it('fails a commit on main that modifies, renames or deletes a merged migration', () => {
    const root = fixture();
    write(root, 'db/migrations/0001_m1.sql', sql(1, '-- edited on main\n'));
    const edit = commit(root, 'edit 0001 on main');
    expect(checkRepository(root, 'main').findings).toEqual([
      expect.stringContaining(
        `db/migrations/0001_m1.sql: commit ${edit.slice(0, 12)} ("edit 0001 on main") on main's first-parent history modified this merged migration.`,
      ),
    ]);
    git(root, ['mv', 'db/migrations/0002_m2.sql', 'db/migrations/0002_renamed.sql']);
    write(root, 'db/upgrade-tests.json', upgradeTests(['0001_m1.sql', '0002_renamed.sql']));
    commit(root, 'rename 0002');
    const findings = checkRepository(root, 'main').findings;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain('db/migrations/0002_m2.sql: commit ');
    expect(findings[0]).toContain(
      'renamed this merged migration to db/migrations/0002_renamed.sql',
    );
  });

  it('fails a merge into main that brings an edit of a migration main already had', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'feat']);
    write(root, 'db/migrations/0002_m2.sql', sql(2, '-- edited on a branch\n'));
    commit(root, 'edit 0002');
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge feat', 'feat']);
    expect(checkRepository(root, 'main').findings).toEqual([
      expect.stringMatching(
        /^db\/migrations\/0002_m2\.sql: commit [0-9a-f]{12} \("merge feat"\) on main's first-parent history modified/,
      ),
    ]);
  });
});

describe('db/upgrade-tests.json at merge (D12)', () => {
  it('conflicts when two branches add a migration after the same last entry', () => {
    const root = fixture();
    git(root, ['switch', '-q', '-c', 'one']);
    addMigrations(root, ['0003_one.sql']);
    commit(root, 'add 0003 on one');
    git(root, ['switch', '-q', '-c', 'two', 'main']);
    addMigrations(root, ['0003_two.sql']);
    commit(root, 'add 0003 on two');
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge one', 'one']);
    git(root, ['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge two', 'two'], true);
    const unmerged = git(root, ['diff', '--name-only', '--diff-filter=U']).trim();
    expect(unmerged).toBe('db/upgrade-tests.json');
  });
});
