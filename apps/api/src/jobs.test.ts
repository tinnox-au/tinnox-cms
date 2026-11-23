/**
 * What the alert check and the media pipeline change (SCR-34; adoption plan step 20): a job has
 * no operator and no credential, so its permit comes from the entry of the jobs, and carries
 * the job's row of JOB_AUDIT. The statements are read off a fake connection; the type cases
 * are checked by `npm run typecheck`. Who may import the entry is lint's
 * (scripts/lib/legacy-transaction-lint.test.ts).
 */
import {
  changeOrg,
  issueAuditStatement,
  unaudited,
  type AuditInput,
  type Change,
  type OrgTx,
  type Pool,
} from '@tinnox/db';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DISPLAY, fakePool, ORG, SET_ORG } from './change.test-support.ts';
import { changeAsJob } from './jobs.ts';
import { JOB_AUDIT, jobStatement, type JobName } from './route-audit.ts';

const BY_THE_SYSTEM = { actorType: 'system', actorId: null, result: 'success' } as const;
const OFFLINE_ALERT = {
  ...BY_THE_SYSTEM,
  action: 'display.offline_alert',
  objectType: 'display',
  objectId: DISPLAY,
  detail: { recipients: 2 },
} as const satisfies AuditInput;
const ONLINE_ALERT = { ...OFFLINE_ALERT, action: 'display.online_alert' } as const;
const VALIDATED = {
  ...BY_THE_SYSTEM,
  action: 'media.validate',
  objectType: 'media',
  objectId: 'a-media-id',
  result: 'failure',
  detail: { errorCode: 'inspection_timeout' },
} as const satisfies AuditInput;

describe('a change by a job on changeOrg (SCR-34)', () => {
  it('runs the change for the organisation and writes the audit rows it returned, in order', async () => {
    const { pool, transactions } = fakePool();
    const claimed = await changeAsJob(pool, 'display_alerts', ORG, async (tx) => {
      await tx.query('CLAIM TRANSITIONS');
      return { value: 2, audit: [OFFLINE_ALERT, ONLINE_ALERT] };
    });
    expect(claimed).toBe(2);
    // No statement between the organisation and the change: a job has no role to read again.
    expect(transactions).toEqual([
      [
        'BEGIN',
        SET_ORG,
        'CLAIM TRANSITIONS',
        'AUDIT display.offline_alert success',
        'AUDIT display.online_alert success',
        'COMMIT',
      ],
    ]);
  });

  it('holds each job to its own row of JOB_AUDIT', async () => {
    const { pool, transactions } = fakePool();
    await changeAsJob(pool, 'media_pipeline', ORG, () =>
      Promise.resolve({ value: 1, audit: VALIDATED }),
    );
    expect(transactions.at(-1)).toEqual([
      'BEGIN',
      SET_ORG,
      'AUDIT media.validate failure',
      'COMMIT',
    ]);

    await expect(
      changeAsJob(pool, 'display_alerts', ORG, async (tx) => {
        await tx.query('UPDATE MEDIA');
        return { value: 1, audit: VALIDATED };
      }),
    ).rejects.toThrow(
      'changeOrg: the change recorded media.validate, which the row of display_alerts in JOB_AUDIT (apps/api/src/route-audit.ts) does not state: it states display.offline_alert, display.online_alert.',
    );
    expect(transactions.at(-1)?.at(-1)).toBe('ROLLBACK');
    await expect(
      changeAsJob(pool, 'media_pipeline', ORG, () =>
        Promise.resolve({ value: 1, audit: OFFLINE_ALERT }),
      ),
    ).rejects.toThrow(
      /^changeOrg: the change recorded display\.offline_alert, which the row of media_pipeline in JOB_AUDIT/,
    );
  });

  it('commits a run that found nothing to do, and takes no reason a job does not state', async () => {
    const { pool, transactions } = fakePool();
    await changeAsJob(pool, 'media_pipeline', ORG, () =>
      Promise.resolve({ value: false, audit: unaudited('nothing_changed') }),
    );
    expect(transactions).toEqual([['BEGIN', SET_ORG, 'COMMIT']]);
    await expect(
      changeAsJob(pool, 'display_alerts', ORG, () =>
        Promise.resolve({ value: 0, audit: unaudited('telemetry') }),
      ),
    ).rejects.toThrow(/unaudited\('telemetry'\), but the row of display_alerts in JOB_AUDIT/);
    await expect(
      changeAsJob(pool, 'display_alerts', ORG, () => Promise.resolve({ value: 0, audit: [] })),
    ).rejects.toThrow(/^changeOrg: the change returned an empty list of audit events/);
  });

  it('lets the alert check alone close an episode without an e-mail and no audit row (step 20 ruling, CMS-36)', async () => {
    const { pool, transactions } = fakePool();
    await changeAsJob(pool, 'display_alerts', ORG, async (tx) => {
      await tx.query('DELETE DISPLAY ALERT');
      return { value: 1, audit: unaudited('alert_closed_silently') };
    });
    expect(transactions).toEqual([['BEGIN', SET_ORG, 'DELETE DISPLAY ALERT', 'COMMIT']]);
    await expect(
      changeAsJob(pool, 'media_pipeline', ORG, () =>
        Promise.resolve({ value: 1, audit: unaudited('alert_closed_silently') }),
      ),
    ).rejects.toThrow(
      "changeOrg: the change returned unaudited('alert_closed_silently'), but the row of media_pipeline in JOB_AUDIT (apps/api/src/route-audit.ts) does not grant it.",
    );
    // Nor does the alert check take the reasons of the pairing routes or the seed.
    for (const reason of ['pairing_expired_by_time', 'development_seed'] as const) {
      await expect(
        changeAsJob(pool, 'display_alerts', ORG, () =>
          Promise.resolve({ value: 1, audit: unaudited(reason) }),
        ),
      ).rejects.toThrow(`unaudited('${reason}'), but the row of display_alerts in JOB_AUDIT`);
    }
  });

  it('refuses a job that has no row, before any statement', async () => {
    const { pool, transactions } = fakePool();
    await expect(
      changeAsJob(pool, 'housekeeping' as never, ORG, () =>
        Promise.resolve({ value: 1, audit: unaudited('nothing_changed') }),
      ),
    ).rejects.toThrow(
      'no job is called housekeeping: a job that changes an organisation gets a row in JOB_AUDIT (apps/api/src/route-audit.ts) with the audit actions it writes, and each action its case in tests/integration/audit-failure.test.ts',
    );
    expect(transactions).toEqual([]);
  });

  it('states for each job the row of JOB_AUDIT, by name', () => {
    expect(Object.keys(JOB_AUDIT).sort()).toEqual(['display_alerts', 'media_pipeline']);
    for (const name of Object.keys(JOB_AUDIT) as JobName[]) {
      // Made by issueAuditStatement, as changePreOrg and changeOrgAsMigrator require (review).
      const row = JOB_AUDIT[name];
      expect(jobStatement(name)).toEqual(
        issueAuditStatement({
          stated: row.audit,
          statedIn: `the row of ${name} in JOB_AUDIT (apps/api/src/route-audit.ts)`,
          // The grants too: the alert check's silent close (step 20 ruling, CMS-36).
          ...('grants' in row ? { grants: row.grants } : {}),
        }),
      );
    }
  });
});

// Never called: these lines are for the type checker.
describe('the permit of a job comes from the entry of the jobs only (SCR-34)', () => {
  it('a job is named, and its change cannot run on changeOrg without the permit', () => {
    const cases = async (pool: Pool): Promise<void> => {
      const change = (tx: OrgTx): Promise<Change<number>> =>
        tx.query('SELECT 1').then(() => ({ value: 1, audit: unaudited('nothing_changed') }));
      await changeAsJob(pool, 'display_alerts', ORG, change);
      // @ts-expect-error a job that changes an organisation has a row in JOB_AUDIT, and this has none
      await changeAsJob(pool, 'housekeeping', ORG, change);
      // @ts-expect-error a change by a job says which job: there is no form without its name
      await changeAsJob(pool, ORG, change);
      // @ts-expect-error changeOrg takes a permit, and a job file has none to give
      await changeOrg(pool, ORG, change);
      // @ts-expect-error the name of a job is not a permit
      await changeOrg(pool, ORG, 'display_alerts', change);
      // @ts-expect-error nor is its statement: only the entry of the jobs issues the permit
      await changeOrg(pool, ORG, jobStatement('display_alerts'), change);
      // @ts-expect-error a job changes { value, audit }, not a bare value
      await changeAsJob(pool, 'media_pipeline', ORG, () => Promise.resolve(1));
    };
    expect(cases).toBeTypeOf('function');
    expectTypeOf(changeAsJob).parameter(1).toEqualTypeOf<'display_alerts' | 'media_pipeline'>();
  });
});
