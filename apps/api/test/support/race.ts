/**
 * The helpers of a race test (adoption plan section 4.2, step 33): two sides, one of which has
 * to wait for the other, and the wait is read from the server, never guessed from how long a
 * side took. Nothing here sleeps for a fixed time: each wait polls an observed server state
 * (pg_locks) and returns as soon as it is there.
 *
 * The primitives live in '@tinnox/db/testing', where the tests of packages/db, which may not
 * import the API's harness, take them too; they are re-exported here so a test of the API or of
 * tests/integration finds every race helper in one place. To stop one side at a statement, hold
 * it with `faultHarness().hold` (./faults.ts): its `reached` gives the pid to wait behind, and
 * `reachedBefore` waits for it without hanging. `withoutWaitingFor` is for the side that must
 * not wait.
 */
import type { LockReader } from '@tinnox/db/testing';

export {
  backendPid,
  twoTransactions,
  waitForLockWaiters,
  type LockReader,
} from '@tinnox/db/testing';

/**
 * Waits until backend `pid` waits for a lock, whoever holds it. For a side whose holder the test
 * cannot name, such as a script that locks rows in an order of its own; where the holder is
 * known, `waitForLockWaiters` is the stricter check, since only a wait behind that holder counts.
 * Any role may read pg_locks, so `reader` needs no more than a connection to the same server.
 * With `waiter`, the promise of the side that has to wait, it fails as soon as that side ends
 * without having been seen waiting. Gives up after ten seconds with `what` in the message.
 */
export async function waitForLockWait(
  reader: LockReader,
  pid: number,
  what: string,
  options: { readonly waiter?: Promise<unknown>; readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let ended = false;
  const mark = (): void => {
    ended = true;
  };
  options.waiter?.then(mark, mark);
  for (;;) {
    // Read before the server is asked, as in waitForLockWaiters.
    const endedBefore = ended;
    const { rowCount } = await reader.query(
      'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted',
      [pid],
    );
    if (rowCount !== null && rowCount > 0) return;
    if (endedBefore) {
      throw new Error(`${what}: the side that had to wait ended without waiting for a lock`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: backend ${String(pid)} did not wait for a lock within ${String(timeoutMs / 1000)} s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The backend of the request stopped at `held` (a hold of ./faults.ts). Fails at once, with what
 * the request answered, when it ends without reaching the held statement, instead of waiting
 * for a hold nobody comes to.
 */
export async function reachedBefore(
  held: { readonly reached: Promise<number> },
  request: Promise<Response>,
  who: string,
): Promise<number> {
  let reached = false;
  return Promise.race([
    held.reached.then((pid) => {
      reached = true;
      return pid;
    }),
    request.then(async (response) => {
      if (reached) return 0;
      throw new Error(
        `${who} answered ${String(response.status)} before it reached the statement it was to be held at: ${await response.clone().text()}`,
      );
    }),
  ]);
}

/** How many backends of this database wait for a lock that backend `holder` holds, now. */
export async function lockWaitersNow(reader: LockReader, holder: number): Promise<number> {
  const { rows } = await reader.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity a
      WHERE a.datname = current_database() AND $1 = ANY (pg_blocking_pids(a.pid))`,
    [holder],
  );
  return rows[0]?.n ?? 0;
}

/**
 * What `work` settles with, which must happen while backend `holder` still holds its locks:
 * the opposite of waitForLockWaiters. Fails as soon as the server shows more than `already`
 * backends waiting for a lock of that holder, with `what` in the message, rather than hanging
 * until the holder lets go; `already` counts the waiters the test knows of. Gives up after ten
 * seconds.
 */
export async function withoutWaitingFor<T>(
  reader: LockReader,
  holder: number,
  work: Promise<T>,
  what: string,
  options: { readonly already?: number } = {},
): Promise<T> {
  let done: { readonly value: T } | undefined;
  let failed: Error | undefined;
  work.then(
    (value) => {
      done = { value };
    },
    (error: unknown) => {
      failed = error instanceof Error ? error : new Error(`${what}: the work failed`);
    },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (done !== undefined) return done.value;
    if (failed !== undefined) throw failed;
    if ((await lockWaitersNow(reader, holder)) > (options.already ?? 0)) {
      throw new Error(`${what}: it waits for a lock of backend ${String(holder)}`);
    }
    if (Date.now() > deadline) throw new Error(`${what}: nothing within 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
