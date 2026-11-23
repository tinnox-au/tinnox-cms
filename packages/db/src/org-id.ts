// The one place that makes an OrgId (AG-2.3, D25): lint refuses a cast to it in every other file
// (NO_ORG_ID_FORGERY in eslint.config.js), and ./entries.test.ts names the modules that may
// import this one. No entry of the package exports it. What reaches the outside is:
//   - the lookups of ./sec.ts, which return the organisation the database gave for a verified
//     session, a device credential or a job (the runtime entry);
//   - newOrgId and the rows asDefiner reads (the '@tinnox/db/migrate' entry, offline tools only);
//   - testOrgId (the '@tinnox/db/testing' entry, tests only).
import type { QueryResult, QueryResultRow } from './pool.ts';
import type { OrgId } from './tx.ts';

/** Says that `value` is an organisation's id. The caller is one of the modules named above. */
export function mintOrgId(value: string): OrgId {
  return value as OrgId;
}

type Minted<V> = V extends string ? OrgId : V;

/**
 * A row read as tinnox_definer: its `org_id` column is an `OrgId` (D25). The definer reads every
 * organisation's rows, so an `org_id` it selects from a tenant table is the organisation that
 * row belongs to, which provisioning then enters. The name of the column is all this goes by:
 * that a statement really selects a table's own org_id under that name is left to review.
 */
export type DefinerRow<R> = { [K in keyof R]: K extends 'org_id' ? Minted<R[K]> : R[K] };

/** The result of a statement sent as tinnox_definer. */
export type DefinerResult<R> = Omit<QueryResult, 'rows'> & { rows: DefinerRow<R>[] };

/**
 * Types the rows of a statement that asDefiner (./definer.ts) sent. No cast is written: pg
 * types the values of a row `any`, so the checker lets the result through as it is. This
 * function is where that is done on purpose, and the only place.
 */
export function readAsDefiner<R extends QueryResultRow>(result: QueryResult<R>): DefinerResult<R> {
  return result;
}
