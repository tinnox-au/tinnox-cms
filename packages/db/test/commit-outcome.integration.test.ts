/**
 * A real refusal at COMMIT (adoption plan section 2.3, step 24): the server checks a deferred
 * constraint only when the transaction commits, and rolls back if it fails. run() of
 * ../src/tx.ts passes that refusal on as it came, never as CommitOutcomeUnknownError, so the API
 * answers it as a database error (internal_error) and nobody is told the change may have been
 * saved. The audit-debt guard's 23U01, also raised at COMMIT, is the same case
 * (./audit-debt-guard.integration.test.ts). The lost answer is in ../src/tx.test.ts and in
 * apps/api/test/upload.integration.test.ts.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitOutcomeUnknownError, isCommitOutcomeUnknown } from '../src/index.ts';
import { withOrg, type Pool } from '../src/testing.ts';
import { appPool, createOrg, migratorClient, type TestOrg } from './support.ts';

let app: Pool;
let org: TestOrg;

beforeAll(async () => {
  app = appPool('a refusal at COMMIT, made on purpose with no audit row', 2);
  const migrator = await migratorClient();
  try {
    org = await createOrg(migrator, 'Commit refusal');
  } finally {
    await migrator.end();
  }
});
afterAll(async () => {
  await app.end();
});

async function itemsAtZero(): Promise<number> {
  return withOrg(app, org.orgId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM playlist_item WHERE playlist_id = $1 AND position = 0',
      [org.playlistId],
    );
    return Number(rows[0]?.n);
  });
}

describe('a refusal at COMMIT is a rollback, not an unknown outcome (SCX-03, step 24)', () => {
  it('passes on the deferred unique constraint of playlist_item as the server sent it', async () => {
    expect(await itemsAtZero()).toBe(1);
    let statementsAnswered = false;
    const error: unknown = await withOrg(app, org.orgId, async (tx) => {
      // A second item at position 0: accepted here, because the constraint waits for COMMIT.
      await tx.query(
        `INSERT INTO playlist_item (org_id, playlist_id, position, media_id, duration_ms)
         VALUES (app_org_id(), $1, 0, $2, 5000)`,
        [org.playlistId, org.mediaId],
      );
      statementsAnswered = true;
    }).then(
      () => 'committed',
      (thrown: unknown) => thrown,
    );
    expect(statementsAnswered).toBe(true);
    expect(error).toBeInstanceOf(pg.DatabaseError);
    expect((error as pg.DatabaseError).code).toBe('23505');
    expect((error as pg.DatabaseError).constraint).toBe('playlist_item_playlist_id_position_key');
    expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(isCommitOutcomeUnknown(error)).toBe(false);
    // Refused means rolled back: the second item is not there.
    expect(await itemsAtZero()).toBe(1);
  });
});
