/**
 * The two closed lists of reasons for "no audit row" and how they relate (D3; adoption plan
 * section 2.1 B, step 20). A change to either list is a decision: this pins both, so the
 * decision is made here on purpose and not by a route that needed a word.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  GRANTED_UNAUDITED_REASONS,
  NO_AUDIT_REASONS,
  STATED_UNAUDITED_REASONS,
  UNAUDITED_REASONS,
  type NoAuditReason,
  type StatedUnauditedReason,
  type UnauditedReason,
} from './index.ts';

describe('the reasons for writing no audit row (D3)', () => {
  it('pins what a route may state, and what one run of a change may say', () => {
    expect(Object.keys(NO_AUDIT_REASONS).sort()).toEqual(['login_state', 'read_only', 'telemetry']);
    expect(Object.keys(UNAUDITED_REASONS).sort()).toEqual([
      'alert_closed_silently',
      'counter_under_threshold',
      'development_seed',
      'idempotent_replay',
      'nothing_changed',
      'pairing_expired_by_time',
      'telemetry',
    ]);
    for (const [reason, why] of [
      ...Object.entries(NO_AUDIT_REASONS),
      ...Object.entries(UNAUDITED_REASONS),
    ]) {
      expect(why.length, `${reason} needs a sentence a reviewer can check`).toBeGreaterThan(60);
    }
  });

  it('a reason of both lists means the same in both, and is the only kind a route must state', () => {
    const shared = Object.keys(UNAUDITED_REASONS).filter((reason) =>
      Object.hasOwn(NO_AUDIT_REASONS, reason),
    );
    expect(
      [...STATED_UNAUDITED_REASONS],
      'STATED_UNAUDITED_REASONS lists the reasons UNAUDITED_REASONS shares with NO_AUDIT_REASONS, and only those: changeOrg takes one only under a statement that gives the same',
    ).toEqual(shared);
    for (const reason of STATED_UNAUDITED_REASONS) {
      expect(UNAUDITED_REASONS[reason]).toBe(NO_AUDIT_REASONS[reason]);
    }
    expectTypeOf<StatedUnauditedReason>().toEqualTypeOf<'telemetry'>();
    expectTypeOf<
      (typeof STATED_UNAUDITED_REASONS)[number]
    >().toEqualTypeOf<StatedUnauditedReason>();
  });

  it('a write left unaudited on purpose is granted by its route, not open to every change (step 20 review)', () => {
    // Every reason that is not what one run found (nothing changed, a replay) is held to the
    // route: by the route's own statement (telemetry) or by its grant (a counter).
    expect([...GRANTED_UNAUDITED_REASONS]).toEqual([
      'counter_under_threshold',
      'alert_closed_silently',
      'pairing_expired_by_time',
      'development_seed',
    ]);
    const open = Object.keys(UNAUDITED_REASONS).filter(
      (reason) =>
        !(STATED_UNAUDITED_REASONS as readonly string[]).includes(reason) &&
        !(GRANTED_UNAUDITED_REASONS as readonly string[]).includes(reason),
    );
    expect(open.sort()).toEqual(['idempotent_replay', 'nothing_changed']);
  });

  it('a change never says it only read, nor that it stored login state', () => {
    // A route that only reads opens readOrg; the login state is stored outside any change (D2).
    expectTypeOf<'read_only'>().not.toExtend<UnauditedReason>();
    expectTypeOf<'login_state'>().not.toExtend<UnauditedReason>();
    // And a route never states what only one run can find.
    expectTypeOf<'nothing_changed'>().not.toExtend<NoAuditReason>();
    expectTypeOf<'idempotent_replay'>().not.toExtend<NoAuditReason>();
    expectTypeOf<'counter_under_threshold'>().not.toExtend<NoAuditReason>();
    // Nor a route that it closes, expires or seeds: those are granted, never stated.
    expectTypeOf<'alert_closed_silently'>().not.toExtend<NoAuditReason>();
    expectTypeOf<'pairing_expired_by_time'>().not.toExtend<NoAuditReason>();
    expectTypeOf<'development_seed'>().not.toExtend<NoAuditReason>();
  });

  it('the three writes step 20 kept unaudited as built name their write and the open decision', () => {
    // Today's behaviour, recorded so it can be searched for; not a decision that it needs no
    // audit row (CMS-36 for the first two).
    expect(UNAUDITED_REASONS.alert_closed_silently).toMatch(/display_alert.*CMS-36/);
    expect(UNAUDITED_REASONS.pairing_expired_by_time).toMatch(
      /sec\.pairing_create.*sec\.pairing_poll.*CMS-36/,
    );
    expect(UNAUDITED_REASONS.development_seed).toMatch(/scripts\/seed\.ts.*tinnox_migrator/);
  });
});
