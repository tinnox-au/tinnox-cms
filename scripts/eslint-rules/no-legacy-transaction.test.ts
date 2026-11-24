// AG-3.1, SCR-34 (adoption plan steps 19 and 20): the legacy-transaction rule against fixture
// code. It reads names only, so one tester without type information is enough. The messages are
// pinned word for word (D16): they are what an author reads, and they must name what to use
// instead.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './no-legacy-transaction.ts';

// ESLint looks for global describe and it, which the unit project does not define. itOnly stays
// unset: a focused case is a red run (U-15).
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const REMEDY =
  'Use readOrg(ctx.db, orgId, fn) for reads and changeOrg(ctx.db, orgId, permit, fn) returning { value, audit } for changes; the permit comes from the role guard: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues it and checks the role again first. A change with no operator behind it gets its permit the same way: a player route calls changeAsDevice(ctx, request, device, fn) (apps/api/src/auth/device.ts), a job changeAsJob(db, job, orgId, fn) (apps/api/src/jobs.ts), an offline tool changeOrgAsMigrator(pool, orgId, statement, fn) (@tinnox/db/migrate), and a refusal that changed nothing is written with recordRefusal(ctx, request, session, event) (apps/api/src/auth/refusal.ts). Before the organisation is known, use changePreOrg(ctx.db, statement, fn), in the files of PRE_ORG_CHANGE_FILES (eslint.config.js) only. The wrapper writes the audit rows you return on the transaction of the change; a change that records nothing returns unaudited(reason) (all from @tinnox/db). The legacy names are for packages/db/src, which builds the new API on them, and for tests (@tinnox/db/testing).';
const OPENS = 'opens a transaction that anything may be written on, with no role check';
const BY_HAND = 'writes an audit row by hand, on whatever transaction it is given';
const legacy = (name: string, what: string) => ({
  message: `${name} is the legacy transaction API: it ${what}. ${REMEDY}`,
});

describe('no-legacy-transaction (AG-3.1, SCR-34)', { timeout: 30_000 }, () => {
  tester.run('no-legacy-transaction', rule, {
    valid: [
      {
        name: 'the new API: a read, a change with its audit, and a change before the organisation',
        code: `
          import { changeOrg, changePreOrg, readOrg, unaudited, type OrgReadTx, type OrgTx } from '@tinnox/db';
          import { changeAsOperator } from '../auth/permissions.ts';
          await readOrg(pool, session.orgId, (tx) => tx.query('SELECT 1'));
          await changeAsOperator(ctx, request, async (tx) => ({ value: await save(tx), audit: event }));
          await changePreOrg(pool, routeStatement(request), async (pre) => ({ value: 1, audit: unaudited('nothing_changed') }));
        `,
      },
      {
        name: 'the changes with no operator behind them, and a refusal recorded on its own (step 20)',
        code: `
          import { changeOrgAsMigrator } from '@tinnox/db/migrate';
          import { changeAsDevice, verifyDeviceCredential } from '../auth/device.ts';
          import { recordRefusal } from '../auth/refusal.ts';
          import { changeAsJob } from './jobs.ts';
          await changeAsDevice(ctx, request, device, async (tx) => ({ value: 1, audit: event }));
          await changeAsJob(pool, 'media_pipeline', orgId, async (tx) => ({ value: 1, audit: event }));
          await changeOrgAsMigrator(pool, orgId, statement, async (tx) => ({ value: 1, audit: event }));
          await recordRefusal(ctx, request, session, event);
        `,
      },
      {
        name: 'the named exceptions of D2 and the lookups, which are not the legacy API',
        code: `
          import { auditStandalone, deviceByTokenHash, poolAsTx, sessionRevokeUnaudited } from '@tinnox/db';
          await auditStandalone(pool, refusal);
          await deviceByTokenHash(poolAsTx(pool), hash);
        `,
      },
      {
        name: 'a helper that takes the tx of its caller, and a sentence that names a function',
        code: `
          import type { OrgTx } from '@tinnox/db';
          // withOrg(pool, orgId, fn) was how this ran before.
          export const NOTE = 'auditScoped(tx, event) wrote the row';
          export async function load(tx: OrgTx): Promise<number> {
            return (await tx.query('SELECT 1')).rows.length;
          }
        `,
      },
      {
        name: 'a legacy name that is a property or a declaration, not a call',
        code: `
          export const openers = { withOrg: 1 };
          export function withResolvedOrg(): void {}
          export const first = openers.withOrg;
        `,
      },
      {
        name: 'the wrappers step 20 deleted are no longer legacy names: the type checker refuses them',
        code: `
          import { withOrgAllowed, withOrgDecisionAllowed } from '../auth/permissions.ts';
          import { withOrgDecision } from '../db-helpers.ts';
        `,
      },
    ],
    invalid: [
      {
        name: 'every legacy name of @tinnox/db, where it is imported',
        code: `
          import { auditScoped, auditUnscoped, withOrg, withoutOrg, withResolvedOrg, type OrgTx } from '@tinnox/db';
          await withOrg(pool, orgId, (tx) => auditScoped(tx, event));
        `,
        errors: [
          legacy('auditScoped', BY_HAND),
          legacy('auditUnscoped', BY_HAND),
          legacy('withOrg', OPENS),
          legacy('withoutOrg', OPENS),
          legacy('withResolvedOrg', OPENS),
        ],
      },
      {
        name: 'from the testing entry, or a module of packages/db by a relative path (step 20)',
        code: `
          import { auditUnscoped, withOrg } from '@tinnox/db/testing';
          import { withResolvedOrg } from '../../packages/db/src/tx.ts';
        `,
        errors: [
          legacy('auditUnscoped', BY_HAND),
          legacy('withOrg', OPENS),
          legacy('withResolvedOrg', OPENS),
        ],
      },
      {
        name: 'under another name: the import is the use, reported once',
        code: `
          import { withOrg as open } from '@tinnox/db';
          await open(pool, orgId, fn);
          await open(pool, orgId, fn);
        `,
        errors: [legacy('withOrg', OPENS)],
      },
      {
        name: 'a re-export, which hands the legacy function to another file',
        code: "export { auditScoped, sha256 } from '@tinnox/db';",
        errors: [legacy('auditScoped', BY_HAND)],
      },
      {
        name: 'through a namespace: every call',
        code: `
          import * as db from '@tinnox/db';
          await db.withOrg(pool, orgId, (tx) => db.auditScoped(tx, event));
        `,
        errors: [legacy('withOrg', OPENS), legacy('auditScoped', BY_HAND)],
      },
      {
        name: 'a name the file did not import: a dynamic import, and a wrapper of its own',
        code: `
          const { withoutOrg } = await import('@tinnox/db');
          await withoutOrg(pool, fn);
          export async function withOrg(pool, orgId, fn) {
            return withResolvedOrg(pool, fn);
          }
        `,
        errors: [legacy('withoutOrg', OPENS), legacy('withResolvedOrg', OPENS)],
      },
    ],
  });
});
