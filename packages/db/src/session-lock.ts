/**
 * A session-level advisory lock held for the length of some work that runs on other connections
 * (adoption plan step 22, sections 1.7 and 2.5; EAX-06): the alert check holds one so that a
 * second runner skips, while its claims run in transactions of their own. The lock lives on a
 * connection of its own with no transaction open, so the pool's transaction timeouts do not
 * apply while it is held, and a dropped connection releases it.
 *
 * Losing that connection loses the lock, and another runner may then take it while this one is
 * still working, so the work is handed a signal that aborts when the connection reports an
 * error, and has to look at it before each step it must not take without the lock. The
 * connection goes back to the pool only once the unlock has answered that it gave the lock back:
 * otherwise it is closed, which releases the lock, so no pooled connection keeps it.
 */
import { poolOfDatabase, type Database } from './database.ts';
import type { PoolClient } from './pool.ts';
import { refuseNested } from './nesting.ts';

/**
 * The session locks, each keyed hashtextextended('tinnox.<name>', 0). The key is the one the
 * alert check took before this helper existed, so a process of the previous release, still
 * running during a deploy, contends for the same lock. A new name is a new holder: a lock that
 * guards work on its own connection only is a pg_advisory_xact_lock in that transaction instead.
 */
export type SessionLock = 'display_alerts';

/** What withSessionLock did: nothing, because another session held the lock, or the work. */
export type SessionLockOutcome<T> =
  { readonly held: false } | { readonly held: true; readonly value: T };

/**
 * Tries to take `lock` on a dedicated connection and, if it is free, runs `work` while holding
 * it, then gives it back; if another session holds it, does nothing and returns
 * `{ held: false }` (try-lock: no wait). `work` runs its statements in transactions of its own
 * (readOrg, changeOrg), never on the lock's connection. Its signal aborts, with the connection's
 * error as the reason, when that connection is lost: the lock is gone with it, so the work
 * should stop taking steps the lock guards.
 *
 * The lock is given back whether `work` returns or throws, and its error is rethrown. When the
 * unlock fails, or answers that the lock was not held on that backend (as behind a
 * transaction-mode pooler), the connection is closed instead of returned to the pool.
 */
export async function withSessionLock<T>(
  db: Database,
  lock: SessionLock,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<SessionLockOutcome<T>> {
  const key = `tinnox.${lock}`;
  // CHK-3: the lock's connection is checked out while an outer transaction would hold another,
  // the pool-exhaustion half of U-3 (tinnox/no-nested-transaction reports what one file shows).
  refuseNested(
    'withSessionLock',
    'Take the lock first and open the transactions inside its work, as runDisplayAlerts in apps/api/src/alerts.ts does.',
    'withSessionLock holds a connection of its own while the open transaction holds another.',
  );
  const client = await poolOfDatabase(db).connect();
  const lost = new AbortController();
  // Set when the connection must not go back to the pool: it was lost, or may still hold the lock.
  let broken: Error | undefined;
  const onError = (error: Error): void => {
    broken = error;
    lost.abort(error);
  };
  // While a client is checked out the pool listens for nothing on it, so without this an error
  // on the connection would be thrown as an unhandled 'error' event.
  client.on('error', onError);
  try {
    let taken: boolean;
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
        [key],
      );
      taken = rows[0]?.ok === true;
    } catch (error) {
      // Whether the server took the lock is not known: close the connection, which releases it.
      broken ??= asError(error, 'advisory lock failed');
      throw error;
    }
    if (!taken) return { held: false };
    try {
      return { held: true, value: await work(lost.signal) };
    } finally {
      broken = (await unlock(client, key)) ?? broken;
    }
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/** Gives the lock back; the reason to close the connection when that did not happen. */
async function unlock(client: PoolClient, key: string): Promise<Error | undefined> {
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok',
      [key],
    );
    return rows[0]?.ok === true ? undefined : new Error('advisory lock was not held');
  } catch (error) {
    return asError(error, 'advisory unlock failed');
  }
}

const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(fallback);
