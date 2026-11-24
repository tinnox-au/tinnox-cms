/**
 * changeOrg and changePreOrg (adoption plan section 2.1 B, steps 19 and 20; AG-3.1, SCR-34): the
 * audit rows a change returns are written on its transaction before COMMIT, a change runs only
 * with a permit, and what it recorded is held to what its route states, before the organisation
 * is known too. The statements are read off a fake connection; the database's half is in
 * packages/db/test/change.integration.test.ts. The type cases are checked by
 * `npm run typecheck`, which reads this file: an unused @ts-expect-error is an error there.
 */
import type { GrantedUnauditedReason } from '@tinnox/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  changeOrg,
  changePreOrg,
  issueAuditStatement,
  issueWritePermit,
  readOrg,
  termsOfStatement,
  unaudited,
  type Audit,
  type AuditInput,
  type AuditStatement,
  type Change,
  type OrgReadTx,
  type OrgTx,
  type PermitTerms,
  type Pool,
  type StatedAudit,
  type Unaudited,
  type WritePermit,
} from './index.ts';
import { asDefiner, auditedInSql, changeOrgAsMigrator, type MigratorPool } from './migrate.ts';
// What the change API is built on, which the runtime entry does not export (step 20).
import { auditScoped, auditUnscoped, testOrgId, withOrg } from './testing.ts';

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
        Promise.resolve({ value: 'unchanged', audit: unaudited('nothing_changed') }),
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
      'changeOrg: the change returned an empty list of audit events, so nothing says why it records nothing. Return the event of what it changed, or { value, audit: unaudited(reason) } with a reason of UNAUDITED_REASONS (packages/contracts/src/audit.ts) when it really writes no audit row. Nothing was committed.',
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('refuses unaudited() from a change whose callback wrote an audit row by hand', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await auditScoped(tx, CREATED);
        return { value: 1, audit: unaudited('nothing_changed') };
      }),
    ).rejects.toThrow(
      "changeOrg: the change returned unaudited('nothing_changed'), yet its callback wrote audit rows itself (folder.create). Return those events as { value, audit } and let changeOrg write them, or return no unaudited(...). Nothing was committed.",
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

  it('holds a row the callback wrote by hand to the same statement as the rows it returned', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, async (tx) => {
        await auditScoped(tx, DELETED);
        return { value: 1, audit: CREATED };
      }),
    ).rejects.toThrow(unstated('folder.delete', 'folder.create, folder.update'));
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
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

  // Adoption plan step 20: UNAUDITED_REASONS and NO_AUDIT_REASONS, and how the two relate.
  it('takes what one run found under any statement: nothing changed, a replay', async () => {
    const { pool, statements } = fakePool();
    for (const stated of [
      { actions: ['folder.create'] },
      { none: 'telemetry' },
      { none: 'read_only' },
    ] as const satisfies readonly StatedAudit[]) {
      for (const reason of ['nothing_changed', 'idempotent_replay'] as const) {
        await changeOrg(pool, ORG, permitFor(stated), () =>
          Promise.resolve({ value: 1, audit: unaudited(reason) }),
        );
      }
    }
    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(6);
    expect(statements).not.toContain('ROLLBACK');
  });

  it('takes an uncounted attempt only where the statement grants it (D3, step 20 review)', async () => {
    // The pairing poll counts a wrong polling token under its limit and audits none: a write
    // left unaudited on purpose, so it is the route's to grant, not any change's to claim.
    const granted = fakePool();
    await changeOrg(
      granted.pool,
      ORG,
      issueWritePermit({
        recheck: () => Promise.resolve(),
        stated: { actions: ['pairing.complete', 'pairing.lock'] },
        statedIn: 'the entry of GET /player/pairing/:id in OTHER_ROUTE_AUDIT (fixture)',
        grants: ['counter_under_threshold'],
      }),
      () => Promise.resolve({ value: 1, audit: unaudited('counter_under_threshold') }),
    );
    expect(granted.statements.at(-1)).toBe('COMMIT');

    const { pool, statements } = fakePool();
    for (const stated of [
      { actions: ['folder.create', 'folder.update'] },
      { none: 'telemetry' },
    ] as const satisfies readonly StatedAudit[]) {
      await expect(
        changeOrg(pool, ORG, permitFor(stated), () =>
          Promise.resolve({ value: 1, audit: unaudited('counter_under_threshold') }),
        ),
      ).rejects.toThrow(
        `changeOrg: the change returned unaudited('counter_under_threshold'), but ${STATED_IN} does not grant it. 'counter_under_threshold' leaves a write unaudited on purpose, which only the route, job or tool that makes that write may do: its entry in OTHER_ROUTE_AUDIT or its row of JOB_AUDIT (apps/api/src/route-audit.ts) grants the reason, and for development_seed changeOrgAsMigrator grants it to seedStatement() of @tinnox/db/migrate alone (D3; UNAUDITED_REASONS in packages/contracts/src/audit.ts says who makes each). Return the audit event of what changed, or unaudited('nothing_changed') when this run changed nothing. Nothing was committed.`,
      );
    }
    expect(statements).not.toContain('COMMIT');
  });

  it('takes the three writes the step 20 ruling leaves unaudited only where each is granted (DEC-38, CMS-36)', async () => {
    // Today's behaviour, named: the alert check's silent close, the pairing expiry mark and the
    // seed. Each is the grant of the one job, routes or tool that makes the write.
    for (const [reason, statedIn, stated] of [
      [
        'alert_closed_silently',
        'the row of display_alerts in JOB_AUDIT (fixture)',
        { actions: ['display.offline_alert', 'display.online_alert'] },
      ],
      [
        'pairing_expired_by_time',
        'the entry of GET /player/pairing/:id in OTHER_ROUTE_AUDIT (fixture)',
        { actions: ['pairing.complete', 'pairing.lock'] },
      ],
      ['development_seed', 'the development seed (fixture)', { actions: [] }],
    ] as const) {
      const granted = fakePool();
      await changeOrg(
        granted.pool,
        ORG,
        issueWritePermit({ recheck: () => Promise.resolve(), stated, statedIn, grants: [reason] }),
        () => Promise.resolve({ value: 1, audit: unaudited(reason) }),
      );
      expect(granted.statements.at(-1), reason).toBe('COMMIT');

      // The same statement without the grant, and a grant of another reason, are refused.
      const { pool, statements } = fakePool();
      for (const grants of [[], ['counter_under_threshold']] as const) {
        await expect(
          changeOrg(
            pool,
            ORG,
            issueWritePermit({ recheck: () => Promise.resolve(), stated, statedIn, grants }),
            () => Promise.resolve({ value: 1, audit: unaudited(reason) }),
          ),
        ).rejects.toThrow(
          `changeOrg: the change returned unaudited('${reason}'), but ${statedIn} does not grant it.`,
        );
      }
      await expect(
        changeOrg(pool, ORG, FOLDER_WRITES, () =>
          Promise.resolve({ value: 1, audit: unaudited(reason) }),
        ),
      ).rejects.toThrow(`but ${STATED_IN} does not grant it`);
      expect(statements, reason).not.toContain('COMMIT');
    }
  });

  it('lets no table grant development_seed: only changeOrgAsMigrator gives it, to seedStatement() (step 20)', () => {
    // A provisioning command, a route or a job makes its statement here, so none can give the
    // seed's reason, whatever its table says; the type refuses it, and the call for a caller the
    // type checker did not read.
    const terms = { stated: { actions: [] }, statedIn: 'the audits of a command (fixture)' };
    expect(() =>
      // @ts-expect-error development_seed is granted by no table.
      issueAuditStatement({ ...terms, grants: ['development_seed'] }),
    ).toThrow(
      "issueAuditStatement: the audits of a command (fixture) grants development_seed, which no table may grant. Only the development seed (scripts/seed.ts) writes rows with no audit row under it, through changeOrgAsMigrator(pool, orgId, seedStatement(), fn) of @tinnox/db/migrate, which grants it to that statement alone. A route, a job or a provisioning command returns the audit events of what it changed, or unaudited('nothing_changed') when a run changed nothing.",
    );
    const widened: readonly GrantedUnauditedReason[] = [
      'counter_under_threshold',
      'development_seed',
    ];
    expect(() => issueAuditStatement({ ...terms, grants: widened as never })).toThrow(
      /grants development_seed, which no table may grant/,
    );
    // The other granted reasons stay the tables' to give.
    expect(
      termsOfStatement(
        'test',
        issueAuditStatement({ ...terms, grants: ['counter_under_threshold'] }),
      ).grants,
    ).toEqual(['counter_under_threshold']);
  });

  it('names a statement with no action as such, not as an empty list (step 20 review)', async () => {
    const { pool } = fakePool();
    await expect(
      changeOrg(pool, ORG, permitFor({ actions: [] }), () =>
        Promise.resolve({ value: 1, audit: CREATED }),
      ),
    ).rejects.toThrow(
      `changeOrg: the change recorded folder.create, which ${STATED_IN} does not state: it states no action at all. Name every action`,
    );
  });

  it('takes telemetry only where the route states telemetry (the reason of both lists)', async () => {
    const telemetry = fakePool();
    await changeOrg(telemetry.pool, ORG, permitFor({ none: 'telemetry' }), () =>
      Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
    );
    expect(telemetry.statements.at(-1)).toBe('COMMIT');

    const { pool, statements } = fakePool();
    await expect(
      changeOrg(pool, ORG, FOLDER_WRITES, () =>
        Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
      ),
    ).rejects.toThrow(
      `changeOrg: the change returned unaudited('telemetry'), but ${STATED_IN} states folder.create, folder.update. 'telemetry' says what the route stores on every request, so its statement has to give the same reason. Return the audit event of what changed, or unaudited('nothing_changed') when this run changed nothing. Nothing was committed.`,
    );
    await expect(
      changeOrg(pool, ORG, permitFor({ none: 'login_state' }), () =>
        Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
      ),
    ).rejects.toThrow(/unaudited\('telemetry'\), but .* states no audit row \(login_state\)/);
    expect(statements).not.toContain('COMMIT');
  });
});

const NOT_ISSUED =
  'requires the audit statement of its route or command, as the table that holds it gives it: a route outside the operator table passes routeStatement(request) (apps/api/src/route-audit.ts), its entry in OTHER_ROUTE_AUDIT; a provisioning command passes provisionStatement(command) (scripts/lib/provision.ts), the audits of its row in PROVISION_COMMANDS. A statement written in place is not one';

/** What a route outside the operator table says it audits, as its entry in OTHER_ROUTE_AUDIT. */
const statementOf = (stated: StatedAudit, route: string): AuditStatement =>
  issueAuditStatement({ stated, statedIn: `the entry of ${route} in OTHER_ROUTE_AUDIT (fixture)` });
const PAIRING = statementOf({ actions: ['pairing.create'] }, 'POST /player/pairing');
const FOLDERS = statementOf({ actions: ['folder.create'] }, 'POST /fixture/folders');

describe('changePreOrg (AG-3.1)', () => {
  it('writes the event with no organisation when the change entered none', async () => {
    const { pool, statements } = fakePool();
    const value = await changePreOrg(pool, PAIRING, () =>
      Promise.resolve({ value: 'pairing', audit: PAIRING_CREATED }),
    );
    expect(value).toBe('pairing');
    expect(statements).toEqual(['BEGIN', 'UNSCOPED AUDIT pairing.create', 'COMMIT']);
  });

  it('writes the event for the organisation the change entered, on the same transaction', async () => {
    const { pool, statements } = fakePool();
    await changePreOrg(pool, FOLDERS, async (_pre, enterOrg) => {
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
    await changePreOrg(pool, PAIRING, () =>
      Promise.resolve({ value: 1, audit: unaudited('nothing_changed') }),
    );
    expect(statements).toEqual(['BEGIN', 'COMMIT']);

    await expect(
      changePreOrg(pool, PAIRING, () => Promise.resolve({ value: 1, audit: [] })),
    ).rejects.toThrow(/^changePreOrg: the change returned an empty list of audit events/);
    await expect(
      changePreOrg(pool, PAIRING, async (pre) => {
        await auditUnscoped(pre, PAIRING_CREATED);
        return { value: 1, audit: unaudited('nothing_changed') };
      }),
    ).rejects.toThrow(/^changePreOrg: the change returned unaudited\('nothing_changed'\), yet/);
    await expect(
      changePreOrg(pool, PAIRING, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(1);

    const nested = (): Promise<number> =>
      changePreOrg(pool, PAIRING, () => Promise.resolve({ value: 1, audit: PAIRING_CREATED }));
    await expect(withOrg(pool, ORG, () => nested())).rejects.toThrow(
      /^changePreOrg was called while a transaction is open/,
    );
  });

  // Adoption plan step 20: the sign-in, sign-out, confirmation and pairing routes are held to
  // their entry in OTHER_ROUTE_AUDIT at run time, as an operator write is to its row.
  it('refuses an action its route does not state, written with or without an organisation', async () => {
    const unscoped = fakePool();
    await expect(
      changePreOrg(unscoped.pool, statementOf({ actions: ['pairing.lock'] }, 'GET /fixture'), () =>
        Promise.resolve({ value: 1, audit: PAIRING_CREATED }),
      ),
    ).rejects.toThrow(
      'changePreOrg: the change recorded pairing.create, which the entry of GET /fixture in OTHER_ROUTE_AUDIT (fixture) does not state: it states pairing.lock. Name every action the route writes in that statement, and give a new one its case in tests/integration/audit-failure.test.ts; or correct the event. Nothing was committed.',
    );
    expect(unscoped.statements).toEqual(['BEGIN', 'UNSCOPED AUDIT pairing.create', 'ROLLBACK']);

    const scoped = fakePool();
    await expect(
      changePreOrg(scoped.pool, PAIRING, async (_pre, enterOrg) => {
        const tx = await enterOrg(ORG);
        await tx.query('TENANT CHANGE');
        return { value: 1, audit: [CREATED] };
      }),
    ).rejects.toThrow(/^changePreOrg: the change recorded folder\.create, which .* does not state/);
    expect(scoped.statements.at(-1)).toBe('ROLLBACK');
    expect(scoped.statements).not.toContain('COMMIT');
  });

  it('holds a row the callback wrote by hand, and a reason, to the same statement', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changePreOrg(pool, statementOf({ none: 'login_state' }, 'GET /fixture'), async (pre) => {
        await auditUnscoped(pre, PAIRING_CREATED);
        return { value: 1, audit: PAIRING_CREATED };
      }),
    ).rejects.toThrow(
      /^changePreOrg: the change recorded pairing\.create, which .* states no audit row \(login_state\)\./,
    );
    await expect(
      changePreOrg(pool, PAIRING, () =>
        Promise.resolve({ value: 1, audit: unaudited('telemetry') }),
      ),
    ).rejects.toThrow(
      /^changePreOrg: the change returned unaudited\('telemetry'\), but the entry of POST \/player\/pairing in OTHER_ROUTE_AUDIT \(fixture\) states pairing\.create\./,
    );
    // A counted attempt under the limit, on a route that does not grant it (step 20 review).
    await expect(
      changePreOrg(pool, PAIRING, () =>
        Promise.resolve({ value: 1, audit: unaudited('counter_under_threshold') }),
      ),
    ).rejects.toThrow(
      /^changePreOrg: the change returned unaudited\('counter_under_threshold'\), but the entry of POST \/player\/pairing in OTHER_ROUTE_AUDIT \(fixture\) does not grant it\./,
    );
    expect(statements).not.toContain('COMMIT');

    // The pairing poll grants it: a wrong polling token under the limit is counted, not audited.
    const poll = fakePool();
    await changePreOrg(
      poll.pool,
      issueAuditStatement({
        stated: { actions: ['pairing.complete', 'pairing.lock'] },
        statedIn: 'the entry of GET /player/pairing/:id in OTHER_ROUTE_AUDIT (fixture)',
        grants: ['counter_under_threshold'],
      }),
      () => Promise.resolve({ value: 1, audit: unaudited('counter_under_threshold') }),
    );
    expect(poll.statements).toEqual(['BEGIN', 'COMMIT']);
  });

  it('refuses to run with no statement, before any statement is sent', async () => {
    const { pool, statements } = fakePool();
    const withoutStatement = (() => Promise.resolve({ value: 1, audit: PAIRING_CREATED })) as never;
    await expect(
      changePreOrg(pool, withoutStatement, () =>
        Promise.resolve({ value: 1, audit: PAIRING_CREATED }),
      ),
    ).rejects.toThrow(`changePreOrg ${NOT_ISSUED}`);
    expect(statements).toEqual([]);
  });

  it('refuses a statement written in place, which no table gave (step 20 review)', async () => {
    const { pool, statements } = fakePool();
    // What a route could otherwise hold itself to: any actions it likes.
    const written = { stated: { actions: ['pairing.create'] }, statedIn: 'x' } as never;
    await expect(
      changePreOrg(pool, written, () => Promise.resolve({ value: 1, audit: PAIRING_CREATED })),
    ).rejects.toThrow(`changePreOrg ${NOT_ISSUED}`);
    expect(statements).toEqual([]);
  });

  it('holds a spread of a statement to the statement it copied, not to the keys beside it (step 20 review)', async () => {
    const { pool, statements } = fakePool();
    // What a route could otherwise do with the statement its table gave: widen it in place.
    const widened = { ...PAIRING, stated: { actions: ['folder.create'] }, statedIn: 'x' };
    await expect(
      changePreOrg(pool, widened, async (_pre, enterOrg) => {
        await enterOrg(ORG);
        return { value: 1, audit: CREATED };
      }),
    ).rejects.toThrow(
      'changePreOrg: the change recorded folder.create, which the entry of POST /player/pairing in OTHER_ROUTE_AUDIT (fixture) does not state: it states pairing.create.',
    );
    expect(statements).not.toContain('COMMIT');

    // The terms are the ones the table gave, and they cannot be changed afterwards either.
    const cases = (): void => {
      // @ts-expect-error a key written beside the spread is not a term of the statement
      const written: AuditStatement = { ...PAIRING, stated: { actions: ['folder.create'] } };
      expect(written).toBeDefined();
    };
    expect(cases).toBeTypeOf('function');
    expect(Object.isFrozen(PAIRING)).toBe(true);
    expect(Object.isFrozen(termsOfStatement('a test', PAIRING))).toBe(true);
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
      await changePreOrg(pool, PAIRING, () => Promise.resolve(1));
      // @ts-expect-error and there the route's statement stands where the permit does: no form without
      await changePreOrg(pool, () => Promise.resolve({ value: 1, audit: PAIRING_CREATED }));
      // @ts-expect-error nor one the caller wrote in place: only a table's helper makes one (step 20 review)
      await changePreOrg(pool, { stated: { actions: ['pairing.create'] }, statedIn: 'x' }, () =>
        Promise.resolve({ value: 1, audit: PAIRING_CREATED }),
      );
      // @ts-expect-error a bare list of actions says nothing of where it is written
      await changePreOrg(pool, { actions: ['pairing.create'] }, change);
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
      'changeOrg requires a WritePermit that the role guard issued: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues the permit and checks the role again first. A change with no operator behind it gets its permit the same way, from what judged it: changeAsDevice (apps/api/src/auth/device.ts), changeAsJob (apps/api/src/jobs.ts), or changeOrgAsMigrator of @tinnox/db/migrate for an offline tool',
    );
    expect(statements).toEqual([]);
  });

  it('the reason of unaudited() is one of the closed list, and only unaudited() makes one', () => {
    expect(unaudited('telemetry')).not.toBe(unaudited('telemetry'));
    // @ts-expect-error a reason is a key of UNAUDITED_REASONS (packages/contracts/src/audit.ts)
    unaudited('nothing_to_see');
    // @ts-expect-error a change is not a read: a route that only reads opens readOrg
    unaudited('read_only');
    // @ts-expect-error the login state is stored outside any change, by the Autocommit wrappers (D2)
    unaudited('login_state');
    // @ts-expect-error a string is not a reason given
    const bare: Audit = 'nothing_changed';
    // @ts-expect-error nor an object that spells the reason: the mark is not exported
    const spelled: Unaudited = { unaudited: 'nothing_changed' };
    expect([bare, spelled]).toHaveLength(2);
    expectTypeOf(unaudited)
      .parameter(0)
      .toEqualTypeOf<
        | 'nothing_changed'
        | 'idempotent_replay'
        | 'telemetry'
        | 'counter_under_threshold'
        | 'alert_closed_silently'
        | 'pairing_expired_by_time'
        | 'development_seed'
      >();
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
        audit: unaudited('nothing_changed'),
      }));
    };
    expect(cases).toBeTypeOf('function');
  });
});

// Adoption plan step 20: an offline tool has no operator, and its permit comes from the
// migrator's connection. The database's half is in packages/db/test/change.integration.test.ts,
// where connectMigrator gives a real MigratorPool.
describe('a change by an offline tool needs the migrator connection (SCR-34)', () => {
  const PROVISIONING = issueAuditStatement({
    stated: { actions: ['membership.create'] },
    statedIn: 'the audits of org-create in PROVISION_COMMANDS (fixture)',
  });

  it('takes a MigratorPool, and no other pool', () => {
    const cases = async (pool: Pool, migrator: MigratorPool): Promise<void> => {
      const change = (): Promise<Change<number>> => Promise.resolve({ value: 1, audit: CREATED });
      await changeOrgAsMigrator(migrator, ORG, PROVISIONING, change);
      // @ts-expect-error the runtime pool is not the migrator's: connectMigrator checks the role
      await changeOrgAsMigrator(pool, ORG, PROVISIONING, change);
      // @ts-expect-error and the tool says what it audits: there is no form without the statement
      await changeOrgAsMigrator(migrator, ORG, change);
      // @ts-expect-error nor with one written in place: provisionStatement(command) reads its row
      await changeOrgAsMigrator(migrator, ORG, { stated: { actions: [] }, statedIn: 'x' }, change);
      // @ts-expect-error a MigratorPool is the proof for changeOrgAsMigrator, not a permit for changeOrg
      await changeOrg(migrator, ORG, migrator, change);
      // @ts-expect-error nor does changeOrg run for an offline tool without one
      await changeOrg(migrator, ORG, change);
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf(changeOrgAsMigrator).parameter(0).toEqualTypeOf<MigratorPool>();
    expectTypeOf<Pool>().not.toExtend<MigratorPool>();
  });

  it('refuses at run time a pool that connectMigrator did not return, and sends nothing', async () => {
    const { pool, statements } = fakePool();
    await expect(
      changeOrgAsMigrator(pool as never, ORG, PROVISIONING, () =>
        Promise.resolve({ value: 1, audit: CREATED }),
      ),
    ).rejects.toThrow(
      'changeOrgAsMigrator requires the pool that connectMigrator returned: call connectMigrator(connectionString, { applicationName }) from @tinnox/db/migrate and pass that pool. The API has no migrator connection: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts)',
    );
    expect(statements).toEqual([]);
  });
});

// Adoption plan step 20, D25: provisioning's `pending` expires invites and writes their audit
// rows in one statement, so its change returns the answer to that statement in place of events.
// The database's half is in packages/db/test/change.integration.test.ts.
describe("the audit rows a change's own statement wrote (D25)", () => {
  const EXPIRY =
    "WITH closed AS (UPDATE public.member_invite SET status = 'expired' RETURNING id, org_id) INSERT INTO public.audit_event (org_id, action, object_id) SELECT org_id, 'invite.cancel', id FROM closed";
  const PENDING = issueAuditStatement({
    stated: { actions: ['invite.cancel'] },
    statedIn: 'the audits of pending in PROVISION_COMMANDS (fixture)',
  });

  /** A pool whose connection answers each statement with a command tag, as the server does. */
  function answering(tags: Readonly<Record<string, { command: string; rowCount: number }>>) {
    const statements: string[] = [];
    const client = {
      on: () => undefined,
      removeListener: () => undefined,
      query: (text: string) => {
        statements.push(text);
        return Promise.resolve({ rows: [], command: 'SELECT', rowCount: 0, ...tags[text] });
      },
      release: () => undefined,
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
    return { pool, statements };
  }

  /** `pending` as provisioning runs it: the expiry as the definer, then what it answered. */
  const expire = (pool: Pool, statement: AuditStatement = PENDING): Promise<number | null> =>
    changePreOrg(pool, statement, async (pre) => {
      const expired = await asDefiner(pool as never, pre, (definer) => definer.query(EXPIRY));
      return { value: expired.rowCount, audit: auditedInSql(expired, 'invite.cancel') };
    });

  it('commits with the rows the statement wrote, and writes none of its own', async () => {
    const { pool, statements } = answering({ [EXPIRY]: { command: 'INSERT', rowCount: 2 } });
    expect(await expire(pool)).toBe(2);
    expect(statements).toEqual([
      'BEGIN',
      'SET LOCAL ROLE tinnox_definer',
      EXPIRY,
      'RESET ROLE',
      'COMMIT',
    ]);
  });

  it('is taken by changeOrg too, for the transaction of the handle the definer was given', async () => {
    const { pool, statements } = answering({ [EXPIRY]: { command: 'INSERT', rowCount: 1 } });
    const permit = issueWritePermit({
      recheck: () => Promise.resolve(),
      stated: { actions: ['invite.cancel'] },
      statedIn: STATED_IN,
    });
    await changeOrg(pool, ORG, permit, async (tx) => {
      const expired = await asDefiner(pool as never, tx, (definer) => definer.query(EXPIRY));
      return { value: undefined, audit: auditedInSql(expired, 'invite.cancel') };
    });
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.filter((text) => text.includes('audit_event'))).toEqual([EXPIRY]);
  });

  it('refuses a statement that wrote no audit row, and commits nothing', async () => {
    const { pool, statements } = answering({ [EXPIRY]: { command: 'INSERT', rowCount: 0 } });
    await expect(expire(pool)).rejects.toThrow(
      "changePreOrg: the change returned auditedInSql(result, 'invite.cancel'), but that statement wrote no audit row: the database counted 0 inserted. A run that found nothing to change returns { value, audit: unaudited('nothing_changed') }; a change whose statement does not write its own audit rows returns its events as { value, audit }. Nothing was committed.",
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('goes by what the database answered, not by the result the caller holds', async () => {
    const { pool, statements } = answering({ [EXPIRY]: { command: 'INSERT', rowCount: 0 } });
    await expect(
      changePreOrg(pool, PENDING, async (pre) => {
        const expired = await asDefiner(pool as never, pre, (definer) => definer.query(EXPIRY));
        expired.rowCount = 3;
        return { value: undefined, audit: auditedInSql(expired, 'invite.cancel') };
      }),
    ).rejects.toThrow(/that statement wrote no audit row: the database counted 0 inserted/);
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('refuses it under a command that does not name the action', async () => {
    const { pool, statements } = answering({ [EXPIRY]: { command: 'INSERT', rowCount: 2 } });
    const fulfil = issueAuditStatement({
      stated: { actions: ['membership.create'] },
      statedIn: 'the audits of fulfil in PROVISION_COMMANDS (fixture)',
    });
    await expect(expire(pool, fulfil)).rejects.toThrow(
      /^changePreOrg: the change recorded invite\.cancel, which the audits of fulfil in PROVISION_COMMANDS \(fixture\) does not state: it states membership\.create\./,
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('refuses the answer to a statement that ran on another transaction', async () => {
    const { pool, statements } = answering({ [EXPIRY]: { command: 'INSERT', rowCount: 2 } });
    const earlier = await changePreOrg(pool, PENDING, async (pre) => {
      const expired = await asDefiner(pool as never, pre, (definer) => definer.query(EXPIRY));
      const audit = auditedInSql(expired, 'invite.cancel');
      return { value: audit, audit };
    });
    statements.length = 0;
    await expect(
      changePreOrg(pool, PENDING, () => Promise.resolve({ value: undefined, audit: earlier })),
    ).rejects.toThrow(
      /^changePreOrg: the change returned auditedInSql\(result, 'invite\.cancel'\) for a statement that ran on another transaction, so its audit rows are not this change's\./,
    );
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('is made only from the result a definer handle gave back, of an INSERT into audit_event that carries the action', async () => {
    const OTHER_TABLE = "INSERT INTO public.folder (name) VALUES ('invite.cancel')";
    const OTHER_ACTION = EXPIRY.replace("'invite.cancel'", "'invite.create'");
    const { pool } = answering({
      [EXPIRY]: { command: 'INSERT', rowCount: 2 },
      [OTHER_TABLE]: { command: 'INSERT', rowCount: 1 },
      [OTHER_ACTION]: { command: 'INSERT', rowCount: 1 },
      // The text of an insert, answered as something else.
      [`${EXPIRY} -- `]: { command: 'UPDATE', rowCount: 2 },
    });
    const NOT_SENT =
      'auditedInSql takes the result of the statement that wrote the audit rows, as definer.query returned it inside asDefiner(pool, tx, work): pass that result itself, not a copy and not the result of another handle. A change whose audit rows no statement of its own writes returns its events as { value, audit } and lets the wrapper write them';
    const NOT_AN_AUDIT_INSERT =
      /^auditedInSql\('invite\.cancel'\): the statement of this result does not write audit rows of invite\.cancel\. It must be an INSERT that names public\.audit_event as its target and carries 'invite\.cancel' as a literal \(the database answered (INSERT|UPDATE|SELECT)\)\./;
    await changePreOrg(pool, PENDING, async (pre) => {
      await asDefiner(pool as never, pre, async (definer) => {
        const expired = await definer.query(EXPIRY);
        expect(() => auditedInSql({ ...expired }, 'invite.cancel')).toThrow(NOT_SENT);
        for (const text of ['SELECT 1', OTHER_TABLE, OTHER_ACTION, `${EXPIRY} -- `]) {
          const result = await definer.query(text);
          expect(() => auditedInSql(result, 'invite.cancel'), text).toThrow(NOT_AN_AUDIT_INSERT);
        }
      });
      return { value: undefined, audit: unaudited('nothing_changed') };
    });
  });

  it('does not type-check as something the runtime entry makes: no event, no reason', () => {
    const cases = (audit: ReturnType<typeof auditedInSql>): void => {
      const taken: Audit = audit;
      // @ts-expect-error it is not an event: the wrapper writes nothing for it
      const event: AuditInput = audit;
      // @ts-expect-error nor a reason: rows were written
      const reason: Unaudited = audit;
      expect([taken, event, reason]).toHaveLength(3);
    };
    expect(cases).toBeTypeOf('function');
  });
});
