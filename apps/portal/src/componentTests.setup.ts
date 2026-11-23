import { beforeAll } from 'vitest';
import { configure } from 'vitest-browser-react/pure';
import { settleTestFrame } from './testFrame.test-support.ts';

// Every component renders inside StrictMode, as the app does (main.tsx), so an effect that is
// not safe to run twice (a missing cleanup, a request sent twice) fails its test (EAX-11).
// `render` and `renderHook` from 'vitest-browser-react' read this same setting.
configure({ reactStrictMode: true });

// Every component test file first waits until the browser provider reaches its frame (see
// settleTestFrame), so a new file cannot fail its first click or key on a busy machine.
beforeAll(settleTestFrame);
