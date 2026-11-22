/**
 * The rules of the runner's schema invariants over hand-made facts (plan section 3.3, EAX-12).
 * No database: packages/db/test/catalogue.integration.test.ts and migrate.integration.test.ts
 * run the same rules on what readSchemaFacts reads.
 */
import { describe, expect, it } from 'vitest';
import {
  SchemaInvariantError,
  ownershipProblems,
  rowSecurityProblems,
  schemaInvariantProblems,
  secFunctionProblems,
  tenantPolicy,
  tenantPolicyProblems,
  triggerProblems,
  type SchemaFacts,
  type SecFunctionFacts,
  type TableFacts,
} from './schema-invariants.ts';

const GOOD_FUNCTION: SecFunctionFacts = {
  name: 'sec.session_revoke(bytea)',
  securityDefiner: true,
  owner: 'tinnox_definer',
  settings: ['search_path=pg_catalog, pg_temp'],
  executors: ['tinnox_app'],
};
const TENANT_TABLE: TableFacts = {
  name: 'public.media',
  rowSecurity: true,
  forced: true,
  policies: [tenantPolicy('public.media')],
  runtimePrivileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE (name)'],
};
/** Read before the organisation is known: forced, no policy, nothing for tinnox_app. */
const DEFINER_ONLY_TABLE: TableFacts = {
  name: 'public.session',
  rowSecurity: true,
  forced: true,
  policies: [],
  runtimePrivileges: [],
};
const GOOD: SchemaFacts = {
  secFunctions: [GOOD_FUNCTION],
  owned: [
    { owner: 'tinnox_definer', object: 'function sec.session_revoke(bytea)', secFunction: true },
  ],
  definersOutsideSec: [],
  tables: [TENANT_TABLE, DEFINER_ONLY_TABLE],
  disabledTriggers: [],
};

const withFunction = (change: Partial<SecFunctionFacts>): SchemaFacts => ({
  ...GOOD,
  secFunctions: [{ ...GOOD_FUNCTION, ...change }],
});
const withTable = (change: Partial<TableFacts>): SchemaFacts => ({
  ...GOOD,
  tables: [{ ...TENANT_TABLE, ...change }],
});

describe('schemaInvariantProblems', () => {
  it('finds nothing in a schema that holds every invariant', () => {
    expect(schemaInvariantProblems(GOOD)).toEqual([]);
  });

  it('is every rule: one fault of each kind gives one sentence each', () => {
    const problems = schemaInvariantProblems({
      secFunctions: [{ ...GOOD_FUNCTION, settings: null }],
      owned: [{ owner: 'tinnox_app', object: 'table public.media', secFunction: false }],
      definersOutsideSec: [],
      tables: [
        { ...TENANT_TABLE, forced: false },
        { ...DEFINER_ONLY_TABLE, policies: [] },
      ],
      disabledTriggers: ['public.media.media_set_updated_at [tgenabled = D]'],
    });
    expect(problems).toHaveLength(4);
  });
});

describe('sec.* functions (AG-1.13, AG-1.15)', () => {
  it('a function with no SET clause at all is not pinned: the missing value counts as unsafe (EAX-12)', () => {
    // proconfig is NULL for such a function. The guard pasted into 0002 to 0013 computed
    // NOT (NULL), which is not true, and let it through.
    expect(secFunctionProblems(withFunction({ settings: null }))).toEqual([
      expect.stringMatching(
        /^sec\.session_revoke\(bytea\) does not pin its search_path \(its SET clauses: none\).*SET search_path = pg_catalog, pg_temp/,
      ),
    ]);
  });

  it('another search_path, or another setting only, is not pinned either', () => {
    for (const settings of [['search_path=public'], ['statement_timeout=5s'], []]) {
      expect(secFunctionProblems(withFunction({ settings })), settings.join()).toHaveLength(1);
    }
    expect(
      secFunctionProblems(
        withFunction({ settings: ['statement_timeout=5s', 'search_path=pg_catalog, pg_temp'] }),
      ),
    ).toEqual([]);
  });

  it('must be SECURITY DEFINER, and an unknown value counts as not', () => {
    for (const securityDefiner of [false, null]) {
      expect(secFunctionProblems(withFunction({ securityDefiner }))).toEqual([
        expect.stringMatching(
          /^sec\.session_revoke\(bytea\) is in schema sec and is not SECURITY DEFINER/,
        ),
      ]);
    }
  });

  it('must be owned by tinnox_definer', () => {
    expect(secFunctionProblems(withFunction({ owner: 'tinnox_migrator' }))).toEqual([
      expect.stringMatching(
        /^sec\.session_revoke\(bytea\) is owned by tinnox_migrator, not tinnox_definer: .*SET LOCAL ROLE tinnox_definer and RESET ROLE/,
      ),
    ]);
  });

  it('is executable by tinnox_app and by nobody else', () => {
    const cases: [readonly string[], RegExp][] = [
      // PostgreSQL's default for a new function, before the migration revokes it.
      [['PUBLIC'], /is executable by PUBLIC, not by tinnox_app alone/],
      [['PUBLIC', 'tinnox_app'], /is executable by PUBLIC, tinnox_app, not by tinnox_app alone/],
      [['tinnox_app', 'tinnox_migrator'], /is executable by tinnox_app, tinnox_migrator, not/],
      [['tinnox_app WITH GRANT OPTION'], /is executable by tinnox_app WITH GRANT OPTION, not/],
      [[], /is executable by nobody but its owner, not by tinnox_app alone/],
    ];
    for (const [executors, message] of cases) {
      const problems = secFunctionProblems(withFunction({ executors }));
      expect(problems, executors.join()).toEqual([expect.stringMatching(message)]);
      expect(problems[0]).toMatch(
        /REVOKE ALL ON FUNCTION sec\.session_revoke\(bytea\) FROM PUBLIC and GRANT EXECUTE ON FUNCTION sec\.session_revoke\(bytea\) TO tinnox_app/,
      );
    }
  });
});

describe('ownership (AG-1.4, AG-1.12)', () => {
  it('tinnox_app owns nothing, and tinnox_definer only the functions in sec', () => {
    expect(
      ownershipProblems({
        ...GOOD,
        owned: [
          ...GOOD.owned,
          { owner: 'tinnox_app', object: 'table public.media', secFunction: false },
          { owner: 'tinnox_definer', object: 'table sec.cache', secFunction: false },
        ],
      }),
    ).toEqual([
      expect.stringMatching(/^tinnox_app owns table public\.media: the runtime role owns nothing/),
      expect.stringMatching(
        /^tinnox_definer owns table sec\.cache: it owns only the functions in schema sec/,
      ),
    ]);
  });

  it('no function outside sec is SECURITY DEFINER', () => {
    expect(ownershipProblems({ ...GOOD, definersOutsideSec: ['public.lookup(uuid)'] })).toEqual([
      expect.stringMatching(/^public\.lookup\(uuid\) is SECURITY DEFINER outside schema sec/),
    ]);
  });
});

describe('row-level security and the tenant policy (AG-1.5, AG-2.5)', () => {
  it('a table with row-level security off, or on and not forced, is refused', () => {
    for (const change of [{ rowSecurity: false }, { forced: false }]) {
      expect(rowSecurityProblems(withTable(change))).toEqual([
        expect.stringMatching(/^public\.media is without forced row-level security/),
      ]);
    }
  });

  it('a table tinnox_app is granted anything on has exactly the tenant policy', () => {
    const cases: (readonly string[])[] = [
      [],
      [
        tenantPolicy('public.media'),
        'probe FOR SELECT PERMISSIVE TO {public} USING true WITH CHECK none',
      ],
      ['tenant_isolation FOR ALL PERMISSIVE TO {public} USING true WITH CHECK true'],
      [tenantPolicy('public.media').replace('{public}', '{tinnox_app}')],
    ];
    for (const policies of cases) {
      expect(tenantPolicyProblems(withTable({ policies })), policies.join('; ')).toEqual([
        expect.stringMatching(
          /^public\.media must have exactly one policy, "tenant_isolation FOR ALL/,
        ),
      ]);
    }
    // One column grant is enough to make it a tenant table.
    expect(
      tenantPolicyProblems(withTable({ policies: [], runtimePrivileges: ['SELECT (id)'] })),
    ).toHaveLength(1);
  });

  it('a grant to PUBLIC, or to a role tinnox_app is a member of, counts as a grant to it', () => {
    // The reader prints how the privilege reaches the runtime role; the rule takes any of them.
    // An open policy on a table read before the organisation is known, plus SELECT for PUBLIC,
    // would show tinnox_app every organisation's rows.
    const open = 'open FOR ALL PERMISSIVE TO {public} USING true WITH CHECK none';
    for (const privilege of [
      'SELECT through PUBLIC',
      'SELECT (expires_at) through PUBLIC',
      'SELECT through readers',
    ]) {
      for (const policies of [[open], []]) {
        const table = { ...DEFINER_ONLY_TABLE, policies, runtimePrivileges: [privilege] };
        const problems = tenantPolicyProblems({ ...GOOD, tables: [table] });
        expect(problems, privilege).toHaveLength(1);
        expect(problems[0]).toContain(
          `and has: ${policies[0] ?? 'none'}. tinnox_app holds ${privilege} on it, so it is a tenant table`,
        );
        expect(problems[0]).toContain(
          'no grant that reaches tinnox_app (to it, to PUBLIC or to a role it is a member of)',
        );
      }
    }
  });

  it('the organisation table is keyed on its own id', () => {
    expect(tenantPolicy('public.organization')).toBe(
      'tenant_isolation FOR ALL PERMISSIVE TO {public} USING (id = public.app_org_id()) WITH CHECK (id = public.app_org_id())',
    );
    expect(tenantPolicy('public.media')).toContain('USING (org_id = public.app_org_id())');
  });

  it('a table with no grant to tinnox_app needs no policy', () => {
    expect(tenantPolicyProblems({ ...GOOD, tables: [DEFINER_ONLY_TABLE] })).toEqual([]);
  });
});

describe('triggers', () => {
  it('a trigger left disabled is refused, with how to put it back', () => {
    expect(
      triggerProblems({
        ...GOOD,
        disabledTriggers: ['public.display.display_set_updated_at [tgenabled = D]'],
      }),
    ).toEqual([
      expect.stringMatching(
        /^trigger public\.display\.display_set_updated_at \[tgenabled = D\] does not fire.*ENABLE TRIGGER/,
      ),
    ]);
  });
});

describe('SchemaInvariantError', () => {
  it('lists every problem and names the file that holds the rules', () => {
    const error = new SchemaInvariantError(['first problem.', 'second problem.']);
    expect(error.problems).toEqual(['first problem.', 'second problem.']);
    expect(error.message).toBe(
      'the schema breaks 2 invariants (packages/db/src/schema-invariants.ts):\n  - first problem.\n  - second problem.',
    );
    expect(new SchemaInvariantError(['one.'], 'Do this next.').message).toBe(
      'the schema breaks 1 invariant (packages/db/src/schema-invariants.ts):\n  - one.\nDo this next.',
    );
  });
});
