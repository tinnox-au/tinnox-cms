import type { HttpError } from './errors.ts';

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  throw new Error('expected a timestamp from the database');
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** Converts an int8 column (returned as a string by pg) to a safe number. */
export function bigintToNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('database returned an out-of-range integer');
  return n;
}

/**
 * What a change returns as its value when a refused request must still leave a committed trace
 * (an audit event, a failed-attempt counter): `{ value: refuse(error), audit }` commits the
 * trace, and the route throws the error once the change has returned (adoption plan section
 * 2.1 B). Throwing inside the change rolls everything back.
 */
export type Decision<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HttpError };

export const accept = <T>(value: T): Decision<T> => ({ ok: true, value });
export const refuse = (error: HttpError): Decision<never> => ({ ok: false, error });
