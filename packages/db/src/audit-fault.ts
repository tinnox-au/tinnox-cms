/**
 * The audit fault (adoption plan section 2.1, step 17; decision D3). TEST DATABASES ONLY, like
 * the audit-debt guard beside it: no migration creates it and every function here refuses a
 * database whose name does not end in `_test`.
 *
 * What it is for: the rule "a change and its audit row commit together or not at all" is only
 * shown by making the audit row fail and looking at the change. While the fault is installed,
 * every insert into audit_event of one action raises an error, whoever writes it (the runtime
 * role, tinnox_definer inside sec.audit_unscoped, the migrator), and everything else is
 * untouched. Each refused insert also advances a sequence, which a rollback does not take back,
 * so a test can tell that its case really reached the audit write: a case that never tries to
 * write the row would otherwise pass for the wrong reason.
 *
 * Every statement here is fixed text (tinnox/sql-fragments): the action travels as a parameter
 * into a transaction-local setting, and the database quotes it itself (format %L).
 */
import type pg from 'pg';
import { connectMigrator } from './migrate.ts';

/** A trigger function, a trigger on audit_event and the sequence that counts the refusals. */
const INSTALL_FAULT = `
  DO $install$
  BEGIN
    CREATE SEQUENCE public.audit_fault_refusals;
    CREATE FUNCTION public.audit_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp AS $fault$
    BEGIN
      IF NEW.action = TG_ARGV[0] THEN
        PERFORM pg_catalog.nextval('public.audit_fault_refusals');
        RAISE EXCEPTION 'injected audit failure: the % row cannot be written (test)', NEW.action;
      END IF;
      RETURN NEW;
    END $fault$;
    REVOKE ALL ON FUNCTION public.audit_fault() FROM PUBLIC;
    EXECUTE format(
      'CREATE TRIGGER audit_fault BEFORE INSERT ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.audit_fault(%L)',
      current_setting('audit_fault.action'));
  END $install$`;

const REMOVE_FAULT = `
  DO $remove$
  BEGIN
    IF to_regclass('public.audit_event') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS audit_fault ON public.audit_event;
    END IF;
    DROP FUNCTION IF EXISTS public.audit_fault();
    DROP SEQUENCE IF EXISTS public.audit_fault_refusals;
  END $remove$`;

const REFUSALS =
  'SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS refused FROM public.audit_fault_refusals';

/** Runs `work` in one transaction as tinnox_migrator, on a test database. */
async function asMigrator<T>(
  migratorUrl: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await connectMigrator(migratorUrl, { applicationName: 'tinnox-audit-fault' });
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
      const name = rows[0]?.name ?? '';
      if (!name.endsWith('_test')) {
        throw new Error(
          `refusing to make audit rows fail in database "${name}": the audit fault is for *_test databases only`,
        );
      }
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Removes the fault; a database without it is left as it is. */
export async function removeAuditFault(migratorUrl: string): Promise<void> {
  await asMigrator(migratorUrl, async (client) => {
    await client.query(REMOVE_FAULT);
  });
}

export interface AuditFaultOutcome<T> {
  /** What `work` returned. */
  readonly result: T;
  /** How many inserts of the action the fault refused while `work` ran. */
  readonly refused: number;
}

/**
 * Runs `work` while every audit insert of `action` raises an error, then removes the fault
 * whatever happened. `work` should not throw for the failure under test: return what the code
 * answered (a status, the error) so the caller also gets the number of refused inserts, and
 * assert that it is not zero.
 */
export async function whileAuditFails<T>(
  migratorUrl: string,
  action: string,
  work: () => Promise<T>,
): Promise<AuditFaultOutcome<T>> {
  await asMigrator(migratorUrl, async (client) => {
    await client.query(REMOVE_FAULT);
    await client.query("SELECT set_config('audit_fault.action', $1, true)", [action]);
    await client.query(INSTALL_FAULT);
  });
  try {
    const result = await work();
    const refused = await asMigrator(migratorUrl, async (client) => {
      const { rows } = await client.query<{ refused: string }>(REFUSALS);
      return Number(rows[0]?.refused ?? 0);
    });
    return { result, refused };
  } finally {
    await removeAuditFault(migratorUrl);
  }
}
