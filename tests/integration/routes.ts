/**
 * The /api routes of the operator API, and which role may use each, written out by hand as the
 * oracle of the role tests (roles-matrix.test.ts, cross-org.test.ts). Not read from the API's
 * own tables on purpose: session-csrf.test.ts compares this list with the routes the
 * application registers, so a route the API adds or drops shows up there as a test failure.
 */
import type { Role } from '@tinnox/contracts';

/**
 * Every route of the operator API, as registered (`:id` is a UUID): the 51 of portal v2, the
 * 8 people routes of stage C (CMS-13), the 3 alert address routes (CMS-15) and the screen
 * delete (CMS-41). session-csrf.test.ts fails when the application serves an operator route
 * that is not listed here, so a new route cannot skip the role checks unnoticed; it probes the
 * session, CSRF and Origin checks of every route from the application's own inventory.
 */
export const OPERATOR_ROUTE_PATTERNS: readonly (readonly [string, string])[] = [
  ['GET', '/api/sites'],
  ['GET', '/api/displays'],
  ['POST', '/api/displays'],
  ['GET', '/api/displays/status'],
  ['GET', '/api/displays/:id'],
  ['PATCH', '/api/displays/:id'],
  ['DELETE', '/api/displays/:id'],
  ['POST', '/api/displays/:id/claim'],
  ['POST', '/api/displays/:id/revoke-player'],
  ['GET', '/api/displays/:id/status'],
  ['GET', '/api/media'],
  ['POST', '/api/media'],
  ['GET', '/api/media/:id'],
  ['PATCH', '/api/media/:id'],
  ['DELETE', '/api/media/:id'],
  ['GET', '/api/media/:id/preview'],
  ['GET', '/api/media/:id/thumbnail'],
  ['GET', '/api/media/:id/usage'],
  ['GET', '/api/apps'],
  ['POST', '/api/apps'],
  ['GET', '/api/apps/:id'],
  ['PATCH', '/api/apps/:id'],
  ['DELETE', '/api/apps/:id'],
  ['GET', '/api/schedules'],
  ['POST', '/api/schedules'],
  ['GET', '/api/schedules/:id'],
  ['PUT', '/api/schedules/:id'],
  ['DELETE', '/api/schedules/:id'],
  ['GET', '/api/layouts'],
  ['POST', '/api/layouts'],
  ['GET', '/api/layouts/:id'],
  ['PUT', '/api/layouts/:id'],
  ['DELETE', '/api/layouts/:id'],
  ['GET', '/api/tags'],
  ['POST', '/api/tags'],
  ['PATCH', '/api/tags/:id'],
  ['DELETE', '/api/tags/:id'],
  ['GET', '/api/folders'],
  ['POST', '/api/folders'],
  ['PATCH', '/api/folders/:id'],
  ['DELETE', '/api/folders/:id'],
  ['GET', '/api/playlists'],
  ['POST', '/api/playlists'],
  ['GET', '/api/playlists/:id'],
  ['PUT', '/api/playlists/:id'],
  ['DELETE', '/api/playlists/:id'],
  ['POST', '/api/playlists/:id/duplicate'],
  ['POST', '/api/playlists/:id/publish'],
  ['GET', '/api/push'],
  ['POST', '/api/push'],
  ['GET', '/api/overview'],
  ['GET', '/api/audit'],
  ['GET', '/api/members'],
  ['GET', '/api/members/names'],
  ['PATCH', '/api/members/:id'],
  ['POST', '/api/members/:id/remove'],
  ['POST', '/api/members/:id/sign-out'],
  ['GET', '/api/invites'],
  ['POST', '/api/invites'],
  ['POST', '/api/invites/:id/cancel'],
  ['GET', '/api/alert-recipients'],
  ['POST', '/api/alert-recipients'],
  ['DELETE', '/api/alert-recipients/:id'],
];

/** The people, invite and alert address routes an Editor may not use. */
const MEMBER_MANAGEMENT = new Set([
  'GET /api/alert-recipients',
  'POST /api/alert-recipients',
  'DELETE /api/alert-recipients/:id',
  'GET /api/members',
  'PATCH /api/members/:id',
  'POST /api/members/:id/remove',
  'POST /api/members/:id/sign-out',
  'GET /api/invites',
  'POST /api/invites',
  'POST /api/invites/:id/cancel',
]);

/**
 * Whether a role may use an operator route, written from the decision (CMS-13, DEC-35; see
 * roles-matrix.test.ts). cross-org.test.ts takes its Editor pass from it.
 */
export function allowed(role: Role, method: string, pattern: string): boolean {
  const route = `${method} ${pattern}`;
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'editor':
      return !MEMBER_MANAGEMENT.has(route);
    case 'viewer':
      return method === 'GET' && !MEMBER_MANAGEMENT.has(route);
  }
}
