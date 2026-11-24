/**
 * The constraints option of changeAsOperator (adoption plan section 2.3, step 26): a route
 * names the registered constraints it answers, and the wrapper maps them through
 * classifyDbError, so no route reads a SQLSTATE code or a constraint name. The statements run
 * on a fake connection whose write fails with the error under test.
 */
import { ROUTES } from '@tinnox/contracts';
import { databaseOn, testOrgId, type Pool } from '@tinnox/db/testing';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../context.ts';
import { HttpError } from '../errors.ts';
import { changeAsOperator, type ConstraintAnswers } from './permissions.ts';
import type { OperatorSession } from './session.ts';

const MEMBER = '00000000-0000-4000-8000-00000000000a';

/** A pool whose role re-check passes and whose write fails with `failure`. */
function failingWrite(failure: Error): AppContext {
  const pool = {
    connect: () =>
      Promise.resolve({
        on: () => undefined,
        removeListener: () => undefined,
        release: () => undefined,
        query: (text: string) => {
          if (text.includes('FROM membership WHERE id = $1')) {
            return Promise.resolve({ rows: [{ role: 'owner', removed_at: null, cut_off: false }] });
          }
          return text === 'WRITE' ? Promise.reject(failure) : Promise.resolve({ rows: [] });
        },
      }),
  } as unknown as Pool;
  return {
    db: databaseOn(pool),
    now: () => new Date('2026-11-24T00:00:00.000Z'),
  } as unknown as AppContext;
}

/** POST /api/folders, as the role guard lets it through. */
function folderRequest(): FastifyRequest {
  return {
    method: 'POST',
    routeOptions: { url: ROUTES.folders },
    operator: {
      orgId: testOrgId('00000000-0000-4000-8000-000000000001'),
      membershipId: MEMBER,
      createdAt: '2026-11-24T00:00:00.000Z',
    } as unknown as OperatorSession,
    permission: { required: { all: ['content.write'] }, audit: { actions: ['folder.create'] } },
    log: { warn: () => undefined, error: () => undefined },
  } as unknown as FastifyRequest;
}

/** What the server sends when it refuses a statement, as the pg driver parses it. */
function serverError(code: string, constraint?: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`server refused (${code})`, 0, 'error');
  error.code = code;
  error.constraint = constraint;
  return error;
}

const nameTaken = (): HttpError => new HttpError(409, 'conflict', 'Taken.');
const ANSWERS = { folder_org_name_key: nameTaken } as const satisfies ConstraintAnswers;

/** Runs a folder write that fails with `failure`, and returns what it threw. */
async function thrownBy(failure: Error, constraints?: ConstraintAnswers): Promise<unknown> {
  try {
    await changeAsOperator(
      failingWrite(failure),
      folderRequest(),
      async (tx) => {
        await tx.query('WRITE');
        throw new Error('the write was expected to fail');
      },
      constraints === undefined ? undefined : { constraints },
    );
  } catch (error) {
    return error;
  }
  throw new Error('the change did not fail');
}

describe('the constraints option of changeAsOperator (step 26)', () => {
  it("answers a registered constraint the route maps with the route's answer", async () => {
    const thrown = await thrownBy(serverError('23505', 'folder_org_name_key'), ANSWERS);
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ statusCode: 409, code: 'conflict', message: 'Taken.' });
  });

  it("leaves the database's error of a constraint the route does not map: a 500", async () => {
    // Registered, but not mapped by this route.
    const other = serverError('23505', 'tag_org_scope_name_key');
    expect(await thrownBy(other, ANSWERS)).toBe(other);
    // Not registered at all, and a registered name raised with another SQLSTATE.
    const unregistered = serverError('23505', 'folder_pkey');
    expect(await thrownBy(unregistered, ANSWERS)).toBe(unregistered);
    const wrongState = serverError('23503', 'folder_org_name_key');
    expect(await thrownBy(wrongState, ANSWERS)).toBe(wrongState);
    // And with no option at all.
    const taken = serverError('23505', 'folder_org_name_key');
    expect(await thrownBy(taken)).toBe(taken);
  });

  it('maps only what the server raised: a look-alike with the code and the name is not mapped', async () => {
    const lookalike = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'folder_org_name_key',
    });
    expect(await thrownBy(lookalike, ANSWERS)).toBe(lookalike);
  });

  it('still answers a lock timeout with 503 and Retry-After, and nothing else transient', async () => {
    const thrown = await thrownBy(serverError('55P03'), ANSWERS);
    expect(thrown).toMatchObject({
      statusCode: 503,
      code: 'service_unavailable',
      headers: { 'retry-after': '2' },
    });
    const deadlock = serverError('40P01');
    expect(await thrownBy(deadlock, ANSWERS)).toBe(deadlock);
  });
});
