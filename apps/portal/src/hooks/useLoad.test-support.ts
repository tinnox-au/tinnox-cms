// fast-check generators for useLoad's scheduler (adoption plan section 4.4, property 13, UTX-03).
//
// Choosing a generator: a case is the answer of the first read and a sequence of steps, each a
// way the next read starts (the pending timer fires, or reload() is called) and how it ends (data
// with something processing, data with nothing processing, or a failure). Every sequence is
// valid, so there is nothing to self-check beyond the length the property relies on.
import fc from 'fast-check';

export type Outcome = 'busy' | 'idle' | 'fail';

export interface Step {
  /** 'tick': the pending timer fires (nothing happens when none is pending); 'reload': reload(). */
  readonly start: 'tick' | 'reload';
  readonly outcome: Outcome;
}

export const MAX_STEPS = 12;

const outcomeArb: fc.Arbitrary<Outcome> = fc.constantFrom('busy', 'idle', 'fail');

export const readSequenceArb: fc.Arbitrary<{ first: Outcome; steps: Step[] }> = fc.record({
  first: outcomeArb,
  steps: fc.array(
    fc.record({ start: fc.constantFrom('tick' as const, 'reload' as const), outcome: outcomeArb }),
    { maxLength: MAX_STEPS },
  ),
});
