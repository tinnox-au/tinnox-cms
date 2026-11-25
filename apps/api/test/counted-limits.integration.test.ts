/**
 * Two creates at a counted ceiling cannot both pass (SCX-05, adoption plan step 22). Each route
 * checks its ceiling with withCountedLimit (packages/db/src/counted-limit.ts): the organisation's
 * lock, then the count, then the insert. Here the first of two requests, one below the ceiling,
 * is held at its insert, after it has counted; the second must then wait for the lock, and
 * counts only once the first has committed. Without the lock the second would count the same
 * number, and both would be created. The lock keys themselves are checked in
 * packages/db/test/counted-limit.integration.test.ts.
 */
import { ABSOLUTE, MAX_ALERT_RECIPIENTS } from '@tinnox/contracts';
import type { OrgTx } from '@tinnox/db';
import { waitForLockWaiters, withOrg } from '@tinnox/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  asMigratorIn,
  createOrg,
  signIn,
  startTestApp,
  statementHolds,
  uploadBytes,
  type Operator,
  type TestApp,
  type TestOrg,
} from './support.ts';

const FILE = 200 * 1024;
// Room for one file of FILE bytes, not two. After the first, 100 KiB are left, which the refusal
// shows as 0.1 MB; a refusal that counted the refused file as stored would show 0.0 MB.
const QUOTA = 300 * 1024;

interface ErrorBody {
  error: { code: string; message: string };
}

describe('two creates at a counted ceiling (SCX-05)', () => {
  const holds = statementHolds();
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ LIMIT_MAX_ORG_STORAGE_BYTES: String(QUOTA) }, 1000, {
      wrapPool: holds.wrapPool,
    });
  });
  afterEach(() => {
    holds.disarmAll();
  });
  afterAll(async () => {
    await t.close();
  });

  /** A new organisation with its Owner signed in, after `arrange` ran in it as the migrator. */
  async function orgWith(
    name: string,
    arrange: (org: TestOrg) => Parameters<typeof asMigratorIn>[1],
  ): Promise<{ org: TestOrg; owner: Operator }> {
    const org = await createOrg(name);
    await asMigratorIn(org.orgId, arrange(org));
    return { org, owner: await signIn(t, org) };
  }

  /** The count `counting` reads in the organisation, on the app's pool. */
  function countIn(
    org: TestOrg,
    counting: (tx: OrgTx) => Promise<{ rows: { n: number }[] }>,
  ): Promise<number> {
    return withOrg(t.pool, org.orgId, async (tx) => (await counting(tx)).rows[0]?.n ?? -1);
  }

  /**
   * Sends `first` and holds it at the statement `atInsert` matches, after its lock and count;
   * sends `second` while it is held, and lets the first go only once the second waits for an
   * advisory lock the first one's backend holds (a lockless build fails here, not by timing:
   * TST-5). `waiting` is how many backends waited behind the first. Both run to their answers
   * before this returns.
   */
  async function race(
    atInsert: (text: string) => boolean,
    first: () => Promise<Response>,
    second: () => Promise<Response>,
  ): Promise<{ waiting: number; statuses: number[]; refusal: ErrorBody }> {
    const held = holds.hold(atInsert);
    const one = first();
    const holder = await Promise.race([
      held.reached,
      one.then((r): never => {
        throw new Error(`the first create was answered ${r.status} before its insert`);
      }),
    ]);
    let waiting: number | undefined;
    let notWaited: unknown;
    const two = second();
    try {
      const waiters = await waitForLockWaiters(
        t.testSql('reads which backends wait for the first create, as a test of the lock'),
        holder,
        1,
        "the second create never waited for the first one's advisory lock",
        { locktype: 'advisory' },
      );
      waiting = waiters.length;
    } catch (error) {
      notWaited = error;
    } finally {
      held.release();
    }
    const answers = await Promise.all([one, two]);
    // Reported once both are answered, so a failure leaves no request open behind it.
    if (waiting === undefined) throw notWaited;
    const refused = answers.find((r) => r.status >= 400);
    return {
      waiting,
      statuses: answers.map((r) => r.status).sort((x, y) => x - y),
      refusal: (refused === undefined ? { error: {} } : await refused.json()) as ErrorBody,
    };
  }

  const startsWith = (prefix: string) => (text: string) => text.trimStart().startsWith(prefix);

  it('SCX-05: two folders at the ceiling: one is created, the other waits and is refused', async () => {
    const { org, owner } = await orgWith(
      'Racing folders',
      () => (c) =>
        c.query(
          `INSERT INTO folder (org_id, name)
         SELECT app_org_id(), 'bulk ' || g FROM generate_series(1, $1::int) AS g`,
          [ABSOLUTE.maxListItems - 1],
        ),
    );
    const create = (name: string) => () =>
      owner.fetch('/api/folders', { method: 'POST', json: { name } });
    const result = await race(startsWith('INSERT INTO folder'), create('One'), create('Two'));
    expect(result.statuses).toEqual([201, 409]);
    expect(result.refusal.error).toMatchObject({
      code: 'conflict',
      message: `The organisation already has ${ABSOLUTE.maxListItems} folders, which is the most it can have. Delete folders that are no longer used.`,
    });
    expect(await countIn(org, (tx) => tx.query('SELECT count(*)::int AS n FROM folder'))).toBe(
      ABSOLUTE.maxListItems,
    );
    // The second was held at the first one's lock until the first was let go.
    expect(result.waiting).toBe(1);
  });

  it('SCX-05: two tags at the ceiling, one of each kind: one is created, the other waits and is refused', async () => {
    const { org, owner } = await orgWith(
      'Racing tags',
      () => (c) =>
        c.query(
          `INSERT INTO tag (org_id, scope, name, colour)
         SELECT app_org_id(), 'media', 'bulk ' || g, 'teal' FROM generate_series(1, $1::int) AS g`,
          [ABSOLUTE.maxListItems - 1],
        ),
    );
    const create = (scope: string) => () =>
      owner.fetch('/api/tags', { method: 'POST', json: { scope, name: `Racing ${scope}` } });
    const result = await race(startsWith('INSERT INTO tag '), create('media'), create('display'));
    expect(result.statuses).toEqual([201, 409]);
    expect(result.refusal.error).toMatchObject({
      code: 'conflict',
      message: `The organisation already has ${ABSOLUTE.maxListItems} tags, which is the most it can have. Delete tags that are no longer used.`,
    });
    expect(await countIn(org, (tx) => tx.query('SELECT count(*)::int AS n FROM tag'))).toBe(
      ABSOLUTE.maxListItems,
    );
    // The second was held at the first one's lock until the first was let go.
    expect(result.waiting).toBe(1);
  });

  it('SCX-05: two alert addresses at the ceiling: one is added, the other waits and is refused', async () => {
    const { org, owner } = await orgWith(
      'Racing alert addresses',
      (o) => (c) =>
        c.query(
          `INSERT INTO alert_recipient (org_id, email, created_by, confirmed_at)
         SELECT app_org_id(), 'listed' || g || '@example.com', $2, now()
         FROM generate_series(1, $1::int) AS g`,
          [MAX_ALERT_RECIPIENTS - 1, o.membershipId],
        ),
    );
    const add = (email: string) => () =>
      owner.fetch('/api/alert-recipients', { method: 'POST', json: { email } });
    const result = await race(
      startsWith('INSERT INTO alert_recipient'),
      add('first-racer@example.com'),
      add('second-racer@example.com'),
    );
    expect(result.statuses).toEqual([201, 409]);
    expect(result.refusal.error).toMatchObject({
      code: 'conflict',
      message: `The alert list already has ${MAX_ALERT_RECIPIENTS} addresses. Remove one first.`,
    });
    expect(
      await countIn(org, (tx) => tx.query('SELECT count(*)::int AS n FROM alert_recipient')),
    ).toBe(MAX_ALERT_RECIPIENTS);
    // The second was held at the first one's lock until the first was let go.
    expect(result.waiting).toBe(1);
  });

  it('SCX-05: two invites at the ceiling: one is made, the other waits on the membership lock and is refused', async () => {
    const { org, owner } = await orgWith(
      'Racing invites',
      (o) => (c) =>
        c.query(
          `INSERT INTO member_invite (org_id, role, name, email, invited_by, expires_at)
         SELECT app_org_id(), 'viewer', 'Waiting ' || g, 'waiting' || g || '@example.com', $2,
                now() + interval '14 days'
         FROM generate_series(1, $1::int) AS g`,
          [ABSOLUTE.maxPendingInvites - 1, o.membershipId],
        ),
    );
    const invite = (name: string, email: string) => () =>
      owner.fetch('/api/invites', { method: 'POST', json: { name, email, role: 'viewer' } });
    const result = await race(
      startsWith('INSERT INTO member_invite'),
      invite('First Racer', 'first-racer@example.com'),
      invite('Second Racer', 'second-racer@example.com'),
    );
    expect(result.statuses).toEqual([201, 409]);
    expect(result.refusal.error).toMatchObject({
      code: 'conflict',
      message: `The organisation already has ${ABSOLUTE.maxPendingInvites} invites waiting for TINNOX. Cancel ones that are no longer needed.`,
    });
    expect(
      await countIn(org, (tx) =>
        tx.query("SELECT count(*)::int AS n FROM member_invite WHERE status = 'pending'"),
      ),
    ).toBe(ABSOLUTE.maxPendingInvites);
    // The second was held at the first one's lock until the first was let go.
    expect(result.waiting).toBe(1);
  });

  it('SCX-05: two uploads that each fit the storage quota but not together: one is stored, the other waits and is refused', async () => {
    const org = await createOrg('Racing uploads');
    const owner = await signIn(t, org);
    const upload = () => () => uploadBytes(owner, fakePng(FILE));
    const result = await race(startsWith('INSERT INTO media'), upload(), upload());
    expect(result.statuses).toEqual([201, 413]);
    expect(result.refusal.error).toMatchObject({
      code: 'storage_quota_exceeded',
      message: 'The file does not fit in the remaining storage (0.1 MB free).',
    });
    expect(await countIn(org, (tx) => tx.query('SELECT count(*)::int AS n FROM media'))).toBe(1);
    // The second was held at the first one's lock until the first was let go.
    expect(result.waiting).toBe(1);
  });
});

/** PNG signature followed by filler: passes the API's magic-byte check, any size. */
function fakePng(size: number): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  return buffer;
}
