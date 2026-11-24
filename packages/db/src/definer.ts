// The one place that switches the database role (D25). tinnox_definer has BYPASSRLS, so it reads
// every organisation; only tinnox_migrator may take it (infra/postgres/init/01-roles.sh), and
// only TINNOX's provisioning does (AGENTS.md section 1). Exported from the '@tinnox/db/migrate'
// entry, which lint keeps out of the API; lint also refuses role-switch SQL in any other file
// (NO_ROLE_SWITCH in eslint.config.js). The incident scripts under scripts/*.sql are SQL, not
// TypeScript, and carry their own SET LOCAL ROLE.
import type { AuditAction } from '@tinnox/contracts';
import type { MigratorPool } from './migrate.ts';
import { readAsDefiner, type DefinerResult } from './org-id.ts';
import type { QueryResultRow } from './pool.ts';
import { statementsOf } from './pre-org.ts';
import { issueSqlAudit, type AuditedInSql } from './sql-audit.ts';
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

/** What the database answered for one statement of a definer handle. */
interface Answer {
  readonly text: string;
  /** The command of the server's tag: INSERT, UPDATE, SELECT. */
  readonly command: string;
  /** The count of that tag: for an INSERT, the rows it inserted. */
  readonly rows: number;
  /** The handle asDefiner was given: the statement ran on its transaction. */
  readonly on: Tx;
}

/**
 * The answer to each statement a definer handle sent, by the result the handle gave back. Kept
 * when the statement is sent and read by `auditedInSql`, so a result somebody built, or changed
 * after it came back, proves nothing.
 */
const answers = new WeakMap<object, Answer>();

/** A statement that names the audit table as the target of an insert. */
const INSERTS_AUDIT_ROWS = /\bINSERT\s+INTO\s+public\.audit_event\b/i;

/**
 * Says that one statement of the definer wrote the audit rows of its change itself, in that same
 * statement, so the wrapper of the change must write none: what the callback of `changePreOrg`
 * or `changeOrgAsMigrator` returns as `audit` in that one case (D25; adoption plan step 20).
 * Provisioning's `pending` is the case: one statement expires the invites of every organisation
 * and inserts an invite.cancel row for each, which the audit writers cannot do (they write for
 * the one organisation of their transaction).
 *
 * `result` is what `definer.query` returned for that statement, and `action` the action of the
 * rows it wrote. Nothing here is taken on the caller's word:
 *  - the result must be one a definer handle gave back, and what the database answered for it
 *    was kept when it was sent. A SELECT count is not possible: tinnox_definer may insert into
 *    audit_event and not read it (0001), and the migrator reads it under row-level security,
 *    one organisation at a time. So the count is the server's own command tag for the
 *    statement, INSERT 0 n: the rows it inserted, on the transaction it ran on;
 *  - the statement must be an INSERT whose text names public.audit_event and carries the action
 *    as a literal. Lint holds the rest of the text: a statement that inserts into audit_event
 *    is refused unless RAW_AUDIT_INSERTS of eslint.config.js names it whole;
 *  - the wrapper (`record` in ./change.ts) refuses the value when the statement inserted no
 *    row, when it ran on another transaction, and when the statement of the command does not
 *    name the action. A run that found nothing to change returns `unaudited('nothing_changed')`.
 *
 * What this cannot see: text made to pass (an insert into audit_event in a CTE that selects no
 * row, in front of an insert into another table). That statement needs its own entry in
 * RAW_AUDIT_INSERTS, which is where a reviewer reads it.
 */
export function auditedInSql(
  result: DefinerResult<QueryResultRow>,
  action: AuditAction,
): AuditedInSql {
  const answer = answers.get(result);
  if (answer === undefined) {
    throw new Error(
      'auditedInSql takes the result of the statement that wrote the audit rows, as definer.query returned it inside asDefiner(pool, tx, work): pass that result itself, not a copy and not the result of another handle. A change whose audit rows no statement of its own writes returns its events as { value, audit } and lets the wrapper write them',
    );
  }
  if (
    answer.command !== 'INSERT' ||
    !INSERTS_AUDIT_ROWS.test(answer.text) ||
    !answer.text.includes(`'${action}'`)
  ) {
    throw new Error(
      `auditedInSql('${action}'): the statement of this result does not write audit rows of ${action}. It must be an INSERT that names public.audit_event as its target and carries '${action}' as a literal (the database answered ${answer.command}). Pass the result of the statement that writes the rows; a change that writes them no other way returns its events as { value, audit }`,
    );
  }
  return issueSqlAudit({ action, rows: answer.rows, on: answer.on });
}

/**
 * Runs `work` as tinnox_definer inside the transaction of `tx`, then returns to the migrator:
 *
 *   SET LOCAL ROLE tinnox_definer; ...work...; RESET ROLE
 *
 * `tx` must come from a transaction opened with this same `pool` (changePreOrg or
 * changeOrgAsMigrator in a tool; withOrg, withoutOrg or withResolvedOrg in a test), so the
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
      'asDefiner needs the tx of a transaction opened on the same MigratorPool: call it inside the callback of changePreOrg (@tinnox/db) or changeOrgAsMigrator (@tinnox/db/migrate) that was given this pool, with the tx that callback received or the one its enterOrg returned',
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
      const result = readAsDefiner(await statements.query<R>(text, values));
      // For auditedInSql: what the database said, before the caller holds the result.
      answers.set(result, { text, command: result.command, rows: result.rowCount ?? 0, on: tx });
      return result;
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
