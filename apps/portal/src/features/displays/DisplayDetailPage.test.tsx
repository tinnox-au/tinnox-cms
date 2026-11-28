import type { DisplayDto, TagDto } from '@tinnox/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ApiRequestError } from '../../api/client.ts';
import { WithSession } from '../../session/session.test-support.tsx';
import type { EditorPageProps } from '../../shell/EditorPage.tsx';
import { ToastProvider } from '../../ui/index.ts';
import { PushContext, type PushContextValue } from '../push/PushContext.tsx';
import { DisplayDetailPage } from './DisplayDetailPage.tsx';

const { getDisplay, listSites, getDisplayStatus, listTags, deleteDisplay } = vi.hoisted(() => ({
  getDisplay: vi.fn<(id: string) => Promise<DisplayDto>>(),
  listSites: vi.fn<() => Promise<[]>>(),
  getDisplayStatus: vi.fn<() => Promise<never>>(),
  listTags: vi.fn<() => Promise<TagDto[]>>(),
  deleteDisplay: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../api/index.ts', () => ({
  api: { getDisplay, listSites, getDisplayStatus, listTags, deleteDisplay },
}));
vi.mock('../../shell/EditorPage.tsx', () => ({
  EditorPage: ({ title, children }: EditorPageProps) => (
    <>
      <h1>{title}</h1>
      <main>{children}</main>
    </>
  ),
}));

const T = '2026-11-14T03:00:00.000Z';
const DISPLAY: DisplayDto = {
  id: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000900',
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

const PUSH: PushContextValue = {
  plan: null,
  planError: null,
  pendingCount: null,
  refresh: () => undefined,
  openDialog: () => undefined,
  openPush: () => undefined,
  refreshPending: () => undefined,
};

afterEach(() => {
  vi.resetAllMocks();
});

describe('DisplayDetailPage', () => {
  it('#4: says the screen was not found once a refresh after an unconfirmed delete finds it gone', async () => {
    // The screen is there until the delete is sent; then the server no longer finds it.
    getDisplay.mockImplementation(() =>
      deleteDisplay.mock.calls.length === 0
        ? Promise.resolve(DISPLAY)
        : Promise.reject(
            new ApiRequestError({
              status: 404,
              code: 'not_found',
              message: 'The screen was not found.',
              fromApi: true,
            }),
          ),
    );
    listSites.mockResolvedValue([]);
    getDisplayStatus.mockReturnValue(new Promise(() => undefined));
    listTags.mockResolvedValue([]);
    // The server deleted it; only its answer was lost.
    deleteDisplay.mockRejectedValue(
      new ApiRequestError({
        status: 0,
        code: 'network_error',
        message: 'The server could not be reached.',
        fromApi: false,
      }),
    );
    const router = createMemoryRouter([{ path: '/screens/:id', element: <DisplayDetailPage /> }], {
      initialEntries: [`/screens/${DISPLAY.id}`],
    });
    const screen = await render(
      <WithSession role="editor">
        <ToastProvider>
          <PushContext value={PUSH}>
            <RouterProvider router={router} />
          </PushContext>
        </ToastProvider>
      </WithSession>,
    );

    await screen.getByRole('button', { name: 'More actions for Lobby' }).click();
    await screen.getByRole('menuitem', { name: 'Delete screen' }).click();
    await screen.getByTestId('screens-delete-dialog-confirm').click();

    await expect.element(screen.getByTestId('screen-detail-missing')).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Screen not found' })).toBeVisible();
  });
});
