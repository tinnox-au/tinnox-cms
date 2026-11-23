/**
 * The lists of the audit-debt guard and the SQL it is made of (adoption plan section 2.1 C,
 * step 16; decision D3). What the guard does in a database is in
 * ../test/audit-debt-guard.integration.test.ts; here the lists are pinned, so a new exemption is
 * a change someone has to make on purpose, with its reason.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_DEBT_SQLSTATE,
  CREATE_TRIGGERS,
  EXEMPT_COLUMNS,
  EXEMPT_FUNCTIONS,
  EXEMPT_TABLES,
  NOTE_FUNCTION,
  PAID_FUNCTION,
  REVOKE_FUNCTIONS,
  SETTLE_FUNCTION,
  TEST_SQL_APPLICATION_NAME,
  UNWATCHED_TABLES,
  auditedTables,
  guardSettings,
  staleListProblems,
  unjudgedSql,
} from './audit-debt-guard.ts';

const TABLES = [
  'audit_event',
  'display_alert',
  'display_delivery',
  'folder',
  'heartbeat_log',
  'login_state',
  'media',
  'pairing_session',
  'schema_migrations',
  'session',
];

describe('the exempt lists of the audit-debt guard (D3)', () => {
  it('are the ones D3 and plan section 2.1 C name, each with its reason', () => {
    expect(Object.keys(EXEMPT_TABLES).sort()).toEqual([
      'display_delivery',
      'heartbeat_log',
      'login_state',
    ]);
    expect(
      Object.entries(EXEMPT_COLUMNS).map(([table, columns]) => [table, Object.keys(columns)]),
    ).toEqual([
      ['session', ['last_seen_at']],
      ['pairing_session', ['failed_attempts']],
    ]);
    expect(Object.keys(EXEMPT_FUNCTIONS)).toEqual([
      'sec.session_purge_expired',
      'sec.pairing_purge',
      'sec.heartbeat_log_purge',
    ]);
    const reasons = [
      ...Object.values(EXEMPT_TABLES),
      ...Object.values(EXEMPT_COLUMNS).flatMap((columns) => Object.values(columns)),
      ...Object.values(EXEMPT_FUNCTIONS),
    ];
    for (const reason of reasons) {
      expect(reason, 'an exemption cites the decision that makes it').toMatch(
        /^(D3|plan section 2\.1 C and D3): \S.{20,}/,
      );
    }
  });

  it('name nothing D3 does not name: the noting function lets no table through by name, and skips only what the lists say', () => {
    // A write D3 does not exempt (the alert check's silent close, the pairing expiry mark) is
    // judged until Michael decides it (step 16 report); it never gets a branch of its own here.
    expect(NOTE_FUNCTION).not.toMatch(/TG_TABLE_NAME =/);
    expect(UNWATCHED_TABLES).toEqual(['schema_migrations', 'audit_event']);
  });

  it('audit every other table, a new one included', () => {
    expect(auditedTables(TABLES)).toEqual([
      'display_alert',
      'folder',
      'media',
      'pairing_session',
      'session',
    ]);
    expect(auditedTables([...TABLES, 'a_new_table'])).toContain('a_new_table');
  });

  it('say so when a list names a table that is gone', () => {
    expect(staleListProblems(TABLES)).toEqual([]);
    expect(staleListProblems(TABLES.filter((name) => name !== 'login_state'))).toEqual([
      'EXEMPT_TABLES of packages/db/src/audit-debt-guard.ts names table login_state, which is not in schema public: remove the entry, or rename it with the table.',
    ]);
    expect(
      staleListProblems(TABLES.filter((name) => name !== 'pairing_session')).map(
        (problem) => problem.split(' ')[0],
      ),
    ).toEqual(['EXEMPT_COLUMNS']);
  });

  it('reach the database as settings: the tables to skip, the exempt columns and the purge frames', () => {
    expect(guardSettings()).toEqual({
      skippedTables: 'schema_migrations,audit_event,heartbeat_log,display_delivery,login_state',
      exemptColumns: '{"session":"last_seen_at","pairing_session":"failed_attempts"}',
      purgeStack: String.raw`function (sec\.session_purge_expired|sec\.pairing_purge|sec\.heartbeat_log_purge)\(`,
    });
    // The pattern meets a frame as PG_CONTEXT prints it, and not a function that only has a
    // purge's name in its own.
    const frames = new RegExp(guardSettings().purgeStack);
    expect(
      frames.test('PL/pgSQL function sec.pairing_purge(integer) line 9 at SQL statement'),
    ).toBe(true);
    expect(frames.test('PL/pgSQL function sec.pairing_purge_all() line 2 at SQL statement')).toBe(
      false,
    );
    expect(frames.test('PL/pgSQL function sec.pairing_poll(uuid,bytea,integer) line 20')).toBe(
      false,
    );
  });
});

describe('a connection the guard does not judge', () => {
  it('says why its SQL is not product code', () => {
    expect(unjudgedSql('tries row-level security as the runtime role')).toBe(
      TEST_SQL_APPLICATION_NAME,
    );
    for (const why of ['', 'test', '   because    ']) {
      expect(() => unjudgedSql(why)).toThrow(
        'unjudgedSql needs a reason of at least 20 characters: say why this SQL is not product code, or name the decision that leaves the path unaudited',
      );
    }
  });
});

describe('the SQL of the audit-debt guard', () => {
  const JUDGED = `WHEN (session_user = 'tinnox_app' AND current_setting('application_name') <> '${TEST_SQL_APPLICATION_NAME}')`;

  it('puts a noting trigger and a deferred settling trigger on each audited table, and one on audit_event, for judged sessions only', () => {
    expect(CREATE_TRIGGERS).toMatch(
      /CREATE TRIGGER audit_debt_paid AFTER INSERT ON public\.audit_event\s+FOR EACH ROW WHEN/,
    );
    expect(CREATE_TRIGGERS).toMatch(
      /CREATE TRIGGER audit_debt_note AFTER INSERT OR UPDATE OR DELETE ON public\.%I\s+FOR EACH ROW WHEN/,
    );
    expect(CREATE_TRIGGERS).toMatch(
      /CREATE CONSTRAINT TRIGGER audit_debt_settle AFTER INSERT OR UPDATE OR DELETE ON public\.%I\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW WHEN/,
    );
    expect(CREATE_TRIGGERS.split(JUDGED)).toHaveLength(4);
    // Every table of schema public that is not skipped: a new table is audited without a change here.
    expect(CREATE_TRIGGERS).toContain(
      "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname::text <> ALL (skipped)",
    );
  });

  it('pins the search_path of its functions, runs them as their caller and takes EXECUTE from PUBLIC', () => {
    for (const statement of [NOTE_FUNCTION, PAID_FUNCTION, SETTLE_FUNCTION]) {
      expect(statement).toContain('SET search_path = pg_catalog, pg_temp');
      expect(statement).not.toMatch(/SECURITY DEFINER/i);
    }
    expect(REVOKE_FUNCTIONS).toBe(
      'REVOKE ALL ON FUNCTION public.audit_debt_note(), public.audit_debt_settle(), public.audit_debt_paid() FROM PUBLIC',
    );
  });

  it('refuses with a code no route handles and a message that says what to do', () => {
    expect(AUDIT_DEBT_SQLSTATE).toBe('23U01');
    expect(SETTLE_FUNCTION).toContain("USING ERRCODE = '23U01', CONSTRAINT = 'audit_debt'");
    expect(SETTLE_FUNCTION).toContain(
      'Write the audit row on the same Tx as the change, with auditScoped(tx, event) or auditUnscoped(tx, event) from @tinnox/db',
    );
    expect(SETTLE_FUNCTION).toContain('packages/db/src/audit-debt-guard.ts');
    // It never points a test author at the connection the guard does not judge.
    expect(SETTLE_FUNCTION).not.toMatch(/TEST_SQL|unjudged|testSql|appPool|appClient/);
  });
});
