/**
 * scripts/seed.ts run for real, as a child process the way `npm run db:seed` and the e2e
 * setup run it. It connects through connectMigrator, so before it writes it refuses a
 * connection whose session does not act as tinnox_migrator (session_user and current_user;
 * poteto adoption plan, D4), and it writes each organisation in one changeOrgAsMigrator
 * transaction under seedStatement(), with no audit row (development_seed; D25, step 20).
 *
 * Each case uses its own database, tinnox_seedcheck_test, never the shared integration-test
 * database: the seed's organisation ids are fixed and membership.oidc_sub is unique, so its
 * rows would outlive this file there. The subjects are fresh for each run.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runMigrations } from '@tinnox/db/migrate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './support.ts';

const SEED_DB = 'tinnox_seedcheck_test';
/** The seed's fixed organisation ids (scripts/seed.ts, SEED). */
const PRIMARY_ORG = '10000000-0000-4000-8000-000000000001';
const SECOND_ORG = '20000000-0000-4000-8000-000000000001';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** The integration migrator login, pointed at the seed's own database. */
function migratorUrl(): URL {
  const url = new URL(need('TEST_DATABASE_MIGRATOR_URL'));
  url.pathname = `/${SEED_DB}`;
  return url;
}

function superuserUrl(database: string): URL {
  const url = migratorUrl();
  url.username = 'postgres';
  url.password = encodeURIComponent(need('POSTGRES_SUPERUSER_PASSWORD'));
  url.pathname = `/${database}`;
  return url;
}

/** Runs `sql` as the cluster superuser, the only role that may create a database. */
async function asSuperuser(...statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: superuserUrl('postgres').toString() });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Fresh subjects for every seeded member, so a run never meets another run's rows. */
function subjects(): Record<string, string> {
  return Object.fromEntries(
    [
      'DEV_OPERATOR_OIDC_SUB',
      'DEV_ADMIN_OIDC_SUB',
      'DEV_EDITOR_OIDC_SUB',
      'DEV_VIEWER_OIDC_SUB',
      'DEV_SECOND_ORG_OIDC_SUB',
    ].map((name) => [name, `seed-${randomUUID()}`]),
  );
}

async function seed(
  login: string,
  env: Record<string, string>,
): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
  return promisify(execFile)(
    join(repoRoot, 'node_modules', '.bin', 'tsx'),
    ['scripts/seed.ts', '--second-org'],
    { cwd: repoRoot, env: { ...process.env, ...env, DATABASE_MIGRATOR_URL: login } },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
}

interface SeededRows {
  readonly orgs: number;
  readonly sites: number;
  readonly members: number;
  readonly audits: number;
}

/**
 * Counts the seed's rows as the superuser, who bypasses row-level security. The audit rows are
 * every row of this database's audit_event, scoped or not: the seed writes none (development_seed,
 * the D3 ruling of step 20), and nothing else writes here.
 */
async function seededRows(): Promise<SeededRows> {
  const client = new pg.Client({ connectionString: superuserUrl(SEED_DB).toString() });
  await client.connect();
  try {
    const { rows } = await client.query<SeededRows>(
      `SELECT (SELECT count(*)::int FROM organization WHERE id = ANY($1)) AS orgs,
              (SELECT count(*)::int FROM site WHERE org_id = ANY($1)) AS sites,
              (SELECT count(*)::int FROM membership WHERE org_id = ANY($1)) AS members,
              (SELECT count(*)::int FROM audit_event) AS audits`,
      [[PRIMARY_ORG, SECOND_ORG]],
    );
    return rows[0] ?? { orgs: -1, sites: -1, members: -1, audits: -1 };
  } finally {
    await client.end();
  }
}

interface SeededMember {
  readonly org_id: string | undefined;
  readonly oidc_sub: string | undefined;
  readonly role: string | undefined;
}

function bySubject(a: SeededMember, b: SeededMember): number {
  return (a.oidc_sub ?? '').localeCompare(b.oidc_sub ?? '');
}

async function seededMembers(): Promise<SeededMember[]> {
  const client = new pg.Client({ connectionString: superuserUrl(SEED_DB).toString() });
  await client.connect();
  try {
    const { rows } = await client.query<SeededMember>(
      'SELECT org_id, oidc_sub, role FROM membership WHERE org_id = ANY($1)',
      [[PRIMARY_ORG, SECOND_ORG]],
    );
    return rows.sort(bySubject);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await asSuperuser(
    `DROP DATABASE IF EXISTS ${SEED_DB} WITH (FORCE)`,
    // Fixed identifier, same settings as tinnox_test in infra/postgres/init/01-roles.sh.
    `CREATE DATABASE ${SEED_DB} OWNER tinnox_migrator ENCODING 'UTF8'`,
    `REVOKE ALL ON DATABASE ${SEED_DB} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${SEED_DB} TO tinnox_app`,
    `ALTER DATABASE ${SEED_DB} SET timezone = 'UTC'`,
  );
  await runMigrations({
    connectionString: migratorUrl().toString(),
    directory: join(repoRoot, 'db', 'migrations'),
  });
}, 120_000);

afterAll(async () => {
  await asSuperuser(`DROP DATABASE IF EXISTS ${SEED_DB} WITH (FORCE)`);
});

describe('scripts/seed.ts', () => {
  it('refuses the superuser and the runtime role before it writes anything (D4)', async () => {
    const superuser = superuserUrl(SEED_DB);
    // The superuser acting as the migrator: current_user passes, session_user does not.
    const superuserAsMigrator = new URL(superuser);
    superuserAsMigrator.searchParams.set('options', '-c role=tinnox_migrator');
    const app = new URL(need('TEST_DATABASE_URL'));
    app.pathname = `/${SEED_DB}`;
    for (const login of [superuser, superuserAsMigrator, app]) {
      const outcome = await seed(login.toString(), subjects());
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toMatch(/must log in and act as role tinnox_migrator/);
    }
    expect(await seededRows()).toEqual({ orgs: 0, sites: 0, members: 0, audits: 0 });
  });

  it('as the migrator writes both organisations once with no audit row, and a second run adds nothing (D25, D3)', async () => {
    const env = subjects();
    const first = await seed(migratorUrl().toString(), env);
    expect(first).toMatchObject({ code: 0, stderr: '' });
    expect(first.stdout).toMatch(/TINNOX Internal: .*owner membership created/);
    expect(first.stdout).toMatch(/Isolation Test Organisation: .*owner membership created/);
    expect(await seededRows()).toEqual({ orgs: 2, sites: 2, members: 5, audits: 0 });

    const again = await seed(migratorUrl().toString(), env);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(again.stdout).not.toMatch(/created/);
    expect(await seededRows()).toEqual({ orgs: 2, sites: 2, members: 5, audits: 0 });

    // Each subject landed in its organisation with its role.
    expect(await seededMembers()).toEqual(
      [
        [PRIMARY_ORG, env['DEV_OPERATOR_OIDC_SUB'], 'owner'],
        [PRIMARY_ORG, env['DEV_ADMIN_OIDC_SUB'], 'admin'],
        [PRIMARY_ORG, env['DEV_EDITOR_OIDC_SUB'], 'editor'],
        [PRIMARY_ORG, env['DEV_VIEWER_OIDC_SUB'], 'viewer'],
        [SECOND_ORG, env['DEV_SECOND_ORG_OIDC_SUB'], 'owner'],
      ]
        .map(([org_id, oidc_sub, role]) => ({ org_id, oidc_sub, role }))
        .sort(bySubject),
    );
  });
});
