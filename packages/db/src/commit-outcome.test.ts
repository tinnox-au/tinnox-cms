/**
 * The migration runner reads the failure of its own COMMIT as the transaction openers do
 * (SCX-03, adoption plan step 24): a refusal rolled the file back, anything else leaves it
 * applied or not. A real refusal at the runner's COMMIT is in
 * ../test/migrate.integration.test.ts.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  CommitOutcomeUnknownError,
  commitFailure,
  commitMigration,
  isCommitOutcomeUnknown,
  type Commits,
} from './commit-outcome.ts';

function serverError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`server refused (${code})`, 0, 'error');
  error.code = code;
  return error;
}

const failingWith = (error: Error): Commits => ({ query: () => Promise.reject(error) });

describe('the runner’s COMMIT (step 24)', () => {
  it('commits quietly when the server confirms', async () => {
    const sent: string[] = [];
    await commitMigration(
      {
        query: (text) => {
          sent.push(text);
          return Promise.resolve();
        },
      },
      '0099_probe.sql',
    );
    expect(sent).toEqual(['COMMIT']);
  });

  it('reports a refusal at COMMIT as a failed file that was rolled back', async () => {
    for (const code of ['23505', '23U01', '40001']) {
      const refusal = serverError(code);
      const error: unknown = await commitMigration(failingWith(refusal), '0099_probe.sql').catch(
        (thrown: unknown) => thrown,
      );
      expect(isCommitOutcomeUnknown(error)).toBe(false);
      expect((error as Error).message).toBe(
        `migration 0099_probe.sql failed at COMMIT and was rolled back: server refused (${code})`,
      );
      expect((error as Error).cause).toBe(refusal);
    }
  });

  it('reports a lost answer as an unknown outcome, and says running again is safe', async () => {
    for (const failure of [
      new Error('Connection terminated unexpectedly'),
      serverError('57P01'),
      serverError('40003'),
    ]) {
      const error: unknown = await commitMigration(failingWith(failure), '0099_probe.sql').catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
      expect((error as Error).cause).toBe(failure);
      expect((error as Error).message).toMatch(
        /^migration 0099_probe\.sql: the server did not confirm its COMMIT, so it may or may not be applied\. Run db:migrate again/,
      );
    }
  });

  it('classifies as the openers do', () => {
    const refusal = serverError('23505');
    expect(commitFailure(refusal)).toBe(refusal);
    expect(commitFailure(serverError('40003'))).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(commitFailure(new Error('timeout'))).toBeInstanceOf(CommitOutcomeUnknownError);
  });
});
