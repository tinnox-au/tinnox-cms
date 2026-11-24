/**
 * changeOncePerKey (./publishing.ts; adoption plan section 2.3, step 27): the one way the
 * publish and push routes publish under an Idempotency-Key. Every run looks the key up first,
 * under its lock, so running the change again creates nothing; it is run again only when it is
 * known to have rolled back because a concurrent request with the same key won, and never when
 * its COMMIT did not confirm. The statements run on a fake connection, one script per
 * transaction; the races against a real database are in apps/api/test/publish.integration.test.ts
 * and push.integration.test.ts.
 */
import { ROUTES } from '@tinnox/contracts';
import { isCommitOutcomeUnknown, unaudited, type Change } from '@tinnox/db';
import { databaseOn, testOrgId, type Pool } from '@tinnox/db/testing';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AppContext } from './context.ts';
import { HttpError, notFound } from './errors.ts';
import { changeOncePerKey, type KeyedPublish, type PublicationRow } from './publishing.ts';

const MEMBER = '00000000-0000-4000-8000-00000000000a';
const DISPLAY = '00000000-0000-4000-8000-0000000000d1';
// What a client sends as its Idempotency-Key; the helper does not read its shape.
const SAME_REQUEST = 'not-a-real-one';

const PREVIOUS: PublicationRow = {
  id: '00000000-0000-4000-8000-0000000000b1',
  display_id: DISPLAY,
  playlist_id: '00000000-0000-4000-8000-0000000000c1',
  manifest: {},
  created_at: new Date('2026-11-25T00:00:00.000Z'),
};

/** What one transaction of the fake connection finds and fails with. */
interface Script {
  /** The publication the key lookup returns. */
  readonly previous?: PublicationRow;
  /** What the statement of `publish` fails with. */
  readonly publishFails?: Error;
  /** What COMMIT fails with. */
  readonly commitFails?: Error;
}

/** A pool whose role re-check passes; each transaction takes the next script. */
function scripted(scripts: readonly Script[]) {
  const transactions: string[][] = [];
  const pool = {
    connect: () => {
      const script = scripts[transactions.length];
      if (script === undefined) throw new Error('more transactions than the test scripted');
      const statements: string[] = [];
      transactions.push(statements);
      return Promise.resolve({
        on: () => undefined,
        removeListener: () => undefined,
        release: () => undefined,
        query: (text: string) => {
          if (text.includes('FROM membership WHERE id = $1')) {
            statements.push('ROLE CHECK');
            return Promise.resolve({ rows: [{ role: 'owner', removed_at: null, cut_off: false }] });
          }
          if (text.includes('pg_advisory_xact_lock')) {
            statements.push('KEY LOCK');
            return Promise.resolve({ rows: [] });
          }
          if (text.includes('idempotency_key = $2')) {
            statements.push('KEY LOOKUP');
            return Promise.resolve({
              rows: script.previous === undefined ? [] : [script.previous],
            });
          }
          if (text === 'PUBLISH') {
            statements.push(text);
            return script.publishFails === undefined
              ? Promise.resolve({ rows: [] })
              : Promise.reject(script.publishFails);
          }
          if (text === 'COMMIT' || text === 'ROLLBACK') statements.push(text);
          return text === 'COMMIT' && script.commitFails !== undefined
            ? Promise.reject(script.commitFails)
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

/** POST /api/playlists/:id/publish, as the role guard lets it through. */
function publishRequest(): FastifyRequest {
  return {
    method: 'POST',
    routeOptions: { url: ROUTES.playlistPublishPattern },
    operator: {
      orgId: testOrgId('00000000-0000-4000-8000-000000000001'),
      membershipId: MEMBER,
      createdAt: '2026-11-24T00:00:00.000Z',
    },
    permission: {
      required: { all: ['push.publish', 'screen.assign'] },
      audit: { actions: ['publication.create'] },
    },
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

const keyTaken = (): pg.DatabaseError => serverError('23505', 'publication_idempotency');

/** A keyed change that says which of its two halves answered, and counts the publishes. */
function keyed(extra: Partial<KeyedPublish<string>> = {}) {
  const calls = { publish: 0, replay: 0 };
  const change: KeyedPublish<string> = {
    displayId: DISPLAY,
    key: SAME_REQUEST,
    replay: (previous): Change<string> => {
      calls.replay += 1;
      return { value: `replayed ${previous.id}`, audit: unaudited('idempotent_replay') };
    },
    publish: async (tx): Promise<Change<string>> => {
      calls.publish += 1;
      await tx.query('PUBLISH');
      // The publication row and its audit event are createPublication's; not what is under test.
      return { value: 'published', audit: unaudited('nothing_changed') };
    },
    ...extra,
  };
  return { change, calls };
}

const thrownBy = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => {
      throw new Error('the change did not fail');
    },
    (error: unknown) => error,
  );

describe('changeOncePerKey (step 27)', () => {
  it('publishes when the key made nothing yet: role check, key lock, key lookup, then the change', async () => {
    const { ctx, transactions } = scripted([{}]);
    const { change, calls } = keyed();
    expect(await changeOncePerKey(ctx, publishRequest(), change)).toBe('published');
    expect(transactions).toEqual([['ROLE CHECK', 'KEY LOCK', 'KEY LOOKUP', 'PUBLISH', 'COMMIT']]);
    expect(calls).toEqual({ publish: 1, replay: 0 });
  });

  it('replays what the key already made and publishes nothing', async () => {
    const { ctx, transactions } = scripted([{ previous: PREVIOUS }]);
    const { change, calls } = keyed();
    expect(await changeOncePerKey(ctx, publishRequest(), change)).toBe(`replayed ${PREVIOUS.id}`);
    expect(transactions).toEqual([['ROLE CHECK', 'KEY LOCK', 'KEY LOOKUP', 'COMMIT']]);
    expect(calls).toEqual({ publish: 0, replay: 1 });
  });

  it('runs once more after losing the race for the key, and replays the winner’s publication', async () => {
    const { ctx, transactions } = scripted([{ publishFails: keyTaken() }, { previous: PREVIOUS }]);
    const { change, calls } = keyed();
    expect(await changeOncePerKey(ctx, publishRequest(), change)).toBe(`replayed ${PREVIOUS.id}`);
    expect(transactions).toEqual([
      ['ROLE CHECK', 'KEY LOCK', 'KEY LOOKUP', 'PUBLISH', 'ROLLBACK'],
      // The second run starts with the role check and the lookup again: it never publishes blind.
      ['ROLE CHECK', 'KEY LOCK', 'KEY LOOKUP', 'COMMIT'],
    ]);
    expect(calls).toEqual({ publish: 1, replay: 1 });
  });

  it('runs once more after the key’s index refused the COMMIT itself', async () => {
    const { ctx, transactions } = scripted([{ commitFails: keyTaken() }, { previous: PREVIOUS }]);
    const { change } = keyed();
    expect(await changeOncePerKey(ctx, publishRequest(), change)).toBe(`replayed ${PREVIOUS.id}`);
    expect(transactions).toHaveLength(2);
  });

  it('runs again once only: a second lost race fails the request', async () => {
    const { ctx, transactions } = scripted([
      { publishFails: keyTaken() },
      { publishFails: keyTaken() },
    ]);
    const { change, calls } = keyed();
    const thrown = await thrownBy(changeOncePerKey(ctx, publishRequest(), change));
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpError);
    expect((thrown as Error).message).toBe(
      'a concurrent request with the same Idempotency-Key published first',
    );
    expect(transactions).toHaveLength(2);
    expect(calls).toEqual({ publish: 2, replay: 0 });
  });

  it('does not run again when the COMMIT did not confirm: the publication may exist (D9)', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const { ctx, transactions } = scripted([{ commitFails: lost }]);
    const { change, calls } = keyed();
    const thrown = await thrownBy(changeOncePerKey(ctx, publishRequest(), change));
    // What the API's handler answers 500 commit_outcome_unknown; the client's repeat with the
    // same key then finds the publication, or makes it.
    expect(isCommitOutcomeUnknown(thrown)).toBe(true);
    expect((thrown as Error).cause).toBe(lost);
    // One transaction and no second: run() sends its ROLLBACK after the failed COMMIT, and
    // scripted() would fail the test on a transaction it has no script for.
    expect(transactions).toEqual([
      ['ROLE CHECK', 'KEY LOCK', 'KEY LOOKUP', 'PUBLISH', 'COMMIT', 'ROLLBACK'],
    ]);
    expect(calls).toEqual({ publish: 1, replay: 0 });
  });

  it('does not run again after any other failure', async () => {
    for (const failure of [notFound('The screen'), serverError('40P01'), new Error('boom')]) {
      const { ctx, transactions } = scripted([{ publishFails: failure }]);
      const { change, calls } = keyed();
      expect(await thrownBy(changeOncePerKey(ctx, publishRequest(), change))).toBe(failure);
      expect(transactions).toHaveLength(1);
      expect(calls).toEqual({ publish: 1, replay: 0 });
    }
  });

  it('answers the constraints the route maps, and keeps the key’s own for itself', async () => {
    const changed = new HttpError(409, 'conflict', 'Changed meanwhile.');
    const constraints = { publication_asset_media_id_org_id_fkey: () => changed };
    const mapped = scripted([
      { publishFails: serverError('23503', 'publication_asset_media_id_org_id_fkey') },
    ]);
    expect(
      await thrownBy(changeOncePerKey(mapped.ctx, publishRequest(), keyed({ constraints }).change)),
    ).toBe(changed);
    expect(mapped.transactions).toHaveLength(1);

    // A route cannot answer the key's constraint itself, and so cannot turn the race into a 409.
    expectTypeOf<NonNullable<KeyedPublish<string>['constraints']>>().not.toHaveProperty(
      'publication_idempotency',
    );
  });
});
