// AG-3.1, SCR-34 (adoption plan step 19): the legacy-transaction rule against fixture code. It
// reads names only, so one tester without type information is enough. The messages are pinned
// word for word (D16): they are what an author reads, and they must name what to use instead.
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
  'Use readOrg(pool, orgId, fn) for reads and changeOrg(pool, orgId, permit, fn) returning { value, audit } for changes; the permit comes from the role guard: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues it and checks the role again first. Before the organisation is known, use changePreOrg(pool, fn), in the files of PRE_ORG_CHANGE_FILES (eslint.config.js) only. The wrapper writes the audit rows you return on the transaction of the change; a change that records nothing returns unaudited(reason) (all from @tinnox/db). This file is not in LEGACY_TRANSACTION_FILES of eslint.config.js, and that list only shrinks: do not add to it.';
const OPENS = 'opens a transaction that anything may be written on, with no role check';
const BY_HAND = 'writes an audit row by hand, on whatever transaction it is given';
const WRAPS = 'is for a callback that writes its audit rows by hand';
const legacy = (name: string, what: string) => ({
  message: `${name} is the legacy transaction API: it ${what}. ${REMEDY}`,
});
const STALE =
  'This file no longer uses the legacy transaction API (withOrg, withoutOrg, withResolvedOrg, auditScoped, auditUnscoped, withOrgAllowed, withOrgDecisionAllowed, withOrgDecision): remove it from LEGACY_TRANSACTION_FILES in eslint.config.js. The list only shrinks, and an entry that stays would let the legacy API back into this file unseen.';

const LISTED = [{ listed: true }];

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
          await changePreOrg(pool, async (pre) => ({ value: 1, audit: unaudited('login_state') }));
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
          export function withOrgAllowed(): void {}
          export const first = openers.withOrg;
        `,
      },
      {
        name: 'a listed file that still imports the legacy API',
        options: LISTED,
        code: `
          import { auditScoped, withOrg } from '@tinnox/db';
          await withOrg(pool, orgId, (tx) => auditScoped(tx, event));
        `,
      },
      {
        name: 'a listed file whose own wrapper calls another (the module that defines them)',
        options: LISTED,
        code: `
          export async function withOrgAllowed(ctx, request, fn) { return fn(); }
          export async function withOrgDecisionAllowed(ctx, request, fn) {
            return withOrgAllowed(ctx, request, fn);
          }
        `,
      },
      {
        name: 'a listed file that reaches it through a namespace only',
        options: LISTED,
        code: `
          import * as db from '@tinnox/db';
          await db.withResolvedOrg(pool, fn);
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
        name: "the API's wrappers for a callback that audits by hand",
        code: `
          import { withOrgAllowed, withOrgDecisionAllowed } from '../auth/permissions.ts';
          import { withOrgDecision } from '../db-helpers.ts';
        `,
        errors: [
          legacy('withOrgAllowed', WRAPS),
          legacy('withOrgDecisionAllowed', WRAPS),
          legacy('withOrgDecision', WRAPS),
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
          export async function withOrgDecisionAllowed(ctx, request, fn) {
            return withOrgAllowed(ctx, request, fn);
          }
        `,
        errors: [legacy('withoutOrg', OPENS), legacy('withOrgAllowed', WRAPS)],
      },
      {
        name: 'a listed file that uses the legacy API no more: the entry is stale',
        options: LISTED,
        code: `
          import { readOrg, type OrgReadTx } from '@tinnox/db';
          import { changeAsOperator } from '../auth/permissions.ts';
          await readOrg(pool, session.orgId, (tx) => tx.query('SELECT 1'));
        `,
        errors: [{ message: STALE, line: 1 }],
      },
      {
        name: 'a listed file that only mentions the names is stale too',
        options: LISTED,
        code: `
          // withOrg and auditScoped are gone from here.
          export const NOTE = 'withOrgAllowed';
          export function withOrgAllowed(): void {}
        `,
        errors: [{ message: STALE, line: 1 }],
      },
    ],
  });
});
