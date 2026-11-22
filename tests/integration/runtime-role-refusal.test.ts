/**
 * AG-1.3 (poteto adoption plan, step 12): both real entry points, the API (src/main.ts) and the
 * alert job (src/alerts-once.ts), refuse to start unless their database session is tinnox_app as
 * infra/postgres/init/01-roles.sh makes it. Each runs as a child process with the development
 * configuration pointed at the integration-test database; neither may listen or run, and the
 * refusal prints no password and no connection string. "Never listened" is checked while the
 * child runs and from its log, not only after it exits, when nothing could answer anyway.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { developmentEnv, freePort, listening, runApiEntryPoint } from './support.ts';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const ENTRY_POINTS = [
  ['the API', 'src/main.ts', 'TINNOX API database role is not acceptable:'],
  ['the alert job', 'src/alerts-once.ts', 'TINNOX alert check database role is not acceptable:'],
] as const;

/**
 * Lines only a process that got past the check writes at LOG_LEVEL=info: Fastify's listen line,
 * the API's warning right after listen, and the alert job's (or loop's) result.
 */
const STARTED = /Server listening|development configuration: plain http|display alert check/;

/** The tinnox_app URL of the test database with pg's ?user= and ?password= set to another login. */
function loginBehindAppUrl(user: string, password: string): string {
  const url = new URL(need('TEST_DATABASE_URL'));
  url.searchParams.set('user', user);
  url.searchParams.set('password', password);
  return url.toString();
}

describe('start-up refuses a database session that is not the runtime role (AG-1.3)', () => {
  const devEnv = developmentEnv();
  const migrator = new URL(need('TEST_DATABASE_MIGRATOR_URL'));
  const migratorPassword = decodeURIComponent(migrator.password);
  const superuserPassword = need('POSTGRES_SUPERUSER_PASSWORD');

  /** Starts the entry point against `databaseUrl` and checks it refused, silently about secrets. */
  async function refused(script: string, databaseUrl: string): Promise<string> {
    const port = await freePort();
    let exited = false;
    const run = runApiEntryPoint(script, {
      ...devEnv,
      NODE_ENV: 'development',
      // Pinned, so the lines STARTED looks for would be written whatever the .env says.
      LOG_LEVEL: 'info',
      DATABASE_URL: databaseUrl,
      API_PORT: String(port),
      // The alert job stops early without e-mail; nothing listens on port 1, so even a run that
      // wrongly got this far would send nothing.
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      MAIL_FROM: 'alerts@tinnox.test',
    }).finally(() => {
      exited = true;
    });
    // Asks the port over and over while the child runs: a process that listened before it
    // refused would answer here, though it is gone by the time it exits.
    let answered = false;
    const poll = (async () => {
      while (!exited) {
        if (await listening(port)) answered = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const result = await run;
    await poll;
    expect(result.code, result.output).toBe(1);
    expect(answered, `${script} listened before it refused`).toBe(false);
    expect(result.output, `${script} got past the role check`).not.toMatch(STARTED);
    for (const secret of [
      databaseUrl,
      migratorPassword,
      superuserPassword,
      decodeURIComponent(new URL(need('TEST_DATABASE_URL')).password),
    ]) {
      expect(secret.length).toBeGreaterThan(6);
      expect(result.output, 'a password or connection string was printed').not.toContain(secret);
    }
    return result.output;
  }

  it('another login behind a tinnox_app URL: the migrator and the superuser', async () => {
    // The URL's username is tinnox_app, so the configuration and assertConnectionRole pass;
    // createPool's session check refuses the connection that assertRuntimeRole opens.
    const logins = [
      ['tinnox_migrator', migratorPassword],
      ['postgres', superuserPassword],
    ] as const;
    for (const [, script, heading] of ENTRY_POINTS) {
      for (const [user, password] of logins) {
        const output = await refused(script, loginBehindAppUrl(user, password));
        expect(output, `${script} as ${user}`).toContain(heading);
        expect(output, `${script} as ${user}`).toContain(`logs in as ${user} and acts as ${user}`);
      }
    }
  }, 120_000);

  it('a tinnox_app that owns something, read from the catalogue', async () => {
    // Ownership is the one attribute that can be given to tinnox_app inside the test database
    // alone; superuser, BYPASSRLS and memberships are cluster-wide, so those cases are rolled
    // back in packages/db/test/rls.integration.test.ts instead. The table is dropped at the end.
    const admin = new pg.Client({ connectionString: superuserUrl() });
    await admin.connect();
    try {
      await admin.query('CREATE TABLE public.runtime_role_probe (id integer)');
      await admin.query('ALTER TABLE public.runtime_role_probe OWNER TO tinnox_app');
      for (const [what, script, heading] of ENTRY_POINTS) {
        const output = await refused(script, need('TEST_DATABASE_URL'));
        expect(output, what).toContain(heading);
        expect(output, what).toMatch(/role tinnox_app owns table runtime_role_probe/);
      }
    } finally {
      await admin.query('DROP TABLE IF EXISTS public.runtime_role_probe');
      await admin.end();
    }
  }, 120_000);
});

function superuserUrl(): string {
  const url = new URL(need('TEST_DATABASE_MIGRATOR_URL'));
  url.username = 'postgres';
  url.password = encodeURIComponent(need('POSTGRES_SUPERUSER_PASSWORD'));
  return url.toString();
}
