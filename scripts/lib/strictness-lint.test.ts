// The strictness lints of eslint.config.js (adoption plan sections 3.2 and 3.5, step 8), run
// against fixture text. Each case takes the rule entries that eslint.config.js resolves for a real
// path, so the file globs are tested with the rules: a block that took a rule away from a file
// group would fail here.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

const SWITCH = '@typescript-eslint/switch-exhaustiveness-check';
const NON_NULL = '@typescript-eslint/no-non-null-assertion';
const SYNTAX = 'no-restricted-syntax';
const repository = new ESLint({ cwd: repoRoot });

// typescript-eslint keeps one project service per process, made with the options of the first
// typed lint, so every switch fixture path is listed here once.
const SWITCH_FIXTURES = [
  'apps/player-web/src/core/fixture.ts',
  'apps/portal/src/lib/fixture.ts',
  'apps/api/src/fixture.ts',
  'packages/db/src/fixture.ts',
  'scripts/lib/fixture.ts',
  'apps/portal/src/fixture.test.tsx',
] as const;

/**
 * The messages of `rules`, as eslint.config.js resolves them for `path`, for `code` at `path`.
 * The switch rule reads types; the project service finds no tsconfig for a file that is not on
 * disk, so the fixture is type-checked alone with the repository's compiler flags.
 */
async function flagged(path: string, code: string, rules: readonly string[]): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const picked: Linter.RulesRecord = {};
  for (const rule of rules) {
    const entry = resolved[rule];
    if (entry !== undefined) picked[rule] = entry;
  }
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        plugins: { '@typescript-eslint': tseslint.plugin },
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            ...(rules.includes(SWITCH)
              ? {
                  projectService: {
                    allowDefaultProject: [...SWITCH_FIXTURES],
                    defaultProject: 'tsconfig.base.json',
                  },
                  tsconfigRootDir: repoRoot,
                }
              : {}),
          },
        },
        rules: picked,
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

// The first case loads eslint.config.js and builds the TypeScript program, and the .tsx case
// builds another: seconds on a busy CI runner, past the unit project's 5 s default (GAP-1).
describe('switch-exhaustiveness-check (section 3.5)', { timeout: 30_000 }, () => {
  const missing = [
    "type Phase = 'idle' | 'playing' | 'faulted';",
    'export function label(phase: Phase): string {',
    '  switch (phase) {',
    "    case 'idle':",
    "      return 'Idle';",
    '    default:',
    "      return 'Other';",
    '  }',
    '}',
  ].join('\n');

  it.each(SWITCH_FIXTURES)(
    'flags a switch whose default hides a missing union member, in %s',
    async (path) => {
      expect(await flagged(path, missing, [SWITCH])).toEqual([
        'Switch is not exhaustive. Cases not matched: "faulted" | "playing"',
      ]);
    },
  );

  it('flags a switch over a nullable string that names no null case', async () => {
    const code = [
      'export function help(code: string | null): string | null {',
      '  switch (code) {',
      "    case 'pairing_expired':",
      "      return 'expired';",
      '    default:',
      '      return null;',
      '  }',
      '}',
    ].join('\n');
    expect(await flagged('apps/portal/src/lib/fixture.ts', code, [SWITCH])).toEqual([
      'Switch is not exhaustive. Cases not matched: null',
    ]);
  });

  it('accepts a switch that names every member, and a plain string switch with a default', async () => {
    const code = [
      "type Phase = 'idle' | 'playing';",
      'export function label(phase: Phase): string {',
      '  switch (phase) {',
      "    case 'idle':",
      "      return 'Idle';",
      "    case 'playing':",
      "      return 'Playing';",
      '  }',
      '}',
      'export function kind(name: string): number {',
      '  switch (name) {',
      "    case 'a':",
      '      return 1;',
      '    default:',
      '      return 0;',
      '  }',
      '}',
    ].join('\n');
    expect(await flagged('apps/portal/src/lib/fixture.ts', code, [SWITCH])).toEqual([]);
  });
});

describe('no non-null assertion outside tests (section 3.5)', () => {
  const code = 'export const size = (value?: string): number => value!.length;';
  const NON_NULL_MESSAGE = /^Do not assert a value is not null or undefined with `!`\. Handle/;

  it.each([
    'apps/api/src/fixture.ts',
    'apps/portal/src/features/fixture.tsx',
    'apps/portal/vite.config.ts',
    'apps/player-web/src/core/fixture.ts',
    'apps/player-web/sw/sw.ts',
    'packages/db/src/fixture.ts',
    'packages/contracts/src/fixture.ts',
    'scripts/lib/fixture.ts',
    'vitest.config.ts',
  ])(
    'flags a non-null assertion in %s, with a message that names the alternative',
    async (path) => {
      const messages = await flagged(path, code, [SYNTAX, NON_NULL]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(NON_NULL_MESSAGE);
    },
  );

  it('is stated once: the typescript-eslint rule, whose message names no alternative, is off', async () => {
    const resolved =
      ((await repository.calculateConfigForFile('apps/api/src/fixture.ts')) as Linter.Config)
        .rules ?? {};
    const entry = resolved[NON_NULL];
    const severity = Array.isArray(entry) ? entry[0] : entry;
    expect([undefined, 0, 'off']).toContain(severity);
  });

  // The test globs are TEST_FILES of eslint.config.js, the list the test-hygiene rules use; the
  // .test.tsx, .test-support.tsx and setup entries were missing from the old hand-written list.
  it.each([
    'apps/api/src/fixture.test.ts',
    'apps/api/test/fixture.integration.test.ts',
    'apps/portal/src/fixture.test.tsx',
    'apps/portal/src/session/fixture.test-support.tsx',
    'apps/portal/src/fixture.test-support.ts',
    'apps/portal/src/componentTests.setup.ts',
    'scripts/vitest-integration-setup.ts',
    'tests/integration/fixture.test.ts',
  ])('allows it in the test file %s', async (path) => {
    expect(await flagged(path, code, [SYNTAX, NON_NULL])).toEqual([]);
  });
});

describe('casts to an inline object type (section 3.2, D25)', () => {
  const INLINE_CAST = /^Do not cast to an inline object type to reach a member/;

  it.each([
    ['a plain cast', 'export const c = (error as { code?: unknown }).code;'],
    ['the union form', 'export const c = (error as { code?: unknown } | null)?.code;'],
    ['a parenthesised type', 'export const c = (error as ({ code?: unknown })).code;'],
    ['an intersection', 'export const c = (error as Error & { code?: unknown }).code;'],
    ['an angle-bracket assertion', 'export const c = (<{ code?: unknown }>error).code;'],
    ['a cast of parsed JSON', "export const c = JSON.parse('{}') as { exceptions: string[] };"],
    ['an array of inline objects', 'export const c = (rows as { id: string }[])[0];'],
    ['a generic argument', 'export const c = (rows as Array<{ id: string }>)[0];'],
    ['a Readonly wrapper', 'export const c = (row as Readonly<{ id: string }>).id;'],
    [
      'a union holding an intersection',
      'export const c = (error as (Error & { code?: unknown }) | null)?.code;',
    ],
    // One report for the outermost literal, not one per nested literal.
    ['a nested literal, once', 'export const c = (row as { a: { b: string } }[])[0];'],
    ['a double cast', 'export const c = (row as unknown as { id: string }).id;'],
  ])('flags %s', async (_name, code) => {
    const messages = await flagged('apps/api/src/fixture.ts', code, [SYNTAX]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(INLINE_CAST);
  });

  it.each([
    'apps/media-worker/src/fixture.ts',
    'apps/player-web/src/platform/fixture.ts',
    'packages/db/src/fixture.ts',
    'packages/contracts/src/fixture.ts',
    'apps/player-web/sw/sw.ts',
    'scripts/fixture.ts',
    'scripts/lib/fixture.ts',
  ])('flags it in %s', async (path) => {
    const code = 'export const c = (error as { code?: unknown } | null)?.code;';
    const messages = await flagged(path, code, [SYNTAX]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(INLINE_CAST);
  });

  it('flags it in portal source, which keeps the portal selectors', async () => {
    const messages = await flagged(
      'apps/portal/src/features/fixture.tsx',
      "const c = (error as { code?: unknown }).code; const x = <div dangerouslySetInnerHTML={{ __html: '' }} />;",
      [SYNTAX],
    );
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(INLINE_CAST),
        'dangerouslySetInnerHTML is not allowed.',
      ]),
    );
  });

  it('leaves named types, query row types, type predicates and satisfies alone', async () => {
    const code = [
      'export const a = value as Error;',
      'export const b = value as unknown;',
      "export const k = ['a'] as const;",
      "export const r = await tx.query<{ ok: boolean }>('SELECT true AS ok');",
      // Only the cast's type is searched, not the expression being cast.
      "export const q = tx.query<{ ok: boolean }>('SELECT true AS ok') as Promise<Result>;",
      'export const f = ((o: { a: number }) => o.a) as Handler;',
      'export const isUser = (u: unknown): u is { id?: unknown } => typeof u === "object";',
      'export const s = { a: 1 } satisfies { a: number };',
      'export const t: { a: number } = { a: 1 };',
    ].join('\n');
    expect(await flagged('apps/api/src/fixture.ts', code, [SYNTAX])).toEqual([]);
  });

  it.each([
    'apps/api/src/fixture.test.ts',
    'apps/api/test/fixture.ts',
    'apps/portal/src/fixture.test.tsx',
    'scripts/lib/fixture.test.ts',
    'tests/integration/fixture.test.ts',
  ])('leaves the test file %s alone', async (path) => {
    const code = 'export const c = (error as { code?: unknown }).code;';
    expect(await flagged(path, code, [SYNTAX])).toEqual([]);
  });
});

describe('casts to MigratorPool (SEC-1, D4)', () => {
  const MIGRATOR_CAST = /^Do not cast to MigratorPool: .*Call connectMigrator\(connectionString/;

  it.each([
    ['a plain cast', 'export const p = pool as MigratorPool;'],
    ['a double cast', 'export const p = pool as unknown as MigratorPool;'],
    ['an angle-bracket assertion', 'export const p = <MigratorPool>pool;'],
    ['a union', 'export const p = pool as MigratorPool | undefined;'],
    ['a generic argument', 'export const p = connect() as Promise<MigratorPool>;'],
    ['a qualified name', 'export const p = pool as db.MigratorPool;'],
  ])('flags %s', async (_name, code) => {
    const messages = await flagged('apps/api/src/routes/fixture.ts', code, [SYNTAX]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(MIGRATOR_CAST);
  });

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/mail.ts',
    'apps/media-worker/src/fixture.ts',
    'packages/db/src/fixture.ts',
    'packages/delivery/src/fixture.ts',
    'apps/portal/src/features/fixture.tsx',
    'apps/portal/vite.config.ts',
    'apps/player-web/sw/sw.ts',
    'scripts/provision-member.ts',
    'scripts/seed.ts',
    'scripts/lib/provision.ts',
    'vitest.config.ts',
    // Tests too: they connect through connectMigrator, so no test needs to mint one.
    'tests/integration/fixture.test.ts',
    'packages/db/test/fixture.integration.test.ts',
    'apps/api/src/fixture.test.ts',
    'apps/portal/src/fixture.test.tsx',
    'apps/portal/src/testFrame.test-support.ts',
  ])('flags it in %s', async (path) => {
    const messages = await flagged(path, 'export const p = pool as MigratorPool;', [SYNTAX]);
    expect(messages).toEqual([expect.stringMatching(MIGRATOR_CAST)]);
  });

  it('leaves the type in annotations and other casts alone', async () => {
    const code = [
      'export async function run(pool: MigratorPool): Promise<void> {}',
      'export let held: MigratorPool | undefined;',
      'export const p = pool as Pool;',
    ].join('\n');
    expect(await flagged('scripts/lib/fixture.ts', code, [SYNTAX])).toEqual([]);
  });

  it('lets packages/db/src/migrate.ts mint it, and keeps that file the rest of its list', async () => {
    const path = 'packages/db/src/migrate.ts';
    expect(await flagged(path, 'export const p = pool as MigratorPool;', [SYNTAX])).toEqual([]);
    const messages = await flagged(
      path,
      "export const v = a!; export const c = (e as { a: 1 }).a; export const m = await import('node:https');",
      [SYNTAX],
    );
    expect(messages).toEqual([
      expect.stringMatching(/^Do not assert a value is not null/),
      expect.stringMatching(/^Do not cast to an inline object type/),
      expect.stringMatching(/Outbound calls need a data-location review/),
    ]);
  });
});

describe('casts to a transaction handle (D2, CX-01, AG-2.1)', { timeout: 30_000 }, () => {
  const TX_CAST =
    /^Do not cast to a transaction handle \(Tx, OrgTx, OrgReadTx, PreOrgTx, DefinerTx\): .*Use the tx that the callback of readOrg receives \(an OrgReadTx\) or of changeOrg \(an OrgTx; an operator route calls changeAsOperator\(ctx, request, fn\) from apps\/api\/src\/auth\/permissions\.ts\), or, before the organisation is known, the one the callback of changePreOrg receives \(a PreOrgTx, for the sec\.\* wrappers\) and the OrgTx its enterOrg returns, all from @tinnox\/db\. A test opens one with withOrg or inTx from @tinnox\/db\/testing\. .*auditStandalone\(pool, event\)\.$/;

  it.each([
    ['a plain cast', 'export const tx = poolAsTx(pool) as Tx;'],
    ['a double cast', 'export const tx = pool as unknown as Tx;'],
    ['an angle-bracket assertion', 'export const tx = <Tx>handle;'],
    ['a union', 'export const tx = handle as Tx | undefined;'],
    ['a generic argument', 'export const tx = open() as Promise<Tx>;'],
    ['a wrapped handle', 'export const tx = handle as Readonly<Tx>;'],
    ['a qualified name', 'export const tx = handle as db.Tx;'],
    // Step 18: the handle with the organisation set, the one before it, and the definer's.
    ['a cast to OrgTx', 'export const tx = pre as OrgTx;'],
    ['a double cast to OrgTx', 'export const tx = pre as unknown as OrgTx;'],
    ['a cast to PreOrgTx', 'export const tx = poolAsTx(pool) as PreOrgTx;'],
    ['a cast to DefinerTx', 'export const tx = handle as DefinerTx;'],
    ['a qualified OrgTx', 'export const tx = <db.OrgTx>handle;'],
  ])('flags %s', async (_name, code) => {
    const messages = await flagged('apps/api/src/routes/fixture.ts', code, [SYNTAX]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(TX_CAST);
  });

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/mail.ts',
    'apps/api/src/config.ts',
    'apps/media-worker/src/fixture.ts',
    // packages/db too: run() builds the handle with its mark, so nothing there needs the cast.
    'packages/db/src/tx.ts',
    'packages/db/src/sec.ts',
    'packages/db/src/migrate.ts',
    'packages/db/src/definer.ts',
    'packages/db/src/pre-org.ts',
    'packages/db/src/org-id.ts',
    'packages/delivery/src/fixture.ts',
    'apps/portal/src/features/fixture.tsx',
    'apps/player-web/sw/sw.ts',
    'scripts/seed.ts',
    'scripts/lib/provision.ts',
    'vitest.config.ts',
    // Tests open a real transaction instead (inTx, withoutOrg).
    'tests/integration/fixture.test.ts',
    'packages/db/test/fixture.integration.test.ts',
    'packages/db/test/support.ts',
    'packages/db/src/fixture.test.ts',
    'apps/api/test/support.ts',
    'apps/api/src/fixture.test.ts',
    'apps/portal/src/fixture.test.tsx',
    'apps/portal/src/testFrame.test-support.ts',
  ])('flags it in %s', async (path) => {
    const code = 'export const tx = poolAsTx(pool) as Tx; export const o = pre as OrgTx;';
    expect(await flagged(path, code, [SYNTAX])).toEqual([
      expect.stringMatching(TX_CAST),
      expect.stringMatching(TX_CAST),
    ]);
  });

  it('leaves the types in annotations, the Autocommit handle and other casts alone', async () => {
    const code = [
      'export async function rename(tx: OrgTx, id: string): Promise<void> {}',
      'export const run = (fn: (tx: PreOrgTx) => Promise<void>): Promise<void> => withoutOrg(pool, fn);',
      'export const read = (definer: DefinerTx): Promise<unknown> => definer.query(TEXT);',
      'export const unscoped: Autocommit = poolAsTx(pool);',
      'export const p = handle as Autocommit;',
      'export const kept: Tx[] = [];',
    ].join('\n');
    expect(await flagged('apps/api/src/fixture.ts', code, [SYNTAX])).toEqual([]);
    expect(await flagged('packages/db/test/fixture.integration.test.ts', code, [SYNTAX])).toEqual(
      [],
    );
  });

  it('keeps the MigratorPool ban beside it in every list', async () => {
    const code = 'export const tx = handle as Tx; export const p = pool as MigratorPool;';
    for (const path of ['apps/api/src/fixture.ts', 'tests/integration/fixture.test.ts']) {
      expect(await flagged(path, code, [SYNTAX])).toEqual([
        expect.stringMatching(TX_CAST),
        expect.stringMatching(/^Do not cast to MigratorPool: /),
      ]);
    }
  });
});

// AG-2.3 (adoption plan step 18, D25): withOrg and enterOrg take an OrgId, and the type checker
// refuses a string there (packages/db/src/tx.test.ts, apps/api/src/org-from-request.test.ts).
// This is the other half: nothing outside packages/db/src/org-id.ts says that a value is one.
describe(
  'making an OrgId outside packages/db/src/org-id.ts (AG-2.3, D25)',
  { timeout: 30_000 },
  () => {
    const FORGED =
      /^Do not make an OrgId here \(AG-2\.3\): not by a cast, a type predicate, or a type argument of a call .* operatorOf\(request\)\.orgId, the device credential .* newOrgId\(\), .* asDefiner \(both from @tinnox\/db\/migrate\)\. A test names its organisation with testOrgId\(id\) from @tinnox\/db\/testing\.$/;

    it.each([
      ['a plain cast', 'export const org = request.params.id as OrgId;'],
      ['a double cast', 'export const org = body as unknown as OrgId;'],
      ['an angle-bracket assertion', 'export const org = <OrgId>id;'],
      ['a union', 'export const org = id as OrgId | null;'],
      ['a generic argument', 'export const org = read() as Promise<OrgId>;'],
      ['a list', 'export const orgs = ids as OrgId[];'],
      ['a qualified name', 'export const org = id as db.OrgId;'],
      ['a type predicate', 'export const isOrg = (id: string): id is OrgId => true;'],
      [
        'an assertion signature',
        'export function assertOrg(id: string): asserts id is OrgId { void id; }',
      ],
      [
        'the row type of a query',
        "export const found = await tx.query<{ org_id: OrgId }>('SELECT $1::uuid AS org_id', [id]);",
      ],
      ['a zod type taken on trust', 'export const Org = z.custom<OrgId>();'],
      // Only expectTypeOf and its matchers are let through, not any method that starts with "to".
      ['a method that takes the type on trust', 'export const org = input.toBranded<OrgId>();'],
      [
        "a route's Params type",
        "app.get<{ Params: { tenant: OrgId } }>('/x/:tenant', (request) => withOrg(pool, request.params.tenant, read));",
      ],
    ])('flags %s', async (_name, code) => {
      const messages = await flagged('apps/api/src/routes/fixture.ts', code, [SYNTAX]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(FORGED);
    });

    it.each([
      'apps/api/src/fixture.ts',
      'apps/api/src/routes/fixture.ts',
      'apps/api/src/main.ts',
      'apps/api/src/mail.ts',
      'apps/api/src/config.ts',
      'apps/media-worker/src/fixture.ts',
      // packages/db too, in every file but the one that makes it: the lookups call mintOrgId.
      'packages/db/src/tx.ts',
      'packages/db/src/sec.ts',
      'packages/db/src/definer.ts',
      'packages/db/src/migrate.ts',
      'packages/db/src/testing.ts',
      'packages/delivery/src/fixture.ts',
      'apps/portal/src/features/fixture.tsx',
      'apps/player-web/sw/sw.ts',
      // D25: scripts are in scope, the two that may call newOrgId included.
      'scripts/provision-member.ts',
      'scripts/seed.ts',
      'scripts/lib/provision.ts',
      'scripts/lib/fixture.ts',
      'vitest.config.ts',
      // Tests too: testOrgId from '@tinnox/db/testing' is their way.
      'tests/integration/fixture.test.ts',
      'tests/e2e/support/database.ts',
      'packages/db/test/fixture.integration.test.ts',
      'packages/db/test/support.ts',
      'packages/db/src/fixture.test.ts',
      'apps/api/test/support.ts',
      'apps/api/src/fixture.test.ts',
      'scripts/lib/fixture.test.ts',
      'apps/portal/src/fixture.test.tsx',
      'apps/portal/src/testFrame.test-support.ts',
    ])('flags a cast and a query row type in %s', async (path) => {
      const code =
        'export const org = id as OrgId; export const rows = await tx.query<{ org_id: OrgId }>(TEXT);';
      expect(await flagged(path, code, [SYNTAX])).toEqual([
        expect.stringMatching(FORGED),
        expect.stringMatching(FORGED),
      ]);
    });

    it('leaves the type in annotations, in a collection and in a type test alone', async () => {
      const code = [
        'export async function enter(pool: Pool, orgId: OrgId): Promise<void> {}',
        'export interface Job { readonly orgId: OrgId }',
        'export const byOrg = new Map<OrgId, string[]>();',
        'export const first = (ids: readonly OrgId[]): OrgId | undefined => ids[0];',
        'export const other = id as string;',
        // The matchers of expectTypeOf only compare types (packages/db/src/sec.test.ts).
        'expectTypeOf<OrgId>().toExtend<string>();',
        'expectTypeOf(withOrg).parameter(1).toEqualTypeOf<OrgId>();',
        'expectTypeOf<string>().not.toExtend<OrgId>();',
      ].join('\n');
      for (const path of [
        'apps/api/src/fixture.ts',
        'scripts/lib/fixture.ts',
        'packages/db/src/fixture.test.ts',
        'tests/integration/fixture.test.ts',
      ]) {
        expect(await flagged(path, code, [SYNTAX]), path).toEqual([]);
      }
    });

    it('lets packages/db/src/org-id.ts make it, and keeps that file the rest of its list', async () => {
      const path = 'packages/db/src/org-id.ts';
      expect(await flagged(path, 'export const org = value as OrgId;', [SYNTAX])).toEqual([]);
      const rest =
        "export const v = a!; export const t = h as OrgTx; export const p = pool as MigratorPool; export const r = 'RESET ROLE';";
      expect(await flagged(path, rest, [SYNTAX])).toEqual([
        expect.stringMatching(/^Do not assert a value is not null/),
        expect.stringMatching(/^Do not cast to a transaction handle/),
        expect.stringMatching(/^Do not cast to MigratorPool: /),
        expect.stringMatching(/^Do not switch the database role here/),
      ]);
    });

    it('keeps the other brand bans beside it in every list', async () => {
      const code =
        'export const org = id as OrgId; export const tx = handle as OrgTx; export const p = pool as MigratorPool;';
      for (const path of [
        'apps/api/src/fixture.ts',
        'scripts/lib/provision.ts',
        'tests/integration/fixture.test.ts',
      ]) {
        expect(await flagged(path, code, [SYNTAX])).toEqual([
          expect.stringMatching(FORGED),
          expect.stringMatching(/^Do not cast to a transaction handle/),
          expect.stringMatching(/^Do not cast to MigratorPool: /),
        ]);
      }
    });
  },
);
