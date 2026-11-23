import type { AppDto } from '@tinnox/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { app } from '../../lib/mediaLibrary.test-support.ts';
import { WithSession } from '../../session/session.test-support.tsx';
import { ToastProvider } from '../../ui/index.ts';
import { AppsPage } from './AppsPage.tsx';

const { listApps, deleteApp } = vi.hoisted(() => ({
  listApps: vi.fn<() => Promise<AppDto[]>>(),
  deleteApp: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../api/index.ts', () => ({ api: { listApps, deleteApp } }));
// The page frame needs the whole shell (SessionContext, push); the test reads the page body.
vi.mock('../../shell/Page.tsx', () => ({
  Page: ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

const ONE = app(1);
const TWO = app(2);
const THREE = app(3);

async function renderPage(items: AppDto[]) {
  listApps.mockResolvedValue(items);
  return render(
    <WithSession role="admin">
      <ToastProvider>
        <MemoryRouter initialEntries={['/apps']}>
          <AppsPage />
        </MemoryRouter>
      </ToastProvider>
    </WithSession>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('AppsPage', () => {
  it('EAX-14: puts focus on the next app after a delete, else the previous one, else Create app', async () => {
    deleteApp.mockResolvedValue();
    const screen = await renderPage([ONE, TWO, THREE]);
    const dialog = screen.getByTestId('apps-delete-dialog');
    const remove = async (which: AppDto, after: AppDto[]) => {
      await screen.getByRole('button', { name: `Actions for ${which.name}` }).click();
      await screen.getByRole('menuitem', { name: 'Delete' }).click();
      listApps.mockResolvedValue(after);
      await screen.getByTestId('apps-delete-dialog-confirm').click();
      await expect.element(dialog).not.toBeVisible();
    };
    await remove(TWO, [ONE, THREE]);
    await expect.element(screen.getByRole('button', { name: 'Actions for Clock 3' })).toHaveFocus();
    await remove(THREE, [ONE]);
    await expect.element(screen.getByRole('button', { name: 'Actions for Clock 1' })).toHaveFocus();
    await remove(ONE, []);
    await expect.element(screen.getByTestId('apps-create')).toHaveFocus();
  });

  it('EAX-14: Escape and Cancel put focus back on the row menu that asked', async () => {
    const screen = await renderPage([ONE, TWO]);
    const dialog = screen.getByTestId('apps-delete-dialog');
    const actions = screen.getByRole('button', { name: 'Actions for Clock 2' });

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    const cancel = screen.getByTestId('apps-delete-dialog-cancel');
    await expect.element(cancel).toHaveFocus();
    await userEvent.type(cancel, '{Escape}');
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await cancel.click();
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();
    expect(deleteApp).not.toHaveBeenCalled();
  });
});
