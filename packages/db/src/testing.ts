// The '@tinnox/db/testing' entry: what only tests may use. Lint refuses the entry in every file
// that is not a test (the db entries of eslint.config.js), so nothing here can reach the API, the
// alert job or an offline tool.
import type { Pool } from './pool.ts';
import { withoutOrg, type Tx } from './tx.ts';

// The audit-debt guard of the integration test database (adoption plan section 2.1 C, D3).
export {
  AUDIT_DEBT_SQLSTATE,
  ensureAuditDebtGuard,
  installAuditDebtGuard,
  removeAuditDebtGuard,
  unjudgedSql,
  watchAuditDebt,
  whileUnauditedAllowed,
  type AuditDebtWatch,
} from './audit-debt-guard.ts';

/**
 * Runs `fn` in a transaction of its own with no organisation, as a route does before the
 * organisation is known. For the sec.* wrappers that change data and the audit writers: they
 * take a `Tx`, and the handle `poolAsTx` gives is not one (D2).
 */
export function inTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withoutOrg(pool, fn);
}
