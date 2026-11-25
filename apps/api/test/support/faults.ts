/**
 * The fault harness (adoption plan section 4.2, step 33): a pool wrapper that delivers one named
 * fault at one statement of the code under test. The code under test gets the wrapped pool
 * (`startTestApp(…, { wrapPool })`, or `databaseOn(harness.wrapPool(pool))`), and the test arms a
 * fault by the statement it strikes at:
 *
 *   const faults = faultHarness();
 *   const t = await startTestApp({}, 1000, { wrapPool: faults.wrapPool });
 *   const fault = faults.arm({ mode: 'deadlock', at: /INSERT INTO audit_event/ });
 *   const answer = await operator.fetch(…);
 *   const seen = await fault.delivered;   // rejects when PostgreSQL did not raise it
 *
 * `faultyPool(pool, fault)` is the short form for a pool with one standing fault. An armed fault
 * strikes once and is then disarmed, unless armed with `{ every: true }`; `disarm()` takes back
 * one that has not struck, and `disarmAll()`, called after each test of a file that shares a
 * harness, takes back every fault and releases every hold, so a test that failed before its
 * fault struck cannot leave it for the next one. `delivered` settles with what the database
 * really did (the SQLSTATE of the server's own error, the backend that is gone, the tag of the
 * COMMIT), and rejects when the fault was not delivered, so a test never passes on a fault that
 * only set a flag.
 *
 * The modes, with what the code under test sees at the statement `at` matches:
 *
 * - `hold` (the method `hold`, not `arm`): the statement is not sent until `release`; nothing
 *   fails. `reached` gives the backend's pid, for waitForLockWaiters (./race.ts).
 * - `lost-commit-answer`: nothing at the statement; the COMMIT of its transaction is sent and
 *   answered, then the backend is ended, and the code sees a lost connection instead of the
 *   answer: the connection emits 'error' and is not queryable, as in production, so it is
 *   destroyed rather than returned to the pool.
 * - `never-sent`: the statement is not sent; the code sees `error`. Without an `error` of the
 *   test's own it is a lost connection, and the backend is ended first, as for
 *   `lost-commit-answer`; a database error the test gives leaves the connection alive.
 * - `backend-killed`: the backend is ended first (pg_terminate_backend) and its transaction is
 *   rolled back by the server; the statement then fails on the dead connection, and the
 *   connection emits 'error'.
 * - `deadlock` (40P01), `statement-timeout` (57014), `lock-timeout` (55P03): PostgreSQL raises
 *   the error in the code's own transaction, on a statement the harness sends on that connection
 *   in place of the matched one (a wait for an advisory lock, or a sleep); the transaction is
 *   aborted as after any error, and the matched statement is not sent. A matched statement sent
 *   outside a transaction gets one of its own, rolled back after the error, as an autocommit
 *   statement that fails is.
 * - `serialization-failure` (40001), `unique-violation` (23505), `foreign-key-violation` (23503):
 *   the matched statement itself is sent, waits for the `rival` transaction of the test, which
 *   is committed once the wait is seen on the server, and then fails with the error PostgreSQL
 *   raises for it: a race really lost. `serialization-failure` is not a production condition:
 *   the product runs at READ COMMITTED, where this race raises nothing, so the harness starts
 *   transactions at REPEATABLE READ while it is armed. It exists to give the error classifier a
 *   real 40001; a test must not present it as something production can see.
 *
 * Beside the faults, the harness keeps every error the database raised on a wrapped connection
 * (`databaseErrors`), struck by a fault or not: a race test reads there which constraint, if
 * any, PostgreSQL refused a request with, where the answer alone would not tell a constraint
 * from the route's own check.
 *
 * Only connections taken with `pool.connect()` are wrapped, which is how every transaction of
 * packages/db takes one; `pool.query()` goes straight through. The harness sends its own
 * statements (the kill, the advisory locks of the other side) on other connections of the same
 * pool, so the pool needs one to spare; they write no table.
 */
import pg from 'pg';
import {
  backendPid,
  killBackend,
  waitForLockWaiters,
  type KilledBackend,
  type Pool,
  type PoolClient,
} from '@tinnox/db/testing';

/** The statement a fault strikes at: its text matches the pattern, or the predicate is true. */
export type StatementMatcher = RegExp | ((text: string) => boolean);

/**
 * The other side of a race: a connection of the test's own, in an open transaction that has
 * made the conflicting change and not committed it. The harness commits it.
 */
export interface Rival {
  query(text: string): Promise<unknown>;
}

/** The SQLSTATE PostgreSQL raises in each mode that makes it raise one. */
export const FAULT_SQLSTATE = {
  deadlock: '40P01',
  'statement-timeout': '57014',
  'lock-timeout': '55P03',
  'serialization-failure': '40001',
  'unique-violation': '23505',
  'foreign-key-violation': '23503',
} as const;

type InjectedMode = 'deadlock' | 'statement-timeout' | 'lock-timeout';
type RaceMode = 'serialization-failure' | 'unique-violation' | 'foreign-key-violation';

/** What a mode that loses a race takes: the other side. */
interface RaceFault<M extends RaceMode> {
  readonly mode: M;
  readonly at: StatementMatcher;
  /**
   * `serialization-failure`: it has changed a row the matched statement changes or locks. The
   * harness starts the code's transactions at REPEATABLE READ while this is armed; the product
   * runs at READ COMMITTED, where PostgreSQL takes the new row version and raises nothing, so
   * production never sees 40001 this way: the mode only gives the classifier a real 40001.
   * `unique-violation`: it has inserted the key the statement inserts.
   * `foreign-key-violation`: it has deleted the row the statement refers to.
   */
  readonly rival: Rival;
}

export type Fault =
  | { readonly mode: 'lost-commit-answer'; readonly at: StatementMatcher }
  | { readonly mode: 'never-sent'; readonly at: StatementMatcher; readonly error?: Error }
  | { readonly mode: 'backend-killed'; readonly at: StatementMatcher }
  | { readonly mode: 'deadlock'; readonly at: StatementMatcher }
  | { readonly mode: 'statement-timeout'; readonly at: StatementMatcher }
  | { readonly mode: 'lock-timeout'; readonly at: StatementMatcher }
  | RaceFault<'serialization-failure'>
  | RaceFault<'unique-violation'>
  | RaceFault<'foreign-key-violation'>;

export type FaultMode = Fault['mode'];

/** What the database did when a fault struck. */
export interface Delivered {
  readonly mode: FaultMode;
  /** The backend of the code under test that the fault struck. */
  readonly pid: number;
  /** The statement `at` matched. */
  readonly statement: string;
  /** The SQLSTATE of the error the code under test saw, or null when it carried none. */
  readonly sqlstate: string | null;
  /** The error the code under test saw. */
  readonly error: Error;
  /** `lost-commit-answer`: the tag the server answered, 'COMMIT' when it committed. */
  readonly commitTag?: string;
  /**
   * `backend-killed`, `lost-commit-answer` and `never-sent` without an error of the test's own:
   * the backend, seen gone from pg_stat_activity.
   */
  readonly killed?: KilledBackend;
}

/** An error the database raised on a connection of the wrapped pool. */
export interface DatabaseErrorSeen {
  /** The backend that raised it. */
  readonly pid: number;
  /** The statement it was raised for. */
  readonly statement: string;
  readonly sqlstate: string | null;
  /** The constraint the error names, or null. */
  readonly constraint: string | null;
}

export interface ArmedFault {
  /**
   * Resolves when the fault struck and the database did what the mode says; rejects when it
   * struck and the database did not, or when it was disarmed before it struck.
   */
  readonly delivered: Promise<Delivered>;
  /** Takes the fault back. Nothing happens when it has already struck. */
  disarm(): void;
}

export interface StatementHold {
  /**
   * Resolves when the held statement arrives, with the backend pid of the connection that sent
   * it (for waitForLockWaiters of @tinnox/db/testing); it is not sent until `release`.
   */
  readonly reached: Promise<number>;
  release(): void;
}

export interface StatementHolds {
  /** Pass as `startTestApp(…, { wrapPool })`. */
  readonly wrapPool: (pool: Pool) => Pool;
  /**
   * Holds the next statement of any transaction for which `matches` is true, before it is
   * sent, until `release`: a test then changes the database in between. `matches` is called
   * for every statement until it matches, so it may count.
   */
  hold(matches: (text: string) => boolean): StatementHold;
  /**
   * For afterEach: takes back every armed fault that has not struck (its `delivered` rejects,
   * naming it) and releases every hold, so a test that failed half-way leaves nothing armed.
   * Forgets the database errors seen so far.
   */
  disarmAll(): void;
  /**
   * Every error the database raised on a wrapped connection since the last `disarmAll`, oldest
   * first: the server's own errors only (pg.DatabaseError), not a lost connection.
   */
  databaseErrors(): readonly DatabaseErrorSeen[];
}

export interface FaultHarness extends StatementHolds {
  /** Arms `fault` for the next statement it matches, or with `every` for each one. */
  arm(fault: Fault, options?: { readonly every?: boolean }): ArmedFault;
  /**
   * Ends the backend of one of the wrapped pool's connections at a moment the test chooses,
   * and returns once the server no longer lists it and the client has seen the connection end
   * (its 'error' listeners have run). For a connection that sends nothing at that moment, such
   * as the one holding a session lock; at a statement, arm `backend-killed`.
   */
  killBackend(pid: number): Promise<KilledBackend>;
}

// The advisory locks of the harness's own waits: (class, pid of the struck backend), so two
// faults on different connections never meet. Transaction-level, so they end with ROLLBACK. A
// deadlock that has to be tried again takes the next pair of classes (FAULT_LOCK_CLASSES).
const LOCK_OWN = 0x7a17_0000;
const LOCK_OTHER = 0x7a17_0001;
const DEADLOCK_ATTEMPTS = 8;
const XACT_LOCK = 'SELECT pg_advisory_xact_lock($1, $2)';
/** How long the harness waits for something it caused, as waitForLockWaiters does. */
const DEADLINE_MS = 10_000;
const GAVE_UP = 'the fault harness gave up after 10 s';

/** The classes of every advisory lock the harness takes, for a test that counts what is left. */
export const FAULT_LOCK_CLASSES = {
  from: LOCK_OWN,
  to: LOCK_OTHER + 2 * (DEADLOCK_ATTEMPTS - 1),
} as const;

interface Armed {
  readonly fault: Fault;
  readonly every: boolean;
  readonly resolve: (seen: Delivered) => void;
  readonly reject: (error: Error) => void;
}

const matches = (at: StatementMatcher, text: string): boolean =>
  typeof at === 'function' ? at(text) : at.test(text);

const bound = <T extends object>(target: T, key: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
};

const asError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(`a statement failed with ${String(thrown)}`);

const describeAt = (at: StatementMatcher): string =>
  typeof at === 'function' ? `the predicate ${at.name || '(anonymous)'}` : String(at);

/** `promise`, or a failure naming `what` when it has not settled within DEADLINE_MS. */
const within = async <T>(promise: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${GAVE_UP} waiting for ${what}`));
    }, DEADLINE_MS);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};

const sqlstateOf = (error: Error): string | null =>
  error instanceof pg.DatabaseError && typeof error.code === 'string' ? error.code : null;

/** A statement's failure, or null when it was answered. */
const failureOf = (statement: Promise<unknown>): Promise<Error | null> =>
  statement.then(
    () => null,
    (thrown: unknown) => asError(thrown),
  );

/** A fault harness: see the head of this file. */
export function faultHarness(): FaultHarness {
  let held: {
    matches: (text: string) => boolean;
    reached: (pid: number) => void;
    released: Promise<void>;
  } | null = null;
  /** The releases of the holds not yet released, for disarmAll. */
  const unreleased = new Set<() => void>();
  const armed: Armed[] = [];
  /** The errors the database raised on the wrapped connections, for databaseErrors. */
  const raised: DatabaseErrorSeen[] = [];
  /** The wrapped pools' connections by backend pid, and the pool each came from. */
  const connections = new Map<number, { client: PoolClient; pool: Pool }>();

  const take = (entry: Armed): void => {
    if (entry.every) return;
    const at = armed.indexOf(entry);
    if (at !== -1) armed.splice(at, 1);
  };

  /** Ends backend `pid` through `pool` and waits for `client` to see its connection end. */
  const kill = async (pool: Pool, client: PoolClient, pid: number): Promise<KilledBackend> => {
    // pg emits 'end' after the 'error' of a lost connection, so every listener has run by then.
    const ended = new Promise<void>((resolve) => {
      client.once('end', () => {
        resolve();
      });
    });
    const killed = await killBackend(pool, pid);
    await within(
      ended,
      `the client of backend ${String(pid)} to see its connection end, after the server stopped listing it`,
    );
    return killed;
  };

  /**
   * Makes PostgreSQL raise the mode's error on `client`, and returns the failure of the
   * harness's statement there (null when it was answered: the fault was not delivered).
   */
  const raise = async (
    mode: InjectedMode,
    pool: Pool,
    client: PoolClient,
    pid: number,
  ): Promise<Error | null> => {
    if (mode === 'statement-timeout') {
      // The server cancels the sleep when the timeout fires; the sleep can only lose.
      await client.query("SET LOCAL statement_timeout = '50ms'");
      return failureOf(client.query('SELECT pg_sleep(600)'));
    }
    const other = await pool.connect();
    try {
      if (mode === 'lock-timeout') {
        await other.query('BEGIN');
        await other.query(XACT_LOCK, [LOCK_OTHER, pid]);
        // The other side keeps the lock until the failure is in, so the wait can only time out.
        await client.query("SET LOCAL lock_timeout = '50ms'");
        return await failureOf(client.query(XACT_LOCK, [LOCK_OTHER, pid]));
      }
      // A deadlock: the struck backend holds its own lock and waits for the other side's, and
      // the other side then asks for the struck backend's. PostgreSQL ends the transaction of
      // the backend whose deadlock check finds the cycle, and each side checks deadlock_timeout
      // after its own wait began. The other side asks in one server-side statement, half that
      // time into the struck backend's wait as pg_locks shows it, so the struck backend checks
      // first, with the cycle there. Which side PostgreSQL ended is then read, not assumed: on
      // a server too busy to keep that order the other side is ended instead, the struck
      // backend gets the lock, and the deadlock is made again with the next pair of locks.
      for (let attempt = 0; attempt < DEADLOCK_ATTEMPTS; attempt += 1) {
        const own = LOCK_OWN + 2 * attempt;
        const others = LOCK_OTHER + 2 * attempt;
        await other.query('BEGIN');
        await other.query(XACT_LOCK, [others, pid]);
        await client.query(XACT_LOCK, [own, pid]);
        const struck = failureOf(client.query(XACT_LOCK, [others, pid]));
        const closing = failureOf(
          other.query(
            `DO $$ BEGIN
               LOOP
                 EXIT WHEN EXISTS (
                   SELECT 1 FROM pg_locks
                    WHERE pid = ${String(pid)} AND NOT granted
                      AND clock_timestamp() - waitstart
                          >= current_setting('deadlock_timeout')::interval / 2);
                 IF clock_timestamp() - statement_timestamp() > interval '10 s' THEN
                   RAISE EXCEPTION '${GAVE_UP} waiting for backend ${String(pid)} to wait for the lock of the deadlock fault';
                 END IF;
                 PERFORM pg_sleep(0.005);
               END LOOP;
               PERFORM pg_advisory_xact_lock(${String(own)}, ${String(pid)});
             END $$`,
          ),
        );
        const failure = await struck;
        if (failure !== null) {
          // The struck transaction keeps its lock until the code rolls it back, so the other
          // side still waits for it: cancel that wait rather than leave it for later.
          await pool.query('SELECT pg_cancel_backend($1)', [backendPid(other)]);
          await closing;
          return failure;
        }
        // The struck backend got the lock: the other side was ended, or gave up.
        const otherFailure = await closing;
        if (otherFailure?.message.startsWith(GAVE_UP) === true) throw otherFailure;
        await other.query('ROLLBACK');
      }
      return null;
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
  };

  /**
   * `raise`, in a transaction of its own when the matched statement was sent outside one:
   * SET LOCAL would otherwise hold for nothing (PostgreSQL only warns) and the sleep run until
   * the role's statement_timeout, and the deadlock's own lock would end with its statement.
   */
  const raiseIn = async (
    inTransaction: boolean,
    mode: InjectedMode,
    pool: Pool,
    client: PoolClient,
    pid: number,
  ): Promise<Error | null> => {
    if (inTransaction) return raise(mode, pool, client, pid);
    await client.query('BEGIN');
    try {
      return await raise(mode, pool, client, pid);
    } finally {
      await client.query('ROLLBACK');
    }
  };

  const strike = async (
    entry: Armed,
    pool: Pool,
    client: PoolClient,
    text: string,
    values: unknown[] | undefined,
    inTransaction: boolean,
  ): Promise<unknown> => {
    const { fault } = entry;
    const pid = backendPid(client);
    const seen = (error: Error, more: Partial<Delivered> = {}): Delivered => ({
      mode: fault.mode,
      pid,
      statement: text,
      sqlstate: sqlstateOf(error),
      error,
      ...more,
    });
    const notDelivered = (why: string): void => {
      entry.reject(new Error(`the ${fault.mode} fault was not delivered at "${text}": ${why}`));
    };

    if (fault.mode === 'never-sent') {
      if (fault.error !== undefined) {
        // An answer of the database the test made up: the connection is alive, as after one.
        entry.resolve(seen(fault.error));
        throw fault.error;
      }
      // A lost connection really ends the backend, so the code under test sees what it would
      // in production: an 'error' on the connection, and a ROLLBACK that fails.
      const killed = await kill(pool, client, pid);
      const error = new Error('Connection terminated unexpectedly');
      entry.resolve(seen(error, { killed }));
      throw error;
    }

    if (fault.mode === 'backend-killed') {
      const killed = await kill(pool, client, pid);
      const failure = await failureOf(client.query(text, values));
      if (failure === null) {
        notDelivered('the statement was answered on a backend that was to be gone');
        return undefined;
      }
      entry.resolve(seen(failure, { killed }));
      throw failure;
    }

    if (
      fault.mode === 'deadlock' ||
      fault.mode === 'statement-timeout' ||
      fault.mode === 'lock-timeout'
    ) {
      const expected = FAULT_SQLSTATE[fault.mode];
      let failure: Error | null;
      try {
        failure = await raiseIn(inTransaction, fault.mode, pool, client, pid);
      } catch (error) {
        notDelivered(asError(error).message);
        throw error;
      }
      if (failure !== null && sqlstateOf(failure) === expected) {
        entry.resolve(seen(failure));
        throw failure;
      }
      notDelivered(
        failure === null
          ? `PostgreSQL raised nothing, not ${expected}`
          : `PostgreSQL raised ${sqlstateOf(failure) ?? failure.message}, not ${expected}`,
      );
      if (failure !== null) throw failure;
      return client.query(text, values);
    }

    if (fault.mode === 'lost-commit-answer') {
      throw new Error('a lost COMMIT answer strikes at COMMIT, not at the statement');
    }

    // A race really lost: the statement waits for the rival's transaction, which then commits.
    const expected = FAULT_SQLSTATE[fault.mode];
    const own = client.query(text, values);
    const failure = failureOf(own);
    try {
      const waiting = await waitForLockWaiters(
        pool,
        backendPid(fault.rival),
        1,
        `the statement of a ${fault.mode} fault never waited for the rival's transaction`,
        { waiter: own },
      );
      if (!waiting.includes(pid))
        throw new Error('another backend waited for the rival, not this one');
    } catch (error) {
      notDelivered(asError(error).message);
      return own;
    }
    await fault.rival.query('COMMIT');
    const lost = await failure;
    if (lost !== null && sqlstateOf(lost) === expected) {
      entry.resolve(seen(lost));
      throw lost;
    }
    notDelivered(
      lost === null
        ? `PostgreSQL raised nothing after the rival committed, not ${expected}`
        : `PostgreSQL raised ${sqlstateOf(lost) ?? lost.message}, not ${expected}`,
    );
    return own;
  };

  const wrapClient = (pool: Pool, client: PoolClient): PoolClient => {
    const pid = backendPid(client);
    if (!connections.has(pid)) {
      connections.set(pid, { client, pool });
      client.once('end', () => connections.delete(pid));
    }
    /** The lost-COMMIT faults whose statement ran in the open transaction. */
    const marked = new Set<Armed>();
    /** Whether this connection has an open transaction, as the statements sent on it say. */
    let inTransaction = false;
    const query = async (text: unknown, values?: unknown[]): Promise<unknown> => {
      try {
        return await judged(text, values);
      } catch (error) {
        if (error instanceof pg.DatabaseError) {
          raised.push({
            pid,
            statement: typeof text === 'string' ? text : '',
            sqlstate: sqlstateOf(error),
            constraint:
              typeof error.constraint === 'string' && error.constraint !== ''
                ? error.constraint
                : null,
          });
        }
        throw error;
      }
    };
    const judged = async (text: unknown, values?: unknown[]): Promise<unknown> => {
      // Only statements sent as text are judged: packages/db sends nothing else.
      if (typeof text !== 'string') return client.query(text as string, values);

      const hold = held;
      if (hold?.matches(text) === true) {
        held = null;
        hold.reached(pid);
        await hold.released;
      }

      // 'BEGIN' or 'BEGIN READ ONLY': a mark never carries over from an earlier transaction.
      if (text === 'COMMIT' || text === 'ROLLBACK') inTransaction = false;
      if (text.startsWith('BEGIN')) {
        inTransaction = true;
        marked.clear();
        if (text === 'BEGIN' && armed.some((a) => a.fault.mode === 'serialization-failure')) {
          const begun = await client.query(text, values);
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          return begun;
        }
      }
      for (const entry of armed) {
        if (entry.fault.mode === 'lost-commit-answer' && matches(entry.fault.at, text)) {
          marked.add(entry);
        }
      }
      if (text === 'COMMIT' && marked.size > 0) {
        const lost = [...marked].filter((entry) => armed.includes(entry));
        marked.clear();
        if (lost.length > 0) {
          const result = await client.query<pg.QueryResultRow>(text, values);
          // The answer has arrived; now the connection is lost for real, so the code sees what
          // it would in production: an 'error' on the connection, and a ROLLBACK that fails.
          const killed = await kill(pool, client, pid);
          const error = new Error('Connection terminated unexpectedly');
          for (const entry of lost) {
            take(entry);
            entry.resolve({
              mode: 'lost-commit-answer',
              pid,
              statement: entry.fault.at.toString(),
              sqlstate: null,
              error,
              commitTag: result.command,
              killed,
            });
          }
          throw error;
        }
      }

      const entry = armed.find(
        (a) => a.fault.mode !== 'lost-commit-answer' && matches(a.fault.at, text),
      );
      if (entry === undefined) return client.query(text, values);
      take(entry);
      return strike(entry, pool, client, text, values, inTransaction);
    };
    return new Proxy(client, {
      get: (real, name) => (name === 'query' ? query : bound(real, name)),
    });
  };

  return {
    wrapPool: (pool) =>
      new Proxy(pool, {
        get(target, key) {
          if (key !== 'connect') return bound(target, key);
          return async () => wrapClient(target, await target.connect());
        },
      }),
    hold(matchesText) {
      let reached: (pid: number) => void = () => undefined;
      let release: () => void = () => undefined;
      const atStatement = new Promise<number>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = () => {
          unreleased.delete(release);
          resolve();
        };
      });
      unreleased.add(release);
      held = { matches: matchesText, reached, released };
      return { reached: atStatement, release };
    },
    disarmAll() {
      for (const entry of armed.splice(0)) {
        entry.reject(
          new Error(
            `the ${entry.fault.mode} fault armed at ${describeAt(entry.fault.at)} never struck: the test ended with it still armed`,
          ),
        );
      }
      held = null;
      for (const release of [...unreleased]) release();
      raised.length = 0;
    },
    databaseErrors: () => [...raised],
    arm(fault, options = {}) {
      let resolve: (seen: Delivered) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const delivered = new Promise<Delivered>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A test that does not await `delivered` still fails on its own assertions, not on an
      // unhandled rejection; one that awaits it gets the rejection.
      delivered.catch(() => undefined);
      const entry: Armed = { fault, every: options.every === true, resolve, reject };
      armed.push(entry);
      return {
        delivered,
        disarm() {
          const at = armed.indexOf(entry);
          if (at === -1) return;
          armed.splice(at, 1);
          reject(new Error(`the ${fault.mode} fault was disarmed before it struck`));
        },
      };
    },
    async killBackend(pid) {
      const connection = connections.get(pid);
      if (connection === undefined) {
        throw new Error(
          `backend ${String(pid)} is not a connection this harness's pool handed out with connect()`,
        );
      }
      return kill(connection.pool, connection.client, pid);
    },
  };
}

/** A pool wrapper whose statements a test can hold one at a time (`hold`): the fault harness. */
export function statementHolds(): StatementHolds {
  return faultHarness();
}

/**
 * `pool` with one standing fault: it strikes at every statement `fault.at` matches, for as long
 * as the pool lives. With `lost-commit-answer`, a pool whose transactions really commit, but
 * report a lost connection instead of the answer to COMMIT once a statement matching `at` ran
 * in them: the case where the database committed and the API cannot know it.
 */
export function faultyPool(pool: Pool, fault: Fault): Pool {
  const harness = faultHarness();
  harness.arm(fault, { every: true });
  return harness.wrapPool(pool);
}
