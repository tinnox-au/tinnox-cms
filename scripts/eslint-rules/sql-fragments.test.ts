// OTH-12: the SQL-fragment rule against fixture code, first with type information (how the
// repository is linted), then without (constants only). The messages are pinned word for word
// (D16): they are what an author reads, and they must name what to do instead.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { repoRoot } from '../lib/env.ts';
import rule from './sql-fragments.ts';

// ESLint looks for global describe and it, which the unit project does not define. itOnly stays
// unset: a focused case is a red run (U-15).
RuleTester.describe = describe;
RuleTester.it = it;

// Not on disk, so the project service type-checks it alone with the repository's compiler flags;
// its import of @tinnox/db resolves to the real packages/db, whose SqlFragment the rule looks for.
// At the repository root, where the nearest tsconfig.json is the small one of the root: a path
// inside a workspace would make the service load that whole workspace first (the rule itself
// does not read the path; scripts/lib/db-access-lint.test.ts holds which files get it).
const FIXTURE = 'sql-fragments-fixture.ts';
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

const HOW =
  'make a SqlFragment with sql`...`, sqlParameter(position) or joinSql(parts, separator) from @tinnox/db (packages/db/src/sql.ts).';
const interpolation = (text: string): string =>
  `SQL text may interpolate only an UPPER_CASE module constant or a SqlFragment, and \`${text}\` is neither. Pass a value as a parameter ($1, $2; see Tx in packages/db/src/tx.ts). For fixed text chosen at run time ${HOW}`;
const statement = (text: string): string =>
  `The statement given to query() must be text from the source: a string literal, a template, an UPPER_CASE module constant or a SqlFragment, and \`${text}\` is none of these. Write the statement at the call and pass values as parameters ($1, $2; see Tx in packages/db/src/tx.ts); for fixed text chosen at run time ${HOW}`;

const HEAD = `
  import { joinSql, sql, sqlParameter, type SqlFragment, type Tx } from '@tinnox/db';
  declare const tx: Tx;
  declare const lock: boolean;
  declare const input: string;
  const COLUMNS = 'id, name';
`;
const typedCase = (code: string) => ({ code: `${HEAD}${code}`, filename: FIXTURE });

// The first typed case builds the TypeScript program for the fixture and packages/db.
describe('with type information', { timeout: 30_000 }, () => {
  typed.run('sql-fragments (OTH-12)', rule, {
    valid: [
      {
        name: 'a literal statement, a template with none, and values as parameters',
        ...typedCase(`
          await tx.query('SELECT 1');
          await tx.query(\`SELECT id FROM folder
                          WHERE id = $1\`, [input]);
        `),
      },
      {
        name: 'an UPPER_CASE constant of the module, declared or imported, in a template or as the statement',
        ...typedCase(`
          import { MEDIA_WINDOW_COLUMNS } from './rows.ts';
          const LIST = \`SELECT \${COLUMNS} FROM folder\`;
          await tx.query(\`SELECT \${COLUMNS}, \${MEDIA_WINDOW_COLUMNS} FROM media WHERE id = $1\`, [input]);
          await tx.query(LIST);
        `),
      },
      {
        name: 'a SqlFragment: a constant, a member, a call, and a choice between two',
        ...typedCase(`
          const FOR_SHARE = sql\`FOR SHARE\`;
          const NO_LOCK = sql\`\`;
          const JOIN = { media: { table: sql\`media_tag\` } } as const;
          const values: unknown[] = [];
          const parameter = (value: unknown): SqlFragment => sqlParameter(values.push(value));
          const sets: SqlFragment[] = [sql\`role = \${parameter(input)}\`];
          const join = JOIN.media;
          await tx.query(\`SELECT 1 FROM \${join.table} WHERE id = \${parameter(input)} \${lock ? FOR_SHARE : NO_LOCK}\`, values);
          await tx.query(\`UPDATE membership SET \${joinSql(sets, sql\`, \`)} WHERE id = $1\`, values);
        `),
      },
      {
        name: 'a choice between two module constants, or between a constant and a fragment',
        ...typedCase(`
          const WIDE = 'id, name, note';
          const NO_LOCK = sql\`\`;
          await tx.query(\`SELECT \${lock ? WIDE : COLUMNS} FROM folder \${lock ? COLUMNS : NO_LOCK}\`);
        `),
      },
      {
        name: 'a statement that is a SqlFragment chosen before the call',
        ...typedCase(`
          const lookup = lock
            ? { text: sql\`SELECT id FROM membership WHERE oidc_sub = $1\` }
            : { text: sql\`SELECT id FROM membership WHERE id = $1\` };
          await tx.query(lookup.text, [input]);
        `),
      },
      {
        name: 'a pass-through name the options give, as the whole statement',
        ...typedCase(`
          export const run = (text: string) => tx.query(text);
        `),
        options: [{ passThrough: ['text'] }],
      },
      {
        name: 'a template that is not a statement',
        ...typedCase(`
          export const label = \`Screen \${input}\`;
        `),
      },
    ],
    invalid: [
      {
        name: 'a value from a request, in a template',
        ...typedCase(`
          await tx.query(\`SELECT 1 FROM folder WHERE name = '\${input}'\`);
        `),
        errors: [{ message: interpolation('input') }],
      },
      {
        name: 'fixed text that is not a constant or a fragment: a choice of literals, a join, a member',
        ...typedCase(`
          const sets: string[] = ['role = $2'];
          const join = { table: 'media_tag' };
          await tx.query(\`SELECT 1 FROM folder \${lock ? 'FOR SHARE' : ''}\`);
          await tx.query(\`UPDATE membership SET \${sets.join(', ')} WHERE id = $1\`, [input]);
          await tx.query(\`DELETE FROM \${join.table} WHERE id = $1\`, [input]);
        `),
        errors: [
          { message: interpolation("lock ? 'FOR SHARE' : ''") },
          { message: interpolation("sets.join(', ')") },
          { message: interpolation('join.table') },
        ],
      },
      {
        name: 'a constant in name only: lower case, declared in a function, or with let',
        ...typedCase(`
          const columns = 'id';
          let MUTABLE = 'id';
          MUTABLE = input;
          export async function read(): Promise<void> {
            const LOCAL = input;
            await tx.query(\`SELECT \${columns}, \${MUTABLE}, \${LOCAL} FROM folder\`);
          }
        `),
        errors: [
          { message: interpolation('columns') },
          { message: interpolation('MUTABLE') },
          { message: interpolation('LOCAL') },
        ],
      },
      {
        name: 'a choice where one branch is not a fragment, and a value typed any',
        ...typedCase(`
          const FOR_SHARE = sql\`FOR SHARE\`;
          declare const anything: any;
          await tx.query(\`SELECT 1 FROM folder \${lock ? FOR_SHARE : input}\`);
          await tx.query(\`SELECT 1 FROM folder \${anything}\`);
        `),
        errors: [
          { message: interpolation('lock ? FOR_SHARE : input') },
          { message: interpolation('anything') },
        ],
      },
      {
        name: 'the statement moved to a variable, joined with +, or a pass-through name inside a template',
        ...typedCase(`
          const text = \`SELECT 1 FROM folder WHERE name = '\${input}'\`;
          await tx.query(text);
          await tx.query('SELECT 1 FROM folder WHERE name = ' + input);
          await tx.query(\`SELECT \${text}\`);
        `),
        options: [{ passThrough: ['sql'] }],
        errors: [
          { message: statement('text') },
          { message: statement("'SELECT 1 FROM folder WHERE name = ' + input") },
          { message: interpolation('text') },
        ],
      },
      {
        name: 'inside the sql tag, which a value typed any would pass',
        ...typedCase(`
          declare const anything: any;
          export const where = sql\`name = \${anything}\`;
        `),
        errors: [{ message: interpolation('anything') }],
      },
      {
        name: 'a long expression is cut short in the message',
        ...typedCase(`
          declare const filters: { readonly name: string }[];
          await tx.query(\`SELECT 1 FROM folder WHERE \${filters.map((filter) => \`name = '\${filter.name}'\`).join(' AND ')}\`);
        `),
        errors: [
          {
            message: interpolation("filters.map((filter) => `name = '${filter.name}'`).join('..."),
          },
        ],
      },
    ],
  });
});

describe('without type information: only the constants are recognised', () => {
  untyped.run('sql-fragments (OTH-12)', rule, {
    valid: [
      {
        name: 'a module constant, also as the branches of a choice',
        code: `
          const COLUMNS = 'id, name';
          const FOR_SHARE = sql\`FOR SHARE\`;
          const NO_LOCK = sql\`\`;
          await tx.query(\`SELECT \${COLUMNS} FROM folder \${lock ? FOR_SHARE : NO_LOCK}\`);
        `,
      },
    ],
    invalid: [
      {
        name: 'anything else, a fragment it cannot recognise included',
        code: `
          const JOIN = { table: sql\`media_tag\` };
          await tx.query(\`DELETE FROM \${JOIN.table} WHERE name = \${input}\`);
          await tx.query(text);
        `,
        errors: [
          { message: interpolation('JOIN.table') },
          { message: interpolation('input') },
          { message: statement('text') },
        ],
      },
    ],
  });
});
