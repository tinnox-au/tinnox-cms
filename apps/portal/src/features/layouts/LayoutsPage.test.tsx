import type { LayoutDto } from '@tinnox/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ID } from '../../lib/mediaLibrary.test-support.ts';
import { WithSession } from '../../session/session.test-support.tsx';
import { ToastProvider } from '../../ui/index.ts';
import { LayoutsPage } from './LayoutsPage.tsx';

const { listLayouts, deleteLayout } = vi.hoisted(() => ({
  listLayouts: vi.fn<() => Promise<LayoutDto[]>>(),
  deleteLayout: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../api/index.ts', () => ({ api: { listLayouts, deleteLayout } }));
// The page frame needs the whole shell (SessionContext, push); the test reads the page body.
vi.mock('../../shell/Page.tsx', () => ({
  Page: ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

const T = '2026-11-18T03:00:00.000Z';

function layout(n: number): LayoutDto {
  return {
    id: ID(n),
    name: `Layout ${String(n)}`,
    description: null,
    zones: [
      { playlist: { id: ID(8), name: 'Menu' }, x: 0, y: 0, width: 10_000, height: 8500 },
      { playlist: { id: ID(9), name: 'Ticker' }, x: 0, y: 8500, width: 10_000, height: 1500 },
    ],
    assignedDisplayCount: 0,
    createdAt: T,
    updatedAt: T,
  };
}

const ONE = layout(1);
const TWO = layout(2);
const THREE = layout(3);

async function renderPage(items: LayoutDto[]) {
  listLayouts.mockResolvedValue(items);
  return render(
    <WithSession role="admin">
      <ToastProvider>
        <MemoryRouter initialEntries={['/layouts']}>
          <LayoutsPage />
        </MemoryRouter>
      </ToastProvider>
    </WithSession>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('LayoutsPage', () => {
  it('EAX-14: puts focus on the next layout after a delete, else the previous one, else Create layout', async () => {
    deleteLayout.mockResolvedValue();
    const screen = await renderPage([ONE, TWO, THREE]);
    const dialog = screen.getByTestId('layouts-delete-dialog');
    const remove = async (which: LayoutDto, after: LayoutDto[]) => {
      await screen.getByRole('button', { name: `Actions for ${which.name}` }).click();
      await screen.getByRole('menuitem', { name: 'Delete' }).click();
      listLayouts.mockResolvedValue(after);
      await screen.getByTestId('layouts-delete-dialog-confirm').click();
      await expect.element(dialog).not.toBeVisible();
    };
    await remove(TWO, [ONE, THREE]);
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Layout 3' }))
      .toHaveFocus();
    await remove(THREE, [ONE]);
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Layout 1' }))
      .toHaveFocus();
    await remove(ONE, []);
    await expect.element(screen.getByTestId('layouts-create')).toHaveFocus();
  });

  it('EAX-14: Escape and Cancel put focus back on the row menu that asked', async () => {
    const screen = await renderPage([ONE, TWO]);
    const dialog = screen.getByTestId('layouts-delete-dialog');
    const actions = screen.getByRole('button', { name: 'Actions for Layout 2' });

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    const cancel = screen.getByTestId('layouts-delete-dialog-cancel');
    await expect.element(cancel).toHaveFocus();
    await userEvent.type(cancel, '{Escape}');
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await cancel.click();
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();
    expect(deleteLayout).not.toHaveBeenCalled();
  });
});
