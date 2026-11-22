import { REDACTED_HEADERS, REDACTED_QUERY_PARAMS } from '@tinnox/contracts';
import { CommitOutcomeUnknownError } from '@tinnox/db';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACT_PATHS, serializeError } from './logger.ts';

const SECRET = 'secret-value-that-must-not-be-logged';

/** What the logger writes for one call with `fields`. */
function written(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  createLogger('info', false, { write: (line) => lines.push(line) }).info(fields, 'event');
  expect(lines).toHaveLength(1);
  return lines.join('');
}

/** An object with SECRET at a redaction path such as `*.*.token` or `req.headers["cookie"]`. */
function objectAt(path: string): Record<string, unknown> {
  const keys = path
    .replace(/\["([^"]+)"\]/g, '.$1')
    .split('.')
    .map((key, index) => (key === '*' ? `level${index}` : key));
  let value: Record<string, unknown> = { [keys.at(-1) ?? '']: SECRET };
  for (const key of keys.slice(0, -1).reverse()) value = { [key]: value };
  return value;
}

describe('redaction (D16)', () => {
  it.each(REDACT_PATHS)('keeps the value at %s out of the log', (path) => {
    const line = written(objectAt(path));
    expect(line).not.toContain(SECRET);
  });

  // The names, not only the paths: removing a field from SECRET_FIELDS fails here, at the top
  // level and one and two objects down.
  it.each([
    'token',
    'deviceToken',
    'pollingToken',
    'csrfToken',
    'idToken',
    'id_token',
    'access_token',
    'refresh_token',
    'code',
    'code_verifier',
    'password',
    'secret',
    'url',
    // DEC-37: an alert address is personal data of someone who may not be a member.
    'email',
    ...REDACTED_QUERY_PARAMS,
  ])('redacts a field named %s at every depth the paths cover', (field) => {
    for (const fields of [
      { [field]: SECRET },
      { query: { [field]: SECRET } },
      { job: { recipient: { [field]: SECRET } } },
    ]) {
      const line = written(fields);
      expect(line).not.toContain(SECRET);
      expect(line).toContain('[redacted]');
    }
  });

  it.each(REDACTED_HEADERS)(
    'redacts the %s header of a request, a reply or a bare headers object',
    (header) => {
      for (const fields of [
        { req: { headers: { [header]: SECRET } } },
        { res: { headers: { [header]: SECRET } } },
        { headers: { [header]: SECRET } },
      ]) {
        expect(written(fields)).not.toContain(SECRET);
      }
    },
  );
});

describe('serializeError', () => {
  it('keeps what went wrong underneath a wrapped error (review round 3, SCX-03)', () => {
    const logged = serializeError(
      new CommitOutcomeUnknownError(new Error('Connection terminated unexpectedly')),
    );
    expect(logged).toMatchObject({
      type: 'CommitOutcomeUnknownError',
      cause: { type: 'Error', message: 'Connection terminated unexpectedly' },
    });
  });

  it('logs a database error by name, message and code, never its detail or bind values', () => {
    const error = new pg.DatabaseError(
      'duplicate key value violates unique constraint',
      0,
      'error',
    );
    error.code = '23505';
    error.detail = 'Key (name)=(secret value) already exists.';
    const logged = serializeError(new CommitOutcomeUnknownError(error));
    expect(logged['cause']).toEqual({
      type: 'error',
      message: 'duplicate key value violates unique constraint',
      errorCode: '23505',
    });
    expect(JSON.stringify(logged)).not.toContain('secret value');
  });

  it('writes the error code to the log; a field named `code` would be redacted', () => {
    const lines: string[] = [];
    const logger = createLogger('info', false, { write: (line) => lines.push(line) });
    const deadlock = new pg.DatabaseError('deadlock detected', 0, 'error');
    deadlock.code = '40P01';
    const lost = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    logger.error({ err: deadlock }, 'refused');
    logger.error({ err: new CommitOutcomeUnknownError(lost) }, 'unknown');
    // The OAuth code of a callback, by contrast, must stay out of the log.
    logger.info({ query: { code: 'oauth-authorisation-code' } }, 'callback');

    const [refused, unknown, callback] = lines.map(
      (line) => JSON.parse(line) as { err?: Record<string, unknown>; query?: unknown },
    );
    expect(refused?.err).toMatchObject({ errorCode: '40P01' });
    expect(unknown?.err?.['cause']).toMatchObject({ errorCode: 'ECONNRESET' });
    expect(callback?.query).toEqual({ code: '[redacted]' });
    expect(lines.join('')).not.toContain('oauth-authorisation-code');
  });

  it('says only that something that is not an error was thrown', () => {
    expect(serializeError('a string')).toEqual({ message: 'non-error value thrown' });
  });
});
