import type { Role } from '@tinnox/contracts';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { routes } from '../App.tsx';
import { PushContext, type PushContextValue } from '../features/push/PushContext.tsx';
import { ROUTE_MANIFEST, type GuardedPath } from '../routes.manifest.ts';
import { WithSession } from '../session/session.test-support.tsx';
import { ShellContext, type ShellContextValue } from './ShellContext.ts';

// The guarded pages themselves, replaced by their headings: the test is about the guard.
vi.mock('../features/users/UsersPage.tsx', () => ({ UsersPage: () => <h1>Users</h1> }));
vi.mock('../features/settings/AlertsPage.tsx', () => ({ AlertsPage: () => <h1>Alerts</h1> }));
vi.mock('../features/displays/DisplayWizardPage.tsx', () => ({
  DisplayWizardPage: () => <h1>Add a screen</h1>,
}));

const SHELL: ShellContextValue = {
  drawerMode: false,
  navOpen: false,
  openNav: () => undefined,
  signOut: { busy: false, error: null, start: () => undefined, dismissError: () => undefined },
  announcePage: () => undefined,
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

/** A child route of App.tsx's table, as App.tsx defines it (its lazy page and its guard). */
function appRoute(path: GuardedPath): RouteObject {
  const route = routes[0]?.children?.find((child) => child.path === path.slice(1));
  if (route === undefined) throw new Error(`App.tsx has no route '${path}'`);
  return route;
}

/**
 * The heading of each guarded page's stand-in (the mocks above). Keyed by the manifest's
 * guarded paths, so a new guarded route fails typecheck here until it has a stand-in.
 */
const STAND_IN_HEADINGS = {
  '/users': 'Users',
  '/screens/new': 'Add a screen',
  '/settings/alerts': 'Alerts',
} as const satisfies Record<GuardedPath, string>;

/** The guarded routes of routes.manifest.ts, and the heading each page's stand-in shows. */
const GUARDED = ROUTE_MANIFEST.flatMap((entry) =>
  'permission' in entry ? [{ path: entry.path, heading: STAND_IN_HEADINGS[entry.path] }] : [],
);

/** Renders App.tsx's guarded routes as `role`, starting at `path`, inside the real page frame. */
function renderAt(role: Role, path: GuardedPath) {
  const router = createMemoryRouter(
    [
      ...GUARDED.map((guarded) => appRoute(guarded.path)),
      { path: 'dashboard', element: <h1>Dashboard</h1> },
    ],
    { initialEntries: [path] },
  );
  return render(
    <WithSession role={role}>
      <ShellContext value={SHELL}>
        <PushContext value={PUSH}>
          <RouterProvider router={router} />
        </PushContext>
      </ShellContext>
    </WithSession>,
  );
}

describe('RequirePermission on the routes of App.tsx', () => {
  it('finds every guarded route of the manifest', () => {
    expect(GUARDED.map(({ path }) => path).sort()).toEqual(Object.keys(STAND_IN_HEADINGS).sort());
  });

  for (const { path, heading } of GUARDED) {
    it(`shows a Viewer on ${path} that the role does not allow the page`, async () => {
      const screen = await renderAt('viewer', path);
      await expect
        .element(screen.getByRole('heading', { level: 1, name: "Your role doesn't allow this" }))
        .toBeVisible();
      await expect
        .element(
          screen.getByText('Ask the Owner or an Admin of your organisation if you need this.'),
        )
        .toBeVisible();
      expect(screen.getByRole('heading', { name: heading }).query()).toBeNull();

      await screen.getByRole('link', { name: 'Go to dashboard' }).click();
      await expect.element(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    });
  }

  it('opens the screen wizard to an Editor, but not the Users page', async () => {
    const wizard = await renderAt('editor', '/screens/new');
    await expect.element(wizard.getByRole('heading', { name: 'Add a screen' })).toBeVisible();
    await wizard.unmount();

    const users = await renderAt('editor', '/users');
    await expect
      .element(users.getByRole('heading', { name: "Your role doesn't allow this" }))
      .toBeVisible();
  });

  it('opens the Users and Alerts pages to an Admin and an Owner, not Alerts to an Editor', async () => {
    for (const role of ['admin', 'owner'] as const) {
      for (const [path, heading] of [
        ['/users', 'Users'],
        ['/settings/alerts', 'Alerts'],
      ] as const) {
        const screen = await renderAt(role, path);
        await expect.element(screen.getByRole('heading', { name: heading })).toBeVisible();
        expect(screen.getByText("Your role doesn't allow this").query()).toBeNull();
        await screen.unmount();
      }
    }
    const alerts = await renderAt('editor', '/settings/alerts');
    await expect
      .element(alerts.getByRole('heading', { name: "Your role doesn't allow this" }))
      .toBeVisible();
  });
});
