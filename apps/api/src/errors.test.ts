/**
 * The error handler's answer to a COMMIT the database did not confirm (review round 3, SCX-03;
 * adoption plan step 24, D9), on a bare Fastify instance with the handler of every API route.
 */
import { API_ERROR_CODES, ApiErrorSchema, STATUS_OF } from '@tinnox/contracts';
import { CommitOutcomeUnknownError } from '@tinnox/db';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMIT_OUTCOME_UNKNOWN_MESSAGE,
  found,
  HttpError,
  notFound,
  registerErrorHandling,
} from './errors.ts';
import { createLogger } from './logger.ts';

/** What PostgreSQL sends when it refuses a statement, as the pg driver parses it. */
function serverError(code: string, message = `server refused (${code})`): pg.DatabaseError {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = code;
  return error;
}

const LOST = 'Connection terminated unexpectedly while sending a secret detail';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** An app whose one address throws `error` for every method, and the lines it logs. */
async function throwing(error: () => Error): Promise<{ app: FastifyInstance; logs: string[] }> {
  const logs: string[] = [];
  const logger: FastifyBaseLogger = createLogger('info', false, {
    write: (line) => logs.push(line),
  });
  const instance = Fastify({ loggerInstance: logger });
  registerErrorHandling(instance);
  instance.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/thing',
    exposeHeadRoute: false,
    handler: () => Promise.reject(error()),
  });
  await instance.ready();
  app = instance;
  return { app: instance, logs };
}

describe('a COMMIT the database did not confirm (SCX-03, D9)', () => {
  const unknown = () => new CommitOutcomeUnknownError(new Error(LOST));

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'answers a %s with 500 commit_outcome_unknown, the fixed message, no-store and no Retry-After (D9)',
    async (method) => {
      const { app } = await throwing(unknown);
      const response = await app.inject({ method, url: '/thing' });
      expect(response.statusCode).toBe(500);
      const body = ApiErrorSchema.parse(response.json());
      expect(body.error.code).toBe('commit_outcome_unknown');
      expect(body.error.message).toBe(
        'The change may have been saved, but the server could not confirm it. Reload to check before you try again.',
      );
      expect(COMMIT_OUTCOME_UNKNOWN_MESSAGE).toBe(body.error.message);
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it.each(['GET', 'HEAD'] as const)(
    'answers a %s with internal_error: a read is not told that a change may have been saved (D9)',
    async (method) => {
      const { app } = await throwing(unknown);
      // inject keeps the body of a HEAD that the route answers itself; a real server drops it.
      const response = await app.inject({ method, url: '/thing' });
      expect(response.statusCode).toBe(500);
      expect(ApiErrorSchema.parse(response.json()).error).toMatchObject({
        code: 'internal_error',
        message: 'Something went wrong. Try again.',
      });
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('logs the name and SQLSTATE of the cause only, never its message (D9)', async () => {
    const { app, logs } = await throwing(
      () => new CommitOutcomeUnknownError(serverError('57P01', LOST)),
    );
    expect((await app.inject({ method: 'POST', url: '/thing' })).statusCode).toBe(500);
    const line = logs.find((text) => text.includes('commit outcome unknown'));
    expect(line).toBeDefined();
    const logged = JSON.parse(line ?? '{}') as Record<string, unknown>;
    // The driver names every error the server sends 'error'; the SQLSTATE says which.
    expect(logged['cause']).toBe('error');
    expect(logged['pgCode']).toBe('57P01');
    expect(logs.join('\n')).not.toContain('secret detail');
  });

  it('answers a refusal at COMMIT, which rolled back, as any database error: internal_error', async () => {
    // run() of packages/db/src/tx.ts passes a deferred constraint's 23505 on unchanged.
    const { app } = await throwing(() => serverError('23505'));
    const response = await app.inject({ method: 'POST', url: '/thing' });
    expect(response.statusCode).toBe(500);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('internal_error');
  });

  it('still answers an HttpError as it says', async () => {
    const { app } = await throwing(() => new HttpError('conflict', 'Taken.'));
    const response = await app.inject({ method: 'POST', url: '/thing' });
    expect(response.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'conflict',
      message: 'Taken.',
    });
  });
});

describe('the status of an HttpError (step 28, section 2.2)', () => {
  it('is the status of its code, for every code', () => {
    for (const code of API_ERROR_CODES) {
      expect(new HttpError(code, 'x').statusCode, code).toBe(STATUS_OF[code]);
    }
  });

  it('cannot be given by the caller', () => {
    // @ts-expect-error the status comes from the code; a call site passes none
    const error = new HttpError(403, 'not_found', 'x');
    expect(error).toBeInstanceOf(HttpError);
  });

  it('answers a code with its status, a 403 code included', async () => {
    const { app } = await throwing(() => new HttpError('url_expired', 'Expired.'));
    const response = await app.inject({ method: 'GET', url: '/thing' });
    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('url_expired');
  });
});

describe('found (step 28, section 2.2)', () => {
  it('returns the row a lookup found', () => {
    const row = { id: 'a' };
    expect(found(row, 'The tag')).toBe(row);
    expect(found(0, 'The count')).toBe(0);
    expect(found('', 'The name')).toBe('');
  });

  it.each([undefined, null])('answers %s as 404 not_found naming what was looked up', (row) => {
    let caught: unknown;
    try {
      found(row, 'The tag');
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(notFound('The tag'));
    expect(caught).toMatchObject({
      statusCode: 404,
      code: 'not_found',
      message: 'The tag was not found.',
    });
  });
});
