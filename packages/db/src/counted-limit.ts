/**
 * A per-organisation ceiling on something counted (adoption plan step 22, section 2.5; SCX-05 of
 * review round 3): the organisation's lock for that thing, then the count, then the refusal or
 * the insert, in that order, in the caller's transaction. A count read without the lock lets two
 * transactions both see one below the ceiling and both insert; under the lock the second one
 * counts after the first has committed. Every counted ceiling of the API goes through here, so a
 * count cannot be written apart from its lock.
 */
import { lockOrgMembership } from './members.ts';
import type { OrgTx } from './tx.ts';

/**
 * The per-organisation lock of each counted thing, hashtextextended('tinnox.<name>:' || org, 0).
 * The names are the keys the routes took before this helper existed, so an API process of the
 * previous release, still serving during a deploy, waits on the same locks. 'membership' is the
 * member-management lock of lockOrgMembership, which the 0013 trigger also takes.
 */
export type CountedLock =
  'folder_count' | 'tag_count' | 'alert_recipient_count' | 'media_quota' | 'membership';

export interface CountedLimit<T> {
  readonly lock: CountedLock;
  /**
   * What is counted, read under the lock: rows, or bytes in use. It may throw a refusal that has
   * to come before the ceiling's (an address already on the list).
   */
  readonly count: (tx: OrgTx) => Promise<number>;
  /** How much the change adds to the count: 1 for a row (the default), the size of a file. */
  readonly adding?: number;
  /** The most the organisation may have. */
  readonly max: number;
  /**
   * Runs instead of the insert when the change would pass `max`, with the count: it throws the
   * refusal, or returns it when the refusal has an audit row to commit.
   */
  readonly whenFull: (counted: number) => T;
}

/**
 * Takes `limit.lock` for the transaction's organisation, counts, and runs `insert` only when the
 * change still fits under `limit.max` (the count plus what it adds is at most `max`); otherwise
 * `limit.whenFull`. It runs on the transaction of a change and opens none. The lock is held until
 * that transaction ends, so the insert has to be made inside `insert`.
 */
export async function withCountedLimit<T>(
  tx: OrgTx,
  limit: CountedLimit<T>,
  insert: (counted: number) => Promise<T>,
): Promise<T> {
  await lockCounted(tx, limit.lock);
  const counted = await limit.count(tx);
  if (counted + (limit.adding ?? 1) > limit.max) return limit.whenFull(counted);
  return insert(counted);
}

async function lockCounted(tx: OrgTx, lock: CountedLock): Promise<void> {
  // Taken again when the change already holds it (changeAsOperator's lockMembership): a second
  // request for an advisory lock a transaction holds succeeds at once.
  if (lock === 'membership') return lockOrgMembership(tx);
  const { rows } = await tx.query<{ in_org: boolean }>(
    `SELECT app_org_id() IS NOT NULL AS in_org,
            pg_advisory_xact_lock(hashtextextended('tinnox.' || $1::text || ':' || app_org_id()::text, 0))`,
    [lock],
  );
  // As in lockOrgMembership: pg_advisory_xact_lock(NULL) takes no lock and says nothing.
  if (rows[0]?.in_org !== true) {
    throw new Error(
      'withCountedLimit requires an organisation context: call it on the tx of changeAsOperator (apps/api/src/auth/permissions.ts) or of changeOrg (@tinnox/db)',
    );
  }
}
