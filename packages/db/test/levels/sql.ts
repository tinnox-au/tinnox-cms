// What a seeder of the migrate-forward chain may use (adoption plan section 4.3, D13). A seeder
// writes plain SQL valid at its own level, so it imports nothing but this file: no @tinnox/*
// helper, whose column lists follow today's schema, and nothing outside this folder
// (eslint.config.js, the db-levels facet of no-restricted-imports).

/** The part of a pg client a seeder needs: the chain passes a client logged in as tinnox_migrator. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: unknown[] }>;
}

/**
 * One level's seeder: `seed` plants, in SQL valid at `level`, the rows an installation at that
 * level could hold, and `plants` says what they are. A level whose migration adds nothing a row
 * could hold has a no-op seeder instead, whose `reason` says why.
 */
export type Seeder =
  | {
      readonly level: string;
      readonly plants: string;
      readonly seed: (client: SqlClient) => Promise<void>;
    }
  | { readonly level: string; readonly reason: string };

/**
 * A fixed id that names its level: `id('0004', 3)` is 00040000-0000-4000-8000-000000000003.
 * Fixed, so the chain's assertions can name each seeded row; version 4, so the contracts take it.
 */
export function id(level: string, n: number): string {
  return `${level}0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** A 32-byte value written as SQL hex (`'\x4141...'`), low in entropy on purpose. */
export function bytes32(hexPair: string): string {
  return `\\x${hexPair.repeat(32)}`;
}

/**
 * Statements as the migrator inside one organisation, in one transaction: row-level security is
 * forced, so even the tables' owner sees and writes no tenant row without app.org_id.
 */
export async function inOrg(
  client: SqlClient,
  orgId: string,
  work: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Statements as tinnox_definer, in one transaction: only it (BYPASSRLS) writes the tables that
 * have no organisation policy (session, pairing_session), as the sec.* functions do.
 */
export async function asDefiner(client: SqlClient, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE tinnox_definer');
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
