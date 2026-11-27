import type { DeliveryStatusView, DisplayDto, Role, TagDto } from '@tinnox/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { WithSession } from '../../../session/session.test-support.tsx';
import type { EditorPageProps } from '../../../shell/EditorPage.tsx';
import { ToastProvider } from '../../../ui/index.ts';
import { PushContext, type PushContextValue } from '../../push/PushContext.tsx';
import { ScreenDetail } from './ScreenDetail.tsx';

const { getDisplayStatus, listTags, deleteDisplay } = vi.hoisted(() => ({
  getDisplayStatus: vi.fn<() => Promise<DeliveryStatusView>>(),
  listTags: vi.fn<() => Promise<TagDto[]>>(),
  deleteDisplay: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../../api/index.ts', () => ({ api: { getDisplayStatus, listTags, deleteDisplay } }));
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

async function renderDetail(role: Role) {
  // The status stays loading: the menu does not wait for it.
  getDisplayStatus.mockReturnValue(new Promise(() => undefined));
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
            onReload={() => undefined}
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
