import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { routes } from './App.tsx';
import { ROUTE_MANIFEST, type RedirectPath, type RouteEntry } from './routes.manifest.ts';

/**
 * An address each redirect of routes.manifest.ts matches, and where it must land. Keyed by
 * `RedirectPath`, so a new redirect fails typecheck here until it has a case. A page marked
 * `kind: 'redirect'` would leave the accessibility spec without a scan for it; this test is what
 * shows that each redirect does send the browser on, rather than rendering something there.
 */
const REDIRECTS = {
  '/': { from: '/', to: '/dashboard' },
  '/screens/:id/edit': { from: '/screens/s-1/edit', to: '/screens/s-1?tab=canvas' },
  '/displays/*': { from: '/displays/s-1?view=list#top', to: '/screens/s-1?view=list#top' },
} as const satisfies Record<RedirectPath, { readonly from: string; readonly to: string }>;

/** The child route App.tsx built for the manifest entry at `index`: it keeps the manifest's order. */
function appRoute(entry: RouteEntry, index: number): RouteObject {
  const route = routes[0]?.children?.[index];
  const matches = entry.path === '/' ? route?.index === true : route?.path === entry.path.slice(1);
  if (route === undefined || !matches) throw new Error(`App.tsx has no route '${entry.path}'`);
  return route;
}

const REDIRECT_ENTRIES = ROUTE_MANIFEST.flatMap((entry, index) =>
  entry.kind === 'redirect' ? [{ route: appRoute(entry, index), ...REDIRECTS[entry.path] }] : [],
);

describe('the redirects of the route table', () => {
  for (const { route, from, to } of REDIRECT_ENTRIES) {
    it(`sends ${from} on to ${to}`, async () => {
      const router = createMemoryRouter(
        [{ path: '/', children: [route, { path: '*', element: <p>Landed</p> }] }],
        { initialEntries: [from] },
      );
      const screen = await render(<RouterProvider router={router} />);
      await expect.element(screen.getByText('Landed')).toBeVisible();
      await vi.waitFor(() => {
        const { pathname, search, hash } = router.state.location;
        expect(`${pathname}${search}${hash}`).toBe(to);
      });
    });
  }
});
