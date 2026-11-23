// U-3: the nested-transaction rule against fixture code. The messages are pinned word for word
// (D16): they are what an author reads, and they must name what to do instead.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './no-nested-transaction.ts';

// ESLint looks for global describe and it, which the unit project does not define. itOnly stays
// unset: a focused case is a red run (U-15).
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const SECOND =
  'where a transaction is already open. This opens a second transaction on another connection that commits independently.';
const REMEDY = `${SECOND} Pass the outer tx to the helper: give it a \`tx: Tx\` parameter (from @tinnox/db) and run the statements on that; work that must commit on its own goes after the outer call has returned.`;
// The two functions that take the pool and no tx: the message names what to call on the outer
// tx, not a parameter the function does not have.
const AUDIT_REMEDY = `${SECOND} Write the event on the outer tx instead: auditUnscoped(tx, event), or auditScoped(tx, event) when the outer transaction is withOrg (both from @tinnox/db). auditStandalone is only for a refusal that no transaction carries: call it after the outer call has returned or thrown.`;
const REVOKE_REMEDY = `${SECOND} End the session on the outer tx instead: sessionRevoke(tx, idHash) (from @tinnox/db), with its audit row on the same tx. sessionRevokeUnaudited is only for the sign-out fallback: call it after the outer call has returned or thrown.`;
const inCallback = (opener: string, outer: string, remedy = REMEDY) =>
  `${opener}() is called inside the callback of ${outer}(), ${remedy}`;
const withHandle = (opener: string, handle: string, remedy = REMEDY) =>
  `${opener}() is called inside a function that takes a transaction handle (${handle}), ${remedy}`;

tester.run('no-nested-transaction (U-3)', rule, {
  valid: [
    {
      name: 'one transaction after another',
      code: `
        await withOrg(pool, orgId, async (tx) => { await tx.query('SELECT 1'); });
        await withOrg(pool, orgId, async (tx) => { await tx.query('SELECT 2'); });
      `,
    },
    {
      name: 'a refusal recorded in its own transaction after the first has rolled back (DEC-35)',
      code: `
        try {
          await withOrg(pool, orgId, (tx) => change(tx));
        } catch (error) {
          await withOrg(pool, orgId, (tx) => auditScoped(tx, event));
          throw error;
        }
      `,
    },
    {
      name: 'a helper that takes the outer handle and runs its statements on it',
      code: `
        async function rename(tx: Tx, id: string): Promise<void> {
          await tx.query('UPDATE folder SET name = $2 WHERE id = $1', [id, 'a']);
        }
        await withOrgAllowed(ctx, request, (tx) => rename(tx, id));
      `,
    },
    {
      name: 'a single statement on the pool before the transaction starts',
      code: `
        const session = await sessionByTokenHash(poolAsTx(ctx.pool), hash);
        await withOrg(ctx.pool, session.orgId, (tx) => touch(tx));
      `,
    },
    {
      name: 'a refusal written on its own after the transaction has rolled back, and the sign-out fallback (D2)',
      code: `
        try {
          await withResolvedOrg(ctx.pool, (tx, enterOrg) => signIn(tx, enterOrg));
        } catch (error) {
          await auditStandalone(ctx.pool, memberLocked);
          await sessionRevokeUnaudited(ctx.pool, idHash);
        }
      `,
    },
    {
      name: 'a function given to an opener that takes no callback is not inside a transaction',
      code: `await auditStandalone(pool, events.find((event) => withoutOrg(pool, check)));`,
    },
    {
      name: 'a wrapper that passes its callback on: its parameter is a function, not a handle',
      code: `
        export async function withOrgDecision<T>(pool: Pool, orgId: string, fn: (tx: Tx) => Promise<T>) {
          return withOrg(pool, orgId, fn);
        }
      `,
    },
    {
      name: 'a parameter that may be a pool and no handle at all: left to run()',
      code: `
        async function count(db: Tx | Pool, orgId: string) {
          return 'query' in db ? one(db) : withOrg(db, orgId, one);
        }
        function wrapped(tx: Promise<Tx>, other: Readonly<Pool>) { return withoutOrg(pool, work); }
      `,
    },
    {
      name: 'a callback given to anything else',
      code: `await Promise.all(orgs.map((orgId) => withOrg(pool, orgId, (tx) => count(tx))));`,
    },
    {
      name: 'a property that only shares the name, read and not called',
      code: `await withOrg(pool, orgId, async (tx) => { log(helpers.withOrg, tx); });`,
    },
  ],
  invalid: [
    {
      name: 'withOrg inside the callback of withOrg',
      code: `
        await withOrg(pool, orgId, async (tx) => {
          await withOrg(pool, orgId, (inner) => auditScoped(inner, event));
        });
      `,
      errors: [{ message: inCallback('withOrg', 'withOrg') }],
    },
    {
      name: 'every opener inside every kind of callback, the API wrappers included',
      code: `
        await withOrgAllowed(ctx, request, async (tx, role) => {
          await withoutOrg(ctx.pool, (inner) => lookup(inner));
        });
        await withResolvedOrg(pool, async (tx, enterOrg) => {
          await withOrgDecisionAllowed(ctx, request, (inner) => decide(inner));
        });
        await withoutOrg(pool, async function (tx) {
          await withResolvedOrg(pool, (inner) => complete(inner));
        });
        await withOrgDecision(pool, orgId, async (tx) => withOrgDecision(pool, orgId, decide));
        await withOrgDecisionAllowed(ctx, request, async (tx) => withOrgAllowed(ctx, request, write));
      `,
      errors: [
        { message: inCallback('withoutOrg', 'withOrgAllowed') },
        { message: inCallback('withOrgDecisionAllowed', 'withResolvedOrg') },
        { message: inCallback('withResolvedOrg', 'withoutOrg') },
        { message: inCallback('withOrgDecision', 'withOrgDecision') },
        { message: inCallback('withOrgAllowed', 'withOrgDecisionAllowed') },
      ],
    },
    {
      name: 'a statement on the pool inside a transaction: poolAsTx is its own transaction',
      code: `
        await withOrg(ctx.pool, orgId, async (tx) => {
          await sessionRevoke(poolAsTx(ctx.pool), hash);
        });
      `,
      errors: [{ message: inCallback('poolAsTx', 'withOrg') }],
    },
    {
      name: 'the two functions that write on the pool by name, inside a transaction (D2)',
      code: `
        await withResolvedOrg(ctx.pool, async (tx, enterOrg) => {
          await auditStandalone(ctx.pool, refusal);
          await sessionRevokeUnaudited(ctx.pool, idHash);
        });
        async function refuse(tx: Tx, pool: Pool): Promise<void> {
          await auditStandalone(pool, refusal);
        }
      `,
      errors: [
        { message: inCallback('auditStandalone', 'withResolvedOrg', AUDIT_REMEDY) },
        { message: inCallback('sessionRevokeUnaudited', 'withResolvedOrg', REVOKE_REMEDY) },
        { message: withHandle('auditStandalone', 'tx: Tx', AUDIT_REMEDY) },
      ],
    },
    {
      name: 'a nested function inside the callback is still inside it',
      code: `
        await withOrg(pool, orgId, async (tx) => {
          await Promise.all(ids.map((id) => withOrg(pool, orgId, (inner) => remove(inner, id))));
        });
      `,
      errors: [{ message: inCallback('withOrg', 'withOrg') }],
    },
    {
      name: 'a helper that has the outer handle and opens a transaction anyway',
      code: `
        async function record(tx: Tx, pool: Pool, orgId: string): Promise<void> {
          await withOrg(pool, orgId, (inner) => auditScoped(inner, event));
        }
      `,
      errors: [{ message: withHandle('withOrg', 'tx: Tx') }],
    },
    {
      name: 'the handle as a method parameter, an arrow parameter, with a default, or db.Tx',
      code: `
        class Store {
          async save(handle: Tx): Promise<void> { await withoutOrg(this.pool, work); }
        }
        const read = async (pool: Pool, tx: db.Tx) => db.withOrg(pool, orgId, work);
        function later(tx: Tx = fallback) { return poolAsTx(pool); }
      `,
      errors: [
        { message: withHandle('withoutOrg', 'handle: Tx') },
        // The type is named without its namespace.
        { message: withHandle('withOrg', 'tx: Tx') },
        { message: withHandle('poolAsTx', 'tx: Tx') },
      ],
    },
    {
      name: 'a handle that may be absent or is wrapped is still a handle',
      code: `
        async function a(tx: Tx | undefined, pool: Pool) { await withoutOrg(pool, work); }
        async function b(tx: null | db.Tx, pool: Pool) { await withOrg(pool, orgId, work); }
        async function c(tx: Readonly<Tx>, pool: Pool) { await lookup(poolAsTx(pool)); }
        async function d(tx: NonNullable<Tx | undefined>) { await withResolvedOrg(pool, work); }
        const e = async (tx: Readonly<Tx> | undefined) => withOrgAllowed(ctx, request, work);
        async function f(tx?: Tx) { await withoutOrg(pool, work); }
      `,
      errors: [
        // The type is named without what wraps it.
        { message: withHandle('withoutOrg', 'tx: Tx') },
        { message: withHandle('withOrg', 'tx: Tx') },
        { message: withHandle('poolAsTx', 'tx: Tx') },
        { message: withHandle('withResolvedOrg', 'tx: Tx') },
        { message: withHandle('withOrgAllowed', 'tx: Tx') },
        { message: withHandle('withoutOrg', 'tx: Tx') },
      ],
    },
    {
      name: 'an opener imported under another name, as the callee and as the outer call',
      code: `
        import { withOrg as inOrg, withoutOrg as bare } from '@tinnox/db';
        await inOrg(pool, orgId, async (tx) => {
          await bare(pool, (inner) => lookup(inner));
        });
      `,
      errors: [{ message: inCallback('withoutOrg', 'withOrg') }],
    },
    {
      name: 'the innermost transaction is the one named',
      code: `
        async function outer(tx: Tx): Promise<void> {
          await withOrg(pool, orgId, async (inner) => {
            await withoutOrg(pool, work);
          });
        }
      `,
      errors: [
        { message: withHandle('withOrg', 'tx: Tx') },
        { message: inCallback('withoutOrg', 'withOrg') },
      ],
    },
  ],
});
