// Rules that keep db/migrations append-only and numbered (scripts/check-migrations.ts, plan
// section 3.3, D12). Each rule returns findings as "path[:line] message"; a message says what to
// do instead.
//   1. every entry of db/migrations is NNNN_description.sql; numbers are unique and run from 0001
//      with no gap;
//   2. append-only, in two modes: on a branch or pull request every migration at the merge-base
//      of HEAD and origin/main is byte-identical in the working tree; on main the first-parent
//      history of HEAD never deletes, modifies, renames or retypes one;
//   3. on a branch, an added file numbers above the highest on origin/main;
//   4. text rules over each file, outside comments and dollar-quoted bodies (one rule reads
//      the bodies too: a new file does not paste the guards the runner now holds);
//   5. db/upgrade-tests.json lists every file, sorted by file name, with its upgrade test or the
//      reason it has none.
// Git is the authority: there is no checksum manifest, because editing a file and its manifest
// together would pass one (D12). The rules are pure; the functions under "Reading the repository"
// at the end collect their input with git.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_FILE_PATTERN, validateMigrationNames } from '@tinnox/db/migrate';

export const MIGRATIONS_DIR = 'db/migrations';
export const UPGRADE_TESTS_PATH = 'db/upgrade-tests.json';
export const MAIN_REF = 'origin/main';

/**
 * Commits on main's first-parent history allowed to change a merged migration, each with its
 * reason (D12). None today: the history has never changed one. Should one ever land, main fails
 * this check for good until it is listed here. A merge that changed a migration main already had
 * is listed together with a new commit that restores the merged bytes. A commit that is not a
 * merge may come from a fast-forward or rebase merge of a branch that revised its own new
 * migration: when the earlier version was never main's tip, it is listed with that reason alone.
 */
export const MAIN_HISTORY_EXCEPTIONS: Readonly<Record<string, string>> = {};

export const NOT_BLOCKING =
  'Until a ruleset on main requires the quality job, this check reports but does not block a merge (D12): fix it before merging.';

function migrationNumber(name: string): number | undefined {
  const match = MIGRATION_FILE_PATTERN.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/** The next free number above every migration in the given lists. */
export function nextNumber(...lists: readonly (readonly string[])[]): string {
  let highest = 0;
  for (const name of lists.flat()) highest = Math.max(highest, migrationNumber(name) ?? 0);
  return pad(highest + 1);
}

// ---------------------------------------------------------------------------------------------
// Rule 1: names, unique and contiguous numbers

/** @param entries every file under db/migrations, relative to it */
export function checkNames(entries: readonly string[]): string[] {
  const findings: string[] = [];
  const sorted = [...entries].sort();
  const next = nextNumber(sorted);
  for (const problem of validateMigrationNames(sorted)) {
    if (problem.kind === 'pattern') {
      findings.push(
        problem.name.endsWith('.sql')
          ? `${MIGRATIONS_DIR}/${problem.name}: a migration is named NNNN_description.sql (four digits, then lower-case letters, digits and underscores), or the runner refuses the whole directory. Rename it, for example to ${next}_${slug(problem.name)}.sql.`
          : `${MIGRATIONS_DIR}/${problem.name}: db/migrations holds migrations only, and the runner silently skips a file that does not end in .sql, so it would never run. Name a migration NNNN_description.sql, or move anything else out of db/migrations.`,
      );
    } else {
      const first = sorted.find((n) => n.startsWith(`${problem.number}_`));
      findings.push(
        `${MIGRATIONS_DIR}/${problem.name}: number ${problem.number} is taken by ${first ?? 'another file'} too, and the runner refuses a repeated number. Keep the one that is on main and renumber the other to ${next} (and its entry in ${UPGRADE_TESTS_PATH}).`,
      );
    }
  }
  // The first file of each number, in order; a repeat is reported above.
  const firsts = sorted.filter(
    (n, k) =>
      migrationNumber(n) !== undefined &&
      sorted.findIndex((m) => migrationNumber(m) === migrationNumber(n)) === k,
  );
  let expected = 1;
  for (const name of firsts) {
    const n = migrationNumber(name) ?? expected;
    if (n > expected) {
      findings.push(
        `${MIGRATIONS_DIR}/${name}: there is no ${pad(expected)}${n - expected > 1 ? ` to ${pad(n - 1)}` : ''} before it. Numbers run from 0001 with no gap, so a skipped number never hides a migration that was lost or renumbered. Renumber it to ${pad(expected)}.`,
      );
    }
    expected = n + 1;
  }
  return findings;
}

function slug(name: string): string {
  const base = name
    .replace(/\.sql$/, '')
    .replace(/^[0-9]+[_-]?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base === '' ? 'description' : base;
}

// ---------------------------------------------------------------------------------------------
// Rule 2: append-only

/**
 * Branch or pull-request mode: every migration at the base is byte-identical now.
 * @param base name -> blob id at the merge-base of HEAD and origin/main
 * @param current name -> blob id in the working tree
 * @param next the next free number, for the message
 */
export function checkAppendOnly(
  base: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  next: string,
): string[] {
  const findings: string[] = [];
  const fix = `Merged migrations are immutable: every existing database rejects a changed checksum. Put the fix in ${MIGRATIONS_DIR}/${next}_<description>.sql, with the next free number.`;
  for (const [name, blob] of base) {
    const now = current.get(name);
    if (now === blob) continue;
    if (now !== undefined) {
      findings.push(`${MIGRATIONS_DIR}/${name} is already on main and was modified. ${fix}`);
      continue;
    }
    const renamedTo = [...current].find(([other, b]) => b === blob && !base.has(other))?.[0];
    findings.push(
      renamedTo === undefined
        ? `${MIGRATIONS_DIR}/${name} is already on main and was deleted. A database that applied it refuses to run without it: restore it with \`git checkout ${MAIN_REF} -- ${MIGRATIONS_DIR}/${name}\`. ${fix}`
        : `${MIGRATIONS_DIR}/${name} is already on main and was renamed to ${renamedTo}. A database that applied it refuses to run without it: rename it back. ${fix}`,
    );
  }
  return findings;
}

export interface HistoryChange {
  readonly commit: string;
  readonly subject: string;
  /** D, M, R or T, as git log --name-status prints it (R carries a score: R100). */
  readonly status: string;
  readonly path: string;
  /** The new path of a rename. */
  readonly renamedTo?: string;
  /** The commit has more than one parent. */
  readonly merge: boolean;
}

/**
 * Main mode: the first-parent history of HEAD lists no deletion, modification, rename or type
 * change under db/migrations, apart from MAIN_HISTORY_EXCEPTIONS. Main takes merge commits or
 * squash merges only. A fast-forward or rebase merge puts the branch's own commits on the
 * first-parent history, so a review fix to the branch's new migration lands here too (CHK-1):
 * the message for a commit that is not a merge says how to tell the two cases apart.
 */
export function checkHistory(
  changes: readonly HistoryChange[],
  exceptions: Readonly<Record<string, string>> = MAIN_HISTORY_EXCEPTIONS,
): string[] {
  const verbs: Record<string, string> = {
    D: 'deleted',
    M: 'modified',
    R: 'renamed',
    T: 'changed the type of',
  };
  return changes
    .filter((c) => exceptions[c.commit] === undefined)
    .map((c) => {
      const verb = verbs[c.status.charAt(0)] ?? `changed (${c.status})`;
      const target = c.renamedTo === undefined ? '' : ` to ${c.renamedTo}`;
      const head = `${c.path}: commit ${c.commit.slice(0, 12)} ("${c.subject}") on main's first-parent history ${verb} this merged migration${target}. Merged migrations are immutable: every existing database rejects a changed checksum.`;
      const restore = `Restore the merged bytes in a new commit and add both commits to MAIN_HISTORY_EXCEPTIONS in scripts/lib/migrations-check.ts with the reason; put the actual fix in a new migration with the next free number.`;
      if (c.merge) return `${head} ${restore}`;
      return `${head} The commit is not a merge: a squash merge or direct push that edited a migration main already had, or a fast-forward or rebase merge of a branch that revised its own new migration (main takes merge commits or squash merges only, .github/workflows/ci.yml). If the earlier version was never main's tip, so no database applied it from main, add this commit to MAIN_HISTORY_EXCEPTIONS in scripts/lib/migrations-check.ts with that reason and restore nothing. Only if the earlier version was on main and could have been applied: ${restore}`;
    });
}

// ---------------------------------------------------------------------------------------------
// Rule 3: a branch's new files number above main's highest

/**
 * @param current names in the working tree
 * @param mergeBase names at the merge-base of HEAD and origin/main
 * @param main names on origin/main
 */
export function checkAddedNumbers(
  current: readonly string[],
  mergeBase: readonly string[],
  main: readonly string[],
): string[] {
  const known = new Set([...mergeBase, ...main]);
  const highest = [...main]
    .filter((n) => migrationNumber(n) !== undefined)
    .sort()
    .at(-1);
  if (highest === undefined) return [];
  const top = migrationNumber(highest) ?? 0;
  const next = nextNumber(current, main);
  return [...current]
    .sort()
    .filter((name) => !known.has(name))
    .flatMap((name) => {
      const n = migrationNumber(name);
      if (n === undefined || n > top) return [];
      return [
        `${MIGRATIONS_DIR}/${name} is new on this branch, but ${MAIN_REF} already has migrations up to ${highest}. A new migration numbers above everything on main, or databases that applied main's files refuse it. Merge ${MAIN_REF}, then renumber it to ${next} (and its entry in ${UPGRADE_TESTS_PATH}).`,
      ];
    });
}

// ---------------------------------------------------------------------------------------------
// Rule 4: text rules

export type SqlRule =
  | 'concurrently'
  | 'vacuum'
  | 'transaction-control'
  | 'role-ddl'
  | 'uuid-literal'
  | 'sec-ddl-outside-switch'
  | 'audit-event'
  | 'locks-header'
  | 'pasted-guard';

/**
 * Merged files that break a text rule and cannot change, by name and rule (plan section 3.3).
 * The list only shrinks: a new migration follows every rule.
 */
export const GRANDFATHERED: readonly {
  readonly file: string;
  readonly rule: SqlRule;
  readonly reason: string;
}[] = [
  {
    file: '0001_schema.sql',
    rule: 'audit-event',
    reason:
      'the two grants that define who may write audit_event (tinnox_app INSERT and SELECT, tinnox_definer INSERT), at 0001_schema.sql:490 and :498',
  },
  {
    file: '0002_security_functions.sql',
    rule: 'sec-ddl-outside-switch',
    reason:
      'creates its sec.* functions as the migrator and moves their ownership with ALTER FUNCTION ... OWNER TO in the DO block at 0002_security_functions.sql:381-394',
  },
];

/**
 * The `-- Locks:` header is required from this number on: earlier files declare their locks in
 * three older wordings (plan row AG-4.11), and merged files cannot change.
 */
export const LOCKS_HEADER_FROM = 15;

/**
 * From this number on a file does not paste the guards that end 0001 to 0014 (forced row-level
 * security, the sec.* hardening, a tenant policy on each new table, no disabled trigger): the
 * migration runner checks them itself after every file and before its COMMIT
 * (packages/db/src/schema-invariants.ts; plan section 3.3, EAX-12). The merged copies stay.
 */
export const RUNNER_GUARDS_FROM = 15;
/** What those guards raise: a file that raises one of these has copied a guard. */
const PASTED_GUARD =
  /RAISE\s+EXCEPTION\s+'(sec functions with unsafe definition|tables without forced row-level security|tables without a tenant policy|triggers left disabled)\b/i;

/**
 * The SQL with comments, dollar-quoted and BEGIN ATOMIC bodies and quoted text blanked to
 * spaces, lines kept.
 */
export interface ScannedSql {
  readonly code: string;
  readonly strings: readonly { readonly line: number; readonly value: string }[];
}

export function scanSql(sql: string): ScannedSql {
  const out = sql.split('');
  const strings: { index: number; line: number; value: string }[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const lineAt = (index: number): number => sql.slice(0, index).split('\n').length;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let k = i + 2;
      while (k < sql.length && depth > 0) {
        if (sql[k] === '/' && sql[k + 1] === '*') {
          depth += 1;
          k += 2;
        } else if (sql[k] === '*' && sql[k + 1] === '/') {
          depth -= 1;
          k += 2;
        } else k += 1;
      }
      blank(i, k);
      i = k;
    } else if (c === "'") {
      // E'...' allows backslash escapes; '' is a quote in both forms.
      const escapes = i > 0 && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      let k = i + 1;
      let value = '';
      while (k < sql.length) {
        if (escapes && sql[k] === '\\') {
          value += sql.slice(k, k + 2);
          k += 2;
        } else if (sql[k] === "'" && sql[k + 1] === "'") {
          value += "'";
          k += 2;
        } else if (sql[k] === "'") break;
        else {
          value += sql[k];
          k += 1;
        }
      }
      strings.push({ index: i, line: lineAt(i), value });
      blank(i + 1, k);
      i = k + 1;
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      i = stop;
    } else if (c === '$' && !/\w/.test(sql[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag === null) {
        i += 1;
        continue;
      }
      const close = sql.indexOf(tag[0], i + tag[0].length);
      const stop = close === -1 ? sql.length : close + tag[0].length;
      blank(i, stop);
      i = stop;
    } else i += 1;
  }
  // A SQL-standard function body (PostgreSQL 14+) ends its inner statements with `;` and closes
  // with END. Blank it like a dollar-quoted body so the splitter does not see the inner
  // statements or a bare END. END can open a statement only as the body's close (CASE ... END
  // sits inside an expression), so the body ends at the first END that follows `;` or ATOMIC.
  const bodies: [number, number][] = [];
  let code = out.join('');
  const atomic = /\bBEGIN\s+ATOMIC\b/gi;
  for (let open = atomic.exec(code); open !== null; open = atomic.exec(code)) {
    const from = open.index + open[0].length;
    let k = from;
    let to = code.length;
    while (k < code.length) {
      const start = k + (/^\s*/.exec(code.slice(k))?.[0].length ?? 0);
      if (/^END\b/i.test(code.slice(start))) {
        to = start;
        break;
      }
      const semicolon = code.indexOf(';', start);
      if (semicolon === -1) break;
      k = semicolon + 1;
    }
    blank(from, to);
    bodies.push([from, to]);
    code = out.join('');
    atomic.lastIndex = to;
  }
  return {
    code,
    strings: strings
      .filter((s) => !bodies.some(([from, to]) => s.index >= from && s.index < to))
      .map(({ line, value }) => ({ line, value })),
  };
}

interface Statement {
  readonly line: number;
  /** Upper case, whitespace collapsed, simple identifiers unquoted. */
  readonly text: string;
}

function statements(code: string): Statement[] {
  const result: Statement[] = [];
  let line = 1;
  for (const part of code.split(';')) {
    const lead = /^\s*/.exec(part)?.[0] ?? '';
    // "audit_event" and audit_event name the same table, so quoting must not change a result
    // (CHK-9). Only a name PostgreSQL would fold to itself loses its quotes: "Audit_Event" is a
    // different table from audit_event, so it keeps them and no rule below matches it.
    const text = part
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/"([a-z_][a-z0-9_$]*)"/g, '$1')
      .toUpperCase();
    if (text !== '') result.push({ line: line + (lead.match(/\n/g)?.length ?? 0), text });
    line += part.match(/\n/g)?.length ?? 0;
  }
  return result;
}

const TRANSACTION_CONTROL =
  /^(BEGIN|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|START TRANSACTION|PREPARE TRANSACTION)\b/;
const ROLE_DDL = /^(CREATE|ALTER|DROP) (ROLE|USER|GROUP)\b/;
const SEC_DDL =
  /^((CREATE (OR REPLACE )?|ALTER |DROP )(FUNCTION|PROCEDURE) (IF EXISTS )?SEC\.|COMMENT ON (FUNCTION|PROCEDURE) SEC\.|(GRANT|REVOKE) .* ON (FUNCTION|PROCEDURE) SEC\.|(GRANT|REVOKE) .* ON ALL (FUNCTIONS|PROCEDURES|ROUTINES) IN SCHEMA SEC\b)/;
/**
 * Statements that write to audit_event, widen who may, or take away the triggers that keep it
 * append-only (CHK-2). A new trigger and a new column are allowed: 0004 adds the stamp trigger
 * and 0005 a generated column, and neither can rewrite a row. Like every text rule, this one sees
 * top-level statements only: a statement inside a DO block or a function body is out of its
 * reach, and step 6's catalogue test (AG-3.7) holds the trigger and the grants there.
 */
const AUDIT_EVENT_WRITE = [
  /\bUPDATE (ONLY )?(PUBLIC\.)?AUDIT_EVENT\b/,
  /\bDELETE FROM (ONLY )?(PUBLIC\.)?AUDIT_EVENT\b/,
  /^TRUNCATE\b.*(?<!")\bAUDIT_EVENT\b(?!")/,
  /^GRANT .* ON (TABLE )?([A-Z0-9_$."]+, )*(PUBLIC\.)?AUDIT_EVENT\b/,
  /^GRANT .* ON ALL TABLES IN SCHEMA PUBLIC\b/,
  /^DROP TABLE\b.*(?<!")\bAUDIT_EVENT\b(?!")/,
  /^ALTER TABLE (IF EXISTS )?(ONLY )?(PUBLIC\.)?AUDIT_EVENT\b.*\b(DISABLE TRIGGER|ENABLE REPLICA TRIGGER|OWNER TO)\b/,
  /^(CREATE OR REPLACE|DROP|ALTER) TRIGGER\b.* ON (ONLY )?(PUBLIC\.)?AUDIT_EVENT\b/,
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The comment line that allows one audit_event statement; it sits directly above it. */
export const AUDIT_EVENT_MARKER = '-- audit_event change:';

/** Rule 4 over one file. @param name the file name inside db/migrations */
export function checkSql(name: string, sql: string): string[] {
  const path = `${MIGRATIONS_DIR}/${name}`;
  const allowed = new Set(GRANDFATHERED.filter((g) => g.file === name).map((g) => g.rule));
  const findings: { rule: SqlRule; text: string }[] = [];
  const add = (rule: SqlRule, line: number, text: string): void => {
    findings.push({ rule, text: `${path}:${line} ${text}` });
  };
  const lines = sql.split('\n');
  const { code, strings } = scanSql(sql);
  const needsLocksHeader =
    (migrationNumber(name) ?? 0) >= LOCKS_HEADER_FROM && !hasLocksHeader(lines);

  code.split('\n').forEach((text, index) => {
    if (/\bCONCURRENTLY\b/i.test(text)) {
      add(
        'concurrently',
        index + 1,
        "uses CONCURRENTLY, which PostgreSQL refuses inside a transaction block, and the runner runs each migration in one transaction with its schema_migrations row. Build the index without CONCURRENTLY and declare the lock in the file's `-- Locks:` header; if the table is too large to lock, raise it in the pull request first.",
      );
    }
  });

  if ((migrationNumber(name) ?? 0) >= RUNNER_GUARDS_FROM) {
    // The guards are DO blocks, whose bodies the scan blanks: read the lines as written.
    lines.forEach((text, index) => {
      const guard = PASTED_GUARD.exec(text.replace(/--.*$/, ''));
      if (guard === null) return;
      add(
        'pasted-guard',
        index + 1,
        `pastes the "${guard[1] ?? ''}" guard that ends the migrations up to 0014. Delete the DO block: the migration runner checks this itself after every file and before its COMMIT, and rolls the file back when it does not hold (assertSchemaInvariants in packages/db/src/schema-invariants.ts). A copy only checks less: the sec.* copies before 0014 pass a function with no SET clause (EAX-12).`,
      );
    });
  }

  const created = new Set<string>();
  let switchOpenedAt: number | undefined;
  for (const s of statements(code)) {
    if (/^VACUUM\b/.test(s.text)) {
      add(
        'vacuum',
        s.line,
        'runs VACUUM, which PostgreSQL refuses inside a transaction block, and the runner runs each migration in one. Leave it to autovacuum or run it by hand after the deploy; ANALYZE <table> runs inside a transaction if the planner needs fresh statistics.',
      );
    }
    if (TRANSACTION_CONTROL.test(s.text)) {
      add(
        'transaction-control',
        s.line,
        `controls the transaction (${s.text.split(' ')[0] ?? ''}). The runner wraps each file in one transaction together with its schema_migrations row, so this would commit or abort part of a migration without its record. Remove it; split work that must commit separately into two migrations.`,
      );
    }
    if (ROLE_DDL.test(s.text)) {
      add(
        'role-ddl',
        s.line,
        'creates, alters or drops a role. Roles are cluster-wide and are created in infra/postgres/init/01-roles.sh, not by a migration (AGENTS.md section 1); change that script and say in the pull request how existing clusters get the change.',
      );
    }
    if (/^SET LOCAL ROLE TINNOX_DEFINER$/.test(s.text)) switchOpenedAt = s.line;
    else if (/^SET (SESSION )?ROLE\b/.test(s.text)) {
      // Whatever role it sets, the statements after it no longer run as tinnox_definer.
      switchOpenedAt = undefined;
      add(
        'sec-ddl-outside-switch',
        s.line,
        'switches role without LOCAL. Use `SET LOCAL ROLE tinnox_definer;` so the switch ends with the transaction even when the migration fails, and close it with `RESET ROLE;`.',
      );
    } else if (/^SET LOCAL ROLE\b/.test(s.text)) {
      switchOpenedAt = undefined;
      add(
        'sec-ddl-outside-switch',
        s.line,
        'switches to a role other than tinnox_definer. A migration runs as tinnox_migrator, and its only role switch is `SET LOCAL ROLE tinnox_definer;` ... `RESET ROLE;` around sec.* function DDL, as db/migrations/0014_display_alerts.sql does (AGENTS.md sections 1 and 4).',
      );
    } else if (/^RESET ROLE$/.test(s.text)) switchOpenedAt = undefined;
    if (SEC_DDL.test(s.text) && switchOpenedAt === undefined) {
      add(
        'sec-ddl-outside-switch',
        s.line,
        'changes a sec.* function outside the role switch. Put sec.* function DDL (CREATE, ALTER, DROP, COMMENT, GRANT and REVOKE) between `SET LOCAL ROLE tinnox_definer;` and `RESET ROLE;`, as db/migrations/0014_display_alerts.sql does, so tinnox_definer owns the function and nothing else does (AGENTS.md section 1).',
      );
    }
    if (AUDIT_EVENT_WRITE.some((pattern) => pattern.test(s.text)) && !marked(lines, s.line)) {
      add(
        'audit-event',
        s.line,
        `grants on, writes to, drops, changes the owner of, or replaces, drops or disables a trigger of audit_event, which is append-only: tinnox_app keeps INSERT and SELECT only, and the audit_event_no_update trigger stays (AGENTS.md sections 1 and 3). If it is truly needed, put the comment line \`${AUDIT_EVENT_MARKER} <why>\` directly above the statement and say why in the pull request.`,
      );
    }
    const create = /^CREATE (UNLOGGED )?TABLE (IF NOT EXISTS )?(PUBLIC\.)?"?([A-Z0-9_]+)/.exec(
      s.text,
    );
    if (create?.[4] !== undefined) created.add(create[4]);
    const alter = /^ALTER TABLE (IF EXISTS )?(ONLY )?([A-Z0-9_]+\.)?"?([A-Z0-9_]+)/.exec(s.text);
    if (alter?.[4] !== undefined && !created.has(alter[4]) && needsLocksHeader) {
      add(
        'locks-header',
        s.line,
        `alters the existing table ${alter[4].toLowerCase()}, and the file's header has no \`-- Locks:\` line. Add one to the opening comment saying which tables it locks, in which mode, whether it rewrites or scans them, and whether to run it while the API is stopped or idle (AGENTS.md section 4).`,
      );
    }
  }
  if (switchOpenedAt !== undefined) {
    add(
      'sec-ddl-outside-switch',
      switchOpenedAt,
      'opens `SET LOCAL ROLE tinnox_definer;` and never closes it. End the switch with `RESET ROLE;` so the statements after it run as the migrator again.',
    );
  }
  for (const s of strings) {
    if (UUID.test(s.value)) {
      add(
        'uuid-literal',
        s.line,
        `has the UUID literal '${UUID.exec(s.value)?.[0] ?? ''}'. A migration must not depend on rows that exist only in development (the seed's ids): select rows by a stable key, or create what the migration needs in the migration itself.`,
      );
    }
  }
  // One locks-header finding per file is enough.
  let locksSeen = false;
  return findings
    .filter((f) => !allowed.has(f.rule))
    .filter((f) => {
      if (f.rule !== 'locks-header') return true;
      if (locksSeen) return false;
      locksSeen = true;
      return true;
    })
    .map((f) => f.text);
}

/** True when the comment block directly above the statement carries the audit_event marker. */
function marked(lines: readonly string[], statementLine: number): boolean {
  for (let k = statementLine - 2; k >= 0; k -= 1) {
    const line = (lines[k] ?? '').trim();
    if (!line.startsWith('--')) return false;
    if (line.startsWith(AUDIT_EVENT_MARKER) && line.length > AUDIT_EVENT_MARKER.length + 1) {
      return true;
    }
  }
  return false;
}

/** The opening comment block (before the first statement) has a `-- Locks:` line. */
function hasLocksHeader(lines: readonly string[]): boolean {
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) return false;
    if (/^--\s*Locks:\s*\S/.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Rule 5: db/upgrade-tests.json

export interface UpgradeTestEntry {
  readonly file: string;
  /** The integration test that upgrades a populated database through this migration. */
  readonly test?: string;
  /** Why it has no test of its own, or how the named test covers it. */
  readonly reason?: string;
}

/** Paths the integration project runs (vitest.config.ts). */
const INTEGRATION_TEST =
  /^((packages|apps)\/[^/]+\/test\/.+\.integration\.test\.ts|tests\/integration\/.+\.test\.ts)$/;

/**
 * @param names the migration file names in the working tree
 * @param text the contents of db/upgrade-tests.json, or undefined when it is missing
 * @param readTest the text of a repository file, or undefined when it is not a file
 */
export function checkUpgradeTests(
  names: readonly string[],
  text: string | undefined,
  readTest: (path: string) => string | undefined,
): string[] {
  const how = `Each entry is { "file": "NNNN_description.sql", "test": "packages/db/test/migration-NNNN.integration.test.ts" } for a migration that changes existing rows (as migration-0014.integration.test.ts does), or { "file": ..., "reason": "..." } saying why it needs no upgrade test.`;
  if (text === undefined) {
    return [
      `${UPGRADE_TESTS_PATH} is missing. It lists every migration, sorted by file name, under "migrations". ${how}`,
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [
      `${UPGRADE_TESTS_PATH} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix it; if a merge conflicted here, keep both entries in file-name order.`,
    ];
  }
  const list =
    typeof parsed === 'object' && parsed !== null && 'migrations' in parsed
      ? parsed.migrations
      : undefined;
  if (!Array.isArray(list)) {
    return [`${UPGRADE_TESTS_PATH} has no "migrations" array. ${how}`];
  }
  const findings: string[] = [];
  const at = (file: string): string => {
    const index = text.split('\n').findIndex((l) => l.includes(`"${file}"`));
    return index === -1 ? UPGRADE_TESTS_PATH : `${UPGRADE_TESTS_PATH}:${index + 1}`;
  };
  const listed = new Set<string>();
  let previous: string | undefined;
  for (const raw of list as unknown[]) {
    const entry = raw as Partial<Record<keyof UpgradeTestEntry, unknown>>;
    if (typeof raw !== 'object' || raw === null || typeof entry.file !== 'string') {
      findings.push(`${UPGRADE_TESTS_PATH}: every entry needs a "file". ${how}`);
      continue;
    }
    const file = entry.file;
    const extra = Object.keys(raw).filter((k) => !['file', 'test', 'reason'].includes(k));
    if (extra.length > 0) {
      findings.push(
        `${at(file)} ${file} has unknown keys (${extra.join(', ')}); an entry has only "file", "test" and "reason".`,
      );
    }
    if (listed.has(file)) {
      findings.push(`${at(file)} ${file} is listed twice; keep one entry per migration.`);
    } else if (previous !== undefined && file < previous) {
      findings.push(
        `${at(file)} ${file} comes after ${previous}. Keep the entries sorted by file name: two branches that add the same number then conflict on this file at merge (D12).`,
      );
    }
    listed.add(file);
    previous = file;
    if (!names.includes(file)) {
      findings.push(
        `${at(file)} ${file} is not in ${MIGRATIONS_DIR}. Remove the entry, or correct its file name.`,
      );
    }
    const test = entry.test;
    const reason = entry.reason;
    if (test !== undefined) {
      if (typeof test !== 'string' || !INTEGRATION_TEST.test(test)) {
        findings.push(
          `${at(file)} ${file}: "test" must name an integration test file (packages/<name>/test/*.integration.test.ts or tests/integration/*.test.ts), because an upgrade test needs a database.`,
        );
      } else {
        const body = readTest(test);
        const number = file.slice(0, 4);
        if (body === undefined) {
          findings.push(
            `${at(file)} ${file} names ${test}, which does not exist. Name the test that upgrades a populated database through it, or give a "reason" instead.`,
          );
        } else if (!body.includes(file) && !new RegExp(`\\b${number}\\b`).test(body)) {
          // A test that names neither the file nor its number does not upgrade through it (CHK-4).
          findings.push(
            `${at(file)} ${file} names ${test}, which mentions neither ${file} nor ${number}. Name the test that upgrades a populated database through this migration (it names the file, as migration-0014.integration.test.ts does), or give a "reason" instead.`,
          );
        }
      }
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
      findings.push(`${at(file)} ${file}: "reason" must be a sentence, not empty.`);
    }
    if (test === undefined && reason === undefined) {
      findings.push(`${at(file)} ${file} has neither "test" nor "reason". ${how}`);
    }
  }
  for (const name of [...names].sort()) {
    if (!listed.has(name)) {
      findings.push(
        `${MIGRATIONS_DIR}/${name} has no entry in ${UPGRADE_TESTS_PATH}. Add one in file-name order. ${how}`,
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Mode

export type Mode = 'branch' | 'main';

/**
 * Main mode on a push to main (or a run started on it), and locally on a checkout of main;
 * branch mode everywhere else, a pull request included (its ref is refs/pull/N/merge).
 */
export function chooseMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  currentBranch: string | undefined,
): Mode {
  if (argv.includes('--main')) return 'main';
  if (argv.includes('--branch')) return 'branch';
  if (env.GITHUB_ACTIONS === 'true')
    return env.GITHUB_REF === 'refs/heads/main' ? 'main' : 'branch';
  return currentBranch === 'main' ? 'main' : 'branch';
}

// ---------------------------------------------------------------------------------------------
// Reading the repository

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function git(root: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitOk(root: string, args: readonly string[]): string {
  const result = git(root, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

/** name -> blob id of every file under db/migrations at a commit. */
export function migrationsAt(root: string, rev: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of gitOk(root, ['ls-tree', '-r', '-z', rev, '--', `${MIGRATIONS_DIR}/`]).split(
    '\0',
  )) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const blob = line.slice(0, tab).split(' ')[2] ?? '';
    map.set(line.slice(tab + 1).slice(MIGRATIONS_DIR.length + 1), blob);
  }
  return map;
}

/**
 * name -> blob id of every file under db/migrations in the working tree: tracked files and new
 * files that are not ignored, so an uncommitted edit counts too.
 */
export function workingMigrations(root: string): Map<string, string> {
  const paths = gitOk(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    `${MIGRATIONS_DIR}/`,
  ])
    .split('\0')
    .filter((p) => p !== '' && existsSync(join(root, p)) && lstatSync(join(root, p)).isFile());
  const unique = [...new Set(paths)].sort();
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  // --no-filters hashes the bytes on disk, which the runner's checksum also reads.
  const blobs = gitOk(root, ['hash-object', '--no-filters', '--', ...unique])
    .trim()
    .split('\n');
  unique.forEach((p, k) => map.set(p.slice(MIGRATIONS_DIR.length + 1), blobs[k] ?? ''));
  return map;
}

/** Changes to db/migrations other than additions on the first-parent history of HEAD. */
export function firstParentChanges(root: string): HistoryChange[] {
  const out = gitOk(root, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--diff-filter=DMRT',
    '--find-renames',
    '--name-status',
    '--no-show-signature',
    '--format=%x1e%H%x1f%P%x1f%s',
    'HEAD',
    '--',
    MIGRATIONS_DIR,
  ]);
  const changes: HistoryChange[] = [];
  for (const chunk of out.split('\x1e')) {
    const [head = '', ...rest] = chunk.split('\n');
    const [commit = '', parents = '', subject = ''] = head.split('\x1f');
    if (commit === '') continue;
    const merge = parents.trim().split(' ').length > 1;
    for (const line of rest) {
      const [status, path, renamedTo] = line.split('\t');
      if (status === undefined || status === '' || path === undefined) continue;
      changes.push(
        renamedTo === undefined
          ? { commit, subject, status, path, merge }
          : { commit, subject, status, path, renamedTo, merge },
      );
    }
  }
  return changes;
}

export interface Report {
  readonly findings: readonly string[];
  readonly summary: string;
}

/** Runs every rule for one mode over the repository at `root`. */
export function checkRepository(root: string, mode: Mode): Report {
  if (git(root, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true') {
    return {
      findings: [
        `check:migrations needs the whole history, and this clone is shallow. Run \`git fetch --unshallow origin\`; in CI the quality job's checkout needs \`fetch-depth: 0\` (.github/workflows/ci.yml).`,
      ],
      summary: '',
    };
  }
  const current = workingMigrations(root);
  const names = [...current.keys()].sort();
  const read = (path: string): string | undefined => {
    const full = join(root, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  };
  const exists = (path: string): boolean => {
    const full = join(root, path);
    return existsSync(full) && lstatSync(full).isFile();
  };
  const sqlNames = names.filter((n) => migrationNumber(n) !== undefined);
  const common = [
    ...checkNames(names),
    ...sqlNames.flatMap((n) => checkSql(n, read(`${MIGRATIONS_DIR}/${n}`) ?? '')),
    ...checkUpgradeTests(sqlNames, read(UPGRADE_TESTS_PATH), (path) =>
      exists(path) ? read(path) : undefined,
    ),
  ];

  if (mode === 'main') {
    // An uncommitted edit on a local checkout of main is compared with HEAD.
    const head = migrationsAt(root, 'HEAD');
    const findings = [
      ...checkHistory(firstParentChanges(root)),
      ...checkAppendOnly(head, current, nextNumber(names)),
      ...common,
    ];
    return {
      findings,
      summary: `main mode, first-parent history of HEAD: ${names.length} migrations`,
    };
  }

  const resolved = git(root, ['rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`]);
  if (resolved.status !== 0) {
    return {
      findings: [
        `check:migrations compares this branch with ${MAIN_REF}, and this checkout has no ${MAIN_REF}. Run \`git fetch origin main\`; in CI the quality job's checkout needs \`fetch-depth: 0\` (.github/workflows/ci.yml).`,
      ],
      summary: '',
    };
  }
  const base = git(root, ['merge-base', 'HEAD', MAIN_REF]);
  if (base.status !== 0) {
    return {
      findings: [
        `check:migrations found no merge-base of HEAD and ${MAIN_REF}. Fetch the whole history (\`git fetch --unshallow origin\`, or \`fetch-depth: 0\` in CI) and branch from main.`,
      ],
      summary: '',
    };
  }
  const baseSha = base.stdout.trim();
  const atBase = migrationsAt(root, baseSha);
  const onMain = migrationsAt(root, MAIN_REF);
  const findings = [
    ...checkAppendOnly(atBase, current, nextNumber(names, [...onMain.keys()])),
    ...checkAddedNumbers(names, [...atBase.keys()], [...onMain.keys()]),
    ...common,
  ];
  return {
    findings,
    summary: `branch mode, against merge-base ${baseSha.slice(0, 12)} of HEAD and ${MAIN_REF}: ${names.length} migrations`,
  };
}
