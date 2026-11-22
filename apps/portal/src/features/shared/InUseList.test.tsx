import type { ApiErrorDetail } from '@tinnox/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ApiRequestError } from '../../api/client.ts';
import { app, ID } from '../../lib/mediaLibrary.test-support.ts';
import { DeleteAppDialog } from '../apps/DeleteAppDialog.tsx';
import { DeleteLayoutDialog } from '../layouts/DeleteLayoutDialog.tsx';
import { DeleteScheduleDialog } from '../schedules/DeleteScheduleDialog.tsx';
import { InUseList } from './InUseList.tsx';

const { deleteLayout, deleteSchedule, deleteApp } = vi.hoisted(() => ({
  deleteLayout: vi.fn<(id: string) => Promise<void>>(),
  deleteSchedule: vi.fn<(id: string) => Promise<void>>(),
  deleteApp: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../api/index.ts', () => ({ api: { deleteLayout, deleteSchedule, deleteApp } }));

afterEach(() => {
  vi.restoreAllMocks();
});

/** Watches for React's report of two siblings with one key (it logs it in development builds). */
function watchKeyErrors(): () => string[] {
  const error = vi.spyOn(console, 'error');
  return () =>
    error.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((text) => text.includes('two children with the same key'));
}

/** The text of each row of the list with `testId`. */
function rowsOf(screen: Awaited<ReturnType<typeof render>>, testId: string): (string | null)[] {
  return screen
    .getByTestId(testId)
    .getByRole('listitem')
    .elements()
    .map((row) => row.textContent);
}

const NAMES = ['Lobby', 'Lobby', 'Lift'];

/** A 409 in-use refusal as the API sends it: the names under `path`, and no ids. */
function inUse(code: 'layout_in_use' | 'schedule_in_use' | 'app_in_use', path: string) {
  const details: ApiErrorDetail[] = NAMES.map((message) => ({ path, message }));
  return new ApiRequestError({
    status: 409,
    code,
    message: 'It is in use.',
    details,
    fromApi: true,
  });
}

const close = () => undefined;

const DIALOGS: readonly {
  readonly what: string;
  readonly testId: string;
  readonly list: string;
  readonly refuse: () => void;
  readonly dialog: ReactNode;
}[] = [
  {
    what: 'layout',
    testId: 'layouts-delete-dialog',
    list: 'layouts-delete-screens',
    refuse: () => deleteLayout.mockRejectedValueOnce(inUse('layout_in_use', 'display')),
    dialog: (
      <DeleteLayoutDialog
        layout={{ id: ID(1), name: 'Menu band' }}
        onClose={close}
        onDeleted={close}
      />
    ),
  },
  {
    what: 'schedule',
    testId: 'schedules-delete-dialog',
    list: 'schedules-delete-screens',
    refuse: () => deleteSchedule.mockRejectedValueOnce(inUse('schedule_in_use', 'display')),
    dialog: (
      <DeleteScheduleDialog
        schedule={{ id: ID(2), name: 'Opening hours' }}
        onClose={close}
        onDeleted={close}
      />
    ),
  },
  {
    what: 'app',
    testId: 'apps-delete-dialog',
    list: 'apps-delete-playlists',
    refuse: () => deleteApp.mockRejectedValueOnce(inUse('app_in_use', 'playlist')),
    dialog: <DeleteAppDialog app={app(3)} onClose={close} onDeleted={close} />,
  },
];

describe('the in-use list of the delete dialogs (LYX-04)', () => {
  it.each(DIALOGS)(
    'the $what dialog shows two screens or playlists with the same name as two rows',
    async ({ testId, list, refuse, dialog }) => {
      const keyErrors = watchKeyErrors();
      refuse();
      const screen = await render(dialog);
      await screen.getByTestId(`${testId}-confirm`).click();
      await expect.element(screen.getByTestId(list).getByRole('listitem').nth(2)).toBeVisible();
      expect(rowsOf(screen, list)).toEqual(NAMES);
      expect(keyErrors()).toEqual([]);
    },
  );
});

describe('InUseList (LYX-04)', () => {
  it('keeps every row when the names change between answers', async () => {
    // With the names as keys, React leaves a stale "Lobby" row behind on this change.
    const keyErrors = watchKeyErrors();
    const screen = await render(<InUseList names={['Lobby', 'Lift', 'Lobby']} testId="in-use" />);
    await screen.rerender(<InUseList names={['Lift', 'Lobby', 'Lobby']} testId="in-use" />);
    expect(rowsOf(screen, 'in-use')).toEqual(['Lift', 'Lobby', 'Lobby']);
    expect(keyErrors()).toEqual([]);
  });

  it('renders nothing when the refusal names nothing', async () => {
    const screen = await render(<InUseList names={[]} testId="in-use" />);
    expect(screen.container.querySelector('[data-testid="in-use"]')).toBeNull();
  });
});
