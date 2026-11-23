/**
 * D5 (poteto adoption plan, step 12; AG-1.9, AG-1.17): both real entry points, the API
 * (src/main.ts) and the alert job (src/alerts-once.ts), refuse in every mode to start in an
 * environment that holds a credential of the migrator, the database superuser, the Keycloak
 * administrator or the provisioning script. Each runs as a child process against the
 * integration-test database. Neither may listen or run, and the refusal names the variable and
 * prints no value. The same credentials in the root .env do no harm: the entry points take only
 * the names they read from that file (runtimeEnv in apps/api/src/config.ts), which is how
 * `npm run dev` starts.
 */
import { describe, expect, it } from 'vitest';
import {
  apiEnvironment,
  developmentEnv,
  freePort,
  listening,
  runApiEntryPoint,
} from './support.ts';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const ENTRY_POINTS = [
  ['the API', 'src/main.ts', 'TINNOX API configuration is not acceptable:'],
  ['the alert job', 'src/alerts-once.ts', 'TINNOX alert check configuration is not acceptable:'],
] as const;

// What `npm run setup` writes for the offline tools and the containers (.env.example).
const ADMINISTRATOR_NAMES = [
  'DATABASE_MIGRATOR_URL',
  'TEST_DATABASE_MIGRATOR_URL',
  'TINNOX_MIGRATOR_PASSWORD',
  'POSTGRES_SUPERUSER_PASSWORD',
  'KC_BOOTSTRAP_ADMIN_PASSWORD',
  'PROVISION_IDP_CLIENT_SECRET',
] as const;

/** Lines only a process that got past its configuration writes at LOG_LEVEL=info. */
const STARTED = /Server listening|development configuration: plain http|display alert check/;

describe('start-up refuses an administrator credential in its environment (D5)', () => {
  const wholeFile = developmentEnv();
  const credentials = ADMINISTRATOR_NAMES.map((name) => [name, wholeFile[name] ?? ''] as const);

  it('has the generated credentials to test with', () => {
    for (const [name, value] of credentials) expect(value.length, name).toBeGreaterThan(8);
  });

  /** Starts the entry point with `extra` beside the API's own names and checks it refused. */
  async function refused(
    script: string,
    mode: string,
    extra: Record<string, string>,
  ): Promise<string> {
    const port = await freePort();
    let exited = false;
    const run = runApiEntryPoint(script, {
      ...apiEnvironment(wholeFile),
      ...extra,
      // Pinned after `extra`, which may be the whole file: a run that wrongly got this far
      // would use the test database and a free port, never the development ones.
      NODE_ENV: mode,
      LOG_LEVEL: 'info',
      DATABASE_URL: need('TEST_DATABASE_URL'),
      API_PORT: String(port),
      // Nothing listens on port 1, so it would send nothing either.
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      MAIL_FROM: 'alerts@tinnox.test',
    }).finally(() => {
      exited = true;
    });
    // Asked while the child runs: a process that listened before it refused would answer here.
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
    expect(result.output, `${script} got past its configuration`).not.toMatch(STARTED);
    for (const [name, value] of credentials) {
      expect(result.output, `the value of ${name} was printed`).not.toContain(value);
    }
    return result.output;
  }

  it('each name alone, in development, by name', async () => {
    // The configuration tests (apps/api/src/config.test.ts) cover every name in every mode.
    for (const [what, script, heading] of ENTRY_POINTS) {
      for (const [name, value] of credentials) {
        const output = await refused(script, 'development', { [name]: value });
        expect(output, `${what}, ${name}`).toContain(heading);
        expect(output, `${what}, ${name}`).toContain(
          `${name} is set in the environment of this process`,
        );
        expect(output, `${what}, ${name}`).toContain(
          'Start the process with its own environment, not the whole root .env',
        );
      }
    }
  }, 120_000);

  it('the whole root .env as the environment, which is how the npm scripts started the API before', async () => {
    for (const [what, script, heading] of ENTRY_POINTS) {
      for (const mode of ['development', 'production']) {
        const output = await refused(script, mode, wholeFile);
        expect(output, `${what}, ${mode}`).toContain(heading);
        for (const name of ADMINISTRATOR_NAMES) {
          expect(output, `${what}, ${mode}`).toMatch(
            new RegExp(`${name}[A-Z_, ]* are set in the environment of this process`),
          );
        }
      }
    }
  }, 120_000);
});
