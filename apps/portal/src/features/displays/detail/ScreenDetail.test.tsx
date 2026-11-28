import type { DeliveryStatusView, DisplayDto, Role, TagDto } from '@tinnox/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ApiRequestError } from '../../../api/client.ts';
import { WithSession } from '../../../session/session.test-support.tsx';
import type { EditorPageProps } from '../../../shell/EditorPage.tsx';
import { ToastProvider } from '../../../ui/index.ts';
import { PushContext, type PushContextValue } from '../../push/PushContext.tsx';
import { ScreenDetail } from './ScreenDetail.tsx';

const { getDisplayStatus, listTags, deleteDisplay, getDisplay } = vi.hoisted(() => ({
  getDisplayStatus: vi.fn<() => Promise<DeliveryStatusView>>(),
  listTags: vi.fn<() => Promise<TagDto[]>>(),
  deleteDisplay: vi.fn<(id: string) => Promise<void>>(),
  getDisplay: vi.fn<(id: string) => Promise<unknown>>(),
}));
vi.mock('../../../api/index.ts', () => ({
  api: { getDisplayStatus, listTags, deleteDisplay, getDisplay },
}));
// The page frame needs the whole shell; the test reads what the page hands it.
vi.mock('../../../shell/EditorPage.tsx', () => ({
  EditorPage: ({ title, status, children }: EditorPageProps) => (
    <>
      <h1>{title}</h1>
      {status}
      <main>{children}</main>
    </>
  ),
}));

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-14T03:00:00.000Z';

const DISPLAY: DisplayDto = {
  id: ID(1),
  siteId: ID(900),
  name: 'Lobby',
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
};

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

// The latest status of a screen with a player that has not reported yet.
const PAIRED_STATUS: DeliveryStatusView = {
  displayId: DISPLAY.id,
  paired: true,
  registrationId: ID(800),
  desired: null,
  downloaded: null,
  active: null,
  playerState: null,
  staging: null,
  lastHeartbeatAt: null,
  stale: true,
  staleAfterSeconds: 90,
  errors: [],
  summary: 'awaiting_player',
  asOf: T,
};

async function renderDetail(
  role: Role,
  options: { readonly status?: DeliveryStatusView; readonly onReload?: () => void } = {},
) {
  // Without one the status stays loading: the menu does not wait for it.
  if (options.status === undefined) getDisplayStatus.mockReturnValue(new Promise(() => undefined));
  else getDisplayStatus.mockResolvedValue(options.status);
  listTags.mockResolvedValue([]);
  const router = createMemoryRouter(
    [
      {
        path: '/screens/:id',
        element: (
          <ScreenDetail
            data={{ display: DISPLAY, site: null }}
            refreshError={null}
            back={{ to: '/screens', label: 'All screens' }}
            onReload={options.onReload ?? (() => undefined)}
            onChanged={() => undefined}
          />
        ),
      },
      { path: '/screens', element: <p>The screens list</p> },
    ],
    { initialEntries: [`/screens/${DISPLAY.id}`] },
  );
  const screen = await render(
    <WithSession role={role}>
      <ToastProvider>
        <PushContext value={PUSH}>
          <RouterProvider router={router} />
        </PushContext>
      </ToastProvider>
    </WithSession>,
  );
  return { screen, router };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('ScreenDetail: "Delete screen"', () => {
  it('deletes from the menu after the confirm, leaving unsaved edits behind without asking', async () => {
    deleteDisplay.mockResolvedValue();
    const { screen, router } = await renderDetail('editor');
    // An unsaved edit: the leave guard would otherwise ask before going to the list.
    const name = screen.getByTestId('screen-detail-name');
    await userEvent.type(name, ' hall');
    await expect.element(screen.getByTestId('screen-detail-unsaved')).toBeVisible();

    await screen.getByRole('button', { name: 'More actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete screen' }).click();
    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByRole('heading', { name: 'Delete Lobby?' })).toBeVisible();
    expect(deleteDisplay).not.toHaveBeenCalled();

    await screen.getByTestId('screens-delete-dialog-confirm').click();
    await expect.element(screen.getByText('The screens list')).toBeVisible();
    expect(router.state.location.pathname).toBe('/screens');
    expect(deleteDisplay).toHaveBeenCalledExactlyOnceWith(DISPLAY.id);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByTestId('leave-dialog')).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole('region', { name: 'Notifications' }).getByText('Lobby deleted'))
      .toBeVisible();
  });

  it('SDC-06: says what happens to the player when only the latest status says one is paired', async () => {
    // The screen was read before the pairing; the 5 s status has seen it since.
    const { screen } = await renderDetail('owner', { status: PAIRED_STATUS });
    await expect.element(screen.getByTestId('status-headline')).toBeVisible();
    await screen.getByRole('button', { name: 'More actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete screen' }).click();
    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText(/This player was unregistered/)).toBeVisible();
    expect(dialog.getByText(/pairing code accepted for it/).query()).toBeNull();
  });

  it('SDC-02: when the answer is lost, stays open and reads the screen and its status again', async () => {
    deleteDisplay.mockRejectedValue(
      new ApiRequestError({
        status: 0,
        code: 'network_error',
        message: 'The server could not be reached.',
        fromApi: false,
      }),
    );
    const onReload = vi.fn<() => void>();
    const { screen, router } = await renderDetail('editor', { status: PAIRED_STATUS, onReload });
    await expect.element(screen.getByTestId('status-headline')).toBeVisible();
    const statusReads = getDisplayStatus.mock.calls.length;
    await screen.getByRole('button', { name: 'More actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete screen' }).click();
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    const dialog = screen.getByTestId('screens-delete-dialog');
    await expect.element(dialog.getByText('The delete could not be confirmed')).toBeVisible();
    await expect
      .element(
        dialog.getByText(
          'The server may or may not have deleted Lobby. The page is being read again; check it before you try again.',
          { exact: false },
        ),
      )
      .toBeVisible();
    expect(onReload).toHaveBeenCalledTimes(1);
    await expect.poll(() => getDisplayStatus.mock.calls.length).toBeGreaterThan(statusReads);
    expect(refreshPush).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe(`/screens/${DISPLAY.id}`);
  });

  it('is offered after the separator, beside "Revoke player", to an Owner', async () => {
    const { screen } = await renderDetail('owner');
    await screen.getByRole('button', { name: 'More actions for Lobby' }).click();
    const menu = screen.getByRole('menu').element();
    const items = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')];
    expect(
      items.map((item) => (item.getAttribute('role') === 'separator' ? '---' : item.textContent)),
    ).toEqual([
      'Refresh status',
      'Pair player',
      '---',
      'Revoke player, Not paired',
      'Delete screen',
    ]);
  });

  it('is not offered to a Viewer', async () => {
    const { screen } = await renderDetail('viewer');
    await screen.getByRole('button', { name: 'More actions for Lobby' }).click();
    await expect.element(screen.getByRole('menuitem', { name: 'Refresh status' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Delete screen' }).query()).toBeNull();
    expect(screen.getByRole('separator').query()).toBeNull();
  });
});
