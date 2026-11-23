/**
 * asDefiner (D25, adoption plan step 15): the one place that switches the database role. It runs
 * its work as tinnox_definer inside the caller's transaction on the migrator's pool, and the
 * switch never outlives the work: not when the work returns, not when it throws, and not on the
 * pooled connection after the transaction. Provisioning's own cases are in
 * tests/integration/provision-member.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg, withoutOrg, withResolvedOrg, type Pool, type Tx } from '../src/index.ts';
import { asDefiner, connectMigrator, type MigratorPool } from '../src/migrate.ts';
import {
  appPool,
  createOrg,
  migratorClient,
  migratorUrl,
  pgCode,
  PG,
  type TestOrg,
} from './support.ts';

// One connection, as connectMigrator makes it: a switch that leaked would be seen by the next
// transaction on the same pool.
let migrator: MigratorPool;
let other: MigratorPool;
let app: Pool;
let org: TestOrg;

beforeAll(async () => {
  migrator = await connectMigrator(migratorUrl(), { applicationName: 'tinnox-test-definer' });
  other = await connectMigrator(migratorUrl(), { applicationName: 'tinnox-test-definer-2' });
  app = appPool('tries the definer-owned functions as the runtime role', 2);
  const arrange = await migratorClient();
  try {
    org = await createOrg(arrange, 'Definer');
  } finally {
    await arrange.end();
  }
});
afterAll(async () => {
  await migrator.end();
  await other.end();
  await app.end();
});

const currentUser = async (tx: Tx): Promise<string | undefined> =>
  (await tx.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user;
const membershipRows = async (tx: Tx): Promise<number> =>
  (await tx.query('SELECT 1 FROM public.membership WHERE id = $1', [org.membershipId])).rows.length;

describe('asDefiner (D25)', () => {
  it('runs its work as tinnox_definer and returns to the migrator, inside one transaction', async () => {
    const seen = await withoutOrg(migrator, async (tx) => ({
      before: await currentUser(tx),
      during: await asDefiner(migrator, tx, () => currentUser(tx)),
      after: await currentUser(tx),
    }));
    expect(seen).toEqual({
      before: 'tinnox_migrator',
      during: 'tinnox_definer',
      after: 'tinnox_migrator',
    });
    expect(await withoutOrg(migrator, currentUser)).toBe('tinnox_migrator');
  });

  it('reads every organisation, where the migrator with no organisation set reads none', async () => {
    const rows = await withoutOrg(migrator, async (tx) => ({
      asMigrator: await membershipRows(tx),
      asDefiner: await asDefiner(migrator, tx, () => membershipRows(tx)),
      asMigratorAgain: await membershipRows(tx),
    }));
    expect(rows).toEqual({ asMigrator: 0, asDefiner: 1, asMigratorAgain: 0 });
  });

  it('serves the provisioning pattern: read as the definer, then enter the organisation the row names', async () => {
    const role = await withResolvedOrg(migrator, async (tx, enterOrg) => {
      const found = await asDefiner(migrator, tx, async () => {
        const { rows } = await tx.query<{ org_id: string }>(
          'SELECT org_id FROM public.membership WHERE id = $1',
          [org.membershipId],
        );
        return rows[0];
      });
      if (found === undefined) throw new Error('the member was not found');
      await enterOrg(found.org_id);
      const { rows } = await tx.query<{ role: string }>(
        'SELECT role FROM membership WHERE id = $1 AND org_id = app_org_id()',
        [org.membershipId],
      );
      return rows[0]?.role;
    });
    expect(role).toBe('owner');
    // And inside withOrg, as org-create uses it.
    expect(
      await withOrg(migrator, org.orgId, (tx) => asDefiner(migrator, tx, () => currentUser(tx))),
    ).toBe('tinnox_definer');
  });

  it('resets the role before an error of the work reaches a caller that carries on', async () => {
    const after = await withoutOrg(migrator, async (tx) => {
      await expect(
        asDefiner(migrator, tx, async () => {
          await membershipRows(tx);
          throw new Error('refused by the work');
        }),
      ).rejects.toThrow('refused by the work');
      return { currentUser: await currentUser(tx), rows: await membershipRows(tx) };
    });
    expect(after).toEqual({ currentUser: 'tinnox_migrator', rows: 0 });
  });

  it("passes on the work's own database error, and leaves the connection the migrator's", async () => {
    const failed = withoutOrg(migrator, (tx) =>
      asDefiner(migrator, tx, () => tx.query('SELECT 1 FROM public.no_such_table')),
    );
    expect(await pgCode(failed)).toBe('42P01');
    expect(await withoutOrg(migrator, currentUser)).toBe('tinnox_migrator');
  });

  it('allows one switch after another in a transaction, and refuses one inside another', async () => {
    const twice = await withoutOrg(migrator, async (tx) => [
      await asDefiner(migrator, tx, () => currentUser(tx)),
      await asDefiner(migrator, tx, () => currentUser(tx)),
      await currentUser(tx),
    ]);
    expect(twice).toEqual(['tinnox_definer', 'tinnox_definer', 'tinnox_migrator']);

    await expect(
      withoutOrg(migrator, (tx) =>
        asDefiner(migrator, tx, () => asDefiner(migrator, tx, () => currentUser(tx))),
      ),
    ).rejects.toThrow(
      'asDefiner was called inside the work of another asDefiner on the same transaction: the inner RESET ROLE would end the outer switch early. Do the definer work in one call',
    );
    expect(await withoutOrg(migrator, currentUser)).toBe('tinnox_migrator');
  });

  it('refuses a tx that was not opened on the pool it is given, before it sends anything', async () => {
    const NOT_THIS_POOL =
      'asDefiner needs the tx of a transaction opened on the same MigratorPool: call it inside the callback of withOrg, withoutOrg or withResolvedOrg that was given this pool, with the tx that callback received';
    // The API's pool: the database would refuse the switch too, but this refusal comes first.
    await expect(
      withoutOrg(app, (tx) => asDefiner(migrator, tx, () => currentUser(tx))),
    ).rejects.toThrow(NOT_THIS_POOL);
    // Another migrator pool: the database would allow it, so only this check stands in the way.
    await expect(
      withoutOrg(other, (tx) => asDefiner(migrator, tx, () => currentUser(tx))),
    ).rejects.toThrow(NOT_THIS_POOL);
    expect(await withoutOrg(other, currentUser)).toBe('tinnox_migrator');
  });

  it('takes a MigratorPool only (the type, checked by npm run typecheck), and tinnox_app cannot take the role', async () => {
    const refused = withoutOrg(app, (tx) =>
      // @ts-expect-error the runtime pool is not a MigratorPool: only connectMigrator makes one.
      asDefiner(app, tx, () => currentUser(tx)),
    );
    // Past the type by force, the database still refuses: tinnox_app is a member of no role.
    expect(await pgCode(refused)).toBe(PG.insufficientPrivilege);
    expect(await withoutOrg(app, currentUser)).toBe('tinnox_app');
  });
});
