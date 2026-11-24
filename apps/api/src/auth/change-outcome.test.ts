/**
 * How changeAsOperator ends (adoption plan section 2.3, step 27): it reads the end of its
 * transaction from settle() of @tinnox/db. Only a change that rolled back is answered (the
 * route's constraint answers, the lock timeout's 503) or recorded as a refusal; a COMMIT that
 * did not confirm is thrown as it came, whatever it failed with, because the change may be
 * saved. The statements run on a fake connection whose COMMIT fails with the error under test.
 */
import { ROUTES } from '@tinnox/contracts';
import { isCommitOutcomeUnknown, unaudited } from '@tinnox/db';
import { databaseOn, testOrgId, type Pool } from '@tinnox/db/testing';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../context.ts';
import { HttpError } from '../errors.ts';
import { changeAsOperator, type ConstraintAnswers } from './permissions.ts';
import type { OperatorSession } from './session.ts';

const MEMBER = '00000000-0000-4000-8000-00000000000a';

/** A pool whose role re-check passes and whose COMMIT fails with `commitFails`, if given. */
function committing(commitFails?: Error) {
  const transactions: string[][] = [];
  const pool = {
    connect: () => {
      const statements: string[] = [];
      transactions.push(statements);
      return Promise.resolve({
        on: () => undefined,
        removeListener: () => undefined,
        release: () => undefined,
        query: (text: string) => {
          statements.push(text);
          if (text.includes('FROM membership WHERE id = $1')) {
            return Promise.resolve({ rows: [{ role: 'owner', removed_at: null, cut_off: false }] });
          }
          return text === 'COMMIT' && commitFails !== undefined
            ? Promise.reject(commitFails)
            : Promise.resolve({ rows: [] });
        },
      });
    },
  } as unknown as Pool;
  const ctx = {
    db: databaseOn(pool),
    now: () => new Date('2026-11-25T00:00:00.000Z'),
  } as unknown as AppContext;
  return { ctx, transactions };
}

/** POST /api/folders, as the role guard lets it through; `warned` is what it logged. */
function folderRequest() {
  const warned: string[] = [];
  const request = {
    method: 'POST',
    routeOptions: { url: ROUTES.folders },
    operator: {
      orgId: testOrgId('00000000-0000-4000-8000-000000000001'),
      membershipId: MEMBER,
      createdAt: '2026-11-24T00:00:00.000Z',
    } as unknown as OperatorSession,
    permission: { required: { all: ['content.write'] }, audit: { actions: ['folder.create'] } },
    log: {
      warn: (_fields: object, message: string) => warned.push(message),
      error: (_fields: object, message: string) => warned.push(message),
    },
  } as unknown as FastifyRequest;
  return { request, warned };
}

/** What the server sends when it refuses a statement, as the pg driver parses it. */
function serverError(code: string, constraint?: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`server refused (${code})`, 0, 'error');
  error.code = code;
  error.constraint = constraint;
  return error;
}

const nameTaken = (): HttpError => new HttpError('conflict', 'Taken.');
const ANSWERS = { folder_org_name_key: nameTaken } as const satisfies ConstraintAnswers;

/** Runs a folder change whose statements succeed, and returns what the change threw. */
async function thrownAtCommit(commitFails: Error) {
  const { ctx, transactions } = committing(commitFails);
  const { request, warned } = folderRequest();
  const thrown: unknown = await changeAsOperator(
    ctx,
    request,
    () => Promise.resolve({ value: 'made', audit: unaudited('nothing_changed') }),
    { constraints: ANSWERS },
  ).then(
    () => {
      throw new Error('the change did not fail');
    },
    (error: unknown) => error,
  );
  return { thrown, transactions, warned };
}

describe('the three ends of changeAsOperator (step 27)', () => {
  it('committed: returns the value of the change', async () => {
    const { ctx } = committing();
    const { request } = folderRequest();
    expect(
      await changeAsOperator(ctx, request, () =>
        Promise.resolve({ value: 'made', audit: unaudited('nothing_changed') }),
      ),
    ).toBe('made');
  });

  it('rolled back at COMMIT: a refusal there is answered like one of a statement', async () => {
    const taken = await thrownAtCommit(serverError('23505', 'folder_org_name_key'));
    expect(taken.thrown).toMatchObject({ statusCode: 409, code: 'conflict', message: 'Taken.' });
    // A serialization failure at COMMIT rolled back; the route maps nothing for it.
    const serialization = serverError('40001');
    expect((await thrownAtCommit(serialization)).thrown).toBe(serialization);
  });

  it('unknown: a COMMIT that did not confirm is thrown as it came, never as an answer of the route', async () => {
    for (const lost of [
      new Error('Connection terminated unexpectedly'),
      // Class 57 and 55 at COMMIT confirm nothing. A 503 with Retry-After would tell the client
      // that the change was not carried out and is safe to send again.
      serverError('57P01'),
      serverError('55P03'),
      // 40003 is class 40, and here even names a constraint the route maps: it confirms nothing.
      serverError('40003', 'folder_org_name_key'),
    ]) {
      const { thrown, transactions, warned } = await thrownAtCommit(lost);
      // What the API's handler answers 500 commit_outcome_unknown (D9).
      expect(isCommitOutcomeUnknown(thrown)).toBe(true);
      expect(thrown).not.toBeInstanceOf(HttpError);
      expect((thrown as Error).cause).toBe(lost);
      // Nothing was recorded or logged in a second transaction: nothing is known to be refused.
      expect(transactions).toHaveLength(1);
      expect(warned).toEqual([]);
    }
  });
});
