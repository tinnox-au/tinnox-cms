/**
 * Which handle each sec.* wrapper takes, which of them name an organisation (step 18), and the
 * two functions that write outside a transaction by name: `auditStandalone` (D2) and
 * `sessionRevokeUnaudited` (the CX-01 residual). The type cases are checked by
 * `npm run typecheck`, which reads this file: an unused @ts-expect-error is an error there.
 */
import type { AuditAction } from '@tinnox/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  auditStandalone,
  poolAsTx,
  sessionRevokeUnaudited,
  type AnyScope,
  type AuditInput,
  type OrgId,
  type OrgTx,
  type Pool,
  type PreOrgTx,
  type StandaloneAuditEvent,
} from './index.ts';
import { auditScoped, withoutOrg } from './testing.ts';
import * as members from './members.ts';
import * as sec from './sec.ts';

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

/** A scoped event, for the type cases that only need one. */
const refusalInOrg = {
  actorType: 'operator',
  actorId: 'a-member-id',
  action: 'security.csrf_rejected',
  objectType: null,
  objectId: null,
  result: 'denied',
  detail: { reason: 'bad_token', method: 'POST', route: null },
} as const satisfies AuditInput;

// The refusal names the function that was called and what to call on the outer tx instead
// (plan section 3.4): neither function takes a tx, so "pass the outer tx" would not help.
const nested = (opener: string, instead: string): string =>
  `${opener} was called while a transaction is open on the same asynchronous path (inside the callback of withOrg, withoutOrg, withResolvedOrg, readOrg, changeOrg or changePreOrg, or in a helper it called). This opens a second transaction on another connection that commits independently. ${instead}`;
const NESTED_AUDIT = nested(
  'auditStandalone',
  'Return the event from the outer change as { value, audit }: changeOrg and changePreOrg, and the wrappers built on them (changeAsOperator, changeAsDevice, changeAsJob, changeOrgAsMigrator), write it on that transaction.',
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

describe('AuditInput (AG-3.3, AG-3.4, D19)', () => {
  it('has one member per AuditAction of @tinnox/contracts, and no other action', () => {
    expectTypeOf<AuditInput['action']>().toEqualTypeOf<AuditAction>();
    // A standalone refusal carries the detail its action declares, nothing wider.
    expectTypeOf<StandaloneAuditEvent>().toExtend<AuditInput>();
  });

  it('refuses an unknown action, an undeclared detail field, another object kind, a wrong actor and a missing field, at compile time', () => {
    // Never called: these lines are for the type checker.
    const cases = async (tx: OrgTx): Promise<void> => {
      const event = {
        actorType: 'operator',
        actorId: 'a-member-id',
        action: 'folder.delete',
        objectType: 'folder',
        objectId: 'a-folder-id',
        result: 'success',
        detail: { movedToRoot: 2 },
      } as const;
      await auditScoped(tx, event);
      // @ts-expect-error an action is a member of AUDIT_ACTIONS (packages/contracts/src/audit.ts)
      await auditScoped(tx, { ...event, action: 'folder.archive' });
      // @ts-expect-error a detail field is declared in AuditEventShapes first: a name is content
      await auditScoped(tx, { ...event, detail: { movedToRoot: 2, name: 'Lobby' } });
      // @ts-expect-error the detail of one action is not the detail of another
      await auditScoped(tx, { ...event, detail: { itemCount: 2 } });
      // @ts-expect-error the action fixes the kind of object it names
      await auditScoped(tx, { ...event, objectType: 'media' });
      // @ts-expect-error the action fixes who its actor may be
      await auditScoped(tx, { ...event, actorType: 'anonymous' });
      // @ts-expect-error an event names its actor, object and result
      await auditScoped(tx, { action: event.action, actorType: 'operator', detail: event.detail });
    };
    expect(cases).toBeTypeOf('function');
  });

  it('needs the id of an operator or player actor and of a named object, and refuses an id the system or nobody would have (AG-3.3)', () => {
    // Never called: these lines are for the type checker.
    const cases = async (tx: OrgTx): Promise<void> => {
      const event = {
        actorType: 'operator',
        actorId: 'a-member-id',
        action: 'folder.delete',
        objectType: 'folder',
        objectId: 'a-folder-id',
        result: 'success',
        detail: { movedToRoot: 2 },
      } as const;
      // @ts-expect-error an operator is named by the membership id
      await auditScoped(tx, { ...event, actorId: null });
      // @ts-expect-error an action that names a kind of object names the object
      await auditScoped(tx, { ...event, objectId: null });
      const alert = {
        actorType: 'system',
        actorId: null,
        action: 'display.offline_alert',
        objectType: 'display',
        objectId: 'a-display-id',
        result: 'success',
        detail: { recipients: 1 },
      } as const;
      await auditScoped(tx, alert);
      // @ts-expect-error the system has no id
      await auditScoped(tx, { ...alert, actorId: 'a-member-id' });
      const paired = {
        actorType: 'player',
        actorId: 'a-registration-id',
        action: 'pairing.complete',
        objectType: 'player_registration',
        objectId: 'a-registration-id',
        result: 'success',
        detail: { displayId: 'a-display-id', pairingId: 'a-pairing-id' },
      } as const;
      await auditScoped(tx, paired);
      // @ts-expect-error a player that pairs is named by its registration id
      await auditScoped(tx, { ...paired, actorId: null });
      // An action whose shape says so may leave an id out: a refused upload made no media row.
      await auditScoped(tx, {
        actorType: 'operator',
        actorId: 'a-member-id',
        action: 'media.upload',
        objectType: 'media',
        objectId: null,
        result: 'denied',
        detail: { reason: 'too_large' },
      });
    };
    expect(cases).toBeTypeOf('function');
    // A rejected device credential names no registration: it was not accepted.
    expectTypeOf<
      Extract<AuditInput, { action: 'player.auth_rejected' }>['actorId']
    >().toEqualTypeOf<null>();
    expectTypeOf<
      Extract<AuditInput, { action: 'folder.delete' }>['actorId']
    >().toEqualTypeOf<string>();
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

describe('the handle each wrapper takes (D2, CX-01, AG-2.1, AG-2.2)', () => {
  // A new wrapper lands in one of the three lists below, by what it needs.
  it('what needs the organisation takes an OrgTx: the scoped audit writer, the claim, the cancel, the member revocation and the member SQL', () => {
    expectTypeOf<Taking<Wrappers, OrgTx>>().toEqualTypeOf<
      | 'auditScoped'
      | 'sessionRevokeMembership'
      | 'pairingClaim'
      | 'pairingCancelClaims'
      | 'lockOrgMembership'
      | 'membershipForCheck'
    >();
  });

  it('what changes data before the organisation is known, and the unscoped audit writer, take a PreOrgTx', () => {
    expectTypeOf<Taking<Wrappers, PreOrgTx>>().toEqualTypeOf<
      | 'auditUnscoped'
      | 'sessionCreate'
      | 'sessionRevoke'
      | 'pairingCreate'
      | 'pairingPoll'
      | 'pairingComplete'
    >();
  });

  // It belongs in this one only when it reads, or when its one statement is complete by itself
  // and nothing is audited with it (D2, D3).
  it('lookups, the login state and the purges take any handle', () => {
    expectTypeOf<Taking<Wrappers, AnyScope>>().toEqualTypeOf<
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

  it('a wrapper refuses the handle of the other scope', () => {
    // Never called: these lines are for the type checker.
    const cases = async (org: OrgTx, pre: PreOrgTx): Promise<void> => {
      const claim = {
        code: 'ABCD2345',
        displayId: 'a-display-id',
        membershipId: 'a-member-id',
        maxFailures: 5,
        windowSeconds: 600,
      };
      await sec.pairingClaim(org, claim);
      // @ts-expect-error a PreOrgTx is not accepted where an OrgTx is needed: no organisation yet
      await sec.pairingClaim(pre, claim);
      // @ts-expect-error nor by the scoped audit writer, whose row takes the organisation of the tx
      await auditScoped(pre, refusalInOrg);
      // @ts-expect-error nor by the member revocation
      await sec.sessionRevokeMembership(pre, 'a-member-id');
      // @ts-expect-error nor by the membership lock
      await members.lockOrgMembership(pre);

      await sec.auditUnscoped(pre, refusal);
      // @ts-expect-error an event with no organisation is not written where one is set
      await sec.auditUnscoped(org, refusal);

      // A lookup takes either.
      await sec.deviceByTokenHash(org, Buffer.alloc(32));
      await sec.deviceByTokenHash(pre, Buffer.alloc(32));
    };
    expect(cases).toBeTypeOf('function');
  });

  it('the handle of poolAsTx serves a lookup, and no wrapper that changes data (D2)', () => {
    // Never called: these lines are for the type checker.
    const cases = async (pool: Pool): Promise<void> => {
      const autocommit = poolAsTx(pool);
      await sec.deviceByTokenHash(autocommit, Buffer.alloc(32));
      // @ts-expect-error a change before the organisation is known takes a PreOrgTx
      await sec.sessionRevoke(autocommit, Buffer.alloc(32));
      // @ts-expect-error and one that needs the organisation takes an OrgTx
      await sec.sessionRevokeMembership(autocommit, 'a-member-id');
    };
    expect(cases).toBeTypeOf('function');
  });
});

// AG-2.3 (adoption plan step 18, D25): the lookups that resolve a verified credential, a job or
// a confirmation link name the organisation as an OrgId, and they are the runtime entry's only
// source of one.
describe('the organisation a lookup names is an OrgId (AG-2.3)', () => {
  type Resolved<F> = F extends (...args: never[]) => Promise<infer R> ? NonNullable<R> : never;

  it('the session, device, pairing, job, alert and confirmation lookups return one', () => {
    expectTypeOf<Resolved<typeof sec.sessionByIdHash>['orgId']>().toEqualTypeOf<OrgId>();
    expectTypeOf<Resolved<typeof sec.sessionRevoke>['orgId']>().toEqualTypeOf<OrgId>();
    expectTypeOf<
      Extract<Resolved<typeof sec.sessionCreate>, { outcome: 'created' | 'reauth' }>['orgId']
    >().toEqualTypeOf<OrgId>();
    expectTypeOf<Resolved<typeof sec.deviceByTokenHash>['orgId']>().toEqualTypeOf<OrgId>();
    expectTypeOf<Resolved<typeof sec.deviceByRegistrationId>['orgId']>().toEqualTypeOf<OrgId>();
    expectTypeOf<
      Extract<Resolved<typeof sec.pairingComplete>, { outcome: 'completed' }>['orgId']
    >().toEqualTypeOf<OrgId>();
    expectTypeOf<
      Resolved<typeof sec.mediaProcessingJobs>[number]['orgId']
    >().toEqualTypeOf<OrgId>();
    expectTypeOf<Resolved<typeof sec.displayAlertOrgs>>().toEqualTypeOf<OrgId[]>();
    expectTypeOf<Resolved<typeof sec.alertRecipientByTokenHash>['orgId']>().toEqualTypeOf<OrgId>();
  });

  it('a lookup by a subject the caller names proves no credential, and returns a plain string', () => {
    expectTypeOf<Resolved<typeof sec.membershipByOidcSub>['orgId']>().toEqualTypeOf<string>();
  });

  it('the value is the org_id the function returned', async () => {
    const ORG = '00000000-0000-4000-8000-000000000001';
    const { pool } = recordingPool([{ registration_id: 'r', org_id: ORG, display_id: 'd' }]);
    expect(await sec.deviceByTokenHash(poolAsTx(pool), Buffer.alloc(32))).toEqual({
      registrationId: 'r',
      orgId: ORG,
      displayId: 'd',
    });
  });
});
