/**
 * What the offline tools read as tinnox_definer (D25, adoption plan step 18): a row's `org_id`
 * is typed `OrgId`, and nothing else of the row changes. The definer's handle is no `OrgTx`.
 * Checked by `npm run typecheck`, which reads this file.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DefinerTx } from './definer.ts';
import type { Autocommit, OrgId, OrgTx, PreOrgTx } from './index.ts';
import { mintOrgId, readAsDefiner, type DefinerRow } from './org-id.ts';
import type { QueryResult } from './pool.ts';

describe('a row read as the definer (D25)', () => {
  it('has its org_id typed OrgId, null kept, and every other column as it was', () => {
    expectTypeOf<DefinerRow<{ id: string; org_id: string }>>().toEqualTypeOf<{
      id: string;
      org_id: OrgId;
    }>();
    expectTypeOf<DefinerRow<{ org_id: string | null; n: number }>>().toEqualTypeOf<{
      org_id: OrgId | null;
      n: number;
    }>();
    // Only the column named org_id: an id under another name stays a string.
    expectTypeOf<DefinerRow<{ id: string; organisation: string; orgId: string }>>().toEqualTypeOf<{
      id: string;
      organisation: string;
      orgId: string;
    }>();
  });

  it('is what the handle of asDefiner returns, so the organisation can be entered', () => {
    // Never called: these lines are for the type checker.
    const cases = async (
      definer: DefinerTx,
      enterOrg: (orgId: OrgId) => Promise<OrgTx>,
    ): Promise<void> => {
      const { rows } = await definer.query<{ id: string; org_id: string }>('SELECT 1');
      const row = rows[0];
      if (row === undefined) return;
      await enterOrg(row.org_id);
      // @ts-expect-error another column of the row is a string, not an OrgId
      await enterOrg(row.id);
    };
    expect(cases).toBeTypeOf('function');
  });

  it('the handle of asDefiner is not an OrgTx, a PreOrgTx or an Autocommit', () => {
    expectTypeOf<DefinerTx>().not.toExtend<OrgTx>();
    expectTypeOf<DefinerTx>().not.toExtend<PreOrgTx>();
    expectTypeOf<DefinerTx>().not.toExtend<Autocommit>();
    expectTypeOf<OrgTx>().not.toExtend<DefinerTx>();
  });

  it('changes nothing at run time: the result and the value are passed through', () => {
    const result = { rows: [{ org_id: 'an-id' }], rowCount: 1 } as unknown as QueryResult<{
      org_id: string;
    }>;
    expect(readAsDefiner(result)).toBe(result);
    expect(mintOrgId('an-id')).toBe('an-id');
  });
});
