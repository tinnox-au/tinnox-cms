/**
 * DEC-23: a publication is created only from a draft a planner returned (adoption plan step 22).
 * Nothing here runs: these lines are for `npm run typecheck`, where an unused @ts-expect-error
 * is an error.
 */
import type { OrgTx } from '@tinnox/db';
import type * as domain from '@tinnox/domain';
import type { PlannedPublication, PublicationDraft } from '@tinnox/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AppContext } from './context.ts';
import { createPublication, type DisplayPlanRow } from './publishing.ts';

describe('createPublication (DEC-23)', () => {
  it('takes a PlannedPublication, never a hand-built draft', () => {
    expectTypeOf<
      Parameters<typeof createPublication>[2]['draft']
    >().toEqualTypeOf<PlannedPublication>();
    const cases = async (
      tx: OrgTx,
      ctx: AppContext,
      display: DisplayPlanRow,
      handBuilt: PublicationDraft,
    ): Promise<void> => {
      const rest = {
        display,
        playlistId: 'a-playlist-id',
        scheduleId: null,
        layoutId: null,
        idempotencyKey: 'a-key',
        membershipId: 'a-membership-id',
        via: 'publish',
      } as const;
      // @ts-expect-error a draft that skipped the route's capability check
      await createPublication(tx, ctx, { ...rest, draft: handBuilt });
      // Every field of a draft, so the missing brand is the only reason it is refused.
      // @ts-expect-error a copied object literal is no better than the variable
      await createPublication(tx, ctx, { ...rest, draft: { ...handBuilt } });
    };
    expect(cases).toBeTypeOf('function');
  });

  it('cannot mint the brand from outside @tinnox/domain', () => {
    // markPlanned lives in packages/domain/src/planned.ts, which the package entry does not
    // re-export; the planners are what the entry offers instead.
    expectTypeOf<'markPlanned' extends keyof typeof domain ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<
      'planPublication' extends keyof typeof domain ? true : false
    >().toEqualTypeOf<true>();
  });
});
