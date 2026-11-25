import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { MAX_STEPS, readSequenceArb, type Outcome } from './useLoad.test-support.ts';
import { useLoad } from './useLoad.ts';

// Adoption plan section 4.4, property 13 (UTX-03), and D11: every run draws a fresh seed, and a
// failure prints the seed and the shrunk counterexample. A counterexample is committed below as
// a plain example test with its fix, never as a seed or path.

interface Data {
  readonly processing: boolean;
}

const POLL_MS = 2_000;
const pollWhileProcessing = (data: Data) => (data.processing ? POLL_MS : null);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLoad generators: self-checks', () => {
  it('sequences hold at most the steps the property allows for', () => {
    fc.assert(
      fc.property(readSequenceArb, ({ steps }) => {
        expect(steps.length).toBeLessThanOrEqual(MAX_STEPS);
      }),
    );
  });
});

// 100 async React runs: past the component project's 5 s default on a busy runner.
describe('useLoad: properties (property 13, UTX-03)', { timeout: 30_000 }, () => {
  it('for any sequence of read outcomes, a timer is pending whenever the function poll would answer non-null for the data shown', async () => {
    await fc.assert(
      fc.asyncProperty(readSequenceArb, async ({ first, steps }) => {
        let next: Outcome = first;
        // A read the hook cancels before it goes out never takes an answer (StrictMode's first
        // mount, as in useLoad.test.tsx).
        const read = (signal: AbortSignal): Promise<Data> =>
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            if (next === 'fail') throw new Error('read failed');
            return { processing: next === 'busy' };
          });
        const hook = await renderHook(() => useLoad(read, pollWhileProcessing));
        try {
          const settle = (run: () => unknown) => hook.act(async () => run());
          const check = (when: string) => {
            const { state } = hook.result.current;
            if (state.status === 'ready' && pollWhileProcessing(state.data) !== null) {
              expect({ when, pending: vi.getTimerCount() > 0 }).toEqual({ when, pending: true });
            }
          };
          await settle(() => vi.advanceTimersByTimeAsync(0));
          check('after the first read');
          for (const [n, step] of steps.entries()) {
            next = step.outcome;
            if (step.start === 'tick') {
              await settle(() => vi.advanceTimersToNextTimerAsync());
            } else {
              await settle(() => hook.result.current.reload());
              await settle(() => vi.advanceTimersByTimeAsync(0));
            }
            check(`after step ${n + 1}, ${step.start} then ${step.outcome}`);
          }
        } finally {
          await hook.unmount();
          vi.clearAllTimers();
        }
      }),
    );
  });
});
