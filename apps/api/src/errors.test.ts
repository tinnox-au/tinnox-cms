/**
 * The error handler's answer to a COMMIT the database did not confirm (review round 3, SCX-03;
 * adoption plan step 24, D9), on a bare Fastify instance with the handler of every API route.
 */
import { ApiErrorSchema } from '@tinnox/contracts';
import { CommitOutcomeUnknownError } from '@tinnox/db';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMIT_OUTCOME_UNKNOWN_MESSAGE, HttpError, registerErrorHandling } from './errors.ts';
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
    const { app } = await throwing(() => new HttpError(409, 'conflict', 'Taken.'));
    const response = await app.inject({ method: 'POST', url: '/thing' });
    expect(response.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'conflict',
      message: 'Taken.',
    });
  });
});
