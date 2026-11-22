/**
 * The invariants the schema holds after every migration (poteto adoption plan section 3.3, review
 * finding EAX-12). Until 0014 each migration pasted them as `DO` blocks at its end: forced
 * row-level security, the `sec.*` hardening, a tenant policy on each new table and no disabled
 * trigger. The six copies of the `sec.*` block before 0014 pass a function with no SET clause,
 * because `NOT (... proconfig @> ...)` is NULL, not true, when proconfig is NULL; merged
 * migrations cannot change, so those copies stay as they are.
 *
 * The migration runner now checks them itself (assertSchemaInvariants, called by runMigrations in
 * ./migrate.ts for every file before its COMMIT), so a new migration does not paste a guard.
 * packages/db/test/catalogue.integration.test.ts reads the same facts and applies the same
 * rules, so the check at deploy time and the test cannot drift.
 *
 * As ./pool.ts does for the runtime role: one reader of the catalogue (readSchemaFacts) and pure
 * rules over what it read (schemaInvariantProblems). The rules decide in TypeScript, where a
 * missing value is `null` and has to be handled, not in SQL, where it silently makes a
 * predicate neither true nor false.
 */
import type pg from 'pg';

const RUNTIME_ROLE = 'tinnox_app';
const DEFINER_ROLE = 'tinnox_definer';
/** The one setting every sec.* function carries, as pg_proc.proconfig stores it. */
const PINNED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
/** The search_path readSchemaFacts needs: PostgreSQL then prints every name with its schema. */
const READER_SEARCH_PATH = 'pg_catalog';
/** Where an author finds the pattern to copy. */
const EXAMPLE = 'db/migrations/0014_display_alerts.sql';

/** Every schema that is not PostgreSQL's own (temporary schemas are); `n` is a pg_namespace row. */
const OURS = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;

/**
 * How the ACL entry `x` reaches the runtime role, whose pg_roles row is `app`: '' when it is the
 * grantee, a suffix when the grantee is PUBLIC or a role it is a member of (inherited or not:
 * it could SET ROLE), NULL when the entry gives it nothing. A CASE, so pg_has_role never sees
 * PUBLIC's oid 0; a database without the role has a NULL `app` and still counts PUBLIC.
 */
const REACHES_RUNTIME = `CASE WHEN x.grantee = 0 THEN ' through PUBLIC'
                              WHEN x.grantee = app.oid THEN ''
                              WHEN pg_has_role(app.oid, x.grantee, 'MEMBER')
                                THEN ' through ' || pg_get_userbyid(x.grantee)::text
                         END`;

/** A function in schema sec. */
export interface SecFunctionFacts {
  /** With its schema and argument types, as regprocedure prints it: `sec.session_revoke(bytea)`. */
  readonly name: string;
  readonly securityDefiner: boolean | null;
  readonly owner: string;
  /** pg_proc.proconfig: the SET clauses of the definition, `null` when it has none. */
  readonly settings: readonly string[] | null;
  /**
   * Who may execute it besides its owner, `PUBLIC` included, sorted; a grantee who may pass
   * the right on reads `<role> WITH GRANT OPTION`.
   */
  readonly executors: readonly string[];
}

/** An object owned by tinnox_app or tinnox_definer. */
export interface OwnedObjectFacts {
  readonly owner: string;
  /** As pg_describe_object prints it: `table public.media`, `function sec.audit_scoped(...)`. */
  readonly object: string;
  /** True for a function in schema sec, the one thing tinnox_definer owns. */
  readonly secFunction: boolean;
}

/** A table of ours; the runner's own `public.schema_migrations` is not read. */
export interface TableFacts {
  /** With its schema: `public.media`. */
  readonly name: string;
  readonly rowSecurity: boolean;
  readonly forced: boolean;
  /** Each policy as `name FOR command PERMISSIVE|RESTRICTIVE TO {roles} USING x WITH CHECK y`. */
  readonly policies: readonly string[];
  /**
   * What tinnox_app can use on the table or on a column of it: `SELECT`, `UPDATE (name)`. A
   * privilege it has through a grant to PUBLIC, or to a role it is a member of, counts and reads
   * `SELECT through PUBLIC`, `SELECT (name) through some_role`.
   */
  readonly runtimePrivileges: readonly string[];
}

/** What readSchemaFacts reads from the catalogue. */
export interface SchemaFacts {
  readonly secFunctions: readonly SecFunctionFacts[];
  /** In this database, and shared objects (databases, tablespaces). */
  readonly owned: readonly OwnedObjectFacts[];
  /** SECURITY DEFINER functions outside schema sec, as regprocedure prints them. */
  readonly definersOutsideSec: readonly string[];
  readonly tables: readonly TableFacts[];
  /** User triggers that do not fire in an ordinary session, as `public.media.name [tgenabled = D]`. */
  readonly disabledTriggers: readonly string[];
}

/** The column of a tenant table that holds the organisation: `organization` is the tenant itself. */
export const tenantOrgColumn = (table: string): string =>
  table === 'public.organization' ? 'id' : 'org_id';

/** The one policy of a tenant table, as readSchemaFacts prints a policy. */
export const tenantPolicy = (table: string): string =>
  `tenant_isolation FOR ALL PERMISSIVE TO {public} USING (${tenantOrgColumn(table)} = public.app_org_id()) ` +
  `WITH CHECK (${tenantOrgColumn(table)} = public.app_org_id())`;

/**
 * AG-1.13, AG-1.15, EAX-12: every function in sec is SECURITY DEFINER, owned by tinnox_definer,
 * pins its search_path and is executable by tinnox_app and by nobody else.
 */
export function secFunctionProblems(facts: SchemaFacts): string[] {
  const problems: string[] = [];
  const inSwitch = `between SET LOCAL ROLE ${DEFINER_ROLE} and RESET ROLE, as ${EXAMPLE} does`;
  for (const fn of facts.secFunctions) {
    if (fn.securityDefiner !== true) {
      problems.push(
        `${fn.name} is in schema sec and is not SECURITY DEFINER: sec holds only the definer functions; put a helper in public.`,
      );
    }
    if (fn.owner !== DEFINER_ROLE) {
      problems.push(
        `${fn.name} is owned by ${fn.owner}, not ${DEFINER_ROLE}: create a sec.* function ${inSwitch}.`,
      );
    }
    // A function created with no SET clause has settings === null, which is "not pinned".
    if (fn.settings?.includes(PINNED_SEARCH_PATH) !== true) {
      problems.push(
        `${fn.name} does not pin its search_path (its SET clauses: ${fn.settings?.join('; ') ?? 'none'}): a SECURITY DEFINER function without it resolves names through the caller's search_path. Define it with SET search_path = pg_catalog, pg_temp and qualify every name in its body.`,
      );
    }
    if (fn.executors.join(', ') !== RUNTIME_ROLE) {
      problems.push(
        `${fn.name} is executable by ${fn.executors.join(', ') || 'nobody but its owner'}, not by ${RUNTIME_ROLE} alone: PostgreSQL gives PUBLIC EXECUTE on every new function. In its migration, ${inSwitch}, run REVOKE ALL ON FUNCTION ${fn.name} FROM PUBLIC and GRANT EXECUTE ON FUNCTION ${fn.name} TO ${RUNTIME_ROLE}.`,
      );
    }
  }
  return problems;
}

/**
 * AG-1.4, AG-1.12: tinnox_app owns nothing, tinnox_definer owns only the functions in sec, and
 * no function outside sec runs with its owner's rights.
 */
export function ownershipProblems(facts: SchemaFacts): string[] {
  return [
    ...facts.owned
      .filter((o) => o.owner === RUNTIME_ROLE)
      .map(
        (o) =>
          `${RUNTIME_ROLE} owns ${o.object}: the runtime role owns nothing. Create it in a migration, which runs as tinnox_migrator, and grant ${RUNTIME_ROLE} only what the feature needs.`,
      ),
    ...facts.owned
      .filter((o) => o.owner === DEFINER_ROLE && !o.secFunction)
      .map(
        (o) =>
          `${DEFINER_ROLE} owns ${o.object}: it owns only the functions in schema sec. Create anything else outside the SET LOCAL ROLE ${DEFINER_ROLE} block of the migration.`,
      ),
    ...facts.definersOutsideSec.map(
      (name) =>
        `${name} is SECURITY DEFINER outside schema sec: only the narrow sec.* functions run with their owner's rights. Make it SECURITY INVOKER, or move it to sec and register it in packages/db/test/catalogue/sec-functions.ts.`,
    ),
  ];
}

/** AG-1.5: row-level security is enabled and forced on every table. */
export function rowSecurityProblems(facts: SchemaFacts): string[] {
  return facts.tables
    .filter((table) => !(table.rowSecurity && table.forced))
    .map(
      (table) =>
        `${table.name} is without forced row-level security: add ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY to its migration. A migration that lifts FORCE for a backfill puts it back before it ends.`,
    );
}

/**
 * AG-2.5: a table the runtime role can use anything on (granted to it, to PUBLIC or to a role
 * it is a member of) is a tenant table and has exactly the tenant policy. A table without such
 * a grant is reached through sec.* functions only.
 */
export function tenantPolicyProblems(facts: SchemaFacts): string[] {
  return facts.tables
    .filter((table) => table.runtimePrivileges.length > 0)
    .filter((table) => table.policies.join('; ') !== tenantPolicy(table.name))
    .map(
      (table) =>
        `${table.name} must have exactly one policy, "${tenantPolicy(table.name)}", and has: ${table.policies.join('; ') || 'none'}. ${RUNTIME_ROLE} holds ${table.runtimePrivileges.join(', ')} on it, so it is a tenant table: copy the CREATE POLICY tenant_isolation block of ${EXAMPLE}. A table that is read before the organisation is known gets no policy and no grant that reaches ${RUNTIME_ROLE} (to it, to PUBLIC or to a role it is a member of); only sec.* functions reach it.`,
    );
}

/** No trigger is left disabled: a migration that disables one for a backfill enables it again. */
export function triggerProblems(facts: SchemaFacts): string[] {
  return facts.disabledTriggers.map(
    (trigger) =>
      `trigger ${trigger} does not fire in an ordinary session: a migration that disables a trigger for a backfill ends with ALTER TABLE ... ENABLE TRIGGER for it.`,
  );
}

/** Every rule the runner enforces, one sentence per offending object, saying what to do. */
export function schemaInvariantProblems(facts: SchemaFacts): string[] {
  return [
    ...secFunctionProblems(facts),
    ...ownershipProblems(facts),
    ...rowSecurityProblems(facts),
    ...tenantPolicyProblems(facts),
    ...triggerProblems(facts),
  ];
}

interface SecFunctionRow {
  name: string;
  security_definer: boolean | null;
  owner: string;
  settings: string[] | null;
  executors: string[];
}
interface OwnedRow {
  owner: string;
  object: string;
  sec_function: boolean;
}
interface TableRow {
  name: string;
  row_security: boolean;
  forced: boolean;
  policies: string[];
  runtime_privileges: string[];
}

/**
 * Reads the facts of schemaInvariantProblems from the catalogue; changes nothing. The session's
 * search_path must be `pg_catalog` alone, or PostgreSQL leaves the schema off the names it can
 * see and the rules would compare other text: the runner sets it for the read only, the
 * catalogue test for its whole session.
 */
export async function readSchemaFacts(client: pg.ClientBase): Promise<SchemaFacts> {
  const path = await client.query<{ search_path: string }>(
    "SELECT current_setting('search_path') AS search_path",
  );
  if (path.rows[0]?.search_path !== READER_SEARCH_PATH) {
    throw new Error(
      `readSchemaFacts needs search_path = ${READER_SEARCH_PATH} and found ` +
        `"${path.rows[0]?.search_path ?? ''}": run SET LOCAL search_path = ${READER_SEARCH_PATH} ` +
        'in the transaction that reads',
    );
  }
  // An ACL that is NULL means PostgreSQL's built-in default, which gives PUBLIC EXECUTE on a
  // function: hence acldefault().
  const secFunctions = await client.query<SecFunctionRow>(
    `SELECT p.oid::regprocedure::text AS name, p.prosecdef AS security_definer,
            pg_get_userbyid(p.proowner)::text AS owner, p.proconfig AS settings,
            ARRAY(SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END
                           || CASE WHEN x.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
                  FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
                  WHERE x.grantee <> p.proowner ORDER BY 1) AS executors
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'sec' ORDER BY 1`,
  );
  // pg_shdepend records the owner of every kind of object, so nothing has to be listed here.
  const owned = await client.query<OwnedRow>(
    `SELECT r.rolname::text AS owner, pg_describe_object(d.classid, d.objid, d.objsubid) AS object,
            EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE d.classid = 'pg_proc'::regclass AND p.oid = d.objid AND n.nspname = 'sec'
                   ) AS sec_function
     FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid
     WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o'
       AND r.rolname IN ('${RUNTIME_ROLE}', '${DEFINER_ROLE}')
       AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
     ORDER BY 1, 2`,
  );
  const definers = await client.query<{ name: string }>(
    `SELECT p.oid::regprocedure::text AS name
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE ${OURS} AND n.nspname <> 'sec' AND p.prosecdef ORDER BY 1`,
  );
  // public.schema_migrations is the runner's own table: it is created before the first
  // migration, without row-level security, and holds no tenant data. A table whose ACL is NULL
  // has PostgreSQL's default, everything for its owner: hence acldefault(), as above.
  const tables = await client.query<TableRow>(
    `SELECT c.oid::regclass::text AS name, c.relrowsecurity AS row_security,
            c.relforcerowsecurity AS forced,
            ARRAY(
              SELECT format('%s FOR %s %s TO %s USING %s WITH CHECK %s', p.polname,
                            CASE p.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                          WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END,
                            CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                            ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END
                                  FROM unnest(p.polroles) AS r ORDER BY 1)::text,
                            coalesce(pg_get_expr(p.polqual, p.polrelid), 'none'),
                            coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'none'))
              FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY p.polname
            ) AS policies,
            ARRAY(
              SELECT x.privilege_type || ${REACHES_RUNTIME}
              FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS x
              WHERE ${REACHES_RUNTIME} IS NOT NULL
              UNION
              SELECT x.privilege_type || ' (' || a.attname || ')' || ${REACHES_RUNTIME}
              FROM pg_attribute a
              CROSS JOIN LATERAL aclexplode(a.attacl) AS x
              WHERE a.attrelid = c.oid AND NOT a.attisdropped AND ${REACHES_RUNTIME} IS NOT NULL
              ORDER BY 1
            ) AS runtime_privileges
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_roles app ON app.rolname = '${RUNTIME_ROLE}'
     WHERE ${OURS} AND c.relkind IN ('r', 'p')
       AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations')
     ORDER BY 1`,
  );
  const triggers = await client.query<{ name: string }>(
    `SELECT c.oid::regclass::text || '.' || g.tgname || ' [tgenabled = ' || g.tgenabled::text || ']' AS name
     FROM pg_trigger g
     JOIN pg_class c ON c.oid = g.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${OURS} AND NOT g.tgisinternal AND g.tgenabled <> 'O' ORDER BY 1`,
  );
  return {
    secFunctions: secFunctions.rows.map((row) => ({
      name: row.name,
      securityDefiner: row.security_definer,
      owner: row.owner,
      settings: row.settings,
      executors: row.executors,
    })),
    owned: owned.rows.map((row) => ({
      owner: row.owner,
      object: row.object,
      secFunction: row.sec_function,
    })),
    definersOutsideSec: definers.rows.map((row) => row.name),
    tables: tables.rows.map((row) => ({
      name: row.name,
      rowSecurity: row.row_security,
      forced: row.forced,
      policies: row.policies,
      runtimePrivileges: row.runtime_privileges,
    })),
    disabledTriggers: triggers.rows.map((row) => row.name),
  };
}

/**
 * The schema is outside its invariants; `problems` has one sentence per offending object, and
 * each names roles and objects only, so a tool can print them as they are.
 */
export class SchemaInvariantError extends Error {
  readonly problems: readonly string[];

  /** @param advice what the reader does next, when the problems alone do not say */
  constructor(problems: readonly string[], advice?: string) {
    super(
      `the schema breaks ${problems.length} invariant${problems.length === 1 ? '' : 's'} ` +
        `(packages/db/src/schema-invariants.ts):\n${problems.map((p) => `  - ${p}`).join('\n')}` +
        (advice === undefined ? '' : `\n${advice}`),
    );
    this.name = 'SchemaInvariantError';
    this.problems = problems;
  }
}

/**
 * The problems of the schema as the open transaction of `client` sees it, its own uncommitted
 * changes included. Must run inside a transaction. The savepoint gives the transaction its
 * search_path back: a deferred trigger that fires at COMMIT must not find the reader's.
 */
export async function schemaProblemsInTransaction(client: pg.ClientBase): Promise<string[]> {
  await client.query('SAVEPOINT schema_invariants');
  try {
    await client.query(`SET LOCAL search_path = ${READER_SEARCH_PATH}`);
    return schemaInvariantProblems(await readSchemaFacts(client));
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT schema_invariants');
    await client.query('RELEASE SAVEPOINT schema_invariants');
  }
}

/**
 * Throws a SchemaInvariantError unless the schema, as the open transaction of `client` sees it,
 * holds every invariant. The migration runner calls it after each file and before that file's
 * COMMIT, so a migration that breaks one is rolled back; no migration pastes a guard for them.
 * A problem that is older than the file refuses it too, as the guards pasted into 0001 to 0014
 * did: nothing is committed on a schema outside the invariants.
 * @param knownBefore problems found before the run began: they are refused too, marked, and
 *   the error says how to get past them.
 */
export async function assertSchemaInvariants(
  client: pg.ClientBase,
  knownBefore: readonly string[] = [],
): Promise<void> {
  const problems = await schemaProblemsInTransaction(client);
  if (problems.length === 0) return;
  const older = problems.filter((problem) => knownBefore.includes(problem));
  throw new SchemaInvariantError(
    problems.map((problem) =>
      older.includes(problem)
        ? `${problem} (It was so before this run: the database was changed outside the migrations.)`
        : problem,
    ),
    older.length === 0
      ? undefined
      : "A problem that was so before this run is not this file's doing, but no file is " +
          'applied while it stands. Put it right by hand as the database administrator, or in a ' +
          'new migration when that migration is the first one pending (a repair behind another ' +
          'pending file is never reached), and run again.',
  );
}
