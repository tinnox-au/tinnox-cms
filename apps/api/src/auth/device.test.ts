/**
 * What a player changes with its device credential (SCR-34, D8; adoption plan step 20): the
 * permit of the change comes from the credential check alone, and carries what the route says
 * it audits. The statements are read off a fake connection; the type cases are checked by
 * `npm run typecheck`.
 */
import { PLAYER_PREFIX, ROUTES } from '@tinnox/contracts';
import {
  changeOrg,
  poolAsTx,
  unaudited,
  type AuditInput,
  type Change,
  type DeviceLookup,
  type OrgTx,
} from '@tinnox/db';
import type { FastifyRequest } from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  contextOn,
  DISPLAY,
  fakePool,
  ORG,
  REGISTRATION,
  requestTo,
  SET_ORG,
} from '../change.test-support.ts';
import type { AppContext } from '../context.ts';
import { changeAsDevice, verifyDeviceCredential, type VerifiedDevice } from './device.ts';
import { changeAsOperator } from './permissions.ts';
import { databaseOn } from '@tinnox/db/testing';

const TOKEN_HASH = Buffer.alloc(32, 7);
const REGISTRATION_ROUTE = `${PLAYER_PREFIX}/registration`;

const REVOKED_BY_THE_PLAYER = {
  actorType: 'player',
  actorId: REGISTRATION,
  action: 'player.revoke',
  objectType: 'player_registration',
  objectId: REGISTRATION,
  result: 'success',
  detail: { reason: 'player_reset', displayId: DISPLAY },
} as const satisfies AuditInput;

async function knownDevice(pool: ReturnType<typeof fakePool>['pool']): Promise<VerifiedDevice> {
  const device = await verifyDeviceCredential(poolAsTx(databaseOn(pool)), TOKEN_HASH);
  if (device === null) throw new Error('the fake pool knows this credential');
  return device;
}

describe('the device-credential check (SCR-34)', () => {
  it('gives the device of a credential the database knows, with one lookup and no transaction', async () => {
    const { pool, transactions, unscoped } = fakePool();
    const device = await knownDevice(pool);
    expect({ ...device }).toEqual({ registrationId: REGISTRATION, orgId: ORG, displayId: DISPLAY });
    // A copy is not the device the check returned: the types let it by, the run does not.
    await expect(
      changeAsDevice(contextOn(pool), requestTo('DELETE', REGISTRATION_ROUTE), { ...device }, () =>
        Promise.resolve({ value: 1, audit: REVOKED_BY_THE_PLAYER }),
      ),
    ).rejects.toThrow(/^changeAsDevice requires the device that verifyDeviceCredential/);
    expect(unscoped).toEqual(['DEVICE LOOKUP']);
    expect(transactions).toEqual([]);
  });

  it('gives nothing for an unknown or revoked credential, so there is nothing to change with', async () => {
    const { pool } = fakePool(false);
    expect(await verifyDeviceCredential(poolAsTx(databaseOn(pool)), TOKEN_HASH)).toBeNull();
  });
});

describe('a change by a player on changeOrg (SCR-34)', () => {
  it('runs the change for the organisation of the credential and writes the audit row it returned', async () => {
    const { pool, transactions } = fakePool();
    const device = await knownDevice(pool);
    const revoked = await changeAsDevice(
      contextOn(pool),
      requestTo('DELETE', REGISTRATION_ROUTE),
      device,
      async (tx) => {
        await tx.query('REVOKE REGISTRATION');
        return { value: true, audit: REVOKED_BY_THE_PLAYER };
      },
    );
    expect(revoked).toBe(true);
    // No statement between the organisation and the change: nothing is read again (D8).
    expect(transactions).toEqual([
      ['BEGIN', SET_ORG, 'REVOKE REGISTRATION', 'AUDIT player.revoke success', 'COMMIT'],
    ]);
  });

  it('holds the change to what its route states in OTHER_ROUTE_AUDIT', async () => {
    const { pool, transactions } = fakePool();
    const device = await knownDevice(pool);
    // The heartbeat states telemetry, and audits nothing.
    await changeAsDevice(
      contextOn(pool),
      requestTo('POST', ROUTES.playerHeartbeat),
      device,
      async (tx) => {
        await tx.query('STORE REPORT');
        return { value: 1, audit: unaudited('telemetry') };
      },
    );
    expect(transactions.at(-1)).toEqual(['BEGIN', SET_ORG, 'STORE REPORT', 'COMMIT']);

    await expect(
      changeAsDevice(contextOn(pool), requestTo('POST', ROUTES.playerHeartbeat), device, () =>
        Promise.resolve({ value: 1, audit: REVOKED_BY_THE_PLAYER }),
      ),
    ).rejects.toThrow(
      'changeOrg: the change recorded player.revoke, which the entry of POST /player/heartbeat in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts) does not state: it states no audit row (telemetry).',
    );
    expect(transactions.at(-1)?.at(-1)).toBe('ROLLBACK');

    // And the reason of the heartbeat is not for the route that revokes.
    await expect(
      changeAsDevice(contextOn(pool), requestTo('DELETE', REGISTRATION_ROUTE), device, () =>
        Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
      ),
    ).rejects.toThrow(/unaudited\('telemetry'\), but the entry of DELETE \/player\/registration/);
    // A registration that was already revoked: this run changed nothing.
    await changeAsDevice(contextOn(pool), requestTo('DELETE', REGISTRATION_ROUTE), device, () =>
      Promise.resolve({ value: 1, audit: unaudited('nothing_changed') }),
    );
    expect(transactions.at(-1)).toEqual(['BEGIN', SET_ORG, 'COMMIT']);
  });

  it('refuses an operator route, whose statement is its row of ROUTE_PERMISSIONS, before any statement', async () => {
    const { pool, transactions } = fakePool();
    const device = await knownDevice(pool);
    await expect(
      changeAsDevice(contextOn(pool), requestTo('POST', ROUTES.folders), device, () =>
        Promise.resolve({ value: 1, audit: unaudited('nothing_changed') }),
      ),
    ).rejects.toThrow(
      'a change ran on POST /api/folders, which has no entry in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts), so nothing says what it audits.',
    );
    expect(transactions).toEqual([]);
  });

  it('refuses at run time a device the check did not return, and sends nothing', async () => {
    const { pool, transactions, unscoped } = fakePool();
    const forged = { registrationId: REGISTRATION, orgId: ORG, displayId: DISPLAY };
    await expect(
      changeAsDevice(
        contextOn(pool),
        requestTo('DELETE', REGISTRATION_ROUTE),
        forged as never,
        () => Promise.resolve({ value: 1, audit: REVOKED_BY_THE_PLAYER }),
      ),
    ).rejects.toThrow(
      'changeAsDevice requires the device that verifyDeviceCredential(unscoped, tokenHash) returned for the credential of this request (apps/api/src/auth/device.ts): a player route resolves its credential first, and an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts)',
    );
    expect(transactions).toEqual([]);
    expect(unscoped).toEqual([]);
  });
});

// Never called: these lines are for the type checker.
describe('the permit of a device comes from the credential check only (SCR-34)', () => {
  it('a device that was not verified cannot change anything, and a verified one is no permit', () => {
    const cases = async (
      ctx: AppContext,
      request: FastifyRequest,
      device: VerifiedDevice,
      lookup: DeviceLookup,
    ): Promise<void> => {
      const change = (tx: OrgTx): Promise<Change<number>> =>
        tx.query('SELECT 1').then(() => ({ value: 1, audit: unaudited('nothing_changed') }));
      await changeAsDevice(ctx, request, device, change);
      // @ts-expect-error a lookup of the registration alone (a signed media URL) is not the credential check
      await changeAsDevice(ctx, request, lookup, change);
      const spelled = { registrationId: 'r', orgId: ORG, displayId: 'd' };
      // @ts-expect-error nor an object that spells a device: the mark of the check is not exported
      await changeAsDevice(ctx, request, spelled, change);
      // @ts-expect-error a change by a device needs the device: there is no form without
      await changeAsDevice(ctx, request, change);
      // @ts-expect-error changeOrg takes a permit, and a player route has none to give
      await changeOrg(ctx.db, device.orgId, change);
      // @ts-expect-error the verified device is the proof for changeAsDevice, not a permit
      await changeOrg(ctx.db, device.orgId, device, change);
      // @ts-expect-error a device changes { value, audit }, not a bare value
      await changeAsDevice(ctx, request, device, () => Promise.resolve(1));
      // An operator's change takes no device: the role guard decides it.
      await changeAsOperator(ctx, request, change);
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<DeviceLookup>().not.toExtend<VerifiedDevice>();
    expectTypeOf<VerifiedDevice>().toExtend<DeviceLookup>();
    expectTypeOf(verifyDeviceCredential).returns.resolves.toEqualTypeOf<VerifiedDevice | null>();
  });
});
