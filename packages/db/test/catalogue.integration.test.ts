/**
 * The catalogue test (docs/coding_guide/poteto_pyramid/adoption-plan.md, section 3.6): reads
 * the schema after all migrations and fails on a shape, not on a behaviour. Roles, ownership,
 * grants, tenant policies, foreign keys, the audit_event triggers, the `sec` functions, CHECKs
 * over optional values and the columns that hold a member id are enumerated from the system
 * catalogues, so a new table, grant or function cannot be forgotten in a hand-typed list.
 *
 * Each rule is a function that returns one sentence per offending object, saying what to do.
 * The last block breaks every rule once inside a transaction that is rolled back, so each rule
 * is known to fail when its subject is wrong (EAX-11).
 *
 * The registers it compares with are in ./catalogue: grants.json, sec-functions.ts,
 * null-passing-checks.ts and member-references.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg, type Pool } from '../src/index.ts';
import { MEMBER_REFERENCES } from './catalogue/member-references.ts';
import { NULL_PASSING_CHECKS } from './catalogue/null-passing-checks.ts';
import { SEC_FUNCTIONS } from './catalogue/sec-functions.ts';
import { appPool, createOrg, migratorClient, superuserUrl, type TestOrg } from './support.ts';

const GRANTS_FILE = 'packages/db/test/catalogue/grants.json';
const SEC_FILE = 'packages/db/test/catalogue/sec-functions.ts';
const CHECKS_FILE = 'packages/db/test/catalogue/null-passing-checks.ts';
const MEMBERS_FILE = 'packages/db/test/catalogue/member-references.ts';
const HERE = 'packages/db/test/catalogue.integration.test.ts';

/** Every schema that is not PostgreSQL's own; `n` is a pg_namespace row. */
const OURS = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;

/**
 * The runner's own table (packages/db/src/migrate.ts creates it before the first migration):
 * no row-level security and no grant, and it is not a tenant table.
 */
const RUNNER_TABLE = 'public.schema_migrations';

/**
 * Tables with no organisation policy, each with its reason. Row-level security is forced on
 * them with no policy at all, and tinnox_app holds nothing on them: only tinnox_definer, inside
 * a sec.* function, reads them. Every other table is a tenant table.
 */
const NOT_TENANT: Readonly<Record<string, string>> = {
  'public.login_state':
    'A sign-in that has not finished has no organisation; only sec.login_state_* reach it.',
  'public.pairing_claim_failure':
    'A throttle counter that sec.pairing_claim alone reads and writes; it has no organisation column.',
  'public.pairing_session':
    'A pairing session exists before any organisation is known; only sec.pairing_* reach it.',
  'public.session':
    'Read by its cookie hash before the organisation is known; only sec.session_* reach it.',
};

/**
 * Foreign keys into a tenant table that do not carry the organisation, each with its reason
 * (AG-2.6). Keyed by table and constraint name.
 */
const FOREIGN_KEYS_WITHOUT_ORG: Readonly<Record<string, string>> = {
  'public.pairing_claim_failure.pairing_claim_failure_membership_id_fkey':
    'pairing_claim_failure has no org_id (0001, merged): a row is a count for one member, read by sec.pairing_claim only after it has checked that the member belongs to the current organisation, and it points at no other tenant row.',
};

const orgColumn = (table: string): string => (table === 'public.organization' ? 'id' : 'org_id');
const tenantPolicy = (table: string): string =>
  `tenant_isolation FOR ALL PERMISSIVE TO {public} USING (${orgColumn(table)} = public.app_org_id()) ` +
  `WITH CHECK (${orgColumn(table)} = public.app_org_id())`;

/** The three roles of infra/postgres/init/01-roles.sh, attribute by attribute (AG-1.1, AG-1.11). */
const ROLES = [
  {
    rolname: 'tinnox_app',
    rolcanlogin: true,
    rolbypassrls: false,
    rolconfig: [
      'idle_in_transaction_session_timeout=30s',
      'lock_timeout=5s',
      'statement_timeout=15s',
    ],
  },
  { rolname: 'tinnox_definer', rolcanlogin: false, rolbypassrls: true, rolconfig: null },
  {
    rolname: 'tinnox_migrator',
    rolcanlogin: true,
    rolbypassrls: false,
    rolconfig: ['lock_timeout=30s'],
  },
].map((role) => ({
  ...role,
  rolsuper: false,
  rolinherit: true,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolconnlimit: -1,
  rolvaliduntil: null,
}));

/** The only membership: the migrator may SET ROLE to the definer and inherits nothing (D4). */
const MEMBERSHIPS = [
  {
    member: 'tinnox_migrator',
    role: 'tinnox_definer',
    inherit_option: false,
    set_option: true,
    admin_option: false,
  },
];

/** The triggers on audit_event, as pg_get_triggerdef prints them (AG-3.7). */
const AUDIT_TRIGGERS = [
  'CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.reject_change()',
  'CREATE TRIGGER audit_event_stamp BEFORE INSERT ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.audit_event_stamp()',
];
/**
 * Their functions: language, settings and body with white space collapsed. The migration text
 * check cannot see a body replaced by CREATE OR REPLACE (plan section 6.1, CHK-2).
 */
const AUDIT_TRIGGER_FUNCTIONS = [
  'public.audit_event_stamp(): plpgsql SET search_path=pg_catalog, pg_temp AS BEGIN NEW.occurred_at := pg_catalog.now(); RETURN NEW; END',
  "public.reject_change(): plpgsql SET search_path=pg_catalog, pg_temp AS BEGIN RAISE EXCEPTION '% on table % is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END",
];

let pool: Pool;
let arrange: pg.Client;
/** tinnox_migrator; every rule reads through it. */
let catalogue: pg.Client;
/** The superuser, for the changes of the last block, each of which is rolled back. */
let admin: pg.Client;

beforeAll(async () => {
  pool = appPool();
  arrange = await migratorClient();
  catalogue = await migratorClient();
  admin = new pg.Client({ connectionString: superuserUrl() });
  await admin.connect();
  // With nothing but pg_catalog on the path, PostgreSQL prints every name of ours with its
  // schema, whatever the reader's own search_path is.
  for (const reader of [catalogue, admin]) await reader.query('SET search_path = pg_catalog');
});
afterAll(async () => {
  await pool.end();
  await arrange.end();
  await catalogue.end();
  await admin.end();
});

async function rows<R extends pg.QueryResultRow>(db: pg.Client, text: string): Promise<R[]> {
  return (await db.query<R>(text)).rows;
}
const difference = (left: readonly string[], right: readonly string[]): string[] =>
  left.filter((item) => !right.includes(item));

// ------------------------------------------------------------------ roles

function roleAttributes(db: pg.Client): Promise<pg.QueryResultRow[]> {
  return rows(
    db,
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
            rolbypassrls, rolconnlimit, rolvaliduntil,
            (SELECT array_agg(setting ORDER BY setting) FROM unnest(rolconfig) AS setting) AS rolconfig
     FROM pg_roles WHERE rolname LIKE 'tinnox\\_%' ORDER BY rolname`,
  );
}

/** Every membership that has a tinnox_ role on either side (SEC-6). */
function roleMemberships(db: pg.Client): Promise<pg.QueryResultRow[]> {
  return rows(
    db,
    `SELECT m.rolname AS member, r.rolname AS role, a.inherit_option, a.set_option, a.admin_option
     FROM pg_auth_members a
     JOIN pg_roles r ON r.oid = a.roleid
     JOIN pg_roles m ON m.oid = a.member
     WHERE r.rolname LIKE 'tinnox\\_%' OR m.rolname LIKE 'tinnox\\_%'
     ORDER BY 1, 2`,
  );
}

// -------------------------------------------------------------- ownership

/** AG-1.4, AG-1.8, AG-1.12: who owns what, and where SECURITY DEFINER functions live. */
async function ownershipProblems(db: pg.Client): Promise<string[]> {
  // pg_shdepend records the owner of every kind of object, so nothing has to be listed here.
  const owned = await rows<{ owner: string; object: string; sec_function: boolean }>(
    db,
    `SELECT r.rolname AS owner, pg_describe_object(d.classid, d.objid, d.objsubid) AS object,
            EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE d.classid = 'pg_proc'::regclass AND p.oid = d.objid AND n.nspname = 'sec'
                   ) AS sec_function
     FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid
     WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o'
       AND r.rolname IN ('tinnox_app', 'tinnox_definer')
       AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
     ORDER BY 1, 2`,
  );
  const expected = await rows<{ object: string; owner: string; expected: string }>(
    db,
    `SELECT object, owner, expected FROM (
       SELECT 'database ' || d.datname AS object, pg_get_userbyid(d.datdba) AS owner, 'tinnox_migrator' AS expected
       FROM pg_database d WHERE d.datname = current_database()
       UNION ALL
       SELECT 'schema ' || n.nspname, pg_get_userbyid(n.nspowner), 'tinnox_migrator'
       FROM pg_namespace n WHERE ${OURS}
       UNION ALL
       SELECT 'relation ' || c.oid::regclass::text, pg_get_userbyid(c.relowner), 'tinnox_migrator'
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${OURS}
       UNION ALL
       SELECT 'function ' || p.oid::regprocedure::text, pg_get_userbyid(p.proowner),
              CASE WHEN n.nspname = 'sec' THEN 'tinnox_definer' ELSE 'tinnox_migrator' END
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${OURS}
     ) AS o WHERE owner <> expected ORDER BY 1`,
  );
  const misplaced = await rows<{ name: string; definer: boolean; in_sec: boolean }>(
    db,
    `SELECT p.oid::regprocedure::text AS name, p.prosecdef AS definer, n.nspname = 'sec' AS in_sec
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE ${OURS} AND p.prosecdef <> (n.nspname = 'sec') ORDER BY 1`,
  );
  const schemas = await rows<{ name: string }>(
    db,
    `SELECT n.nspname AS name FROM pg_namespace n
     WHERE ${OURS} AND n.nspname NOT IN ('public', 'sec') ORDER BY 1`,
  );
  return [
    ...owned
      .filter((o) => o.owner === 'tinnox_app')
      .map(
        (o) =>
          `tinnox_app owns ${o.object}: the runtime role owns nothing. Create it in a migration, which runs as tinnox_migrator, and grant tinnox_app only what the feature needs.`,
      ),
    ...owned
      .filter((o) => o.owner === 'tinnox_definer' && !o.sec_function)
      .map(
        (o) =>
          `tinnox_definer owns ${o.object}: it owns only the functions in schema sec. Create anything else outside the SET LOCAL ROLE tinnox_definer block of the migration.`,
      ),
    ...expected.map(
      (o) =>
        `${o.object} is owned by ${o.owner}, not ${o.expected}: tinnox_migrator owns the schema and tinnox_definer the functions in sec (create those between SET LOCAL ROLE tinnox_definer and RESET ROLE, as db/migrations/0014_display_alerts.sql does).`,
    ),
    ...misplaced.map((f) =>
      f.definer
        ? `${f.name} is SECURITY DEFINER outside schema sec: only the narrow sec.* functions run with their owner's rights. Make it SECURITY INVOKER, or move it to sec and register it in ${SEC_FILE}.`
        : `${f.name} is in schema sec and is not SECURITY DEFINER: sec holds only the definer functions; put a helper in public.`,
    ),
    ...schemas.map(
      (s) =>
        `schema ${s.name} is new: the rules in ${HERE} know public and sec only. Put the objects in public, or teach this file the new schema.`,
    ),
  ];
}

// ----------------------------------------------------------------- grants

interface Privilege {
  readonly grantee: string;
  readonly object: string;
  readonly privilege: string;
}

/**
 * Every privilege held by anyone but the object's owner: on this database, on our schemas and
 * on the tables, columns, sequences, functions and types in them, plus default privileges. An
 * object whose ACL is NULL has PostgreSQL's built-in default (EXECUTE for PUBLIC on a function,
 * for one), hence acldefault().
 */
function readPrivileges(db: pg.Client): Promise<Privilege[]> {
  return rows<Privilege>(
    db,
    `WITH ours AS (SELECT n.oid FROM pg_namespace n WHERE ${OURS}),
     objects (object, owner, acl, col) AS (
       SELECT 'database', d.datdba, coalesce(d.datacl, acldefault('d', d.datdba)), NULL::name
       FROM pg_database d WHERE d.datname = current_database()
       UNION ALL
       SELECT 'schema ' || n.nspname, n.nspowner, coalesce(n.nspacl, acldefault('n', n.nspowner)), NULL
       FROM pg_namespace n WHERE ${OURS}
       UNION ALL
       SELECT CASE c.relkind WHEN 'S' THEN 'sequence ' WHEN 'v' THEN 'view '
                             WHEN 'm' THEN 'materialized view ' WHEN 'f' THEN 'foreign table '
                             ELSE 'table ' END || c.oid::regclass::text,
              c.relowner,
              coalesce(c.relacl,
                       acldefault(CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END::"char", c.relowner)),
              NULL
       FROM pg_class c JOIN ours ON ours.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       UNION ALL
       SELECT 'table ' || c.oid::regclass::text, c.relowner, a.attacl, a.attname
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN ours ON ours.oid = c.relnamespace
       WHERE a.attacl IS NOT NULL AND NOT a.attisdropped
       UNION ALL
       SELECT CASE p.prokind WHEN 'p' THEN 'procedure ' ELSE 'function ' END || p.oid::regprocedure::text,
              p.proowner, coalesce(p.proacl, acldefault('f', p.proowner)), NULL
       FROM pg_proc p JOIN ours ON ours.oid = p.pronamespace
       UNION ALL
       -- Types made for their own sake; a table's row type and array types follow their table.
       SELECT 'type ' || t.oid::regtype::text, t.typowner,
              coalesce(t.typacl, acldefault('T', t.typowner)), NULL
       FROM pg_type t JOIN ours ON ours.oid = t.typnamespace
       WHERE t.typtype <> 'b'
         AND (t.typrelid = 0
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
       UNION ALL
       SELECT 'default for '
                || CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
                                        WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types'
                                        WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END
                || ' created by ' || pg_get_userbyid(d.defaclrole)
                || CASE WHEN d.defaclnamespace = 0 THEN ''
                        ELSE ' in schema ' || d.defaclnamespace::regnamespace::text END,
              d.defaclrole, d.defaclacl, NULL
       FROM pg_default_acl d
     )
     SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
            o.object,
            x.privilege_type
              || CASE WHEN o.col IS NULL THEN '' ELSE ' (' || o.col || ')' END
              || CASE WHEN x.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END AS privilege
     FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) AS x
     WHERE x.grantee <> o.owner
     ORDER BY 1, 2, 3`,
  );
}

interface GrantEntry {
  readonly privileges: readonly string[];
  readonly why?: string;
}
type Snapshot = Readonly<Record<string, Readonly<Record<string, GrantEntry>>>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** grants.json, checked for its shape: `{ grants: { grantee: { object: { privileges, why? } } } }`. */
function readSnapshot(): Snapshot {
  const file: unknown = JSON.parse(
    readFileSync(new URL('./catalogue/grants.json', import.meta.url), 'utf8'),
  );
  const grants = isRecord(file) ? file['grants'] : undefined;
  if (!isRecord(grants)) throw new Error(`${GRANTS_FILE} has no "grants" object`);
  const snapshot: Record<string, Record<string, GrantEntry>> = {};
  for (const [grantee, objects] of Object.entries(grants)) {
    if (!isRecord(objects)) throw new Error(`${GRANTS_FILE}: ${grantee} is not an object`);
    const entries: Record<string, GrantEntry> = {};
    for (const [object, entry] of Object.entries(objects)) {
      const privileges = isRecord(entry) ? entry['privileges'] : undefined;
      const why = isRecord(entry) ? entry['why'] : undefined;
      if (
        !Array.isArray(privileges) ||
        !privileges.every((privilege): privilege is string => typeof privilege === 'string') ||
        (why !== undefined && typeof why !== 'string')
      ) {
        throw new Error(
          `${GRANTS_FILE}: ${grantee} on ${object} must be { "privileges": [...], "why"?: "..." }`,
        );
      }
      entries[object] = why === undefined ? { privileges } : { privileges, why };
    }
    snapshot[grantee] = entries;
  }
  return snapshot;
}

/** AG-1.6: the catalogue's privileges against the snapshot, one sentence per difference. */
function snapshotProblems(actual: readonly Privilege[], snapshot: Snapshot): string[] {
  const line = (p: Privilege): string => `${p.grantee} | ${p.privilege} | ${p.object}`;
  const listed: Privilege[] = Object.entries(snapshot).flatMap(([grantee, objects]) =>
    Object.entries(objects).flatMap(([object, entry]) =>
      entry.privileges.map((privilege) => ({ grantee, object, privilege })),
    ),
  );
  const have = new Set(actual.map(line));
  const want = new Set(listed.map(line));
  return [
    ...actual
      .filter((p) => !want.has(line(p)))
      .map(
        (p) =>
          `${p.grantee} gained ${p.privilege} on ${p.object}. If the feature needs it, update ${GRANTS_FILE} in the same PR and say why in the migration header.` +
          (p.grantee === 'tinnox_definer'
            ? ' A tinnox_definer entry also says in "why" which sec.* function or script uses it.'
            : ''),
      ),
    ...listed
      .filter((p) => !have.has(line(p)))
      .map(
        (p) =>
          `${p.grantee} lost ${p.privilege} on ${p.object}. If the migration means to take it away, remove it from ${GRANTS_FILE} in the same PR.`,
      ),
  ];
}

/** SCR-27, AG-1.18: no grant to tinnox_definer without the name of what uses it. */
function reasonProblems(snapshot: Snapshot): string[] {
  return Object.entries(snapshot['tinnox_definer'] ?? {})
    .filter(([, entry]) => (entry.why ?? '').trim().length < 20)
    .map(
      ([object, entry]) =>
        `tinnox_definer holds ${entry.privileges.join(', ')} on ${object} with no "why" in ${GRANTS_FILE}: name the sec.* function or script that uses it, or drop the grant in a new migration.`,
    );
}

/**
 * AG-1.5, AG-1.7, AG-3.6: limits that hold whatever grants.json says, so that an edit of the
 * snapshot cannot bless them.
 */
function grantLimitProblems(actual: readonly Privilege[]): string[] {
  const problems: string[] = [];
  const audit: string[] = [];
  for (const p of actual) {
    const held = `${p.grantee} holds ${p.privilege} on ${p.object}`;
    const [kind = '', name = ''] = p.object.split(' ');
    if (p.grantee !== 'tinnox_app' && p.grantee !== 'tinnox_definer') {
      problems.push(
        `${held}: only tinnox_app and tinnox_definer are granted anything. PUBLIC holds nothing: 0001 revokes what PostgreSQL gives it by default, and a new function or type that brings such a default needs REVOKE ALL ... FROM PUBLIC in its migration. Grant to one of the two roles, or revoke it in a new migration.`,
      );
    }
    if (p.privilege.endsWith(' WITH GRANT OPTION')) {
      problems.push(`${held}: no role may pass a privilege on. Grant it without the option.`);
    }
    if (p.grantee === 'tinnox_app' && kind === 'table') {
      if (!/^(SELECT|INSERT|UPDATE|DELETE)( \(.+\))?$/.test(p.privilege)) {
        problems.push(
          `${held}: the runtime role gets SELECT, INSERT, UPDATE and DELETE only, never TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.`,
        );
      }
      if (name in NOT_TENANT) {
        problems.push(
          `${held}: tinnox_app reaches a table without an organisation policy only through a sec.* function. Revoke the grant, or give the table a tenant policy and take it out of NOT_TENANT in ${HERE}.`,
        );
      }
    }
    if (p.grantee === 'tinnox_app' && kind === 'schema' && p.privilege !== 'USAGE') {
      problems.push(`${held}: the runtime role may use a schema, never create in it.`);
    }
    if (p.grantee === 'tinnox_app' && p.object === 'database' && p.privilege !== 'CONNECT') {
      problems.push(`${held}: the runtime role may connect and nothing else.`);
    }
    if (p.object === 'table public.audit_event') audit.push(`${p.grantee} ${p.privilege}`);
  }
  const appendOnly = ['tinnox_app INSERT', 'tinnox_app SELECT', 'tinnox_definer INSERT'];
  if (audit.sort().join(', ') !== appendOnly.join(', ')) {
    problems.push(
      `audit_event privileges are [${audit.join(', ')}], not [${appendOnly.join(', ')}]: the audit trail is append-only (AGENTS.md section 3), table-wide INSERT and SELECT for tinnox_app, INSERT for tinnox_definer, and no column grant. Revoke the rest in a new migration.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------- tenant tables

interface TableShape {
  readonly name: string;
  readonly forced: boolean;
  readonly policies: readonly string[];
}

function readTables(db: pg.Client): Promise<TableShape[]> {
  return rows<TableShape>(
    db,
    `SELECT c.oid::regclass::text AS name,
            c.relrowsecurity AND c.relforcerowsecurity AS forced,
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
            ) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${OURS} AND c.relkind IN ('r', 'p') AND c.oid::regclass::text <> '${RUNNER_TABLE}'
     ORDER BY 1`,
  );
}

/** Every table but the runner's own and those of NOT_TENANT: derived, never typed (AG-2.8). */
async function tenantTables(db: pg.Client): Promise<string[]> {
  return (await readTables(db)).map((t) => t.name).filter((name) => !(name in NOT_TENANT));
}

/** AG-2.5: forced row-level security everywhere, and one policy per tenant table. */
async function policyProblems(db: pg.Client): Promise<string[]> {
  const tables = await readTables(db);
  const problems: string[] = [];
  for (const table of tables) {
    if (!table.forced) {
      problems.push(
        `${table.name} is without forced row-level security: add ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY to its migration.`,
      );
    }
    const found = table.policies.length === 0 ? 'none' : table.policies.join('; ');
    if (table.name in NOT_TENANT) {
      if (table.policies.length > 0) {
        problems.push(
          `${table.name} is listed in NOT_TENANT (${HERE}) and has a policy (${found}): a table read before the organisation is known has none, so that only tinnox_definer reads it. Drop the policy, or take the table out of NOT_TENANT.`,
        );
      }
    } else if (found !== tenantPolicy(table.name)) {
      problems.push(
        `${table.name} must have exactly one policy, "${tenantPolicy(table.name)}", and has: ${found}. Copy the CREATE POLICY tenant_isolation block of db/migrations/0014_display_alerts.sql; a table that is read before the organisation is known gets no policy and an entry with its reason in NOT_TENANT (${HERE}).`,
      );
    }
  }
  const names = tables.map((t) => t.name);
  for (const stale of difference(Object.keys(NOT_TENANT), names)) {
    problems.push(`${stale} is in NOT_TENANT (${HERE}) and is not a table: remove the entry.`);
  }
  return problems;
}

/** AG-2.6: a row can only point at a row of its own organisation. */
async function foreignKeyProblems(db: pg.Client): Promise<string[]> {
  const tenant = await tenantTables(db);
  const keys = await rows<{
    name: string;
    from_table: string;
    to_table: string;
    from_columns: string[];
    to_columns: string[];
  }>(
    db,
    `SELECT c.conrelid::regclass::text || '.' || c.conname AS name,
            c.conrelid::regclass::text AS from_table, c.confrelid::regclass::text AS to_table,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                  ORDER BY k.position) AS from_columns,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, position)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                  ORDER BY k.position) AS to_columns
     FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE ${OURS} AND c.contype = 'f' ORDER BY 1`,
  );
  const withoutOrg = keys
    .filter((key) => tenant.includes(key.to_table))
    .filter(
      (key) =>
        !key.from_columns.some(
          (column, i) =>
            column === orgColumn(key.from_table) && key.to_columns[i] === orgColumn(key.to_table),
        ),
    )
    .map((key) => key.name);
  return [
    ...difference(withoutOrg, Object.keys(FOREIGN_KEYS_WITHOUT_ORG)).map(
      (name) =>
        `${name} points into a tenant table without the organisation: reference (id, org_id) from (..., org_id), so that the row cannot point at another organisation's row even when a policy is bypassed (see alert_recipient_created_by_fk in db/migrations/0014_display_alerts.sql).`,
    ),
    ...difference(Object.keys(FOREIGN_KEYS_WITHOUT_ORG), withoutOrg).map(
      (name) =>
        `${name} is in FOREIGN_KEYS_WITHOUT_ORG (${HERE}) and is no longer a foreign key without the organisation: remove the entry.`,
    ),
  ];
}

// ------------------------------------------------------------ audit_event

/** AG-3.6, AG-3.7 and what the migration text check cannot see (CHK-2). */
async function auditProblems(db: pg.Client): Promise<string[]> {
  const triggers = await rows<{ definition: string }>(
    db,
    `SELECT pg_get_triggerdef(t.oid)
              || CASE t.tgenabled WHEN 'O' THEN '' ELSE ' [tgenabled = ' || t.tgenabled::text || ']' END AS definition
     FROM pg_trigger t
     WHERE t.tgrelid = 'public.audit_event'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`,
  );
  const functions = await rows<{ definition: string }>(
    db,
    `SELECT p.oid::regprocedure::text || ': ' || l.lanname
              || CASE WHEN p.prosecdef THEN ' SECURITY DEFINER' ELSE '' END
              || coalesce(' SET ' || array_to_string(p.proconfig, ', '), '')
              || ' AS ' || btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) AS definition
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid IN (SELECT t.tgfoid FROM pg_trigger t
                     WHERE t.tgrelid = 'public.audit_event'::regclass AND NOT t.tgisinternal)
     ORDER BY 1`,
  );
  const rules = await rows<{ name: string }>(
    db,
    `SELECT r.rulename::text AS name FROM pg_rewrite r
     WHERE r.ev_class = 'public.audit_event'::regclass ORDER BY 1`,
  );
  const policies =
    (await readTables(db)).find((t) => t.name === 'public.audit_event')?.policies ?? [];
  const decide =
    'The audit trail is append-only and stamped by the database (AGENTS.md section 3). A change to that needs a decision in docs/decisions-2026-11.md first; then change the expectation in ' +
    `${HERE} in the same PR.`;
  const problems: string[] = [];
  const compare = (what: string, found: readonly string[], want: readonly string[]): void => {
    if (found.join('\n') !== want.join('\n')) {
      problems.push(
        `${what} of audit_event differ.\n  found:    ${found.join('\n            ') || 'none'}\n  expected: ${want.join('\n            ') || 'none'}\n  ${decide}`,
      );
    }
  };
  compare(
    'The triggers',
    triggers.map((t) => t.definition),
    AUDIT_TRIGGERS,
  );
  compare(
    'The trigger functions',
    functions.map((f) => f.definition),
    AUDIT_TRIGGER_FUNCTIONS,
  );
  compare(
    'The rewrite rules',
    rules.map((r) => r.name),
    [],
  );
  compare('The policies', policies, [tenantPolicy('public.audit_event')]);
  return problems;
}

// ---------------------------------------------------------- sec functions

/** AG-1.16, AG-1.14, AG-1.20, EAX-11: the register equals schema sec, result types included. */
async function secRegisterProblems(db: pg.Client): Promise<string[]> {
  const functions = await rows<{ name: string; returns: string }>(
    db,
    `SELECT p.oid::regprocedure::text AS name, pg_get_function_result(p.oid) AS returns
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'sec' ORDER BY 1`,
  );
  const problems: string[] = [];
  for (const fn of functions) {
    const entry = SEC_FUNCTIONS[fn.name];
    if (entry === undefined) {
      problems.push(
        `${fn.name} is not in ${SEC_FILE}: add it with its result type and one line saying why it must run before the organisation is known. A new cross-organisation read is High until justified (AGENTS.md section 1).`,
      );
    } else if (entry.returns !== fn.returns) {
      problems.push(
        `${fn.name} returns ${fn.returns}, and ${SEC_FILE} says ${entry.returns}: a sec.* function returns the minimum. If the caller needs the new result, update the register in the same PR and say why in the migration header.`,
      );
    }
  }
  const names = functions.map((fn) => fn.name);
  for (const [name, entry] of Object.entries(SEC_FUNCTIONS)) {
    if (!names.includes(name)) {
      problems.push(`${name} is in ${SEC_FILE} and not in schema sec: remove or rename the entry.`);
    }
    if (entry.why.trim().length < 20) {
      problems.push(`${name} has no reason in ${SEC_FILE}: say why it must run as tinnox_definer.`);
    }
  }
  return problems;
}

/** AG-1.19: PL/pgSQL bodies are not tracked in pg_depend, so the text is searched. */
async function inviteReaderProblems(db: pg.Client): Promise<string[]> {
  const readers = await rows<{ name: string }>(
    db,
    `SELECT p.oid::regprocedure::text AS name
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'sec' AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~* 'member_invite'
     ORDER BY 1`,
  );
  return readers.map(
    (fn) =>
      `${fn.name} names member_invite: tinnox_definer's rights on that table are for provision-member only, under SET LOCAL ROLE tinnox_definer (AGENTS.md section 1). Read invites as tinnox_app inside withOrg, which the tenant policy keeps to one organisation.`,
  );
}

// ------------------------------------------------------------------ CHECKs

/** `sql` with the content of every string literal removed, so that its operators can be read. */
const withoutLiterals = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, "''");

/** True when the parenthesis that opens `text` closes at its last character. */
function wrapsWhole(text: string): boolean {
  if (!text.startsWith('(')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') depth -= 1;
    if (depth === 0) return i === text.length - 1;
  }
  return false;
}

/**
 * True when the whole expression of a CHECK, as pg_get_constraintdef prints it, is written
 * `(...) IS TRUE`: a NULL result then counts as false and the row is refused (0008).
 */
function refusesNull(definition: string): boolean {
  const match = /^CHECK \((.*)\)(?: NO INHERIT)?(?: NOT VALID)?$/s.exec(
    withoutLiterals(definition),
  );
  let expression = match?.[1] ?? '';
  while (wrapsWhole(expression)) expression = expression.slice(1, -1);
  if (!expression.endsWith(' IS TRUE')) return false;
  const operand = expression.slice(0, -' IS TRUE'.length);
  return wrapsWhole(operand) || /^[\w."]+$/.test(operand);
}

/** A JSON value taken by key, index or path: NULL when the key is absent. */
const readsJsonPath = (definition: string): boolean =>
  /->|#>|_extract_path|jsonb_path_|_array_element|_object_field/.test(withoutLiterals(definition));

/**
 * Some entries rest on another CHECK (display_content_rect_in_canvas on
 * display_content_rect_all_or_none) and say so only in their `why`, which the test cannot read.
 */
const SEARCH_FOR_DEPENDENTS = `Then search ${CHECKS_FILE} for this constraint's name and re-read every entry whose reason rests on it.`;

/** CX-02: a CHECK that passes on a missing value is either written to refuse it or explained. */
async function checkProblems(db: pg.Client): Promise<string[]> {
  const checks = await rows<{ name: string; definition: string; nullable: string[] }>(
    db,
    `SELECT c.conrelid::regclass::text || '.' || c.conname AS name,
            pg_get_constraintdef(c.oid) AS definition,
            ARRAY(SELECT a.attname::text FROM pg_attribute a
                  WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND NOT a.attnotnull
                  ORDER BY a.attname) AS nullable
     FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE ${OURS} AND c.contype = 'c' AND c.conrelid <> 0 ORDER BY 1`,
  );
  /** What an entry judges: the expression and the columns in it that may be NULL. */
  const judged = (check: { definition: string; nullable: readonly string[] }): string =>
    `${check.definition} over the nullable columns [${[...check.nullable].sort().join(', ')}]`;
  const problems: string[] = [];
  const passing = checks.filter(
    (check) =>
      (check.nullable.length > 0 || readsJsonPath(check.definition)) &&
      !refusesNull(check.definition),
  );
  for (const check of passing) {
    const entry = NULL_PASSING_CHECKS[check.name];
    if (entry === undefined) {
      const reads =
        check.nullable.length > 0
          ? `the nullable column${check.nullable.length > 1 ? 's' : ''} ${check.nullable.join(', ')}`
          : 'a JSON path';
      problems.push(
        `${check.name} reads ${reads} and passes when its expression is NULL: ${check.definition}. If a missing value must be refused, write the CHECK as (...) IS TRUE, as db/migrations/0008_null_safe_checks.sql does. If it may pass, or the expression can never be NULL, add the constraint to ${CHECKS_FILE} with this definition and the nullable columns [${check.nullable.join(', ')}], and say which.`,
      );
    } else if (judged(entry) !== judged(check)) {
      // An entry judges one expression over columns of which some may be NULL. The same name over
      // another expression is not covered by it, and neither is the same expression after
      // ALTER COLUMN ... DROP NOT NULL, which pg_get_constraintdef prints as before.
      problems.push(
        `${check.name} is not the CHECK its entry in ${CHECKS_FILE} was written for: its expression, or which of its columns may be NULL, has changed.\n  now:   ${judged(check)}\n  entry: ${judged(entry)}\n  Re-read the entry: say again whether a missing value passes on purpose or the expression can never be NULL, then update its definition and nullable columns. If a missing value must be refused, write the CHECK as (...) IS TRUE and remove the entry. ${SEARCH_FOR_DEPENDENTS}`,
      );
    }
  }
  const names = passing.map((check) => check.name);
  for (const stale of difference(Object.keys(NULL_PASSING_CHECKS), names)) {
    problems.push(
      `${stale} is in ${CHECKS_FILE} and is no longer a CHECK that passes on NULL over a nullable column or JSON path (dropped, renamed, written IS TRUE, or its columns are NOT NULL now): remove the entry. ${SEARCH_FOR_DEPENDENTS}`,
    );
  }
  return problems;
}

// ------------------------------------------------------ member references

/** RCX-01: nothing a member authorised outlives them unnoticed. */
async function memberReferenceProblems(db: pg.Client): Promise<string[]> {
  const columns = await rows<{ name: string }>(
    db,
    `SELECT c.conrelid::regclass::text || '.' || a.attname AS name
     FROM pg_constraint c
     CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(attnum, refnum)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     JOIN pg_attribute r ON r.attrelid = c.confrelid AND r.attnum = k.refnum
     WHERE c.contype = 'f' AND c.confrelid = 'public.membership'::regclass AND r.attname = 'id'
     UNION
     SELECT c.oid::regclass::text || '.' || a.attname
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${OURS} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname ~ 'membership'
     ORDER BY 1`,
  );
  const names = columns.map((column) => column.name);
  return [
    ...difference(names, Object.keys(MEMBER_REFERENCES)).map(
      (name) =>
        `${name} holds a membership id and has no entry in ${MEMBERS_FILE}: say how a removal, a reactivation and a cut-off (sessions_valid_after) end what the column lets happen on the member's behalf (revoked, cut-off, cancelled on removal, or record only), and build that in the same PR.`,
    ),
    ...difference(Object.keys(MEMBER_REFERENCES), names).map(
      (name) =>
        `${name} is in ${MEMBERS_FILE} and is not a member column of the schema: remove the entry.`,
    ),
    ...Object.entries(MEMBER_REFERENCES)
      .filter(([, entry]) => entry.how.trim().length < 20)
      .map(([name]) => `${name} has no "how" in ${MEMBERS_FILE}: say what ends it.`),
  ];
}

// ------------------------------------------------------------------ tests

describe('the three roles', () => {
  it('have exactly the attributes of infra/postgres/init/01-roles.sh (AG-1.1, AG-1.11)', async () => {
    expect(
      await roleAttributes(catalogue),
      'Roles are created and altered only in infra/postgres/init/01-roles.sh, never in a migration. If the script changed on purpose, change ROLES in this file with it.',
    ).toEqual(ROLES);
  });

  it('have one membership between them, read from both sides (AG-1.5, D4, SEC-6)', async () => {
    expect(
      await roleMemberships(catalogue),
      'The only membership is tinnox_migrator in tinnox_definer, with SET and without INHERIT or ADMIN. A tinnox_ role is granted to nobody else, and tinnox_app and tinnox_definer are members of nothing: revoke the membership.',
    ).toEqual(MEMBERSHIPS);
  });
});

describe('ownership', () => {
  it('tinnox_app owns nothing, tinnox_definer only the functions in sec, tinnox_migrator the rest (AG-1.4, AG-1.8, AG-1.12)', async () => {
    expect(await ownershipProblems(catalogue)).toEqual([]);
  });
});

describe('grants', () => {
  it('equal catalogue/grants.json, privilege by privilege (AG-1.6, AG-1.18)', async () => {
    expect(snapshotProblems(await readPrivileges(catalogue), readSnapshot())).toEqual([]);
  });

  it('every grant to tinnox_definer carries its reason (SCR-27)', () => {
    expect(reasonProblems(readSnapshot())).toEqual([]);
  });

  it('stay inside the limits no snapshot edit can move: nothing for PUBLIC, no grant option, append-only audit_event (AG-1.5, AG-1.7, AG-3.6)', async () => {
    const privileges = await readPrivileges(catalogue);
    expect(grantLimitProblems(privileges)).toEqual([]);
    // Not vacuous: the reader found the grants that the limits were tested on.
    expect(privileges.length).toBeGreaterThan(100);
  });
});

describe('tenant tables', () => {
  let a: TestOrg;
  let b: TestOrg;

  /** One row in each of the five tenant tables that `createOrg` leaves empty. */
  async function fillRest(org: TestOrg): Promise<void> {
    const registrationId = randomUUID();
    await arrange.query('BEGIN');
    try {
      await arrange.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await arrange.query(
        'INSERT INTO player_registration (id, org_id, display_id, token_hash) VALUES ($1, $2, $3, $4)',
        [registrationId, org.orgId, org.displayId, randomBytes(32)],
      );
      await arrange.query(
        `INSERT INTO heartbeat_log (org_id, display_id, registration_id, seq, accepted, payload)
         VALUES ($1, $2, $3, 1, true, '{}')`,
        [org.orgId, org.displayId, registrationId],
      );
      await arrange.query(
        `INSERT INTO member_invite (org_id, role, name, email, invited_by, expires_at)
         VALUES ($1, 'viewer', 'Catalogue invitee', $2, $3, now() + interval '7 days')`,
        [org.orgId, `invitee-${org.orgId}@example.com`, org.membershipId],
      );
      await arrange.query(
        'INSERT INTO display_alert (display_id, org_id, offline_since) VALUES ($1, $2, now())',
        [org.displayId, org.orgId],
      );
      await arrange.query(
        `INSERT INTO alert_recipient (org_id, email, created_by, confirm_token_hash, confirm_expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [org.orgId, `alerts-${org.orgId}@example.com`, org.membershipId, randomBytes(32)],
      );
      await arrange.query('COMMIT');
    } catch (error) {
      await arrange.query('ROLLBACK');
      throw error;
    }
  }

  beforeAll(async () => {
    a = await createOrg(arrange, 'Catalogue A');
    b = await createOrg(arrange, 'Catalogue B');
    await fillRest(a);
    await fillRest(b);
  });

  it('have forced row-level security and exactly one policy, for ALL, on app_org_id() (AG-2.5)', async () => {
    expect(await policyProblems(catalogue)).toEqual([]);
  });

  it('are exactly the tables the runtime role can read (AG-2.8)', async () => {
    // tests/integration/cross-org.test.ts derives its list this way, as tinnox_app.
    const readable = (await readPrivileges(catalogue))
      .filter((p) => p.grantee === 'tinnox_app' && /^SELECT( \(|$)/.test(p.privilege))
      .map((p) => p.object.replace(/^table /, ''));
    expect(
      [...new Set(readable)].sort(),
      `A tenant table gives tinnox_app SELECT in its migration; a table tinnox_app must not read is listed in NOT_TENANT (${HERE}) and gets no grant.`,
    ).toEqual((await tenantTables(catalogue)).sort());
  });

  it('show an organisation its own rows only, in every one of them, and nothing without a context (AG-2.5, AG-2.8)', async () => {
    const tables = await tenantTables(catalogue);
    expect(tables).toContain('public.organization');
    // No WHERE clause below: only the policies decide what comes back.
    for (const table of tables) {
      const none = await pool.query(`SELECT ${orgColumn(table)} FROM ${table}`);
      expect(none.rowCount, `${table} without a context`).toBe(0);
    }
    for (const [mine, theirs] of [
      [a, b],
      [b, a],
    ] as const) {
      await withOrg(pool, mine.orgId, async (tx) => {
        for (const table of tables) {
          const found = await tx.query<{ org: string }>(
            `SELECT ${orgColumn(table)} AS org FROM ${table}`,
          );
          expect(
            found.rows.length,
            `${table} has no row for a test organisation, so this loop proves nothing about it: add one to createOrg (packages/db/test/support.ts) or to fillRest (${HERE})`,
          ).toBeGreaterThan(0);
          expect(
            found.rows.filter((row) => row.org !== mine.orgId),
            `${table} for ${mine.orgId}, next to ${theirs.orgId}`,
          ).toEqual([]);
        }
      });
    }
  });

  it('are referenced with the organisation in the key (AG-2.6, EAX-11)', async () => {
    expect(await foreignKeyProblems(catalogue)).toEqual([]);
  });
});

describe('audit_event', () => {
  it('has exactly its two triggers, their function bodies, its one policy and no rule (AG-3.6, AG-3.7, CHK-2)', async () => {
    expect(await auditProblems(catalogue)).toEqual([]);
  });
});

describe('the sec functions', () => {
  it('equal the register, result types included (AG-1.16, AG-1.14, AG-1.20, EAX-11)', async () => {
    expect(await secRegisterProblems(catalogue)).toEqual([]);
  });

  it('never name member_invite (AG-1.19)', async () => {
    expect(await inviteReaderProblems(catalogue)).toEqual([]);
  });
});

describe('CHECK constraints', () => {
  it('over a nullable column or a JSON path refuse NULL or are registered (CX-02)', async () => {
    expect(await checkProblems(catalogue)).toEqual([]);
  });

  it('are read as PostgreSQL prints them: IS TRUE over the whole expression only', () => {
    expect(refusesNull("CHECK ((((a = 'x'::text) AND (b > 0)) IS TRUE))")).toBe(true);
    expect(refusesNull('CHECK ((ok IS TRUE)) NOT VALID')).toBe(true);
    expect(refusesNull('CHECK (((a IS TRUE) OR (b > 0)))')).toBe(false);
    expect(refusesNull('CHECK (((a > 0) OR (b IS TRUE)))')).toBe(false);
    expect(refusesNull("CHECK ((note <> '(x) IS TRUE'::text))")).toBe(false);
    expect(readsJsonPath("CHECK (((manifest ->> 'a'::text) = 'b'::text))")).toBe(true);
    expect(readsJsonPath("CHECK ((note <> '->'::text))")).toBe(false);
  });
});

describe('columns that hold a member id', () => {
  it('each say how a removal, a reactivation and a cut-off close them (RCX-01, D22)', async () => {
    expect(await memberReferenceProblems(catalogue)).toEqual([]);
  });
});

describe('each rule fails when its subject is wrong (every change is rolled back)', () => {
  /** Runs the statements as the superuser, reads, and rolls everything back. */
  async function broken<T>(
    statements: readonly string[],
    read: (db: pg.Client) => Promise<T>,
  ): Promise<T> {
    await admin.query('BEGIN');
    try {
      for (const statement of statements) await admin.query(statement);
      return await read(admin);
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  /**
   * What the statements broke: the sentences of the broken schema that the schema as migrated
   * does not give. When a snapshot or register is behind the migrations, its own rule above
   * fails and the cases here still pass, so one cause shows as one failure.
   */
  async function caused(
    statements: readonly string[],
    rule: (db: pg.Client) => Promise<string[]>,
  ): Promise<string[]> {
    const asMigrated = await rule(admin);
    return difference(await broken(statements, rule), asMigrated);
  }
  const privilegeProblems = async (db: pg.Client): Promise<string[]> => {
    const privileges = await readPrivileges(db);
    return [...snapshotProblems(privileges, readSnapshot()), ...grantLimitProblems(privileges)];
  };
  const asDefiner = (...statements: string[]): string[] => [
    'SET LOCAL ROLE tinnox_definer',
    ...statements,
    'RESET ROLE',
  ];

  it('a role attribute, and a membership on either side (SEC-6)', async () => {
    expect(await broken(['ALTER ROLE tinnox_app BYPASSRLS'], roleAttributes)).not.toEqual(ROLES);
    const asMigrated = (await roleMemberships(admin)).length;
    for (const grant of [
      'GRANT tinnox_definer TO tinnox_app',
      // The step 5a case filtered on the member only and missed these two.
      'GRANT pg_read_all_data TO tinnox_definer',
      'CREATE ROLE catalogue_probe; GRANT tinnox_app TO catalogue_probe',
    ]) {
      expect(await broken([grant], roleMemberships), grant).toHaveLength(asMigrated + 1);
    }
  });

  it('ownership', async () => {
    const cases: [string[], RegExp[]][] = [
      [
        ['ALTER TABLE public.media_tag OWNER TO tinnox_app'],
        [
          /^tinnox_app owns table public\.media_tag: the runtime role owns nothing/,
          /^relation public\.media_tag is owned by tinnox_app, not tinnox_migrator/,
        ],
      ],
      [
        asDefiner('CREATE TABLE sec.probe (id integer)'),
        [
          /^tinnox_definer owns table sec\.probe: it owns only the functions in schema sec/,
          /^relation sec\.probe is owned by tinnox_definer, not tinnox_migrator/,
        ],
      ],
      [
        [
          'CREATE FUNCTION public.probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$',
          'ALTER FUNCTION public.probe() OWNER TO tinnox_migrator',
        ],
        [/^public\.probe\(\) is SECURITY DEFINER outside schema sec/],
      ],
      [
        asDefiner(
          'CREATE FUNCTION sec.probe() RETURNS integer LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$',
        ),
        [/^sec\.probe\(\) is in schema sec and is not SECURITY DEFINER/],
      ],
      [['CREATE SCHEMA probe AUTHORIZATION tinnox_migrator'], [/^schema probe is new/]],
    ];
    for (const [statements, messages] of cases) {
      expect(await broken(statements, ownershipProblems), statements.join('; ')).toEqual(
        expect.arrayContaining(messages.map((message): unknown => expect.stringMatching(message))),
      );
    }
  });

  it('a new grant shows as a line of the snapshot diff, with what to do', async () => {
    expect(
      await caused(['GRANT UPDATE ON public.media_tag TO tinnox_app'], privilegeProblems),
    ).toEqual([
      `tinnox_app gained UPDATE on table public.media_tag. If the feature needs it, update ${GRANTS_FILE} in the same PR and say why in the migration header.`,
    ]);
    // A column grant is a line too; table-level tests never saw one (AG-1.7).
    expect(
      await caused(
        ['GRANT SELECT (email) ON public.alert_recipient TO tinnox_definer'],
        privilegeProblems,
      ),
    ).toEqual([
      `tinnox_definer gained SELECT (email) on table public.alert_recipient. If the feature needs it, update ${GRANTS_FILE} in the same PR and say why in the migration header. A tinnox_definer entry also says in "why" which sec.* function or script uses it.`,
    ]);
    expect(
      await caused(['REVOKE INSERT ON public.media_tag FROM tinnox_app'], privilegeProblems),
    ).toEqual([
      `tinnox_app lost INSERT on table public.media_tag. If the migration means to take it away, remove it from ${GRANTS_FILE} in the same PR.`,
    ]);
  });

  it('a grant past the limits fails even when the snapshot would be edited', async () => {
    const limits = async (db: pg.Client): Promise<string[]> =>
      grantLimitProblems(await readPrivileges(db));
    const cases: [string, RegExp][] = [
      [
        'GRANT EXECUTE ON FUNCTION sec.display_alert_orgs() TO PUBLIC',
        /^PUBLIC holds EXECUTE on function sec\.display_alert_orgs\(\): only tinnox_app and tinnox_definer/,
      ],
      ['GRANT USAGE ON SCHEMA public TO PUBLIC', /^PUBLIC holds USAGE on schema public/],
      [
        'GRANT SELECT ON public.media TO tinnox_app WITH GRANT OPTION',
        /no role may pass a privilege on/,
      ],
      [
        'GRANT TRUNCATE ON public.media TO tinnox_app',
        /^tinnox_app holds TRUNCATE on table public\.media: the runtime role gets SELECT, INSERT, UPDATE and DELETE only/,
      ],
      [
        'GRANT SELECT ON public.session TO tinnox_app',
        /^tinnox_app holds SELECT on table public\.session: tinnox_app reaches a table without an organisation policy only through a sec\.\* function/,
      ],
      ['GRANT CREATE ON SCHEMA public TO tinnox_app', /^tinnox_app holds CREATE on schema public/],
      // No GRANT at all: a function made by tinnox_definer has PostgreSQL's default, EXECUTE for
      // PUBLIC, until its migration revokes it. Its ACL is NULL, which the reader must not skip.
      [
        `SET LOCAL ROLE tinnox_definer;
         CREATE FUNCTION sec.probe() RETURNS integer LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;
         RESET ROLE`,
        /^PUBLIC holds EXECUTE on function sec\.probe\(\)/,
      ],
      [
        'GRANT UPDATE (detail) ON public.audit_event TO tinnox_app',
        /^audit_event privileges are \[tinnox_app INSERT, tinnox_app SELECT, tinnox_app UPDATE \(detail\), tinnox_definer INSERT\]/,
      ],
      ['GRANT DELETE ON public.audit_event TO tinnox_definer', /^audit_event privileges are /],
      // A grant made inside a DO block, which the migration text check does not read.
      [
        `DO $$ BEGIN EXECUTE 'GRANT DELETE ON public.audit_event TO tinnox_app'; END $$`,
        /^audit_event privileges are /,
      ],
    ];
    for (const [statement, message] of cases) {
      expect(await broken([statement], limits), statement).toEqual(
        expect.arrayContaining([expect.stringMatching(message)]),
      );
    }
  });

  it('a table without its policy, with a second one, or with another expression', async () => {
    const cases: [string[], RegExp][] = [
      [
        [
          'CREATE TABLE public.probe (id uuid PRIMARY KEY, org_id uuid NOT NULL)',
          'ALTER TABLE public.probe OWNER TO tinnox_migrator',
        ],
        /^public\.probe is without forced row-level security/,
      ],
      [
        ['DROP POLICY tenant_isolation ON public.app'],
        /^public\.app must have exactly one policy, .* and has: none/,
      ],
      [
        ['CREATE POLICY probe ON public.media FOR SELECT USING (true)'],
        /^public\.media must have exactly one policy/,
      ],
      [
        ['ALTER POLICY tenant_isolation ON public.audit_event USING (true)'],
        /^public\.audit_event must have exactly one policy/,
      ],
      [
        ['ALTER POLICY tenant_isolation ON public.site TO tinnox_app'],
        /^public\.site must have exactly one policy/,
      ],
      [
        ['ALTER TABLE public.site NO FORCE ROW LEVEL SECURITY'],
        /^public\.site is without forced row-level security/,
      ],
      [
        ['CREATE POLICY probe ON public.session USING (true)'],
        /^public\.session is listed in NOT_TENANT/,
      ],
    ];
    for (const [statements, message] of cases) {
      expect(await broken(statements, policyProblems), statements.join('; ')).toEqual(
        expect.arrayContaining([expect.stringMatching(message)]),
      );
    }
  });

  it('a foreign key into a tenant table without the organisation', async () => {
    expect(
      await caused(
        [
          'ALTER TABLE public.folder ADD COLUMN probe uuid CONSTRAINT folder_probe_fk REFERENCES public.media (id)',
        ],
        foreignKeyProblems,
      ),
    ).toEqual([
      expect.stringMatching(
        /^public\.folder\.folder_probe_fk points into a tenant table without the organisation/,
      ),
    ]);
    // The other direction: an entry of the exception list that no longer applies.
    expect(
      await caused(
        [
          'ALTER TABLE public.pairing_claim_failure DROP CONSTRAINT pairing_claim_failure_membership_id_fkey',
        ],
        foreignKeyProblems,
      ),
    ).toEqual([
      expect.stringMatching(
        /^public\.pairing_claim_failure\.pairing_claim_failure_membership_id_fkey is in FOREIGN_KEYS_WITHOUT_ORG/,
      ),
    ]);
  });

  it('a trigger of audit_event disabled, dropped, added or given another body (CHK-2)', async () => {
    const cases = [
      'ALTER TABLE public.audit_event DISABLE TRIGGER audit_event_no_update',
      `DO $$ BEGIN EXECUTE 'DROP TRIGGER audit_event_stamp ON public.audit_event'; END $$`,
      'CREATE TRIGGER probe BEFORE DELETE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.reject_change()',
      'CREATE OR REPLACE FUNCTION public.audit_event_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$',
      'CREATE OR REPLACE FUNCTION public.reject_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$',
      'CREATE RULE probe AS ON UPDATE TO public.audit_event DO INSTEAD NOTHING',
      'CREATE POLICY probe ON public.audit_event FOR UPDATE USING (true)',
    ];
    for (const statement of cases) {
      const problems = await broken([statement], auditProblems);
      expect(problems.length, statement).toBeGreaterThan(0);
      expect(problems[0], statement).toMatch(/of audit_event differ\.[\s\S]*append-only/);
    }
  });

  it('a sec function that is new, returns more, or reads member_invite', async () => {
    const probe = asDefiner(
      `CREATE FUNCTION sec.probe() RETURNS TABLE (email text) LANGUAGE sql STABLE SECURITY DEFINER
         SET search_path = pg_catalog, pg_temp AS $$ SELECT i.email FROM public.member_invite i $$`,
    );
    expect(await caused(probe, secRegisterProblems)).toEqual([
      expect.stringMatching(
        /^sec\.probe\(\) is not in .*sec-functions\.ts: add it with its result type and one line saying why/,
      ),
    ]);
    expect(await caused(probe, inviteReaderProblems)).toEqual([
      expect.stringMatching(/^sec\.probe\(\) names member_invite/),
    ]);
    expect(
      await caused(
        asDefiner(
          'DROP FUNCTION sec.display_alert_orgs()',
          `CREATE FUNCTION sec.display_alert_orgs() RETURNS TABLE (org_id uuid, name text) LANGUAGE sql STABLE
             SECURITY DEFINER SET search_path = pg_catalog, pg_temp
             AS $$ SELECT o.id, o.name FROM public.organization o $$`,
        ),
        secRegisterProblems,
      ),
    ).toEqual([
      expect.stringMatching(
        /^sec\.display_alert_orgs\(\) returns TABLE\(org_id uuid, name text\), and .* says TABLE\(org_id uuid\)/,
      ),
    ]);
    expect(
      await caused(asDefiner('DROP FUNCTION sec.pairing_purge(integer)'), secRegisterProblems),
    ).toEqual([
      expect.stringMatching(/^sec\.pairing_purge\(integer\) is in .* and not in schema sec/),
    ]);
  });

  it('a CHECK that passes on NULL', async () => {
    expect(
      await caused(
        [`ALTER TABLE public.media ADD CONSTRAINT media_probe CHECK (codec <> 'none')`],
        checkProblems,
      ),
    ).toEqual([
      expect.stringMatching(
        /^public\.media\.media_probe reads the nullable column codec and passes when its expression is NULL/,
      ),
    ]);
    expect(
      await caused(
        [`ALTER TABLE public.app ADD CONSTRAINT app_probe CHECK (settings ->> 'kind' = 'x')`],
        checkProblems,
      ),
    ).toEqual([expect.stringMatching(/^public\.app\.app_probe reads a JSON path/)]);
    expect(
      await caused(
        [
          `ALTER TABLE public.media ADD CONSTRAINT media_probe CHECK ((codec <> 'none') IS TRUE) NOT VALID`,
        ],
        checkProblems,
      ),
    ).toEqual([]);
    expect(
      await caused(['ALTER TABLE public.media DROP CONSTRAINT media_bytes_check'], checkProblems),
    ).toEqual([
      expect.stringMatching(/^public\.media\.media_bytes_check is in .*null-passing-checks\.ts/),
    ]);
    // The same name over another expression, as 0008 re-made the CHECKs it fixed: the entry was
    // written for the old one and does not cover the new one.
    expect(
      await caused(
        [
          `ALTER TABLE public.media DROP CONSTRAINT media_failed_has_code,
             ADD CONSTRAINT media_failed_has_code CHECK (status <> 'failed' OR error_code <> '')`,
        ],
        checkProblems,
      ),
    ).toEqual([
      expect.stringMatching(
        /^public\.media\.media_failed_has_code is not the CHECK its entry in .*null-passing-checks\.ts was written for.*\n {2}now: {3}CHECK \(\(\(status <> 'failed'::text\) OR \(error_code <> ''::text\)\)\) over the nullable columns \[error_code\]\n {2}entry: CHECK \(\(\(status <> 'failed'::text\) OR \(error_code IS NOT NULL\)\)\) over the nullable columns \[error_code\]\n {2}Re-read the entry/,
      ),
    ]);
    // DROP NOT NULL leaves the expression as it was, and an entry that says "never null" because
    // org_id is NOT NULL is no longer true. Only the two CHECKs that read org_id name it.
    expect(
      await caused(['ALTER TABLE public.media ALTER COLUMN org_id DROP NOT NULL'], checkProblems),
    ).toEqual([
      expect.stringMatching(
        /^public\.media\.media_storage_key_in_own_org is not the CHECK its entry in .*null-passing-checks\.ts was written for.*\n {2}now: {3}CHECK .* over the nullable columns \[org_id, storage_key\]\n {2}entry: CHECK .* over the nullable columns \[storage_key\]\n {2}Re-read the entry/,
      ),
      expect.stringMatching(
        /^public\.media\.media_thumb_storage_key_in_own_org is not the CHECK its entry in .*null-passing-checks\.ts was written for.*\n {2}now: {3}CHECK .* over the nullable columns \[org_id, thumb_storage_key\]\n {2}entry: CHECK .* over the nullable columns \[thumb_storage_key\]\n {2}Re-read the entry/,
      ),
    ]);
  });

  it('a new column that holds a member id', async () => {
    for (const column of [
      'approved_by uuid, ADD FOREIGN KEY (approved_by, org_id) REFERENCES public.membership (id, org_id)',
      'approved_by_membership uuid',
    ]) {
      expect(
        await caused([`ALTER TABLE public.folder ADD COLUMN ${column}`], memberReferenceProblems),
        column,
      ).toEqual([
        expect.stringMatching(
          /^public\.folder\.approved_by(_membership)? holds a membership id and has no entry/,
        ),
      ]);
    }
    expect(
      await caused(['ALTER TABLE public.media DROP COLUMN created_by'], memberReferenceProblems),
    ).toEqual([expect.stringMatching(/^public\.media\.created_by is in .*member-references\.ts/)]);
  });
});
