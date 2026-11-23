/**
 * Which handle each sec.* wrapper takes, and the two functions that write outside a transaction
 * by name: `auditStandalone` (D2) and `sessionRevokeUnaudited` (the CX-01 residual). The type
 * cases are checked by `npm run typecheck`, which reads this file: an unused @ts-expect-error is
 * an error there.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  auditStandalone,
  sessionRevokeUnaudited,
  withoutOrg,
  type AuditInput,
  type Autocommit,
  type Pool,
  type StandaloneAuditEvent,
  type Tx,
} from './index.ts';
import type * as members from './members.ts';
import type * as sec from './sec.ts';

interface Sent {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

/** A pool that records what is sent to it directly, and hands out one connection. */
function recordingPool(rows: readonly unknown[] = []) {
  const onPool: Sent[] = [];
  let taken = 0;
  const client = {
    on: () => undefined,
    removeListener: () => undefined,
    query: () => Promise.resolve({ rows: [] }),
    release: () => undefined,
  };
  const pool = {
    connect: () => {
      taken += 1;
      return Promise.resolve(client);
    },
    query: (text: string, values?: readonly unknown[]) => {
      onPool.push({ text, values });
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;
  return { pool, onPool, connectionsTaken: () => taken };
}

const refusal = {
  actorType: 'anonymous',
  actorId: null,
  action: 'auth.login',
  objectType: null,
  objectId: null,
  result: 'denied',
  detail: { reason: 'unknown_or_expired_state' },
} as const satisfies StandaloneAuditEvent;

// The refusal names the function that was called and what to call on the outer tx instead
// (plan section 3.4): neither function takes a tx, so "pass the outer tx" would not help.
const nested = (opener: string, instead: string): string =>
  `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of withOrg, withoutOrg or withResolvedOrg, or in a helper it called). This opens a second transaction on another connection that commits independently. ${instead}`;
const NESTED_AUDIT = nested(
  'auditStandalone',
  'Write the event on the outer tx with auditUnscoped(tx, event), or with auditScoped(tx, event) when the outer transaction is withOrg.',
);
const NESTED_REVOKE = nested(
  'sessionRevokeUnaudited',
  'End the session on the outer tx with sessionRevoke(tx, idHash), and write its audit row on the same tx.',
);
// Defined outside the callbacks below: lint reports the form it can read
// (tinnox/no-nested-transaction), and these cases are the rest, which only the run-time guard sees.
const writeRefusal = (pool: Pool): Promise<void> => auditStandalone(pool, refusal);
const endSession = (pool: Pool): Promise<boolean> => sessionRevokeUnaudited(pool, Buffer.alloc(32));

describe('auditStandalone (D2)', () => {
  it('writes the refusal as one unscoped statement on the pool, outside any transaction', async () => {
    const { pool, onPool, connectionsTaken } = recordingPool();
    await auditStandalone(pool, refusal);
    expect(onPool).toEqual([
      {
        text: 'SELECT sec.audit_unscoped($1, $2, $3, $4, $5, $6, $7)',
        values: [
          'anonymous',
          null,
          'auth.login',
          null,
          null,
          'denied',
          '{"reason":"unknown_or_expired_state"}',
        ],
      },
    ]);
    expect(connectionsTaken()).toBe(0);
  });

  it('refuses a success event, an actor or object id, and any other action, at compile time', () => {
    // Never called: these lines are for the type checker.
    const cases = async (pool: Pool, anyEvent: AuditInput): Promise<void> => {
      const success = { ...refusal, result: 'success' } as const;
      const withActor = { ...refusal, actorId: 'a-member-id' } as const;
      const withObject = { ...refusal, objectType: 'membership', objectId: 'a-member-id' } as const;
      const anotherAction = { ...refusal, action: 'auth.logout' } as const;
      const asOperator = { ...refusal, actorType: 'operator' } as const;
      const failedCredential = {
        ...refusal,
        actorType: 'player',
        action: 'player.auth_rejected',
        result: 'failure',
      } as const;
      // @ts-expect-error a success records a change: it is written on the Tx of that change
      await auditStandalone(pool, success);
      // @ts-expect-error a standalone refusal has no actor id
      await auditStandalone(pool, withActor);
      // @ts-expect-error a standalone refusal has no object
      await auditStandalone(pool, withObject);
      // @ts-expect-error only auth.login and player.auth_rejected are in the union
      await auditStandalone(pool, anotherAction);
      // @ts-expect-error a refused sign-in comes from nobody: the actor is anonymous
      await auditStandalone(pool, asOperator);
      // @ts-expect-error a rejected device credential is denied, never a failure
      await auditStandalone(pool, failedCredential);
      // @ts-expect-error the open AuditInput is for auditScoped and auditUnscoped only
      await auditStandalone(pool, anyEvent);
    };
    expect(cases).toBeTypeOf('function');

    // The union, pinned: a new member is a decision (see the comment on the type), so it must
    // also be written here.
    type Login = Extract<StandaloneAuditEvent, { action: 'auth.login' }>;
    type Rejected = Extract<StandaloneAuditEvent, { action: 'player.auth_rejected' }>;
    expectTypeOf<StandaloneAuditEvent['action']>().toEqualTypeOf<
      'auth.login' | 'player.auth_rejected'
    >();
    expectTypeOf<Login['actorType']>().toEqualTypeOf<'anonymous'>();
    expectTypeOf<Login['result']>().toEqualTypeOf<'denied' | 'failure'>();
    expectTypeOf<Rejected['actorType']>().toEqualTypeOf<'player'>();
    expectTypeOf<Rejected['result']>().toEqualTypeOf<'denied'>();
    expectTypeOf<StandaloneAuditEvent['actorId']>().toEqualTypeOf<null>();
    expectTypeOf<StandaloneAuditEvent['objectType']>().toEqualTypeOf<null>();
    expectTypeOf<StandaloneAuditEvent['objectId']>().toEqualTypeOf<null>();
  });

  it('is refused while a transaction is open on the same path, with the writers to use on the outer tx (U-3)', async () => {
    const { pool, onPool } = recordingPool();
    await expect(withoutOrg(pool, () => writeRefusal(pool))).rejects.toThrow(
      new Error(NESTED_AUDIT),
    );
    expect(onPool).toEqual([]);
  });
});

describe('sessionRevokeUnaudited (CX-01 residual)', () => {
  it('ends the session in one statement on the pool and says whether one was live', async () => {
    const idHash = Buffer.alloc(32, 7);
    const live = recordingPool([{ '?column?': 1 }]);
    expect(await sessionRevokeUnaudited(live.pool, idHash)).toBe(true);
    expect(live.onPool).toEqual([
      { text: 'SELECT 1 FROM sec.session_revoke($1)', values: [idHash] },
    ]);
    expect(live.connectionsTaken()).toBe(0);
    expect(await sessionRevokeUnaudited(recordingPool().pool, idHash)).toBe(false);
  });

  it('is refused while a transaction is open on the same path, with the revocation to use on the outer tx (U-3)', async () => {
    const { pool, onPool } = recordingPool();
    await expect(withoutOrg(pool, () => endSession(pool))).rejects.toThrow(
      new Error(NESTED_REVOKE),
    );
    expect(onPool).toEqual([]);
  });
});

// The first parameter of a function, or 'none' for an export that is not a function.
type Handle<F> = F extends (handle: infer H, ...rest: never[]) => unknown ? H : 'none';
// The exports of M whose first parameter is exactly H.
type Taking<M, H> = {
  [K in keyof M]: [Handle<M[K]>] extends [H] ? ([H] extends [Handle<M[K]>] ? K : never) : never;
}[keyof M];
type Wrappers = typeof sec & typeof members;

describe('the handle each wrapper takes (D2, CX-01)', () => {
  it('a wrapper that changes data, or locks until commit, and both audit writers take a Tx', () => {
    expectTypeOf<Taking<Wrappers, Tx>>().toEqualTypeOf<
      | 'auditScoped'
      | 'auditUnscoped'
      | 'sessionCreate'
      | 'sessionRevoke'
      | 'sessionRevokeMembership'
      | 'pairingCreate'
      | 'pairingPoll'
      | 'pairingClaim'
      | 'pairingCancelClaims'
      | 'pairingComplete'
      | 'lockOrgMembership'
      | 'membershipForCheck'
    >();
  });

  // A new wrapper lands in one of these two lists. It belongs in this one only when it reads,
  // or when its one statement is complete by itself and nothing is audited with it (D2, D3).
  it('lookups, the login state and the purges take either handle', () => {
    expectTypeOf<Taking<Wrappers, Autocommit>>().toEqualTypeOf<
      | 'membershipByOidcSub'
      | 'loginStatePut'
      | 'loginStateTake'
      | 'sessionByIdHash'
      | 'sessionPurgeExpired'
      | 'pairingPurge'
      | 'heartbeatLogPurge'
      | 'deviceByTokenHash'
      | 'deviceByRegistrationId'
      | 'mediaProcessingJobs'
      | 'displayAlertOrgs'
      | 'alertRecipientByTokenHash'
    >();
  });

  it('only the two named exceptions take the pool itself', () => {
    expectTypeOf<Taking<Wrappers, Pool>>().toEqualTypeOf<
      'auditStandalone' | 'sessionRevokeUnaudited'
    >();
  });
});
