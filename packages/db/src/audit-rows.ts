/**
 * Reads audit rows of every organisation from a test database, for the scan the integration
 * set-up runs after each test file (AG-3.4; scripts/lib/audit-row-scan.ts holds the rules).
 * TEST DATABASES ONLY: both functions refuse a database whose name does not end in `_test`.
 *
 * audit_event forces row-level security on its owner, and tinnox_definer may only insert into
 * it, so only the database administrator can read the rows of every organisation and the ones
 * with none. The caller gives that connection string; this package names no credential.
 */
import pg from 'pg';

export interface StoredAuditRow {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly detail: unknown;
}

async function asAdministrator<T>(
  administratorUrl: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: administratorUrl,
    application_name: 'tinnox-audit-row-scan',
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
    const name = rows[0]?.name ?? '';
    if (!name.endsWith('_test')) {
      throw new Error(
        `refusing to read the audit rows of database "${name}": the audit row scan is for *_test databases only`,
      );
    }
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The database's clock now: the mark a test file scans from. */
export async function auditScanMark(administratorUrl: string): Promise<string> {
  return asAdministrator(administratorUrl, async (client) => {
    const { rows } = await client.query<{ mark: string }>('SELECT now()::text AS mark');
    const mark = rows[0]?.mark;
    if (mark === undefined) throw new Error('the database returned no time');
    return mark;
  });
}

/**
 * Every audit row written in a transaction that began at or after `mark`, oldest first; none
 * when the schema has no audit_event table at the moment (a migration test in between states).
 */
export async function auditRowsSince(
  administratorUrl: string,
  mark: string,
): Promise<StoredAuditRow[]> {
  return asAdministrator(administratorUrl, async (client) => {
    const table = await client.query<{ found: boolean }>(
      "SELECT to_regclass('public.audit_event') IS NOT NULL AS found",
    );
    if (table.rows[0]?.found !== true) return [];
    const { rows } = await client.query<{
      id: string;
      action: string;
      actor_id: string | null;
      object_type: string | null;
      object_id: string | null;
      detail: unknown;
    }>(
      `SELECT id::text AS id, action, actor_id, object_type, object_id, detail
       FROM public.audit_event WHERE occurred_at >= $1::timestamptz ORDER BY id`,
      [mark],
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      objectType: row.object_type,
      objectId: row.object_id,
      detail: row.detail,
    }));
  });
}
