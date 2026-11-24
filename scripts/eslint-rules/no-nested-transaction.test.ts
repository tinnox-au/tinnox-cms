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
const REMEDY = `${SECOND} Pass the outer tx to the helper: give it a \`tx: OrgTx\` parameter (from @tinnox/db) and run the statements on that; work that must commit on its own goes after the outer call has returned.`;
// The two functions that take the pool and no tx: the message names what to call on the outer
// tx, not a parameter the function does not have.
const AUDIT_REMEDY = `${SECOND} Write the event on the outer transaction instead: return it from that change as { value, audit }, and changeOrg or changePreOrg (or the wrapper the route calls: changeAsOperator, changeAsDevice, changeAsJob) writes it there. auditStandalone is only for a refusal that no transaction carries: call it after the outer call has returned or thrown.`;
const REVOKE_REMEDY = `${SECOND} End the session on the outer tx instead: sessionRevoke(tx, idHash) (from @tinnox/db), with its audit row on the same tx. sessionRevokeUnaudited is only for the sign-out fallback: call it after the outer call has returned or thrown.`;
const REFUSAL_REMEDY = `${SECOND} A refusal that commits with what the outer transaction wrote is returned from it, as { value: refuse(error), audit: event } (refuse from apps/api/src/db-helpers.ts): the wrapper writes the event there. recordRefusal is for a refusal that changed nothing: throw the refusal, and call it after the outer call has rolled back (SCR-32).`;
// CHK-3: withSessionLock and ping open no transaction, but each checks out a connection of its own.
const OPEN = 'where a transaction is already open.';
const LOCK_REMEDY = `${OPEN} It checks out a connection of its own and holds it while the outer transaction holds another, so with every connection held that way the pool never answers. Take the lock first and open the transactions inside its work, as runDisplayAlerts in apps/api/src/alerts.ts does: withSessionLock(ctx.db, name, (signal) => readOrg(...)). A lock that only guards the statements of this transaction is pg_advisory_xact_lock on the outer tx.`;
const PING_REMEDY = `${OPEN} It sends its statement on another connection of the pool, which waits while the outer transaction holds one. Call ping(ctx.db) from the liveness probe, outside any transaction; inside one, the statements of the outer tx already show that the database answers.`;
const inCallback = (opener: string, outer: string, remedy = REMEDY) =>
  `${opener}() is called inside the callback of ${outer}(), ${remedy}`;
const withHandle = (opener: string, handle: string, remedy = REMEDY) =>
  `${opener}() is called inside a function that takes a transaction handle (${handle}), ${remedy}`;

tester.run('no-nested-transaction (U-3)', rule, {
  valid: [
    {
      name: 'CHK-3: transactions inside the work of withSessionLock, and ping on its own',
      code: `
        await withSessionLock(ctx.db, 'display_alerts', async (signal) => {
          await readOrg(ctx.db, orgId, (tx) => tx.query('SELECT 1'));
          await changeAsJob(ctx.db, 'display_alerts', orgId, change);
        });
        await ping(ctx.db);
      `,
    },
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
      name: 'a refusal recorded with recordRefusal after the change has rolled back (SCR-32)',
      code: `
        try {
          await changeAsOperator(ctx, request, (tx) => change(tx));
        } catch (error) {
          await recordRefusal(ctx, request, session, event);
          throw error;
        }
        // It takes no callback: a function among its arguments is not inside a transaction.
        await recordRefusal(ctx, request, session, eventFor(() => readOrg(pool, orgId, load)));
      `,
    },
    {
      name: 'a helper that takes the outer handle and runs its statements on it',
      code: `
        async function rename(tx: Tx, id: string): Promise<void> {
          await tx.query('UPDATE folder SET name = $2 WHERE id = $1', [id, 'a']);
        }
        await changeAsOperator(ctx, request, (tx) => rename(tx, id));
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
        export async function openWith<T>(pool: Pool, orgId: string, fn: (tx: Tx) => Promise<T>) {
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
      name: 'a type parameter with no constraint, or one that names no handle, is no handle',
      code: `
        async function a<T>(value: T, pool: Pool) { await withOrg(pool, orgId, work); }
        async function b<P extends Pool>(pool: P) { await withoutOrg(pool, work); }
        // The inner T is its own and unconstrained: the outer one's constraint does not reach it.
        function c<T extends OrgTx>() {
          return function d<T>(value: T) { return withOrg(pool, orgId, work); };
        }
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
      name: 'CHK-3: withSessionLock and ping inside a transaction, or in a function that takes one',
      code: `
        await readOrg(ctx.db, orgId, async (tx) => {
          await withSessionLock(ctx.db, 'display_alerts', work);
          await ping(ctx.db);
        });
        export async function inside(tx: OrgTx): Promise<void> {
          await db.withSessionLock(ctx.db, 'display_alerts', work);
        }
      `,
      errors: [
        { message: inCallback('withSessionLock', 'readOrg', LOCK_REMEDY) },
        { message: inCallback('ping', 'readOrg', PING_REMEDY) },
        { message: withHandle('withSessionLock', 'tx: OrgTx', LOCK_REMEDY) },
      ],
    },
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
        await changeAsOperator(ctx, request, async (tx, role) => {
          await withoutOrg(ctx.pool, (inner) => lookup(inner));
        });
        await withResolvedOrg(pool, async (tx, enterOrg) => {
          await changeAsDevice(ctx, request, (inner) => decide(inner));
        });
        await withoutOrg(pool, async function (tx) {
          await withResolvedOrg(pool, (inner) => complete(inner));
        });
        await changeAsJob(pool, orgId, async (tx) => changeAsJob(pool, orgId, decide));
        await changeAsDevice(ctx, request, async (tx) => changeAsOperator(ctx, request, write));
      `,
      errors: [
        { message: inCallback('withoutOrg', 'changeAsOperator') },
        { message: inCallback('changeAsDevice', 'withResolvedOrg') },
        { message: inCallback('withResolvedOrg', 'withoutOrg') },
        { message: inCallback('changeAsJob', 'changeAsJob') },
        { message: inCallback('changeAsOperator', 'changeAsDevice') },
      ],
    },
    {
      name: 'the openers of step 19: a read, a change and the operator wrapper, inside and outside',
      code: `
        await changeOrg(pool, orgId, permit, async (tx) => {
          await readOrg(pool, orgId, (inner) => load(inner));
          return { value: 1, audit: event };
        });
        await readOrg(pool, orgId, async (tx) => changeAsOperator(ctx, request, write));
        await changePreOrg(pool, async (pre) => changeOrg(pool, orgId, permit, write));
        await withOrg(pool, orgId, async (tx) => changePreOrg(pool, write));
        export async function total(tx: OrgReadTx, pool: Pool): Promise<number> {
          return readOrg(pool, orgId, (inner) => count(inner));
        }
      `,
      errors: [
        { message: inCallback('readOrg', 'changeOrg') },
        { message: inCallback('changeAsOperator', 'readOrg') },
        { message: inCallback('changeOrg', 'changePreOrg') },
        { message: inCallback('changePreOrg', 'withOrg') },
        { message: withHandle('readOrg', 'tx: OrgReadTx') },
      ],
    },
    {
      name: 'the openers of step 20: a device, a job, an offline tool and a refusal, inside and outside',
      code: `
        await changeAsDevice(ctx, request, device, async (tx) => {
          await readOrg(pool, device.orgId, (inner) => load(inner));
          return { value: 1, audit: event };
        });
        await changeAsJob(pool, 'display_alerts', orgId, async (tx) => changeAsJob(pool, 'media_pipeline', orgId, write));
        await changeOrgAsMigrator(pool, orgId, statement, async (tx) => changePreOrg(pool, statement, write));
        await readOrg(pool, orgId, async (tx) => changeAsDevice(ctx, request, device, write));
        await changeAsOperator(ctx, request, async (tx) => {
          await recordRefusal(ctx, request, session, event);
          return { value: 1, audit: event };
        });
        async function refuse(tx: OrgTx): Promise<void> {
          await recordRefusal(ctx, request, session, event);
        }
      `,
      errors: [
        { message: inCallback('readOrg', 'changeAsDevice') },
        { message: inCallback('changeAsJob', 'changeAsJob') },
        { message: inCallback('changePreOrg', 'changeOrgAsMigrator') },
        { message: inCallback('changeAsDevice', 'readOrg') },
        { message: inCallback('recordRefusal', 'changeAsOperator', REFUSAL_REMEDY) },
        { message: withHandle('recordRefusal', 'tx: OrgTx', REFUSAL_REMEDY) },
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
        const e = async (tx: Readonly<Tx> | undefined) => changeAsOperator(ctx, request, work);
        async function f(tx?: Tx) { await withoutOrg(pool, work); }
      `,
      errors: [
        // The type is named without what wraps it.
        { message: withHandle('withoutOrg', 'tx: Tx') },
        { message: withHandle('withOrg', 'tx: Tx') },
        { message: withHandle('poolAsTx', 'tx: Tx') },
        { message: withHandle('withResolvedOrg', 'tx: Tx') },
        { message: withHandle('changeAsOperator', 'tx: Tx') },
        { message: withHandle('withoutOrg', 'tx: Tx') },
      ],
    },
    {
      name: "each kind of handle: with the organisation, before it, either, and the definer's (step 18)",
      code: `
        async function a(tx: OrgTx, pool: Pool) { await withOrg(pool, orgId, work); }
        async function b(pre: PreOrgTx, pool: Pool) { await withoutOrg(pool, work); }
        async function c(tx: Tx, pool: Pool) { await withResolvedOrg(pool, work); }
        async function d(definer: DefinerTx, pool: Pool) { await withOrg(pool, orgId, work); }
      `,
      errors: [
        { message: withHandle('withOrg', 'tx: OrgTx') },
        { message: withHandle('withoutOrg', 'pre: PreOrgTx') },
        { message: withHandle('withResolvedOrg', 'tx: Tx') },
        { message: withHandle('withOrg', 'definer: DefinerTx') },
      ],
    },
    {
      name: 'a handle typed by a type parameter whose constraint names a handle (step 20 review)',
      code: `
        async function a<T extends OrgReadTx>(tx: T, lock: LockOn<T>) {
          await readOrg(pool, orgId, (inner) => inner.query('SELECT 1'));
        }
        const b = async <H extends Readonly<OrgTx>>(handle: H | undefined) => withoutOrg(pool, work);
        async function c<T extends db.Tx>(tx: Readonly<T>) { await poolAsTx(pool); }
        // The parameter of an enclosing function reaches an inner one.
        function d<T extends PreOrgTx>() {
          return async (tx: T) => withOrg(pool, orgId, work);
        }
      `,
      errors: [
        { message: withHandle('readOrg', 'tx: T extends OrgReadTx') },
        { message: withHandle('withoutOrg', 'handle: H extends OrgTx') },
        { message: withHandle('poolAsTx', 'tx: T extends Tx') },
        { message: withHandle('withOrg', 'tx: T extends PreOrgTx') },
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
