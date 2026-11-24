/**
 * The order withCountedLimit sends its statements in, read off a fake connection: the lock, then
 * the count, then the insert or the refusal (SCX-05). The two-connection cases, that two creates
 * at a ceiling cannot both pass, are in apps/api/test/counted-limits.integration.test.ts, and the
 * lock keys are checked against the database in packages/db/test/counted-limit.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { withCountedLimit, type CountedLimit, type OrgTx } from './index.ts';
import { testOrgId, withOrg, type Pool } from './testing.ts';

const ORG = testOrgId('00000000-0000-4000-8000-000000000001');

/** A pool whose one connection records each statement and its values, and says the org is set. */
function fakePool(inOrg = true) {
  const sent: { text: string; values: readonly unknown[] | undefined }[] = [];
  const client = {
    on: () => undefined,
    removeListener: () => undefined,
    release: () => undefined,
    query: (text: string, values?: readonly unknown[]) => {
      sent.push({ text, values });
      return Promise.resolve({ rows: text.includes('AS in_org') ? [{ in_org: inOrg }] : [] });
    },
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  const work = () =>
    sent.map((s) => s.text).filter((t) => !/^(BEGIN|COMMIT|ROLLBACK)$|set_config/.test(t));
  return { pool, sent, work };
}

/** A limit whose count and whenFull are recorded as statements of their own. */
function limitOf(
  counted: number,
  options: Partial<Pick<CountedLimit<string>, 'lock' | 'adding' | 'max'>> = {},
): CountedLimit<string> {
  return {
    lock: options.lock ?? 'folder_count',
    count: async (tx: OrgTx) => {
      await tx.query('COUNT');
      return counted;
    },
    adding: options.adding,
    max: options.max ?? 3,
    whenFull: (n) => `full at ${n}`,
  };
}

const insert = (tx: OrgTx) => async (n: number) => {
  await tx.query('INSERT');
  return `inserted after ${n}`;
};

describe('withCountedLimit (SCX-05)', () => {
  it('SCX-05: takes the lock, then counts, then inserts while there is room', async () => {
    const { pool, work } = fakePool();
    expect(await withOrg(pool, ORG, (tx) => withCountedLimit(tx, limitOf(2), insert(tx)))).toBe(
      'inserted after 2',
    );
    expect(work()).toHaveLength(3);
    expect(work()[0]).toContain('pg_advisory_xact_lock');
    expect(work().slice(1)).toEqual(['COUNT', 'INSERT']);
  });

  it('SCX-05: refuses at the ceiling without inserting', async () => {
    const { pool, work } = fakePool();
    expect(await withOrg(pool, ORG, (tx) => withCountedLimit(tx, limitOf(3), insert(tx)))).toBe(
      'full at 3',
    );
    expect(work().slice(1)).toEqual(['COUNT']);
  });

  it('a refusal thrown by whenFull passes through, and nothing is inserted', async () => {
    const { pool, work } = fakePool();
    const throwing: CountedLimit<string> = {
      ...limitOf(3),
      whenFull: () => {
        throw new Error('the ceiling');
      },
    };
    await expect(
      withOrg(pool, ORG, (tx) => withCountedLimit(tx, throwing, insert(tx))),
    ).rejects.toThrow('the ceiling');
    expect(work().slice(1)).toEqual(['COUNT']);
  });

  it('counts what the change adds: the file that would pass the quota is refused, one that fits is not', async () => {
    for (const [adding, expected] of [
      [40, 'inserted after 60'],
      [41, 'full at 60'],
    ] as const) {
      const { pool } = fakePool();
      expect(
        await withOrg(pool, ORG, (tx) =>
          withCountedLimit(tx, limitOf(60, { adding, max: 100, lock: 'media_quota' }), insert(tx)),
        ),
      ).toBe(expected);
    }
  });

  it('locks the key the routes used before it: tinnox.<name>: and the organisation', async () => {
    for (const lock of [
      'folder_count',
      'tag_count',
      'alert_recipient_count',
      'media_quota',
    ] as const) {
      const { pool, sent } = fakePool();
      await withOrg(pool, ORG, (tx) => withCountedLimit(tx, limitOf(0, { lock }), insert(tx)));
      const taken = sent.find((s) => s.text.includes('pg_advisory_xact_lock'));
      expect(taken?.text).toContain(
        "hashtextextended('tinnox.' || $1::text || ':' || app_org_id()::text, 0)",
      );
      expect(taken?.values).toEqual([lock]);
    }
  });

  it('takes the membership lock through lockOrgMembership, with its key', async () => {
    const { pool, sent } = fakePool();
    await withOrg(pool, ORG, (tx) =>
      withCountedLimit(tx, limitOf(0, { lock: 'membership' }), insert(tx)),
    );
    const taken = sent.find((s) => s.text.includes('pg_advisory_xact_lock'));
    expect(taken?.text).toContain(
      "hashtextextended('tinnox.membership:' || app_org_id()::text, 0)",
    );
  });

  it('refuses to count when the transaction has no organisation, as lockOrgMembership does', async () => {
    const { pool, work } = fakePool(false);
    await expect(
      withOrg(pool, ORG, (tx) => withCountedLimit(tx, limitOf(0), insert(tx))),
    ).rejects.toThrow(/requires an organisation context/);
    expect(work()).toHaveLength(1);
  });
});
