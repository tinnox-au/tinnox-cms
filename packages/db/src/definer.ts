// The one place that switches the database role (D25). tinnox_definer has BYPASSRLS, so it reads
// every organisation; only tinnox_migrator may take it (infra/postgres/init/01-roles.sh), and
// only TINNOX's provisioning does (AGENTS.md section 1). Exported from the '@tinnox/db/migrate'
// entry, which lint keeps out of the API; lint also refuses role-switch SQL in any other file
// (NO_ROLE_SWITCH in eslint.config.js). The incident scripts under scripts/*.sql are SQL, not
// TypeScript, and carry their own SET LOCAL ROLE.
import type { MigratorPool } from './migrate.ts';
import { readAsDefiner, type DefinerResult } from './org-id.ts';
import type { QueryResultRow } from './pool.ts';
import { statementsOf } from './pre-org.ts';
import { poolOf } from './tx-pool.ts';
import type { Autocommit, Tx } from './tx.ts';

/** Marks the handle asDefiner makes. Not exported, so no other module can build one. */
const asTheDefiner: unique symbol = Symbol('asTheDefiner');

/**
 * What `work` sends its statements on while the role is switched. It reads every organisation,
 * so it is the one handle that takes a statement where no organisation is set, and a row it
 * reads has its `org_id` typed `OrgId` (DefinerRow in ./org-id.ts): that is how provisioning
 * gets the organisation it then enters with `enterOrg` (D25). It is not an `OrgTx`: the scoped
 * audit writer and the wrappers that need the organisation do not take it. It works until
 * `work` ends; after that it refuses, and sends nothing.
 */
export interface DefinerTx {
  readonly [asTheDefiner]: true;
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DefinerResult<R>>;
}

/** The transactions whose role is switched right now, by their statements (./pre-org.ts). */
const acting = new WeakSet<Autocommit>();

/**
 * Runs `work` as tinnox_definer inside the transaction of `tx`, then returns to the migrator:
 *
 *   SET LOCAL ROLE tinnox_definer; ...work...; RESET ROLE
 *
 * `tx` must come from withOrg, withoutOrg or withResolvedOrg called with this same `pool`, so the
 * caller holds the connection connectMigrator checked. `work` sends its own statements on the
 * handle it is given, which runs them on that transaction; a sec.* wrapper that needs the
 * organisation still takes the caller's `OrgTx`.
 *
 * The switch cannot outlive `work`. It is SET LOCAL, so the end of the transaction undoes it
 * whatever happens. When `work` throws, the role is reset before the error reaches the caller,
 * who may catch it and carry on in the same transaction. After a database error the transaction
 * is aborted and refuses RESET too, but then it refuses every other statement as well until its
 * ROLLBACK, which undoes the switch; so that one failure is ignored.
 */
export async function asDefiner<T>(
  pool: MigratorPool,
  tx: Tx,
  work: (definer: DefinerTx) => Promise<T>,
): Promise<T> {
  if (poolOf(tx) !== pool) {
    throw new Error(
      'asDefiner needs the tx of a transaction opened on the same MigratorPool: call it inside the callback of withOrg, withoutOrg or withResolvedOrg that was given this pool, with the tx that callback received',
    );
  }
  const statements = statementsOf(tx);
  if (acting.has(statements)) {
    throw new Error(
      'asDefiner was called inside the work of another asDefiner on the same transaction: the inner RESET ROLE would end the outer switch early. Do the definer work in one call',
    );
  }
  // The handle is good while the role is switched, and no longer: kept past `work`, it would
  // send a statement as the migrator and type what came back as the definer's.
  let switched = true;
  const definer: DefinerTx = {
    [asTheDefiner]: true,
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) => {
      if (!switched) {
        throw new Error(
          'the handle asDefiner gave its work was used after the work ended, when the role is the migrator again, so the statement was not sent. Send every statement of the definer inside `work`, and await it there',
        );
      }
      return readAsDefiner(await statements.query<R>(text, values));
    },
  };
  await statements.query('SET LOCAL ROLE tinnox_definer');
  acting.add(statements);
  let result: T;
  try {
    result = await work(definer);
  } catch (error) {
    switched = false;
    await statements.query('RESET ROLE').catch(() => undefined);
    throw error;
  } finally {
    switched = false;
    acting.delete(statements);
  }
  await statements.query('RESET ROLE');
  return result;
}
