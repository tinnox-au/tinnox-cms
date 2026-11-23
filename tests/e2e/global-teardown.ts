import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { removeSavedStates, savedStateFiles } from './support/contexts.ts';
import { API_URL, PORTAL_URL, stopApi } from './support/stack.ts';

interface SavedState {
  cookies: { name: string; value: string; domain: string }[];
}

/**
 * Signs out every operator session this run saved (API session and, through the
 * end-session URL the API returns, the Keycloak session). Returns one line per session it
 * could not sign out; the caller deletes the saved browser states regardless.
 */
async function signOutSavedSessions(): Promise<string[]> {
  const failures: string[] = [];
  for (const path of savedStateFiles()) {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as SavedState;
      const header = (names: (name: string) => boolean): string =>
        state.cookies
          .filter((c) => names(c.name))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      const apiCookie = header((name) => name.startsWith('tinnox_') || name.startsWith('__Host-'));
      if (apiCookie === '') continue;
      const read = await fetch(`${API_URL}/api/session`, { headers: { cookie: apiCookie } });
      if (read.status !== 200) throw new Error(`GET /api/session answered ${read.status}`);
      const session = (await read.json()) as { authenticated: boolean; csrfToken?: string };
      // A session a test already ended (sign-out, demotion) has nothing left to end.
      if (!session.authenticated || session.csrfToken === undefined) continue;
      const logout = await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: apiCookie,
          origin: PORTAL_URL,
          'x-csrf-token': session.csrfToken,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (logout.status !== 200) throw new Error(`POST /api/auth/logout answered ${logout.status}`);
      const { redirectTo } = (await logout.json()) as { redirectTo: string | null };
      if (redirectTo !== null) {
        const keycloakCookie = header(
          (name) => name.startsWith('KEYCLOAK_') || name === 'AUTH_SESSION_ID',
        );
        const ended = await fetch(redirectTo, {
          redirect: 'manual',
          headers: { cookie: keycloakCookie },
        });
        // Keycloak answers its end-session endpoint with a redirect or its own page.
        if (ended.status >= 400) {
          throw new Error(`the identity provider's end-session URL answered ${ended.status}`);
        }
      }
    } catch (error) {
      // The file name says whose session it was; the message never holds a cookie or URL.
      failures.push(
        `${basename(path)}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return failures;
}

/**
 * Signs out the saved sessions, deletes their files and stops the API, then fails the run if
 * a session could not be signed out: a live session left in the shared Keycloak and E2E
 * database is a finding, not a warning (adoption plan section 4.1). Playwright reports the
 * error in the run's result file, which npm run check:test-results reads.
 */
export default async function globalTeardown(): Promise<void> {
  let failures: string[];
  try {
    failures = await signOutSavedSessions();
  } finally {
    removeSavedStates();
    await stopApi();
  }
  if (failures.length > 0) {
    throw new Error(
      `global teardown could not sign out ${failures.length} saved E2E session(s): ${failures.join('; ')}. Sign them out in Keycloak (Sessions of the tinnox-dev realm) and find why the sign-out failed.`,
    );
  }
}
