// Global setup for `npm run test:integration`: rebuilds the integration-test database
// (name must end in _test) from the migrations, so every run starts from a known schema, and
// installs the audit-debt guard on it (adoption plan section 2.1 C): from here on, a
// transaction of the runtime role that changes audited state and commits no audit row fails.
import { join } from 'node:path';
import { resetTestDatabase, runMigrations } from '@tinnox/db/migrate';
import { installAuditDebtGuard } from '@tinnox/db/testing';
import { loadEnv, repoRoot, requireEnv } from './lib/env.ts';

export default async function setup(): Promise<void> {
  loadEnv();
  const migratorUrl = requireEnv('TEST_DATABASE_MIGRATOR_URL');
  requireEnv('TEST_DATABASE_URL');
  await resetTestDatabase(migratorUrl);
  await runMigrations({
    connectionString: migratorUrl,
    directory: join(repoRoot, 'db', 'migrations'),
  });
  // After the migrations and never by one: the guard is for the test database only.
  await installAuditDebtGuard(migratorUrl);
}
