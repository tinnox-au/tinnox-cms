// TINNOX's membership provisioning: new customers, invites, names, sign-in resets and lost Owners
// (docs/portal-v2/stage-c.md section 8.2). TINNOX staff run it from a controlled host, never
// from the API's host or container:
//   npm run provision -- <command> [options]      (npm run provision -- --help for the list)
// Environment (controlled host only): DATABASE_MIGRATOR_URL and PROVISION_IDP_ISSUER (default
// OIDC_ISSUER). For Keycloak also PROVISION_IDP_CLIENT_ID and PROVISION_IDP_CLIENT_SECRET, the
// identity-provider client that can only read accounts. For a Cognito user pool instead the
// short-lived AWS credentials of the person who runs it (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), which need cognito-idp:AdminGetUser on the pool; a
// username is then the person's e-mail address. Exit 0 done, 1 refused or failed, 2 usage error.
import { settle } from '@tinnox/db';
import { connectMigrator, type MigratorPool } from '@tinnox/db/migrate';
import { loadEnv, requireEnv } from './lib/env.ts';
import {
  cognitoDirectory,
  isCognitoIssuer,
  keycloakDirectory,
  type IdpDirectory,
} from './lib/idp.ts';
import {
  USAGE,
  UsageError,
  parseInvocation,
  reportEnd,
  runInvocation,
  type Invocation,
} from './lib/provision.ts';

// Read before the repository's .env is loaded: AWS credentials belong to the person's shell
// and expire; a pair written into .env would be a stored key. Never printed.
const AWS_FROM_SHELL = {
  accessKeyId: (process.env['AWS_ACCESS_KEY_ID'] ?? '').trim(),
  secretAccessKey: (process.env['AWS_SECRET_ACCESS_KEY'] ?? '').trim(),
  sessionToken: (process.env['AWS_SESSION_TOKEN'] ?? '').trim(),
};

let announced = false;

/** The reader for the configured identity provider: the issuer's address says which one. */
function directory(): IdpDirectory {
  const issuer = process.env['PROVISION_IDP_ISSUER'] || requireEnv('OIDC_ISSUER');
  // Which directory is read is not tied to the database that is written: say it, so a
  // wrong pool or realm is seen before its answer is believed.
  if (!announced) {
    announced = true;
    console.error(`identity provider: ${issuer}`);
  }
  if (!isCognitoIssuer(issuer)) {
    return keycloakDirectory({
      issuer,
      clientId: requireEnv('PROVISION_IDP_CLIENT_ID'),
      clientSecret: requireEnv('PROVISION_IDP_CLIENT_SECRET'),
    });
  }
  const { accessKeyId, secretAccessKey, sessionToken } = AWS_FROM_SHELL;
  if (accessKeyId === '' || secretAccessKey === '' || sessionToken === '') {
    throw new Error(
      'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN must be set in this shell: the Cognito user pool is read with your own temporary AWS credentials (a key without a session token is a stored key, and is refused)',
    );
  }
  return cognitoDirectory({ issuer, credentials: { accessKeyId, secretAccessKey, sessionToken } });
}

/** Returns the exit code (no process.exit, so nothing written to a pipe is lost). */
async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) {
    console.log(USAGE);
    return 0;
  }
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  loadEnv();
  // Read on first use, so `pending` needs no identity-provider settings.
  const idp: IdpDirectory = {
    findByUsername: (username) => directory().findByUsername(username),
  };
  let pool: MigratorPool | undefined;
  try {
    // One connection, not createPool: the commands run one transaction each, as the migrator.
    // connectMigrator refuses any other login before a command reads the identity provider.
    pool = await connectMigrator(requireEnv('DATABASE_MIGRATOR_URL'), {
      applicationName: 'tinnox-provision',
    });
    // One transaction per command: done, refused or failed, or outcome unknown (reportEnd).
    return reportEnd(await settle(runInvocation(pool, idp, invocation)), console);
  } catch (error) {
    // Before any command ran: a missing setting, or a login that connectMigrator refused.
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

process.exitCode = await main(process.argv.slice(2));
