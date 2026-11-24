/**
 * What a failed statement means (adoption plan section 2.3, step 25): one classifier over the
 * errors PostgreSQL raises, so that callers stop reading SQLSTATE codes and constraint names
 * themselves (step 26 moves them here). A COMMIT that did not confirm is not one of these: its
 * error is CommitOutcomeUnknownError (./commit-outcome.ts), which this classifier does not class.
 */
import pg from 'pg';
import { CONSTRAINTS, isConstraintName, type ConstraintName } from './constraints.ts';

/** SQLSTATEs after which the same statement may succeed if sent again in a new transaction. */
const TRANSIENT = [
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available: lock_timeout ran out
  '57014', // query_canceled: statement_timeout ran out
] as const;
export type TransientSqlstate = (typeof TRANSIENT)[number];

/** SQLSTATE insufficient_privilege: a grant, or row-level security's WITH CHECK, refused. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * What the database said, closed so that a `switch` with a `never` default sees every kind:
 * - `constraint`: a name of the registry (./constraints.ts), raised with its registered SQLSTATE;
 *   the one kind a caller maps to an answer of its own.
 * - `unmapped_constraint`: any other integrity violation (class 23): a constraint not in the
 *   registry, a registered one raised with another SQLSTATE, or one with no name (NOT NULL, a
 *   guard that names none). It stays a 500, logged by SQLSTATE and name.
 * - `denied`: 42501; a grant or row-level security refused the statement.
 * - `transient`: a serialization failure, a deadlock, a lock or statement timeout.
 * - `other`: any other server error; `sqlstate` is null when the error carries no valid code.
 */
export type DbFailure =
  | { readonly kind: 'constraint'; readonly name: ConstraintName }
  | {
      readonly kind: 'unmapped_constraint';
      readonly sqlstate: string;
      readonly name: string | null;
    }
  | { readonly kind: 'denied' }
  | { readonly kind: 'transient'; readonly sqlstate: TransientSqlstate }
  | { readonly kind: 'other'; readonly sqlstate: string | null };

const isTransient = (sqlstate: string): sqlstate is TransientSqlstate =>
  TRANSIENT.some((code) => code === sqlstate);

/**
 * What `error` says about the database, or null when it is not an error the server raised: a
 * lost connection, a pool timeout, CommitOutcomeUnknownError, an HttpError, anything else. Only
 * pg's DatabaseError counts, never an object that merely has a `code`: Node's own errors carry
 * five-letter codes too (EPIPE). A refusal at COMMIT (a deferred constraint, a serialization
 * failure) reaches the caller as the server's own error (./commit-outcome.ts) and is classed
 * like any other.
 */
export function classifyDbError(error: unknown): DbFailure | null {
  if (!(error instanceof pg.DatabaseError)) return null;
  const code: unknown = error.code;
  const sqlstate = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  if (sqlstate === null) return { kind: 'other', sqlstate: null };
  if (sqlstate.startsWith('23')) {
    const name =
      typeof error.constraint === 'string' && error.constraint !== '' ? error.constraint : null;
    if (name !== null && isConstraintName(name) && CONSTRAINTS[name].sqlstate === sqlstate) {
      return { kind: 'constraint', name };
    }
    return { kind: 'unmapped_constraint', sqlstate, name };
  }
  if (sqlstate === INSUFFICIENT_PRIVILEGE) return { kind: 'denied' };
  if (isTransient(sqlstate)) return { kind: 'transient', sqlstate };
  return { kind: 'other', sqlstate };
}
