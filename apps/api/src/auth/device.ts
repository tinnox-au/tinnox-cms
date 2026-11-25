/**
 * What a player may change with its device credential (adoption plan step 20; SCR-34, D8).
 *
 * A player has no role, so the permit of an operator's write (./permissions.ts) is not for it.
 * `changeOrg` of @tinnox/db still runs no change without a permit, and this module issues the
 * device's: only to a `VerifiedDevice`, which only the credential check below makes. So a
 * handler that did not resolve a device credential has nothing to give `changeAsDevice`, and a
 * device's write that skipped the check does not type-check. The permit carries what the route
 * says it audits (its entry in OTHER_ROUTE_AUDIT, ../route-audit.ts), as an operator's carries
 * its row.
 *
 * Nothing is read again inside the change: a request already past the lookup finishes its one
 * transaction, which is the window D8 states. One write looks all the same: the heartbeat's
 * UPDATE takes effect only while the registration is still active (../routes/player.ts).
 */
import {
  changeOrg,
  deviceByTokenHash,
  issueWritePermit,
  settle,
  termsOfStatement,
  type AnyScope,
  type Change,
  type DeviceLookup,
  type OrgTx,
} from '@tinnox/db';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { routeStatement } from '../route-audit.ts';
import { lockTimeoutAsUnavailable } from './permissions.ts';

/** Marks what `verifyDeviceCredential` returns. Not exported, so nothing else makes one. */
const verified: unique symbol = Symbol('verifiedDevice');

/**
 * The registration, organisation and display of a device credential that the database knows
 * and has not revoked. Made by `verifyDeviceCredential` alone; lint refuses a cast to it
 * (NO_VERIFIED_DEVICE_CAST in eslint.config.js), and `changeAsDevice` refuses a value that
 * was cast.
 */
export interface VerifiedDevice extends DeviceLookup {
  readonly [verified]: true;
}

/**
 * The device of a credential, by the SHA-256 of its token; null for an unknown or revoked one.
 * `unscoped` is the handle for lookups before the organisation is known (`poolAsTx(ctx.db)`).
 */
export async function verifyDeviceCredential(
  unscoped: AnyScope,
  tokenHash: Buffer,
): Promise<VerifiedDevice | null> {
  const device = await deviceByTokenHash(unscoped, tokenHash);
  if (device === null) return null;
  const marked = { ...device, [verified]: true as const };
  // Not enumerable: a copy or a log line of the device shows the three ids and nothing else.
  Object.defineProperty(marked, verified, { enumerable: false });
  return Object.freeze(marked);
}

/**
 * A change by a player, for the organisation of its credential, on `changeOrg`:
 *
 *   BEGIN; set the organisation; ...fn...; the audit rows `fn` returned; COMMIT
 *
 * `fn` returns `{ value, audit }` and writes no audit row itself. The change is refused before
 * COMMIT when it recorded an action the route's entry in OTHER_ROUTE_AUDIT does not state.
 * A lock timeout (55P03) raised anywhere inside becomes 503 service_unavailable with
 * retry-after 2, as in changeAsOperator; it rolled back, so nothing of it is stored. A COMMIT
 * that did not confirm is thrown as it came (CommitOutcomeUnknownError).
 */
export async function changeAsDevice<T>(
  ctx: AppContext,
  request: FastifyRequest,
  device: VerifiedDevice,
  fn: (tx: OrgTx) => Promise<Change<T>>,
): Promise<T> {
  // A value that was cast to the type never passed the check: say so before anything is sent.
  const candidate: unknown = device;
  if (typeof candidate !== 'object' || candidate === null || !Object.hasOwn(candidate, verified)) {
    throw new Error(
      'changeAsDevice requires the device that verifyDeviceCredential(unscoped, tokenHash) returned for the credential of this request (apps/api/src/auth/device.ts): a player route resolves its credential first, and an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts)',
    );
  }
  const statement = routeStatement(request);
  const permit = issueWritePermit({
    // The whole statement, grants included.
    ...termsOfStatement('changeAsDevice', statement),
    // Nothing to read again (D8): the lookup that made `device` is the check.
    recheck: () => Promise.resolve(),
  });
  const ended = await settle(changeOrg(ctx.db, device.orgId, permit, (tx) => fn(tx)));
  switch (ended.end) {
    case 'committed':
      return ended.value;
    case 'rolled_back':
      throw lockTimeoutAsUnavailable(request, ended.error);
    case 'unknown':
      throw ended.unconfirmed;
  }
}
