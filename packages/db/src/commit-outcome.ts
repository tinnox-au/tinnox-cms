/**
 * What a failed COMMIT means (review round 3, SCX-03; adoption plan section 2.3, step 24). The
 * transaction openers of ./tx.ts and the migration runner of ./migrate.ts send their COMMIT and
 * read its failure here, so both tell a refusal from an unknown outcome the same way.
 */
import pg from 'pg';

/**
 * COMMIT was sent but did not confirm, so the transaction may have committed. Callers
 * must not undo work outside the database (delete files or stored objects) on this
 * error: the rows that own that work may exist (review round 3, SCX-03). `cause` holds
 * what COMMIT failed with. The API answers it, on a request that changes state, with 500
 * `commit_outcome_unknown` (apps/api/src/errors.ts, D9). A caller that does anything outside
 * the database after its change does not catch this class: it reads the end of the change
 * from settle() (./outcome.ts), whose 'unknown' arm carries this error (step 27).
 */
export class CommitOutcomeUnknownError extends Error {
  constructor(
    cause: unknown,
    message = 'the outcome of the transaction is unknown: COMMIT did not confirm',
  ) {
    super(message, { cause });
    this.name = 'CommitOutcomeUnknownError';
  }
}

/**
 * `error` itself when it is the error a COMMIT that did not confirm was reported with, else
 * null. The one test of the class (lint refuses `instanceof CommitOutcomeUnknownError` in every
 * other file of the package, of the API and of the offline tools, step 27): settle() of
 * ./outcome.ts reads the outcome of a change through it. Not in the runtime entry.
 */
export function unconfirmedCommit(error: unknown): CommitOutcomeUnknownError | null {
  return error instanceof CommitOutcomeUnknownError ? error : null;
}

/**
 * True for the error a COMMIT that did not confirm was reported with. For the API's error
 * handler (apps/api/src/errors.ts), which answers it and has nothing to undo (D9); lint keeps
 * it to that file in API source and the offline tools (step 27), where a caller with work
 * outside the database reads the three outcomes from settle() of ./outcome.ts. Not a type
 * predicate: the class has the shape of any Error, so narrowing it away would leave the
 * caller's Error with nothing.
 */
export function isCommitOutcomeUnknown(error: unknown): boolean {
  return unconfirmedCommit(error) !== null;
}

/** SQLSTATE 40003, statement_completion_unknown: class 40, yet it confirms nothing. */
const STATEMENT_COMPLETION_UNKNOWN = '40003';

/**
 * True when the server answered COMMIT with an error that it raises only while rolling
 * the transaction back: a deferred constraint (class 23, the audit-debt guard's 23U01 of the
 * test database among them) or a serialization failure (class 40, except 40003, which says
 * the server itself does not know). Anything else (a lost connection, a timeout, a server
 * shutting down) may have come after the commit was durable.
 */
function commitRefused(error: unknown): boolean {
  return (
    error instanceof pg.DatabaseError &&
    typeof error.code === 'string' &&
    error.code !== STATEMENT_COMPLETION_UNKNOWN &&
    (error.code.startsWith('23') || error.code.startsWith('40'))
  );
}

/**
 * What to throw for `error`, the failure of a COMMIT of a transaction that may have written: a
 * refusal unchanged, since the server rolled back; anything else as CommitOutcomeUnknownError.
 * Not in any entry of the package: only ./tx.ts and ./migrate.ts send a COMMIT of their own.
 */
export function commitFailure(error: unknown): unknown {
  return commitRefused(error) ? error : new CommitOutcomeUnknownError(error);
}

/** The one statement the runner's COMMIT needs from its connection. */
export interface Commits {
  query(text: 'COMMIT'): Promise<unknown>;
}

/**
 * Commits migration `name` with its schema_migrations row, for runMigrations (./migrate.ts). A
 * refusal (a deferred constraint, a trigger that fires at COMMIT) rolled the file back, and is
 * reported as any other failure of the file. Anything else leaves the file applied or not: the
 * error says so and that running again is safe, since the history row commits with the file.
 */
export async function commitMigration(client: Commits, name: string): Promise<void> {
  try {
    await client.query('COMMIT');
  } catch (error) {
    if (commitRefused(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${name} failed at COMMIT and was rolled back: ${message}`, {
        cause: error,
      });
    }
    throw new CommitOutcomeUnknownError(
      error,
      `migration ${name}: the server did not confirm its COMMIT, so it may or may not be applied. ` +
        'Run db:migrate again: the file commits with its schema_migrations row, so the next run ' +
        'skips it if it was applied and applies it if it was not',
    );
  }
}
