// Applies pending migrations from db/migrations as role tinnox_migrator.
//   npm run db:migrate            development database (DATABASE_MIGRATOR_URL)
//   npm run db:migrate -- --test  integration-test database (TEST_DATABASE_MIGRATOR_URL)
// On a deployed server the connection string arrives as a file instead
// (DATABASE_MIGRATOR_URL_FILE, set by infra/deploy/release.sh): a container's environment
// is kept on disk by Docker, a file in memory is not.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '@tinnox/db/migrate';
import { loadEnv, repoRoot, requireEnv } from './lib/env.ts';

loadEnv();
const useTest = process.argv.includes('--test');
const file = process.env['DATABASE_MIGRATOR_URL_FILE'];
const connectionString =
  !useTest && file !== undefined && file !== ''
    ? readFileSync(file, 'utf8').trim()
    : requireEnv(useTest ? 'TEST_DATABASE_MIGRATOR_URL' : 'DATABASE_MIGRATOR_URL');

try {
  const result = await runMigrations({
    connectionString,
    directory: join(repoRoot, 'db', 'migrations'),
    log: (message) => console.log(message),
  });
  console.log(
    result.applied.length === 0
      ? `Database is up to date (${result.alreadyApplied.length} migrations already applied).`
      : `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
