import type { FolderDto, PermissionKey, Role, TagDto } from '@tinnox/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { AuthenticatedProvider } from '../../session/AuthenticatedSession.tsx';
import { sessionFor } from '../../session/session.test-support.tsx';
import { ToastProvider } from '../../ui/index.ts';
import { TagsPage } from './TagsPage.tsx';

const { listTags, listFolders } = vi.hoisted(() => ({
  listTags: vi.fn<() => Promise<TagDto[]>>(),
  listFolders: vi.fn<() => Promise<FolderDto[]>>(),
}));
vi.mock('../../api/index.ts', () => ({ api: { listTags, listFolders } }));
// The page frame needs the whole shell (SessionContext, push); the test reads the page body.
vi.mock('../../shell/Page.tsx', () => ({
  Page: ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

const MEDIA_TAG: TagDto = {
  id: '00000000-0000-4000-8000-000000000001',
  scope: 'media',
  name: 'Lobby',
  colour: 'teal',
  usageCount: 0,
};
const SCREEN_TAG: TagDto = {
  id: '00000000-0000-4000-8000-000000000002',
  scope: 'display',
  name: 'Level 2',
  colour: 'sky',
  usageCount: 0,
};

/** The page on `scope`'s tab, signed in as `role`, or with only `keys` when they are given. */
async function renderPage(scope: 'media' | 'display', role: Role, keys?: readonly PermissionKey[]) {
  listTags.mockResolvedValue([MEDIA_TAG, SCREEN_TAG]);
  listFolders.mockResolvedValue([]);
  const base = sessionFor(role);
  const session =
    keys === undefined ? base : { ...base, user: { ...base.user, permissions: [...keys] } };
  return render(
    <AuthenticatedProvider session={session}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/settings/tags?scope=${scope}`]}>
          <TagsPage />
        </MemoryRouter>
      </ToastProvider>
    </AuthenticatedProvider>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('TagsPage', () => {
  it.each([
    ['media', MEDIA_TAG],
    ['display', SCREEN_TAG],
  ] as const)('offers an Editor every action on a %s tag', async (scope, tag) => {
    const screen = await renderPage(scope, 'editor');
    await expect.element(screen.getByRole('button', { name: 'New tag' })).toBeVisible();
    await screen.getByRole('button', { name: `Actions for tag ${tag.name}` }).click();
    await expect.element(screen.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect.element(screen.getByRole('menuitem', { name: 'Change colour' })).toBeVisible();
    await expect.element(screen.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  });

  it('offers a Viewer no change', async () => {
    const screen = await renderPage('media', 'viewer');
    await expect.element(screen.getByText(MEDIA_TAG.name)).toBeVisible();
    expect(screen.getByRole('button', { name: 'New tag' }).elements()).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: `Actions for tag ${MEDIA_TAG.name}` }).elements(),
    ).toHaveLength(0);
  });

  // No real role holds a content key without screen.setup (packages/domain/src/permissions.ts),
  // so hypothetical key sets show what the page mirrors of the API: a new tag needs its scope's
  // key, a change or deletion needs the content key and screen.setup together.
  it.each([
    ['media', MEDIA_TAG, ['org.read', 'content.write', 'content.delete']],
    ['display', SCREEN_TAG, ['org.read', 'screen.setup']],
  ] as const)(
    "D20: offers a new %s tag but no change of one with that scope's keys alone",
    async (scope, tag, keys) => {
      const screen = await renderPage(scope, 'editor', keys);
      await expect.element(screen.getByRole('button', { name: 'New tag' })).toBeVisible();
      await expect.element(screen.getByText(tag.name)).toBeVisible();
      expect(
        screen.getByRole('button', { name: `Actions for tag ${tag.name}` }).elements(),
      ).toHaveLength(0);
    },
  );
});
