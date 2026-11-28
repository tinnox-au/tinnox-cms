/**
 * The portal's route table as data (docs/portal-v2/stage-a.md, section 1): every address the
 * application's router matches, in the router's order, with what a page needs to be reached:
 * the permission its guard asks for and the kind of object whose id fills `:id`. No JSX and no
 * React: `App.tsx` builds its router from this list, and tests read it through the package
 * entry `@tinnox/portal/routes-manifest`. The accessibility spec
 * (tests/e2e/11-accessibility.spec.ts) keys its page scans by `PagePath`, so a page added here
 * without a scan fails `npm run typecheck` (adoption plan section 4.5, step 35).
 */
import type { PermissionKey } from '@tinnox/contracts';

/** An object a page shows by id. A scan opens one its fixture has made. */
export type ObjectKind = 'media' | 'app' | 'layout' | 'playlist' | 'schedule' | 'screen';

export interface RouteEntry {
  /**
   * The address pattern from the root: `/` is the index route, `/*` any address nothing else
   * matches. The leading slash is required because `App.tsx` drops it to get the router's
   * relative path: `'reports'` would otherwise become the route `eports`.
   */
  readonly path: `/${string}`;
  /**
   * `page` renders a page of its own; `redirect` sends the browser to another address. `App.tsx`
   * types its elements by this, so a redirect cannot be given a lazily loaded page, and
   * `App.test.tsx` checks that each redirect does move the browser.
   */
  readonly kind: 'page' | 'redirect';
  /** The page opens only for a role with this key (`RequirePermission`); others see `ForbiddenPage`. */
  readonly permission?: PermissionKey;
  /** The page shows one object, whose id is `:id`; it is mounted afresh for each id (`PerObject`). */
  readonly idFrom?: ObjectKind;
}

/** The children of the shell route `/`, in the order `App.tsx` gives them to the router. */
export const ROUTE_MANIFEST = [
  { path: '/', kind: 'redirect' },
  { path: '/dashboard', kind: 'page' },

  { path: '/media', kind: 'page' },
  { path: '/media/images', kind: 'page' },
  { path: '/media/videos', kind: 'page' },
  { path: '/media/audio', kind: 'page' },
  { path: '/media/documents', kind: 'page' },
  { path: '/media/web-pages', kind: 'page' },
  { path: '/media/:id', kind: 'page', idFrom: 'media' },

  { path: '/apps', kind: 'page' },
  { path: '/apps/:id', kind: 'page', idFrom: 'app' },
  { path: '/layouts', kind: 'page' },
  { path: '/layouts/:id', kind: 'page', idFrom: 'layout' },
  { path: '/users', kind: 'page', permission: 'member.read' },

  { path: '/playlists', kind: 'page' },
  { path: '/playlists/:id', kind: 'page', idFrom: 'playlist' },

  { path: '/schedules', kind: 'page' },
  { path: '/schedules/:id', kind: 'page', idFrom: 'schedule' },

  { path: '/screens', kind: 'page' },
  { path: '/screens/new', kind: 'page', permission: 'screen.setup' },
  { path: '/screens/:id', kind: 'page', idFrom: 'screen' },
  // Only a redirect to the Canvas tab, which is read-only without screen.setup: no guard.
  { path: '/screens/:id/edit', kind: 'redirect' },
  { path: '/displays/*', kind: 'redirect' },

  { path: '/settings', kind: 'page' },
  { path: '/settings/tags', kind: 'page' },
  { path: '/settings/alerts', kind: 'page', permission: 'alerts.manage' },
  { path: '/audit', kind: 'page' },

  { path: '/*', kind: 'page' },
] as const satisfies readonly RouteEntry[];

type Manifested = (typeof ROUTE_MANIFEST)[number];

/** Every address pattern of the route table. */
export type RoutePath = Manifested['path'];

/** The addresses that render a page of their own: each needs an accessibility scan. */
export type PagePath = Extract<Manifested, { readonly kind: 'page' }>['path'];

/** The addresses that only send the browser on: no scan, since nothing renders there. */
export type RedirectPath = Extract<Manifested, { readonly kind: 'redirect' }>['path'];

/** The pages behind `RequirePermission`. */
export type GuardedPath = Extract<Manifested, { readonly permission: PermissionKey }>['path'];

/** The manifest entry of a page, narrowed to its path. */
export type PageEntry = Extract<Manifested, { readonly kind: 'page' }>;

/** The pages of the route table, in its order. */
export const PAGE_ROUTES: readonly PageEntry[] = ROUTE_MANIFEST.filter(
  (entry): entry is PageEntry => entry.kind === 'page',
);

/**
 * Screens the portal shows outside the route table, so `PagePath` does not hold them: the
 * session gate's three (before the router exists), the router's error element, the page a
 * guard shows in place of one the role may not open, and the public alert confirmation page
 * (`App()` picks it by address, outside the session gate). Each is where it is rendered, for
 * the checks that cover these screens (adoption plan section 4.5, item 3). The development-only
 * component gallery (`/styleguide`) is left out: production builds drop it.
 */
export const OUTSIDE_ROUTE_TABLE = {
  'sign-in': 'shell/Screens.tsx, SignInScreen',
  'session-checking': 'shell/Screens.tsx, SessionCheckingScreen',
  'session-error': 'shell/Screens.tsx, SessionErrorScreen',
  'route-error': 'shell/Screens.tsx, RouteError',
  forbidden: 'shell/ForbiddenPage.tsx, ForbiddenPage',
  'alert-confirm': 'features/alerts/AlertConfirmPage.tsx, AlertConfirmPage',
} as const;

/** A screen of `OUTSIDE_ROUTE_TABLE`. */
export type ShellScreen = keyof typeof OUTSIDE_ROUTE_TABLE;
