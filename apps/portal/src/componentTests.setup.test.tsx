import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

/** What the probe's effect did, in order. */
const steps: string[] = [];

function Probe() {
  useEffect(() => {
    steps.push('effect');
    return () => {
      steps.push('cleanup');
    };
  }, []);
  return <p>probe</p>;
}

describe('the component test setup', () => {
  // StrictMode runs a new component's effects, their cleanup, then the effects again. That
  // extra pass is what makes an effect that is not safe to run twice fail its test.
  it('renders every component inside StrictMode, as main.tsx does (EAX-11)', async () => {
    const screen = await render(<Probe />);
    await expect.element(screen.getByText('probe')).toBeVisible();
    expect(
      steps,
      "component tests must render in StrictMode: keep configure({ reactStrictMode: true }) from 'vitest-browser-react/pure' in apps/portal/src/componentTests.setup.ts",
    ).toEqual(['effect', 'cleanup', 'effect']);
  });
});
