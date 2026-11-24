// TINNOX's membership provisioning: new customers, invites, names, sign-in resets and lost Owners
// (docs/portal-v2/stage-c.md section 8.2). TINNOX staff run it from a controlled host, never
// from the API's host or container:
//   npm run provision -- <command> [options]      (npm run provision -- --help for the list)
// Environment (controlled host only): DATABASE_MIGRATOR_URL; PROVISION_IDP_ISSUER (default
// OIDC_ISSUER), PROVISION_IDP_CLIENT_ID and PROVISION_IDP_CLIENT_SECRET, the identity-provider
// client that can only read accounts. Exit 0 done, 1 refused or failed, 2 usage error.
import { settle } from '@tinnox/db';
import { connectMigrator, type MigratorPool } from '@tinnox/db/migrate';
import { loadEnv, requireEnv } from './lib/env.ts';
import { keycloakDirectory, type IdpDirectory } from './lib/idp.ts';
import {
  USAGE,
  UsageError,
  parseInvocation,
  reportEnd,
  runInvocation,
  type Invocation,
} from './lib/provision.ts';

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
    findByUsername: (username) =>
      keycloakDirectory({
        issuer: process.env['PROVISION_IDP_ISSUER'] || requireEnv('OIDC_ISSUER'),
        clientId: requireEnv('PROVISION_IDP_CLIENT_ID'),
        clientSecret: requireEnv('PROVISION_IDP_CLIENT_SECRET'),
      }).findByUsername(username),
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
