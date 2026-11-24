/**
 * withCountedLimit takes the same advisory locks the routes took before it (SCX-05, adoption plan
 * step 22): an API process of the previous release, still serving during a deploy, must wait on
 * the same keys. Each key is written out here as the old routes wrote it, and another connection
 * tries it while the helper holds its lock. The races themselves, two creates at a ceiling, are
 * in apps/api/test/counted-limits.integration.test.ts.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCountedLimit, type CountedLock } from '../src/index.ts';
import { withOrg, type Pool } from '../src/testing.ts';
import { appPool, createOrg, migratorClient, type TestOrg } from './support.ts';

let pool: Pool;
let other: pg.Client;
let a: TestOrg;
let b: TestOrg;

beforeAll(async () => {
  pool = appPool('runs withCountedLimit directly, as the runtime role');
  other = await migratorClient();
  a = await createOrg(other, 'Counted A');
  b = await createOrg(other, 'Counted B');
});
afterAll(async () => {
  await pool.end();
  await other.end();
});

/** Whether another connection could take the lock of `key` now (released again at once). */
async function free(key: string): Promise<boolean> {
  const { rows } = await other.query<{ got: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
    [key],
  );
  return rows[0]?.got === true;
}

// The keys exactly as the routes and lockOrgMembership wrote them before this helper.
const OLD_KEYS: Record<CountedLock, (org: string) => string> = {
  folder_count: (org) => `tinnox.folder_count:${org}`,
  tag_count: (org) => `tinnox.tag_count:${org}`,
  alert_recipient_count: (org) => `tinnox.alert_recipient_count:${org}`,
  media_quota: (org) => `tinnox.media_quota:${org}`,
  membership: (org) => `tinnox.membership:${org}`,
};

describe('withCountedLimit lock keys (SCX-05)', () => {
  for (const [lock, oldKey] of Object.entries(OLD_KEYS) as [CountedLock, (o: string) => string][]) {
    it(`SCX-05: holds the old key of ${lock} for its organisation only, until the transaction ends`, async () => {
      expect(await free(oldKey(a.orgId))).toBe(true);
      const seen = await withOrg(pool, a.orgId, (tx) =>
        withCountedLimit(
          tx,
          { lock, count: () => Promise.resolve(0), max: 1, whenFull: () => null },
          async () => ({ own: await free(oldKey(a.orgId)), another: await free(oldKey(b.orgId)) }),
        ),
      );
      expect(seen).toEqual({ own: false, another: true });
      expect(await free(oldKey(a.orgId))).toBe(true);
    });
  }
});
