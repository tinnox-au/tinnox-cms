/**
 * changeOrg and changePreOrg (adoption plan section 2.1 B, step 19; AG-3.1, SCR-34): the audit
 * rows a change returns are written on its transaction before COMMIT, a change runs only with a
 * permit, and what it recorded is held to what its route states. The statements are read off a
 * fake connection; the database's half is in packages/db/test/change.integration.test.ts. The
 * type cases are checked by `npm run typecheck`, which reads this file: an unused
 * @ts-expect-error is an error there.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  auditScoped,
  auditUnscoped,
  changeOrg,
  changePreOrg,
  issueWritePermit,
  legacyAudit,
  readOrg,
  unaudited,
  withOrg,
  type Audit,
  type AuditInput,
  type Change,
  type OrgReadTx,
  type OrgTx,
  type PermitTerms,
  type Pool,
  type StatedAudit,
  type Unaudited,
  type WritePermit,
} from './index.ts';
import { testOrgId } from './testing.ts';

const ORG = testOrgId('00000000-0000-4000-8000-000000000001');
const SET_ORG = "SELECT set_config('app.org_id', $1, true)";

/** A pool with one connection that records the first line of every statement it is sent. */
function fakePool(failing: readonly string[] = []) {
  const statements: string[] = [];
  const client = {
    on: () => undefined,
    removeListener: () => undefined,
    query: (text: string, values?: readonly unknown[]) => {
      // An audit row is named by its action, so the order of two rows can be read.
      const line =
        text.includes('audit_event') || text.includes('audit_unscoped')
          ? `${text.includes('audit_unscoped') ? 'UNSCOPED AUDIT' : 'AUDIT'} ${String(values?.[2])}`
          : text;
      statements.push(line);
      return failing.includes(line)
        ? Promise.reject(new Error(`${line} failed`))
        : Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, statements };
}

const BY_A_MEMBER = {
  actorType: 'operator',
  actorId: 'a-member-id',
  objectType: 'folder',
  objectId: 'a-folder-id',
  result: 'success',
} as const;
const CREATED = {
  ...BY_A_MEMBER,
  action: 'folder.create',
  detail: null,
} as const satisfies AuditInput;
const UPDATED = {
  ...BY_A_MEMBER,
  action: 'folder.update',
  detail: { fields: ['name'] },
} as const satisfies AuditInput;
const DELETED = {
  ...BY_A_MEMBER,
  action: 'folder.delete',
  detail: { movedToRoot: 0 },
} as const satisfies AuditInput;
const PAIRING_CREATED = {
  actorType: 'anonymous',
  actorId: null,
  action: 'pairing.create',
  objectType: 'pairing_session',
  objectId: 'a-pairing-id',
  result: 'success',
  detail: null,
} as const satisfies AuditInput;

const STATED_IN = 'the row of POST /api/folders in ROUTE_PERMISSIONS (fixture)';
/** A permit as the role guard issues it: a re-check that reads the role, and the route's row. */
const permitFor = (
  stated: StatedAudit,
  recheck: PermitTerms<string>['recheck'] = async (tx) => {
    await tx.query('ROLE RE-CHECK');
    return 'editor';
  },
): WritePermit<string> => issueWritePermit({ recheck, stated, statedIn: STATED_IN });
const FOLDER_WRITES = permitFor({ actions: ['folder.create', 'folder.update'] });

describe('changeOrg (AG-3.1, SCR-34)', () => {
  it('re-checks first, runs the change, writes the audit row it returned, then commits', async () => {
    const { pool, statements } = fakePool();
    const value = await changeOrg(pool, ORG, FOLDER_WRITES, async (tx, role) => {
      await tx.query('INSERT FOLDER');
      return { value: `made by an ${role}`, audit: CREATED };
    });
    expect(value).toBe('made by an editor');
    expect(statements).toEqual([
      'BEGIN',
      SET_ORG,
      'ROLE RE-CHECK',
      'INSERT FOLDER',
      'AUDIT folder.create',
      'COMMIT',
    ]);
  });

  it('writes several events in the order they were returned', async () => {
    const { pool, statements } = fakePool();
    await changeOrg(pool, ORG, FOLDER_WRITES, () =>
      Promise.resolve({
        value: undefined,
        audit: [UPDATED, CREATED],
      }),
    );
    expect(statements.slice(3)).toEqual(['AUDIT folder.update', 'AUDIT folder.create', 'COMMIT']);
  });

  it('runs nothing of the change when the re-check refuses, and rolls back', async () => {
    const { pool, statements } = fakePool();
    const refused = permitFor({ actions: ['folder.create'] }, () =>
      Promise.reject(new Error('role taken away')),
    );
    let ran = false;
    await expect(
      changeOrg(pool, ORG, refused, () => {
        ran = true;
        return Promise.resolve({ value: 1, audit: CREATED });
      }),
    ).rejects.toThrow('role taken away');
    expect(ran).toBe(false);
    expect(statements).toEqual(['BEGIN', SET_ORG, 'ROLLBACK']);
  });

  it('rolls the change back when its audit row cannot be written (CX-01)', async () => {
    const { pool, statements } = fakePool(['AUDIT folder.create']);
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await tx.query('INSERT FOLDER');
        return { value: 1, audit: CREATED };
      }),
    ).rejects.toThrow('AUDIT folder.create failed');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('rolls back when the change throws: an audit row is never written for it', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await tx.query('INSERT FOLDER');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(statements).toEqual(['BEGIN', SET_ORG, 'ROLE RE-CHECK', 'INSERT FOLDER', 'ROLLBACK']);
  });

  it('commits a change that says why it records nothing, and writes no audit row', async () => {
    const { pool, statements } = fakePool();
    expect(
      await changeOrg(pool, ORG, FOLDER_WRITES, () =>
        Promise.resolve({ value: 'unchanged', audit: unaudited('read_only') }),
      ),
    ).toBe('unchanged');
    expect(statements).toEqual(['BEGIN', SET_ORG, 'ROLE RE-CHECK', 'COMMIT']);
  });

  it('refuses an empty list of events: nothing says why the change records nothing', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await tx.query('INSERT FOLDER');
        return { value: 1, audit: [] };
      }),
    ).rejects.toThrow(
      'changeOrg: the change returned an empty list of audit events, so nothing says why it records nothing. Return the event of what it changed, or { value, audit: unaudited(reason) } with a reason of NO_AUDIT_REASONS (packages/contracts/src/audit.ts) when it really writes no audit row. Nothing was committed.',
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('refuses unaudited() from a change whose callback wrote an audit row by hand', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await auditScoped(tx, CREATED);
        return { value: 1, audit: unaudited('read_only') };
      }),
    ).rejects.toThrow(
      "changeOrg: the change returned unaudited('read_only'), yet its callback wrote audit rows itself (folder.create). Return those events as { value, audit } and let changeOrg write them, or return no unaudited(...). Nothing was committed.",
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('is refused inside another transaction under its own name (U-3)', async () => {
    const { pool } = fakePool();
    const nested = (): Promise<number> =>
      changeOrg(pool, ORG, FOLDER_WRITES, () => Promise.resolve({ value: 1, audit: CREATED }));
    await expect(withOrg(pool, ORG, () => nested())).rejects.toThrow(
      /^changeOrg was called while a transaction is open on the same asynchronous path/,
    );
    await expect(
      changeOrg(pool, testOrgId('not-a-uuid'), FOLDER_WRITES, () =>
        Promise.resolve({ value: 1, audit: CREATED }),
      ),
    ).rejects.toThrow('changeOrg requires a lower-case UUID organisation id');
  });
});

// Step 17 made every route say what it audits; the permit carries that statement, so the
// wrapper compares it with what the change recorded, on every request, before COMMIT.
describe('what a change records against what its route states (D3)', () => {
  const unstated = (actions: string, states: string): string =>
    `changeOrg: the change recorded ${actions}, which ${STATED_IN} does not state: it states ${states}. Name every action the route writes in that statement, and give a new one its case in tests/integration/audit-failure.test.ts; or correct the event. Nothing was committed.`;

  it('refuses an action the route does not state, and commits nothing', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await tx.query('DELETE FOLDER');
        return { value: 1, audit: [UPDATED, DELETED] };
      }),
    ).rejects.toThrow(unstated('folder.delete', 'folder.create, folder.update'));
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('holds a row the callback wrote by hand to the same statement (the legacy callers)', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await auditScoped(tx, DELETED);
        return { value: 1, audit: legacyAudit() };
      }),
    ).rejects.toThrow(unstated('folder.delete', 'folder.create, folder.update'));
    expect(statements.at(-1)).toBe('ROLLBACK');

    // A stated action written by hand passes, and nothing is written twice.
    const stated = fakePool();
    await changeOrg(stated.pool, ORG, FOLDER_WRITES, async (tx) => {
      await auditScoped(tx, CREATED);
      return { value: 1, audit: legacyAudit() };
    });
    expect(stated.statements.slice(3)).toEqual(['AUDIT folder.create', 'COMMIT']);
    // Nor does the legacy callback have to write one: nothing here can tell.
    const none = fakePool();
    await changeOrg(none.pool, ORG, FOLDER_WRITES, () =>
      Promise.resolve({ value: 1, audit: legacyAudit() }),
    );
    expect(none.statements.at(-1)).toBe('COMMIT');
  });

  it('refuses any audit row on a route that states none', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, permitFor({ none: 'telemetry' }), () =>
        Promise.resolve({ value: 1, audit: CREATED }),
      ),
    ).rejects.toThrow(unstated('folder.create', 'no audit row (telemetry)'));
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('takes the reason the route states, and read_only on any route, and no other', async () => {
    const telemetry = fakePool();
    await changeOrg(telemetry.pool, ORG, permitFor({ none: 'telemetry' }), () =>
      Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
    );
    await changeOrg(telemetry.pool, ORG, permitFor({ none: 'telemetry' }), () =>
      Promise.resolve({ value: 1, audit: unaudited('read_only') }),
    );
    expect(telemetry.statements.filter((text) => text === 'COMMIT')).toHaveLength(2);

    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, () =>
        Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
      ),
    ).rejects.toThrow(
      `changeOrg: the change returned unaudited('telemetry'), but ${STATED_IN} states folder.create, folder.update. Return the audit event of what changed, or unaudited('read_only') when this run changed nothing. Nothing was committed.`,
    );
    await expect(
      changeOrg(pool, ORG, permitFor({ none: 'telemetry' }), () =>
        Promise.resolve({ value: 1, audit: unaudited('login_state') }),
      ),
    ).rejects.toThrow(/unaudited\('login_state'\), but .* states no audit row \(telemetry\)/);
    expect(statements).not.toContain('COMMIT');
  });
});

describe('changePreOrg (AG-3.1)', () => {
  it('writes the event with no organisation when the change entered none', async () => {
    const { pool, statements } = fakePool();
    const value = await changePreOrg(pool, () =>
      Promise.resolve({ value: 'pairing', audit: PAIRING_CREATED }),
    );
    expect(value).toBe('pairing');
    expect(statements).toEqual(['BEGIN', 'UNSCOPED AUDIT pairing.create', 'COMMIT']);
  });

  it('writes the event for the organisation the change entered, on the same transaction', async () => {
    const { pool, statements } = fakePool();
    await changePreOrg(pool, async (_pre, enterOrg) => {
      const tx = await enterOrg(ORG);
      await tx.query('TENANT CHANGE');
      return { value: undefined, audit: CREATED };
    });
    expect(statements).toEqual([
      'BEGIN',
      SET_ORG,
      'TENANT CHANGE',
      'AUDIT folder.create',
      'COMMIT',
    ]);
  });

  it('keeps the same rules: a reason or an event, never both, and a rollback on a throw', async () => {
    const { pool, statements } = fakePool();
    await changePreOrg(pool, () => Promise.resolve({ value: 1, audit: unaudited('login_state') }));
    expect(statements).toEqual(['BEGIN', 'COMMIT']);

    await expect(
      changePreOrg(pool, () => Promise.resolve({ value: 1, audit: [] })),
    ).rejects.toThrow(/^changePreOrg: the change returned an empty list of audit events/);
    await expect(
      changePreOrg(pool, async (pre) => {
        await auditUnscoped(pre, PAIRING_CREATED);
        return { value: 1, audit: unaudited('read_only') };
      }),
    ).rejects.toThrow(/^changePreOrg: the change returned unaudited\('read_only'\), yet/);
    await expect(changePreOrg(pool, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);

    const nested = (): Promise<number> =>
      changePreOrg(pool, () => Promise.resolve({ value: 1, audit: PAIRING_CREATED }));
    await expect(withOrg(pool, ORG, () => nested())).rejects.toThrow(
      /^changePreOrg was called while a transaction is open/,
    );
  });
});

// SCR-34: what the type checker holds. Never called: these lines are for `npm run typecheck`.
describe('a change needs a permit, and a permit comes from the role guard (SCR-34)', () => {
  it('a change cannot be run without a permit', () => {
    const cases = async (pool: Pool, permit: WritePermit<string>): Promise<void> => {
      const change = (): Promise<Change<number>> => Promise.resolve({ value: 1, audit: CREATED });
      await changeOrg(pool, ORG, permit, change);
      // @ts-expect-error a change takes the permit of the role guard: there is no form without
      await changeOrg(pool, ORG, change);
      // @ts-expect-error nor is "no permit" a permit
      await changeOrg(pool, ORG, undefined, change);
      // @ts-expect-error the callback returns { value, audit }: a bare value says nothing of the audit
      await changeOrg(pool, ORG, permit, () => Promise.resolve(1));
      // @ts-expect-error and the audit is an event or unaudited(reason), never left out
      await changeOrg(pool, ORG, permit, () => Promise.resolve({ value: 1 }));
      // @ts-expect-error before the organisation is known the same holds
      await changePreOrg(pool, () => Promise.resolve(1));
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf(changeOrg).parameter(2).toExtend<WritePermit<unknown>>();
  });

  it('a permit cannot be made outside issueWritePermit, which lint keeps to the role guard', () => {
    const recheck = (): Promise<string> => Promise.resolve('editor');
    const cases = async (pool: Pool): Promise<void> => {
      const change = (): Promise<Change<number>> => Promise.resolve({ value: 1, audit: CREATED });
      // @ts-expect-error an empty object is not a permit: the key of its terms is not exported
      await changeOrg(pool, ORG, {}, change);
      // @ts-expect-error nor are the terms themselves, held in a hand-made object
      await changeOrg(pool, ORG, { recheck, stated: { actions: [] }, statedIn: 'nowhere' }, change);
      // @ts-expect-error nor a string key of the same spelling
      await changeOrg(pool, ORG, { terms: { recheck } }, change);
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf<object>().not.toExtend<WritePermit>();
    expectTypeOf<PermitTerms<string>>().not.toExtend<WritePermit<string>>();
  });

  it('refuses at run time a value that was cast to the type, and takes no statement', async () => {
    const { pool, statements } = fakePool();
    const forged = JSON.parse('{}') as never;
    await expect(
      changeOrg(pool, ORG, forged, () => Promise.resolve({ value: 1, audit: CREATED })),
    ).rejects.toThrow(
      'changeOrg requires a WritePermit that the role guard issued: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues the permit and checks the role again first',
    );
    expect(statements).toEqual([]);
  });

  it('the reason of unaudited() is one of the closed list, and only unaudited() makes one', () => {
    expect(unaudited('telemetry')).not.toBe(unaudited('telemetry'));
    // @ts-expect-error a reason is a key of NO_AUDIT_REASONS (packages/contracts/src/audit.ts)
    unaudited('nothing_to_see');
    // @ts-expect-error a string is not a reason given
    const bare: Audit = 'read_only';
    // @ts-expect-error nor an object that spells the reason: the mark is not exported
    const spelled: Unaudited = { unaudited: 'read_only' };
    expect([bare, spelled]).toHaveLength(2);
    expectTypeOf(unaudited).parameter(0).toEqualTypeOf<'read_only' | 'telemetry' | 'login_state'>();
  });

  it('the handle of readOrg cannot be given to a change, nor a change to readOrg', () => {
    const cases = async (pool: Pool, permit: WritePermit<string>): Promise<void> => {
      const write = async (tx: OrgTx): Promise<void> => {
        await tx.query('INSERT FOLDER');
      };
      const read = async (tx: OrgReadTx): Promise<number> =>
        (await tx.query('SELECT 1')).rows.length;
      // @ts-expect-error a helper that takes an OrgTx is not a read: readOrg gives an OrgReadTx
      await readOrg(pool, ORG, write);
      await readOrg(pool, ORG, read);
      // A change may read with the same helper.
      await changeOrg(pool, ORG, permit, async (tx) => ({
        value: await read(tx),
        audit: unaudited('read_only'),
      }));
    };
    expect(cases).toBeTypeOf('function');
  });
});
