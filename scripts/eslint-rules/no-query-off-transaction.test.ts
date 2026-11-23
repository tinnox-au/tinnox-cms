// AG-2.1: the query-receiver rule against fixture code, first with type information (how the
// repository is linted), then without (the fallback by name). The message is pinned word for word
// (D16): it is what an author reads, and it must name what to use instead.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { repoRoot } from '../lib/env.ts';
import rule from './no-query-off-transaction.ts';

// ESLint looks for global describe and it, which the unit project does not define. itOnly stays
// unset: a focused case is a red run (U-15).
RuleTester.describe = describe;
RuleTester.it = it;

// Not on disk, so the project service type-checks it alone with the repository's compiler flags;
// its import of @tinnox/db resolves to the real packages/db, whose OrgTx the rule looks for. At the
// repository root, where the nearest tsconfig.json is the small one of the root: a path inside a
// workspace would make the service load that whole workspace first (the rule itself does not
// read the path; scripts/lib/db-access-lint.test.ts holds which files get it).
const FIXTURE = 'query-rule-fixture.ts';
const typed = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: { allowDefaultProject: [FIXTURE], defaultProject: 'tsconfig.base.json' },
      tsconfigRootDir: repoRoot,
    },
  },
});
const untyped = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const message = (receiver: string): string =>
  `Do not call query() on ${receiver}: only an OrgTx takes a statement (the tx that the callback of withOrg receives, or that enterOrg returns inside withResolvedOrg). On the pool, a pooled client or the handle of poolAsTx the statement runs outside any transaction and with no organisation. Use withOrg(pool, session.orgId, (tx) => tx.query(...)), a typed sec.* wrapper from @tinnox/db (add it to packages/db/src/sec.ts if it is missing), or ping(pool) for a liveness probe. An offline tool that reads across organisations sends the statement on the handle asDefiner gives its work (@tinnox/db/migrate).`;

const HEAD = `
  import { poolAsTx, withOrg, withResolvedOrg, type Autocommit, type OrgId, type OrgTx, type Pool } from '@tinnox/db';
  import { asDefiner, type DefinerTx, type MigratorPool } from '@tinnox/db/migrate';
  declare const pool: Pool;
  declare const migrator: MigratorPool;
  declare const orgId: OrgId;
`;
const typedCase = (code: string) => ({ code: `${HEAD}${code}`, filename: FIXTURE });

const SESSION_LOCK = [
  {
    allowed: [
      {
        sql: '^SELECT pg_try_advisory_lock\\(hashtextextended\\(\\$1, 0\\)\\) AS ok$',
        reason: 'session lock; removed by `withSessionLock` in step 22',
      },
    ],
  },
];
const LOCK = "'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok'";

// The first typed case builds the TypeScript program for the fixture and packages/db.
describe('with type information', { timeout: 30_000 }, () => {
  typed.run('no-query-off-transaction (AG-2.1)', rule, {
    valid: [
      {
        name: 'the tx a transaction gives its callback',
        ...typedCase(`
          export const rows = await withOrg(pool, orgId, (tx) => tx.query('SELECT 1'));
          export const more = await withResolvedOrg(pool, async (_pre, enterOrg) => {
            const entered = await enterOrg(orgId);
            return (await entered.query('SELECT 2')).rows;
          });
        `),
      },
      {
        name: 'the handle asDefiner gives its work, whatever it is called (D25)',
        ...typedCase(`
          export const all = await withResolvedOrg(migrator, (pre) =>
            asDefiner(migrator, pre, (definer) => definer.query('SELECT org_id FROM public.membership')),
          );
          export async function count(asTheDefiner: DefinerTx): Promise<number> {
            return (await asTheDefiner.query('SELECT 1 FROM public.organization')).rows.length;
          }
        `),
      },
      {
        name: 'a helper that takes the transaction, whatever it calls the parameter',
        ...typedCase(`
          export async function rename(handle: OrgTx, id: string): Promise<void> {
            await handle.query('UPDATE folder SET name = $2 WHERE id = $1', [id, 'a']);
          }
        `),
      },
      {
        name: 'a subtype, a read-only view and a generic parameter bounded by OrgTx are still an OrgTx',
        ...typedCase(`
          interface Scoped extends OrgTx { readonly orgId: string }
          export async function a(tx: Scoped): Promise<void> { await tx.query('SELECT 1'); }
          export async function b(tx: Readonly<OrgTx>): Promise<void> { await tx.query('SELECT 1'); }
          export async function c<T extends OrgTx>(tx: T): Promise<void> { await tx.query('SELECT 1'); }
        `),
      },
      {
        name: 'a property called query that is not called (the query string of a request)',
        ...typedCase(`
          declare const request: { query: unknown };
          export const input = request.query;
        `),
      },
      {
        name: 'a statement the options allow, written as a string literal',
        ...typedCase(`
          const client = await pool.connect();
          export const locked = await client.query(${LOCK}, ['key']);
        `),
        options: SESSION_LOCK,
      },
    ],
    invalid: [
      {
        name: 'the pool itself, also through a context object',
        ...typedCase(`
          declare const ctx: { pool: Pool };
          await pool.query('SELECT 1');
          await ctx.pool.query('SELECT 1');
        `),
        errors: [{ message: message('pool') }, { message: message('ctx.pool') }],
      },
      {
        name: 'a pooled client',
        ...typedCase(`
          const client = await pool.connect();
          await client.query('SELECT pg_advisory_unlock(1)');
        `),
        errors: [{ message: message('client') }],
      },
      {
        name: 'the handle of poolAsTx, also under the name tx, and an Autocommit parameter',
        ...typedCase(`
          await poolAsTx(pool).query('SELECT 1 FROM sec.media_processing_jobs($1)', [5]);
          const tx = poolAsTx(pool);
          await tx.query('SELECT 1');
          export async function read(db: Autocommit): Promise<void> { await db.query('SELECT 1'); }
        `),
        errors: [
          { message: message('poolAsTx(pool)') },
          { message: message('tx') },
          { message: message('db') },
        ],
      },
      {
        name: 'a value that may be a pool, and one whose type says nothing',
        ...typedCase(`
          declare const either: OrgTx | Pool;
          declare const anything: any;
          await either.query('SELECT 1');
          await anything.query('SELECT 1');
        `),
        errors: [{ message: message('either') }, { message: message('anything') }],
      },
      {
        name: 'an optional call and a computed member',
        ...typedCase(`
          declare const maybe: Pool | undefined;
          await maybe?.query('SELECT 1');
          await pool['query']('SELECT 1');
        `),
        errors: [{ message: message('maybe') }, { message: message('pool') }],
      },
      {
        name: 'an allowed statement opens nothing else: another statement, or the same one built at run time',
        ...typedCase(`
          const client = await pool.connect();
          await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok; SELECT 1');
          await client.query(\`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok\`);
          await client.query('SELECT 1 FROM display');
        `),
        options: SESSION_LOCK,
        errors: [
          { message: message('client') },
          { message: message('client') },
          { message: message('client') },
        ],
      },
    ],
  });
});

describe('without type information: the receiver is judged by its name', () => {
  untyped.run('no-query-off-transaction (AG-2.1)', rule, {
    valid: [
      {
        name: 'an identifier called tx',
        code: `await withOrg(pool, orgId, (tx) => tx.query('SELECT 1'));`,
      },
      { name: 'a property that is not called', code: `export const input = request.query;` },
      {
        name: 'a statement the options allow',
        code: `await client.query(${LOCK}, [key]);`,
        options: SESSION_LOCK,
      },
    ],
    invalid: [
      {
        name: 'anything else',
        code: `
          await pool.query('SELECT 1');
          await ctx.pool.query('SELECT 1');
          await poolAsTx(pool).query('SELECT 1');
          await handle.query('SELECT 1');
        `,
        errors: [
          { message: message('pool') },
          { message: message('ctx.pool') },
          { message: message('poolAsTx(pool)') },
          { message: message('handle') },
        ],
      },
    ],
  });
});
