// The one place that switches the database role (D25). tinnox_definer has BYPASSRLS, so it reads
// every organisation; only tinnox_migrator may take it (infra/postgres/init/01-roles.sh), and
// only TINNOX's provisioning does (AGENTS.md section 1). Exported from the '@tinnox/db/migrate'
// entry, which lint keeps out of the API; lint also refuses role-switch SQL in any other file
// (NO_ROLE_SWITCH in eslint.config.js). The incident scripts under scripts/*.sql are SQL, not
// TypeScript, and carry their own SET LOCAL ROLE.
import type { MigratorPool } from './migrate.ts';
import { poolOf } from './tx-pool.ts';
import type { Tx } from './tx.ts';

/** The transactions whose role is switched right now. */
const acting = new WeakSet<Tx>();

/**
 * Runs `work` as tinnox_definer inside the transaction of `tx`, then returns to the migrator:
 *
 *   SET LOCAL ROLE tinnox_definer; ...work...; RESET ROLE
 *
 * `tx` must come from withOrg, withoutOrg or withResolvedOrg called with this same `pool`, so the
 * caller holds the connection connectMigrator checked. `work` runs its statements on that `tx`.
 *
 * The switch cannot outlive `work`. It is SET LOCAL, so the end of the transaction undoes it
 * whatever happens. When `work` throws, the role is reset before the error reaches the caller,
 * who may catch it and carry on in the same transaction. After a database error the transaction
 * is aborted and refuses RESET too, but then it refuses every other statement as well until its
 * ROLLBACK, which undoes the switch; so that one failure is ignored.
 */
export async function asDefiner<T>(pool: MigratorPool, tx: Tx, work: () => Promise<T>): Promise<T> {
  if (poolOf(tx) !== pool) {
    throw new Error(
      'asDefiner needs the tx of a transaction opened on the same MigratorPool: call it inside the callback of withOrg, withoutOrg or withResolvedOrg that was given this pool, with the tx that callback received',
    );
  }
  if (acting.has(tx)) {
    throw new Error(
      'asDefiner was called inside the work of another asDefiner on the same transaction: the inner RESET ROLE would end the outer switch early. Do the definer work in one call',
    );
  }
  await tx.query('SET LOCAL ROLE tinnox_definer');
  acting.add(tx);
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await tx.query('RESET ROLE').catch(() => undefined);
    throw error;
  } finally {
    acting.delete(tx);
  }
  await tx.query('RESET ROLE');
  return result;
}
