import type { FolderDto, MediaListResponse, TagDto } from '@tinnox/contracts';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ID, media } from '../../../lib/mediaLibrary.test-support.ts';
import { WithSession } from '../../../session/session.test-support.tsx';
import { ToastProvider } from '../../../ui/index.ts';
import { PushContext, type PushContextValue } from '../../push/PushContext.tsx';
import { MediaLibrary } from './MediaLibrary.tsx';

const { listMedia, listFolders, listTags, deleteFolder } = vi.hoisted(() => ({
  listMedia: vi.fn<() => Promise<MediaListResponse>>(),
  listFolders: vi.fn<() => Promise<FolderDto[]>>(),
  listTags: vi.fn<() => Promise<TagDto[]>>(),
  deleteFolder: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../../api/index.ts', () => ({
  api: { listMedia, listFolders, listTags, deleteFolder },
}));
// The page frame needs the whole shell (SessionContext, push); the test reads the page body.
vi.mock('../../../shell/Page.tsx', () => ({
  Page: ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

// "Add to playlist" offers a push; nothing here pushes.
const PUSH: PushContextValue = {
  plan: null,
  planError: null,
  pendingCount: null,
  refresh: () => undefined,
  openDialog: () => undefined,
  openPush: () => undefined,
  refreshPending: () => undefined,
};

const folder = (n: number, name: string): FolderDto => ({ id: ID(n), name, itemCount: 0 });
const ARCHIVE = folder(1, 'Archive');
const BANNERS = folder(2, 'Banners');
const CAMPAIGNS = folder(3, 'Campaigns');

async function renderLibrary(folders: FolderDto[], chosen: FolderDto) {
  listMedia.mockResolvedValue({
    items: [media(5, 'image')],
    storage: { usedBytes: 0, limitBytes: 1_000_000 },
  });
  listFolders.mockResolvedValue(folders);
  listTags.mockResolvedValue([]);
  // A data router: the library blocks leaving while files upload (useBlocker).
  const router = createMemoryRouter([{ path: '/media', element: <MediaLibrary kind="all" /> }], {
    initialEntries: [`/media?folder=${chosen.id}`],
  });
  return render(
    <WithSession role="admin">
      <ToastProvider>
        <PushContext value={PUSH}>
          <RouterProvider router={router} />
        </PushContext>
      </ToastProvider>
    </WithSession>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('MediaLibrary: folders', () => {
  it('EAX-14: puts focus on the next folder after a delete, else the previous one, else New folder', async () => {
    deleteFolder.mockResolvedValue();
    const screen = await renderLibrary([ARCHIVE, BANNERS, CAMPAIGNS], BANNERS);
    const chip = (which: FolderDto) =>
      screen
        .getByTestId('media-library-folder')
        .filter({ hasText: which.name })
        .getByRole('button');
    // The chosen folder's menu offers the delete; its button leaves with the folder.
    const remove = async (which: FolderDto, after: FolderDto[]) => {
      await screen.getByRole('button', { name: `Actions for folder ${which.name}` }).click();
      await screen.getByRole('menuitem', { name: 'Delete folder' }).click();
      listFolders.mockResolvedValue(after);
      await screen.getByRole('dialog').getByRole('button', { name: 'Delete folder' }).click();
      await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    };
    await remove(BANNERS, [ARCHIVE, CAMPAIGNS]);
    await expect.element(chip(CAMPAIGNS)).toHaveFocus();
    await chip(CAMPAIGNS).click();
    await remove(CAMPAIGNS, [ARCHIVE]);
    await expect.element(chip(ARCHIVE)).toHaveFocus();
    await chip(ARCHIVE).click();
    await remove(ARCHIVE, []);
    await expect.element(screen.getByTestId('media-library-folder-new')).toHaveFocus();
    expect(deleteFolder.mock.calls).toEqual([[BANNERS.id], [CAMPAIGNS.id], [ARCHIVE.id]]);
  });

  it('EAX-14: Escape and Cancel put focus back on the folder menu that asked', async () => {
    const screen = await renderLibrary([ARCHIVE, BANNERS], BANNERS);
    const actions = screen.getByRole('button', { name: 'Actions for folder Banners' });

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete folder' }).click();
    const cancel = screen.getByRole('dialog').getByRole('button', { name: 'Cancel' });
    await expect.element(cancel).toHaveFocus();
    await userEvent.type(cancel, '{Escape}');
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete folder' }).click();
    await cancel.click();
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(actions).toHaveFocus();
    expect(deleteFolder).not.toHaveBeenCalled();
  });
});
