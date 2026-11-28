import type { DisplayDto, PlaylistSummaryDto, Role, TagDto } from '@tinnox/contracts';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ApiRequestError, errorFromResponse, type ClientErrorCode } from '../../../api/client.ts';
import { WithSession } from '../../../session/session.test-support.tsx';
import { ToastProvider } from '../../../ui/index.ts';
import { PushContext, type PushContextValue } from '../../push/PushContext.tsx';
import { ScreensList } from './ScreensList.tsx';
import { useScreensData, type ScreensData } from './useScreensData.ts';

const { patchDisplay, deleteDisplay, getDisplay, listPlaylists, listTags } = vi.hoisted(() => ({
  patchDisplay: vi.fn<(id: string, patch: unknown) => Promise<DisplayDto>>(),
  deleteDisplay: vi.fn<(id: string) => Promise<void>>(),
  getDisplay: vi.fn<(id: string) => Promise<DisplayDto>>(),
  listPlaylists: vi.fn<() => Promise<PlaylistSummaryDto[]>>(),
  listTags: vi.fn<() => Promise<TagDto[]>>(),
}));
vi.mock('../../../api/index.ts', () => ({
  api: { patchDisplay, deleteDisplay, getDisplay, listPlaylists, listTags },
}));
vi.mock('./useScreensData.ts', () => ({ useScreensData: vi.fn() }));
vi.mock('../../../shell/Page.tsx', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    readonly title: string;
    readonly actions?: ReactNode;
    readonly children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

const mockedScreensData = vi.mocked(useScreensData);

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-14T03:00:00.000Z';

function display(n: number, change: Partial<DisplayDto> = {}): DisplayDto {
  return {
    id: ID(n),
    siteId: ID(900),
    name: `Screen ${String(n)}`,
    description: null,
    canvas: { width: 1920, height: 1080 },
    contentRect: null,
    defaultFit: 'contain',
    rotation: 0,
    workingHours: null,
    alertOfflineMinutes: 30,
    alertBackOnline: true,
    route: 'browser',
    player: null,
    tagIds: [],
    assignedPlaylist: null,
    assignedSchedule: null,
    assignedLayout: null,
    createdAt: T,
    updatedAt: T,
    ...change,
  };
}

// The list's copy: a playlist, no schedule. "No playlist" is then a change worth sending.
const LOBBY = display(1, { name: 'Lobby', assignedPlaylist: { id: ID(20), name: 'Loop' } });

const refreshPush = vi.fn<() => void>();

const PUSH: PushContextValue = {
  plan: null,
  planError: null,
  pendingCount: null,
  refresh: refreshPush,
  openDialog: () => undefined,
  openPush: () => undefined,
  refreshPending: () => undefined,
};

function screensData(displays: DisplayDto[]): ScreensData {
  return {
    displays: { status: 'ready', data: displays, refreshError: null, fetchedAt: 0 },
    sites: { status: 'ready', data: [], refreshError: null, fetchedAt: 0 },
    statuses: { status: 'ready', data: [], refreshError: null, fetchedAt: 0 },
    reloadDisplays: () => undefined,
    reloadSites: () => undefined,
    reloadStatuses: () => undefined,
    mergeDisplays: () => undefined,
  };
}

// What the next list read answers; reloadDisplays serves it, as useLoad would.
let served: DisplayDto[] = [];
// True holds the next read until the test calls `landRead`; else it answers in the same render.
let holdRead = false;
let landRead: () => void = () => undefined;
const reloadDisplays = vi.fn<() => void>();
const reloadStatuses = vi.fn<() => void>();

function useServedScreens(): ScreensData {
  const [list, setList] = useState(served);
  return {
    ...screensData(list),
    reloadDisplays: () => {
      reloadDisplays();
      const next = served;
      if (!holdRead) setList(next);
      else
        landRead = () => {
          setList(next);
        };
    },
    reloadStatuses,
  };
}

function renderList(role: Role) {
  return render(
    <MemoryRouter>
      <WithSession role={role}>
        <ToastProvider>
          <PushContext value={PUSH}>
            <ScreensList />
          </PushContext>
        </ToastProvider>
      </WithSession>
    </MemoryRouter>,
  );
}

async function unassignFromLobby() {
  const screen = await renderList('owner');
  await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
  await screen.getByRole('menuitem', { name: 'Assign content' }).click();
  await screen.getByRole('radio', { name: /No playlist/ }).click();
  await screen.getByRole('button', { name: 'Assign playlist' }).click();
  expect(patchDisplay).toHaveBeenCalledTimes(1);
  expect(patchDisplay).toHaveBeenCalledWith(LOBBY.id, { assignedPlaylistId: null });
  return { screen, toasts: screen.getByRole('region', { name: 'Notifications' }) };
}

beforeEach(() => {
  mockedScreensData.mockReturnValue(screensData([LOBBY]));
  listPlaylists.mockResolvedValue([]);
  listTags.mockResolvedValue([]);
  // After a delete's 404 the dialog reads the screen: gone, unless a test says otherwise.
  getDisplay.mockRejectedValue(
    new ApiRequestError({ status: 404, code: 'not_found', message: 'Gone.', fromApi: true }),
  );
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('ScreensList: "No playlist" for one screen', () => {
  it('says the screen now has a schedule when one was assigned elsewhere meanwhile', async () => {
    patchDisplay.mockResolvedValue({
      ...LOBBY,
      assignedPlaylist: null,
      assignedSchedule: {
        id: ID(30),
        name: 'Shop week',
        defaultPlaylist: { id: ID(20), name: 'Loop' },
      },
    });
    const { toasts } = await unassignFromLobby();

    // The message and its detail share one text block, so the message is matched in the stack.
    await expect
      .element(
        toasts.getByText(
          'Its schedule stays assigned. To remove it, use "Remove content" on the screen\'s page.',
        ),
      )
      .toBeVisible();
    expect(toasts.element().textContent).toContain('Lobby now has a schedule');
    expect(toasts.element().textContent).not.toContain('Playlist unassigned from Lobby');
  });

  it('says the screen now has a layout when one was assigned elsewhere meanwhile', async () => {
    patchDisplay.mockResolvedValue({
      ...LOBBY,
      assignedPlaylist: null,
      assignedLayout: {
        id: ID(40),
        name: 'Foyer band',
        mainPlaylist: { id: ID(20), name: 'Loop' },
      },
    });
    const { toasts } = await unassignFromLobby();

    await expect
      .element(
        toasts.getByText(
          'Its layout stays assigned. To remove it, use "Remove content" on the screen\'s page.',
        ),
      )
      .toBeVisible();
    expect(toasts.element().textContent).toContain('Lobby now has a layout');
  });

  it('shows the usual success toast when the screen still has no schedule', async () => {
    patchDisplay.mockResolvedValue({ ...LOBBY, assignedPlaylist: null });
    const { toasts } = await unassignFromLobby();

    await expect
      .element(toasts.getByText('The screen keeps what it was last given.'))
      .toBeVisible();
    expect(toasts.element().textContent).toContain('Playlist unassigned from Lobby');
    expect(toasts.element().textContent).not.toContain('now has a schedule');
  });
});

describe('ScreensList: what each role is offered', () => {
  it('offers an Owner "Add screen", the row menu and selection', async () => {
    const screen = await renderList('owner');
    await expect.element(screen.getByRole('link', { name: 'Add screen' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Actions for Lobby' })).toBeVisible();
    await expect.element(screen.getByRole('checkbox', { name: 'Select Lobby' })).toBeVisible();
  });

  it('tells a Viewer with no screens that an editor adds them, with no button', async () => {
    mockedScreensData.mockReturnValue(screensData([]));
    const screen = await renderList('viewer');
    await expect.element(screen.getByText('An editor adds screens.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add screen' }).query()).toBeNull();
  });

  it('shows a Viewer the screens with no "Add screen", no row menu and no selection', async () => {
    const screen = await renderList('viewer');
    await expect.element(screen.getByRole('link', { name: 'Lobby' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add screen' }).query()).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Lobby' }).query()).toBeNull();
    expect(screen.getByRole('checkbox').query()).toBeNull();
  });
});

describe('ScreensList: deleting a screen', () => {
  // Its own id: LOBBY is display(1), and the two are served together.
  const ONE = display(1, { id: ID(101) });
  const TWO = display(2);
  const THREE = display(3);

  const serve = (displays: DisplayDto[]) => {
    served = displays;
    mockedScreensData.mockImplementation(useServedScreens);
  };

  it.each(['owner', 'editor'] as const)(
    'offers %s "Delete" in the row menu of a screen with no player',
    async (role) => {
      const screen = await renderList(role);
      await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
      await expect.element(screen.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    },
  );

  it('deletes after the confirm, then reads the list, the statuses and the push plan again', async () => {
    serve([LOBBY, ONE]);
    deleteDisplay.mockResolvedValue();
    const screen = await renderList('editor');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByRole('heading', { name: 'Delete Lobby?' })).toBeVisible();
    expect(deleteDisplay).not.toHaveBeenCalled();

    served = [ONE];
    await screen.getByTestId('screens-delete-dialog-confirm').click();
    await expect.element(dialog).not.toBeVisible();
    expect(deleteDisplay).toHaveBeenCalledExactlyOnceWith(LOBBY.id);
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    await expect
      .element(screen.getByRole('region', { name: 'Notifications' }).getByText('Lobby deleted'))
      .toBeVisible();
    expect(screen.getByRole('link', { name: 'Lobby' }).query()).toBeNull();
  });

  it('shows a refusal in the dialog and removes nothing', async () => {
    serve([LOBBY]);
    deleteDisplay.mockRejectedValue(
      new ApiRequestError({
        status: 403,
        code: 'forbidden',
        message: 'Your role does not allow this.',
        fromApi: true,
      }),
    );
    const screen = await renderList('owner');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText('The screen was not deleted')).toBeVisible();
    await expect.element(dialog.getByText(/Your role does not allow this\./)).toBeVisible();
    await expect.element(dialog.getByText('forbidden', { exact: true })).toBeVisible();
    expect(reloadDisplays).not.toHaveBeenCalled();
    expect(refreshPush).not.toHaveBeenCalled();

    await screen.getByTestId('screens-delete-dialog-cancel').click();
    await expect.element(dialog).not.toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Lobby' })).toBeVisible();
    expect(screen.getByText('Lobby deleted').query()).toBeNull();
  });

  it('treats a 404 as already deleted: closes, reads the list again and says so', async () => {
    serve([LOBBY, ONE]);
    deleteDisplay.mockRejectedValue(
      new ApiRequestError({
        status: 404,
        code: 'not_found',
        message: 'The screen was not found.',
        fromApi: true,
      }),
    );
    const screen = await renderList('owner');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    served = [ONE];
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    await expect.element(screen.getByTestId('screens-delete-dialog')).not.toBeVisible();
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    await expect
      .element(
        screen
          .getByRole('region', { name: 'Notifications' })
          .getByText('Lobby was already deleted'),
      )
      .toBeVisible();
    expect(screen.getByText('Lobby deleted').query()).toBeNull();
  });

  it('SDC-02: when the answer is lost, says the delete could not be confirmed, reads everything again and stays open; deleting again settles it', async () => {
    serve([LOBBY, ONE]);
    deleteDisplay
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 0,
          code: 'network_error',
          message: 'The server could not be reached.',
          fromApi: false,
        }),
      )
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 404,
          code: 'not_found',
          message: 'The screen was not found.',
          fromApi: true,
        }),
      );
    const screen = await renderList('owner');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    // The server did delete it; only its answer was lost.
    served = [ONE];
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText('The delete could not be confirmed')).toBeVisible();
    await expect
      .element(
        dialog.getByText(
          'The server may or may not have deleted Lobby. The list is being read again; check it before you try again.',
          { exact: false },
        ),
      )
      .toBeVisible();
    await expect.element(dialog.getByText('network_error', { exact: true })).toBeVisible();
    expect(dialog.getByText('The screen was not deleted').query()).toBeNull();
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole('link', { name: 'Lobby' })).not.toBeInTheDocument();
    expect(screen.getByText('Lobby deleted').query()).toBeNull();

    // Deleting again: a 404 now reads as already deleted.
    await screen.getByTestId('screens-delete-dialog-confirm').click();
    await expect.element(dialog).not.toBeVisible();
    expect(deleteDisplay.mock.calls).toEqual([[LOBBY.id], [LOBBY.id]]);
    await expect
      .element(
        screen
          .getByRole('region', { name: 'Notifications' })
          .getByText('Lobby was already deleted'),
      )
      .toBeVisible();
  });

  it("R2-01, R2-02: a 429 on deleting again shows the server's words, and the lost answer stays in view", async () => {
    serve([LOBBY]);
    deleteDisplay
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 0,
          code: 'network_error',
          message: 'The server could not be reached.',
          fromApi: false,
        }),
      )
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 429,
          code: 'rate_limited',
          message: 'Too many requests. Try again in 1 minute.',
          fromApi: true,
        }),
      );
    const screen = await renderList('owner');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await screen.getByTestId('screens-delete-dialog-confirm').click();
    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText('network_error', { exact: true })).toBeVisible();

    await screen.getByTestId('screens-delete-dialog-confirm').click();
    await expect.element(dialog.getByText('Deleting it again was refused')).toBeVisible();
    await expect
      .element(dialog.getByText(/Too many requests\. Try again in 1 minute\./))
      .toBeVisible();
    await expect.element(dialog.getByText('The delete could not be confirmed')).toBeVisible();
    expect(dialog.getByText('The screen was not deleted').query()).toBeNull();
    expect(reloadDisplays).toHaveBeenCalledTimes(2);
  });

  it('#7: a 404 while the screen is still there (an API without the route) is not "already deleted"', async () => {
    serve([LOBBY]);
    deleteDisplay.mockRejectedValue(
      new ApiRequestError({
        status: 404,
        code: 'not_found',
        message: 'There is nothing at this address.',
        fromApi: true,
      }),
    );
    getDisplay.mockResolvedValue(LOBBY);
    const screen = await renderList('owner');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText('The screen was not deleted')).toBeVisible();
    await expect.element(dialog.getByText(/There is nothing at this address\./)).toBeVisible();
    expect(getDisplay).toHaveBeenCalledExactlyOnceWith(LOBBY.id);
    expect(reloadDisplays).not.toHaveBeenCalled();
    expect(screen.getByText('Lobby was already deleted').query()).toBeNull();
  });

  it("SDC-01: a 404 that is not the API's own is not read as already deleted", async () => {
    serve([LOBBY]);
    deleteDisplay.mockRejectedValue(errorFromResponse(404, '<html>Not Found</html>', null));
    const screen = await renderList('owner');
    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText('The delete could not be confirmed')).toBeVisible();
    await expect.element(dialog.getByText('invalid_response', { exact: true })).toBeVisible();
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Lobby was already deleted').query()).toBeNull();
  });

  it('says what happens to the player only when one is paired', async () => {
    const paired = display(4, {
      name: 'Hall',
      player: { registrationId: ID(800), registeredAt: '2026-11-20T00:00:00.000Z' },
    });
    serve([LOBBY, paired]);
    const screen = await renderList('owner');
    const dialog = screen.getByTestId('screens-delete-dialog');

    await screen.getByRole('button', { name: 'Actions for Hall' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await expect.element(dialog.getByText(/This player was unregistered/)).toBeVisible();
    expect(dialog.getByText(/pairing code accepted for it/).query()).toBeNull();
    await screen.getByTestId('screens-delete-dialog-cancel').click();
    await expect.element(dialog).not.toBeVisible();

    await screen.getByRole('button', { name: 'Actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await expect.element(dialog.getByText(/pairing code accepted for it/)).toBeVisible();
    expect(dialog.getByText(/This player was unregistered/).query()).toBeNull();
  });

  it('EAX-14: puts focus on the next screen after a delete, else the previous one, else Add screen', async () => {
    serve([ONE, TWO, THREE]);
    deleteDisplay.mockResolvedValue();
    const screen = await renderList('owner');
    const dialog = screen.getByTestId('screens-delete-dialog');
    const remove = async (which: DisplayDto, after: DisplayDto[]) => {
      await screen.getByRole('button', { name: `Actions for ${which.name}` }).click();
      await screen.getByRole('menuitem', { name: 'Delete' }).click();
      served = after;
      await screen.getByTestId('screens-delete-dialog-confirm').click();
      await expect.element(dialog).not.toBeVisible();
    };
    await remove(TWO, [ONE, THREE]);
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Screen 3' }))
      .toHaveFocus();
    await remove(THREE, [ONE]);
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Screen 1' }))
      .toHaveFocus();
    await remove(ONE, []);
    await expect.element(screen.getByTestId('screens-add')).toHaveFocus();
  });

  it('EAX-14: Escape and Cancel put focus back on the row menu that asked', async () => {
    serve([ONE, TWO]);
    const screen = await renderList('owner');
    const dialog = screen.getByTestId('screens-delete-dialog');
    const actions = screen.getByRole('button', { name: 'Actions for Screen 2' });

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    const cancel = screen.getByTestId('screens-delete-dialog-cancel');
    await expect.element(cancel).toHaveFocus();
    await userEvent.type(cancel, '{Escape}');
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await cancel.click();
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();
    expect(deleteDisplay).not.toHaveBeenCalled();
  });
});

describe('ScreensList: deleting the selected screens', () => {
  const ONE = display(1);
  const TWO = display(2);
  const THREE = display(3);
  const FOUR = display(4);
  const PLAYER = { registrationId: ID(800), registeredAt: '2026-11-20T00:00:00.000Z' };

  const serve = (displays: DisplayDto[]) => {
    served = displays;
    mockedScreensData.mockImplementation(useServedScreens);
  };

  const refusal = (status: number, code: ClientErrorCode, message: string) =>
    new ApiRequestError({ status, code, message, fromApi: true });

  async function tick(screen: Awaited<ReturnType<typeof renderList>>, ...names: string[]) {
    for (const name of names) {
      await screen.getByRole('checkbox', { name: `Select ${name}` }).click();
    }
  }

  it.each(['owner', 'editor'] as const)(
    'offers %s "Delete" in the selection bar once screens are ticked',
    async (role) => {
      serve([ONE, TWO]);
      const screen = await renderList(role);
      await expect.element(screen.getByRole('link', { name: 'Screen 1' })).toBeVisible();
      expect(screen.getByTestId('screens-bulk-delete').query()).toBeNull();

      await tick(screen, 'Screen 1');
      const bar = screen.getByRole('region', { name: 'Selected screens' });
      await expect.element(bar.getByTestId('screens-bulk-delete')).toBeVisible();
      await expect.element(bar.getByTestId('screens-bulk-delete')).toHaveTextContent('Delete');
    },
  );

  it('offers a Viewer no selection and so no bulk delete', async () => {
    serve([ONE, TWO]);
    const screen = await renderList('viewer');
    await expect.element(screen.getByRole('link', { name: 'Screen 1' })).toBeVisible();
    expect(screen.getByRole('checkbox').query()).toBeNull();
    expect(screen.getByRole('region', { name: 'Selected screens' }).query()).toBeNull();
    expect(screen.getByTestId('screens-bulk-delete').query()).toBeNull();
  });

  it('deletes one screen after another in list order, then reads everything again and clears them from the selection', async () => {
    serve([ONE, TWO, THREE]);
    const resolvers: (() => void)[] = [];
    deleteDisplay.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const screen = await renderList('owner');
    // Ticked out of order: the requests still follow the list.
    await tick(screen, 'Screen 2', 'Screen 1');
    await screen.getByTestId('screens-bulk-delete').click();

    const dialog = screen.getByTestId('screens-bulk-delete-dialog');
    await expect.element(screen.getByRole('heading', { name: 'Delete 2 screens?' })).toBeVisible();
    await expect
      .element(dialog.getByText('These 2 screens are removed for good.', { exact: false }))
      .toBeVisible();
    const confirm = screen.getByTestId('screens-bulk-delete-confirm');
    await expect.element(confirm).toHaveTextContent('Delete 2 screens');
    expect(deleteDisplay).not.toHaveBeenCalled();

    served = [THREE];
    await confirm.click();
    const progress = screen.getByTestId('screens-bulk-delete-progress');
    await expect.element(progress).toHaveTextContent('Deleting 1 of 2');
    // Never two at once.
    expect(deleteDisplay).toHaveBeenCalledTimes(1);
    expect(deleteDisplay).toHaveBeenLastCalledWith(ONE.id);

    resolvers[0]?.();
    await expect.element(progress).toHaveTextContent('Deleting 2 of 2');
    expect(deleteDisplay).toHaveBeenCalledTimes(2);
    expect(deleteDisplay).toHaveBeenLastCalledWith(TWO.id);
    expect(reloadDisplays).not.toHaveBeenCalled();

    resolvers[1]?.();
    await expect.element(dialog).not.toBeVisible();
    expect(deleteDisplay.mock.calls).toEqual([[ONE.id], [TWO.id]]);
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    await expect
      .element(screen.getByRole('region', { name: 'Notifications' }).getByText('2 screens deleted'))
      .toBeVisible();
    expect(screen.getByRole('region', { name: 'Selected screens' }).query()).toBeNull();
    expect(screen.getByRole('link', { name: 'Screen 1' }).query()).toBeNull();
    expect(screen.getByRole('link', { name: 'Screen 2' }).query()).toBeNull();
    await expect
      .element(screen.getByRole('checkbox', { name: 'Select Screen 3' }))
      .not.toBeChecked();
  });

  it('asks about one ticked screen by name', async () => {
    serve([ONE, TWO]);
    deleteDisplay.mockResolvedValue();
    const screen = await renderList('editor');
    await tick(screen, 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();

    const dialog = screen.getByTestId('screens-bulk-delete-dialog');
    await expect
      .element(screen.getByRole('heading', { name: 'Delete this screen?' }))
      .toBeVisible();
    await expect
      .element(
        dialog.getByText('Screen 2 is removed for good. Its history stays in the activity log.'),
      )
      .toBeVisible();
    await expect.element(dialog.getByRole('strong')).toHaveTextContent('Screen 2');
    expect(dialog.getByRole('list', { name: 'Screens to delete' }).query()).toBeNull();
    await expect
      .element(screen.getByTestId('screens-bulk-delete-confirm'))
      .toHaveTextContent('Delete screen');

    served = [ONE];
    await screen.getByTestId('screens-bulk-delete-confirm').click();
    await expect.element(dialog).not.toBeVisible();
    expect(deleteDisplay).toHaveBeenCalledExactlyOnceWith(TWO.id);
    await expect
      .element(screen.getByRole('region', { name: 'Notifications' }).getByText('Screen 2 deleted'))
      .toBeVisible();
  });

  it('lists the screens, marks those with a paired player and says what happens to it', async () => {
    const hall = display(5, { name: 'Hall', player: PLAYER });
    const room = display(6, { name: 'Room', player: PLAYER });
    serve([hall, room, ONE]);
    const screen = await renderList('owner');
    const dialog = screen.getByTestId('screens-bulk-delete-dialog');
    const names = dialog.getByRole('list', { name: 'Screens to delete' });

    // One of the two has a player.
    await tick(screen, 'Hall', 'Screen 1');
    await screen.getByTestId('screens-bulk-delete').click();
    await expect.element(names).toBeVisible();
    expect(
      names
        .getByRole('listitem')
        .elements()
        .map((item) => item.textContent),
    ).toEqual(['HallPlayer paired', 'Screen 1']);
    await expect
      .element(
        dialog.getByText(
          'The player paired with 1 of them loses access immediately. When it next reports it shows “This player was unregistered”, and it must be reset there before it can be paired again. A player that is not reporting keeps showing what it has cached until then.',
        ),
      )
      .toBeVisible();
    await expect
      .element(
        dialog.getByText(
          'Any pairing code accepted for them that no player has collected yet stops working.',
        ),
      )
      .toBeVisible();
    await screen.getByTestId('screens-bulk-delete-cancel').click();
    await expect.element(dialog).not.toBeVisible();

    // Both have a player: no pairing codes to speak of.
    await tick(screen, 'Screen 1', 'Room');
    await screen.getByTestId('screens-bulk-delete').click();
    await expect.element(names).toBeVisible();
    expect(
      names
        .getByRole('listitem')
        .elements()
        .map((item) => item.textContent),
    ).toEqual(['HallPlayer paired', 'RoomPlayer paired']);
    await expect
      .element(
        dialog.getByText(/^The players paired with them lose access immediately\. When each next/),
      )
      .toBeVisible();
    expect(dialog.getByText(/pairing code accepted/).query()).toBeNull();
    expect(deleteDisplay).not.toHaveBeenCalled();
  });

  it('keeps a failure in the dialog with its reason, and "Try again" repeats only that one', async () => {
    serve([ONE, TWO, THREE]);
    deleteDisplay
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(refusal(403, 'forbidden', 'Your role does not allow this.'))
      .mockResolvedValueOnce();
    const screen = await renderList('owner');
    await tick(screen, 'Screen 1', 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();
    served = [TWO, THREE];
    await screen.getByTestId('screens-bulk-delete-confirm').click();

    const dialog = screen.getByTestId('screens-bulk-delete-dialog');
    await expect
      .element(screen.getByRole('heading', { name: '1 of 2 screens was not deleted' }))
      .toBeVisible();
    await expect.element(dialog.getByText('1 screen was deleted.')).toBeVisible();
    const failures = screen.getByTestId('screens-bulk-delete-failures');
    expect(failures.getByRole('listitem').elements()).toHaveLength(1);
    await expect
      .element(failures.getByRole('listitem'))
      .toHaveTextContent('Screen 2: Your role does not allow this. forbidden');
    await expect
      .element(screen.getByTestId('screens-bulk-delete-cancel'))
      .toHaveTextContent('Close');
    expect(screen.getByTestId('screens-bulk-delete-confirm').query()).toBeNull();
    // What was deleted has left the list and the selection; the failure stays ticked.
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Screen 1' }).query()).toBeNull();
    await expect.element(screen.getByRole('checkbox', { name: 'Select Screen 2' })).toBeChecked();
    expect(screen.getByText('2 screens deleted').query()).toBeNull();

    served = [THREE];
    const retry = screen.getByTestId('screens-bulk-delete-retry');
    await expect.element(retry).toHaveTextContent('Try again');
    await retry.click();
    await expect.element(dialog).not.toBeVisible();
    expect(deleteDisplay.mock.calls).toEqual([[ONE.id], [TWO.id], [TWO.id]]);
    expect(reloadDisplays).toHaveBeenCalledTimes(2);
    expect(reloadStatuses).toHaveBeenCalledTimes(2);
    expect(refreshPush).toHaveBeenCalledTimes(2);
    await expect
      .element(screen.getByRole('region', { name: 'Notifications' }).getByText('2 screens deleted'))
      .toBeVisible();
    expect(screen.getByRole('region', { name: 'Selected screens' }).query()).toBeNull();
  });

  it('counts a screen the server no longer finds (404) as deleted and says so', async () => {
    serve([ONE, TWO, THREE]);
    deleteDisplay
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(refusal(404, 'not_found', 'The screen was not found.'));
    const screen = await renderList('owner');
    await tick(screen, 'Screen 1', 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();
    served = [THREE];
    await screen.getByTestId('screens-bulk-delete-confirm').click();

    await expect.element(screen.getByTestId('screens-bulk-delete-dialog')).not.toBeVisible();
    expect(deleteDisplay).toHaveBeenCalledTimes(2);
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    await expect
      .element(
        screen
          .getByRole('region', { name: 'Notifications' })
          .getByText('2 screens deleted; 1 of them already was'),
      )
      .toBeVisible();
    expect(screen.getByRole('region', { name: 'Selected screens' }).query()).toBeNull();
  });

  it('SDC-02: says which deletes could not be confirmed, with their codes, and reads the list again', async () => {
    serve([ONE, TWO, THREE]);
    deleteDisplay
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 0,
          code: 'network_error',
          message: 'The server could not be reached.',
          fromApi: false,
        }),
      )
      .mockRejectedValueOnce(refusal(403, 'forbidden', 'Your role does not allow this.'));
    const screen = await renderList('owner');
    await tick(screen, 'Screen 1', 'Screen 2', 'Screen 3');
    await screen.getByTestId('screens-bulk-delete').click();
    served = [TWO, THREE];
    await screen.getByTestId('screens-bulk-delete-confirm').click();

    const dialog = screen.getByTestId('screens-bulk-delete-dialog');
    await expect
      .element(screen.getByRole('heading', { name: 'Not every delete could be confirmed' }))
      .toBeVisible();
    const failures = screen.getByTestId('screens-bulk-delete-failures');
    expect(
      failures
        .getByRole('listitem')
        .elements()
        .map((item) => item.textContent),
    ).toEqual([
      'Screen 2: The server may or may not have deleted it. network_error',
      'Screen 3: Your role does not allow this. forbidden',
    ]);
    await expect.element(dialog.getByText('1 screen was deleted.')).toBeVisible();
    await expect
      .element(dialog.getByText('The list is being read again; check it before you try again.'))
      .toBeVisible();
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
    expect(reloadStatuses).toHaveBeenCalledTimes(1);
    expect(refreshPush).toHaveBeenCalledTimes(1);
  });

  it('R2-01: a retry refused after a lost answer keeps that screen unconfirmed', async () => {
    serve([ONE, TWO]);
    deleteDisplay
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 0,
          code: 'network_error',
          message: 'The server could not be reached.',
          fromApi: false,
        }),
      )
      .mockRejectedValueOnce(refusal(403, 'forbidden', 'Your role does not allow this.'));
    const screen = await renderList('owner');
    await tick(screen, 'Screen 1', 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();
    served = [TWO];
    await screen.getByTestId('screens-bulk-delete-confirm').click();
    // (A 429 never gets here: the bulk run waits it out and sends the delete again.)
    await screen.getByTestId('screens-bulk-delete-retry').click();

    await expect
      .poll(() => screen.getByTestId('screens-bulk-delete-failures').element().textContent)
      .toBe(
        'Screen 2: The server may or may not have deleted it. Your role does not allow this. forbidden',
      );
    await expect
      .element(screen.getByRole('heading', { name: 'Not every delete could be confirmed' }))
      .toBeVisible();
    expect(reloadDisplays).toHaveBeenCalledTimes(2);
  });

  it('SDC-02: for one screen, says the delete could not be confirmed', async () => {
    serve([ONE, TWO]);
    deleteDisplay.mockRejectedValue(
      refusal(500, 'commit_outcome_unknown', 'The change may have been saved.'),
    );
    const screen = await renderList('owner');
    await tick(screen, 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();
    await screen.getByTestId('screens-bulk-delete-confirm').click();

    await expect
      .element(screen.getByRole('heading', { name: 'The delete could not be confirmed' }))
      .toBeVisible();
    await expect
      .element(screen.getByTestId('screens-bulk-delete-failures').getByRole('listitem'))
      .toHaveTextContent(
        'Screen 2: The server may or may not have deleted it. commit_outcome_unknown',
      );
    expect(screen.getByText(/was not deleted/).query()).toBeNull();
    expect(reloadDisplays).toHaveBeenCalledTimes(1);
  });

  it('SDG-07: a keyboard retry that fails again leaves focus on "Try again"', async () => {
    serve([ONE, TWO]);
    deleteDisplay.mockRejectedValue(refusal(403, 'forbidden', 'Your role does not allow this.'));
    const screen = await renderList('owner');
    await tick(screen, 'Screen 1', 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();
    await screen.getByTestId('screens-bulk-delete-confirm').click();
    await expect
      .element(screen.getByRole('heading', { name: 'None of the 2 screens were deleted' }))
      .toBeVisible();

    const retry = screen.getByTestId('screens-bulk-delete-retry');
    // Focuses it, then presses Enter.
    await userEvent.type(retry, '{Enter}');
    await expect.poll(() => deleteDisplay.mock.calls.length).toBe(4);
    await expect.element(retry).not.toHaveAttribute('aria-busy');
    // Past the frame in which focus used to move to Close.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await expect.element(retry).toHaveFocus();
  });

  it('EAX-14: puts focus on the first remaining screen after a bulk delete', async () => {
    serve([ONE, TWO, THREE, FOUR]);
    deleteDisplay.mockResolvedValue();
    const screen = await renderList('owner');
    await tick(screen, 'Screen 2', 'Screen 3');
    await screen.getByTestId('screens-bulk-delete').click();
    served = [ONE, FOUR];
    await screen.getByTestId('screens-bulk-delete-confirm').click();
    await expect.element(screen.getByTestId('screens-bulk-delete-dialog')).not.toBeVisible();
    // The first remaining row from the top, not the row after the deleted ones.
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Screen 1' }))
      .toHaveFocus();
  });

  it('EAX-14: after deleting every screen, puts focus on Add screen', async () => {
    serve([ONE, TWO]);
    deleteDisplay.mockResolvedValue();
    const screen = await renderList('owner');
    await tick(screen, 'Screen 1', 'Screen 2');
    await screen.getByTestId('screens-bulk-delete').click();
    served = [];
    await screen.getByTestId('screens-bulk-delete-confirm').click();
    await expect.element(screen.getByTestId('screens-bulk-delete-dialog')).not.toBeVisible();
    await expect
      .element(screen.getByRole('region', { name: 'Notifications' }).getByText('2 screens deleted'))
      .toBeVisible();
    await expect.element(screen.getByTestId('screens-add')).toHaveFocus();
  });

  it('EAX-14: after deleting every screen, puts focus on Add screen once the slower list read lands', async () => {
    serve([ONE, TWO]);
    deleteDisplay.mockResolvedValue();
    holdRead = true;
    try {
      const screen = await renderList('owner');
      await tick(screen, 'Screen 1', 'Screen 2');
      await screen.getByTestId('screens-bulk-delete').click();
      served = [];
      await screen.getByTestId('screens-bulk-delete-confirm').click();
      await expect.element(screen.getByTestId('screens-bulk-delete-dialog')).not.toBeVisible();
      // While the read is out, the old rows stay and focus goes to the header's Add screen.
      const header = screen.getByTestId('screens-add');
      await expect.element(header).toHaveFocus();
      const before = header.element();

      // The read lands: the empty state replaces the table and that button with its own.
      landRead();
      await expect.element(screen.getByText('No screens yet')).toBeVisible();
      expect(before.isConnected).toBe(false);
      await expect.element(screen.getByTestId('screens-add')).toHaveFocus();
    } finally {
      holdRead = false;
      landRead = () => undefined;
    }
  });

  it("EAX-14: Escape and Cancel put focus back on the bar's Delete", async () => {
    serve([ONE, TWO]);
    const screen = await renderList('owner');
    const dialog = screen.getByTestId('screens-bulk-delete-dialog');
    await tick(screen, 'Screen 1', 'Screen 2');
    const remove = screen.getByTestId('screens-bulk-delete');

    await remove.click();
    const cancel = screen.getByTestId('screens-bulk-delete-cancel');
    await expect.element(cancel).toHaveFocus();
    await userEvent.type(cancel, '{Escape}');
    await expect.element(dialog).not.toBeVisible();
    await expect.element(remove).toHaveFocus();

    await remove.click();
    await cancel.click();
    await expect.element(dialog).not.toBeVisible();
    await expect.element(remove).toHaveFocus();
    expect(deleteDisplay).not.toHaveBeenCalled();
    // Nothing deleted: the selection stays.
    await expect.element(screen.getByRole('checkbox', { name: 'Select Screen 1' })).toBeChecked();
    await expect.element(screen.getByRole('checkbox', { name: 'Select Screen 2' })).toBeChecked();
  });
});
