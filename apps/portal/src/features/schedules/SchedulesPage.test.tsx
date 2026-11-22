import type { ScheduleSummaryDto } from '@tinnox/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ID } from '../../lib/mediaLibrary.test-support.ts';
import { WithSession } from '../../session/session.test-support.tsx';
import { ToastProvider } from '../../ui/index.ts';
import { SchedulesPage } from './SchedulesPage.tsx';

const { listSchedules, deleteSchedule } = vi.hoisted(() => ({
  listSchedules: vi.fn<() => Promise<ScheduleSummaryDto[]>>(),
  deleteSchedule: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('../../api/index.ts', () => ({ api: { listSchedules, deleteSchedule } }));
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

function schedule(n: number): ScheduleSummaryDto {
  return {
    id: ID(n),
    name: `Schedule ${String(n)}`,
    description: null,
    defaultPlaylist: { id: ID(8), name: 'Lobby loop' },
    eventCount: 0,
    assignedDisplayCount: 0,
    createdAt: T,
    updatedAt: T,
  };
}

const ONE = schedule(1);
const TWO = schedule(2);
const THREE = schedule(3);

async function renderPage(items: ScheduleSummaryDto[]) {
  listSchedules.mockResolvedValue(items);
  return render(
    <WithSession role="admin">
      <ToastProvider>
        <MemoryRouter initialEntries={['/schedules']}>
          <SchedulesPage />
        </MemoryRouter>
      </ToastProvider>
    </WithSession>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('SchedulesPage', () => {
  it('EAX-14: puts focus on the next schedule after a delete, else the previous one, else Create schedule', async () => {
    deleteSchedule.mockResolvedValue();
    const screen = await renderPage([ONE, TWO, THREE]);
    const dialog = screen.getByTestId('schedules-delete-dialog');
    const remove = async (which: ScheduleSummaryDto, after: ScheduleSummaryDto[]) => {
      await screen.getByRole('button', { name: `Actions for ${which.name}` }).click();
      await screen.getByRole('menuitem', { name: 'Delete' }).click();
      listSchedules.mockResolvedValue(after);
      await screen.getByTestId('schedules-delete-dialog-confirm').click();
      await expect.element(dialog).not.toBeVisible();
    };
    await remove(TWO, [ONE, THREE]);
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Schedule 3' }))
      .toHaveFocus();
    await remove(THREE, [ONE]);
    await expect
      .element(screen.getByRole('button', { name: 'Actions for Schedule 1' }))
      .toHaveFocus();
    await remove(ONE, []);
    await expect.element(screen.getByTestId('schedules-create')).toHaveFocus();
  });

  it('EAX-14: Escape and Cancel put focus back on the row menu that asked', async () => {
    const screen = await renderPage([ONE, TWO]);
    const dialog = screen.getByTestId('schedules-delete-dialog');
    const actions = screen.getByRole('button', { name: 'Actions for Schedule 2' });

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    const cancel = screen.getByTestId('schedules-delete-dialog-cancel');
    await expect.element(cancel).toHaveFocus();
    await userEvent.type(cancel, '{Escape}');
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    await cancel.click();
    await expect.element(dialog).not.toBeVisible();
    await expect.element(actions).toHaveFocus();
    expect(deleteSchedule).not.toHaveBeenCalled();
  });
});
