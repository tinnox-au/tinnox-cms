# tests

Repository-level tests of TINNOX CMS prototype M0. All of them run against real
services; nothing is mocked except where a file says so in its header.

| Directory | What | Command (from the repository root) |
|---|---|---|
| `integration/` | Integration and security-boundary tests (vitest). Real PostgreSQL as the runtime role, the real API on a real listener, the real media-worker container image. | `npm run test:integration` |
| `e2e/` | Browser end-to-end tests (Playwright, Chromium). Real Keycloak sign-in with TOTP, real API process, production builds of the portal and the player in separate browser contexts. | `npm run test:e2e` |
| `support/` | `dev-identity.ts` (generated development users, TOTP codes), `png.ts` (PNG writer and reader for synthetic images and pixel checks). | |

Development users (`support/dev-identity.ts`, `DevUserName`): `operator` (Owner of "TINNOX Internal"; every spec defaults to it), `secondOrgOperator` (Owner of the second organisation), and since stage C `admin` (Keycloak username `org-admin`), `editor` and `viewer`, the Admin, Editor and Viewer of "TINNOX Internal". `npm run setup` adds missing users to an existing credentials file; the Keycloak container must then be recreated (setup prints the command) and the database re-seeded.

Stage B slice 2 (built-in apps) added `e2e/07-apps-player.spec.ts` (apps drawn by a
paired player: the site's time zone, item order and index, a finished countdown, a QR
code, a ticker on a strip canvas and on a screen rotated 90°, reduced motion, text fit,
no CSP violation) and `e2e/08-apps-portal.spec.ts` (creating and editing an app through
the portal by keyboard, the contrast warning, adding an app to a playlist and pushing,
deleting an app in use, the still ticker preview, no CSP violation and no web storage).

Stage B slice 4 (layouts) added `e2e/12-layouts-portal.spec.ts` (creating a layout through the
dialog by keyboard; a band with no playlist refused, with the error summary leading to its
field; the band height stepped with the keyboard and the preview's pixel sizes on landscape,
portrait and a small LED shape; assigning the layout on a screen's page and pushing it; the
refusals to delete a layout a screen has and a playlist a layout uses; a playlist replacing the
layout; phone width; no CSP violation and no web storage) and `e2e/13-layouts-player.spec.ts`
(a main zone and a Ticker band on four canvases, rotation and a content rectangle included:
version 5, the zone boxes within 1 px, the ticker size, the reduced-motion wrap, a band-height
change, and back to version 1). `support/operator.ts` gains `bandLayout`, `createLayout`,
`replaceLayout` and `assignLayout`; `support/portal.ts` gains `createLayoutInPortal`,
`saveLayout` and `assignLayoutOnScreenPage`; `support/player.ts` gains `zoneBox`.

Stage B slice 3 (schedules) added `e2e/09-schedules-portal.spec.ts` (creating a schedule
through the dialog by keyboard; an event with no playlist refused, with the error summary
leading to its field; events filled in, reordered and removed with focus kept in the
list; assigning the schedule on a screen's page and pushing it; the refusals to delete a
schedule a screen has and a playlist a schedule uses; a playlist replacing the schedule
on a screen, with the dialog saying so; phone width without sideways scrolling; no CSP
violation and no web storage) and `e2e/10-schedules-player.spec.ts` (a paired player in
Australia/Melbourne: an event that covers every moment plays its playlist from a
version 4 manifest; an event on another weekday leaves the default playlist on screen; a
schedule without events is pushed below version 4; the "Schedule picks" and "Build" rows
of the diagnostics panel; no CSP violation). The crossing of an event edge is unit-tested
only (`apps/player-web/src/core/playback.test.ts`): the player corrects its clock from
the server, so a faked browser clock would not move it. Both files pass in the full suite.

`e2e/11-accessibility.spec.ts` runs axe (`@axe-core/playwright`, WCAG 2.2 A and AA) on
every main portal page and on the schedule editor with errors, the create-schedule and
push dialogs, the screen page's tabs and its Change menu, in light and in dark. It fails
on serious and critical findings only (`e2e/support/a11y.ts`, which first waits for short
entrance animations so a dialog is not measured while it fades in). An automated check
finds a share of what a screen-reader user meets; a listening pass with a real screen
reader is still a manual step.

`integration/` gained the schedule routes in `session-csrf.test.ts` and the schedule
probes in `cross-org.test.ts`; the API's own schedule tests are
`apps/api/test/schedules.integration.test.ts`, and the database's are
`packages/db/test/stage-b-schedules.integration.test.ts`.

Stage C (roles and people, `docs/portal-v2/stage-c.md` section 9) added `e2e/14-roles.spec.ts`
(passed in the full e2e run of the round 6 review on 2026-11-20; covers ISO-05: each role signed in through Keycloak, what it sees and what
the API refuses, an invite request and its cancellation, a demotion that ends a session, "Sign out
everywhere" and the forced sign-in with a fresh one-time code, and the seeded roles restored). New integration files: `integration/roles-matrix.test.ts` (every operator route of `integration/routes.ts` as
each of the four roles, against an oracle written in the test), `integration/reauth.test.ts`
(the cut-off, `auth_time` and the forced `prompt=login` round, with a stub provider),
`integration/provision-member.test.ts` (every `provision-member` command), the shared route list
`integration/routes.ts`, `apps/api/test/roles.integration.test.ts`,
`apps/api/test/members.integration.test.ts` and
`packages/db/test/migration-0013.integration.test.ts`. `session-csrf.test.ts` reads its route list
from `integration/routes.ts`; `cross-org.test.ts` gained the people routes and the role refusal
that is the same 403 for every id; `session-revoke-all.test.ts` gained the member cut-off.

Component tests (`npm run test:component`, `apps/portal/src/**/*.test.tsx` in headless
Chromium): every file first waits until the browser provider reaches its frame
(`apps/portal/src/componentTests.setup.ts`, registered as `setupFiles` of the `component`
project in `vitest.config.ts`, which runs `settleTestFrame` from
`apps/portal/src/testFrame.test-support.ts`). The Vitest Playwright provider looks the test
frame up by name and can lag behind the switch to the next file's frame, so on a busy machine a
file's first click or key failed with "Frame was detached".

`npm run test:integration` also runs `packages/*/test/*.integration.test.ts` and
`apps/api/test/*.integration.test.ts`. It rebuilds the database `tinnox_test` first.

### The audit-debt guard

The integration database carries a test-only guard (`packages/db/src/audit-debt-guard.ts`;
poteto adoption plan section 2.1 C, decision D3). No migration creates it and it refuses any
database whose name does not end in `_test`. A transaction of the runtime role `tinnox_app` that
changes a table whose changes must be audited, and commits no `audit_event` row, fails at
`COMMIT` with SQLSTATE `23U01` and a message that names the tables. So every route, and every run
of the media pipeline or the alert check, that an integration test touches is checked for its
audit row, whatever the test asserts. The global setup installs the guard after the migrations;
`scripts/vitest-integration-file-setup.ts` puts it back before each file (a migration test
rebuilds the schema, and the catalogue test removes the guard so that it reads only what the
migrations made) and fails a test with the guard's message when a commit was refused while it
ran, also when the route answered 500 or product code caught the error.

- **Exempt, by D3**: the tables `heartbeat_log`, `display_delivery` and `login_state`; the columns
  `session.last_seen_at` and `pairing_session.failed_attempts`; writes made inside the three
  purge functions. The lists, with their reasons, are at the top of the guard's file.
- **Exempt by shape, by the step 20 ruling** (DEC-38; whether they are audited is open, CMS-36):
  a `DELETE` on `display_alert`, which is the alert check closing an offline episode without an
  e-mail (`alert_closed_silently`); and an `UPDATE` of `pairing_session` that changes only its
  `status`, from pending or claimed to expired, on a row whose time has passed, which is
  `sec.pairing_create` or `sec.pairing_poll` marking it expired (`pairing_expired_by_time`).
  Every other write on those two tables is judged. The list, `EXEMPT_SHAPES`, is in the
  guard's file with its reasons.
- **Not judged**: `tinnox_migrator` and the superuser, which is how test helpers arrange data,
  and how the development seed writes (its `development_seed` reason has no backstop here).
  A test that must write as `tinnox_app` itself (to try row-level security, a grant, a `sec.*`
  function, or to arrange what only that role can) uses a connection named by
  `unjudgedSql(why)`, and says what its SQL is: `appPool(why)` in `packages/db/test/support.ts`,
  `appClient(why)` in `integration/support.ts`, and `t.testSql(why)` of the API harness. A
  route's, job's or helper's own call never moves there to get past the guard. `t.pool` is the
  application's own pool and is judged; reading on it is fine.
- **One path is unaudited by decision**: the sign-out fallback (`sessionRevokeUnaudited`, the
  CX-01 residual). Its test says so with `whileUnauditedAllowed(...)`, which lets one table
  through for the length of one call.

The browser suite's database (`tinnox_e2e_test`) does not get the guard.

### Audit actions, one failure case each, and the row scan

`integration/audit-failure.test.ts` (poteto adoption plan step 17, decision D3) has one case per
audit action: its table is typed by `AuditAction`, so a new action without a case does not
compile. A case names the route that writes the action (or the job, provisioning command or
migration), the request that writes it and a read of what it changes. The harness makes every
insert of that action fail in the database (`whileAuditFails` of `@tinnox/db/testing`, a trigger
on `audit_event` that also counts the inserts it refused), requires that the attempt reached the
audit write, that nothing of the change was kept, and that the same attempt goes through once
the fault is gone. A refusal (nothing changes, and it is answered the same) and the sign-out
(the session ends anyway, the CX-01 residual) say so in their case. `pairing.cancel`, which only
migration 0012 writes, is failed in `packages/db/test/migration-0012.integration.test.ts`.
`integration/provision-member.test.ts` does the same for every command of `PROVISION_COMMANDS`
(`scripts/lib/provision.ts`) and each audit action a command declares (SCR-09).

After each integration test file, `scripts/vitest-integration-file-setup.ts` reads every audit
row the file wrote, as the database administrator, and fails the file when a row holds a URL, a
query string, a token-shaped string or an e-mail address (`scripts/lib/audit-row-scan.ts`,
AG-3.4). A short secret or a typed name has no shape the scan can see; the tests of the routes
that take them check those by value.

Before either suite: `npm run setup`, `npm run infra:up`, and for E2E also
`npm run db:migrate` and `npm run db:seed -- --second-org`. For E2E the API (4000), the
portal (5173) and the player (5174) must **not** be running: Playwright starts them.

## A run is green only when every test ran

A skipped, todo or focused test is a red run (U-15): the lint refuses the declared forms, and
two checks catch what happens at run time. `vitest.config.ts` (and `apps/api/vitest.config.ts`,
the API's own `npm run test:integration -w @tinnox/api`) adds
`scripts/vitest-results-reporter.ts` to the reporters, which fails a unit, component or
integration run that reports a test skipped, todo or never started (`ctx.skip()` included; a
run that selects some tests of its files, by `-t`, a `file:line`, an editor's test ids, a tag
filter or the watch mode's `t`, is not checked). When every file of a project ran, the reporter also
fails it below its floor under `"vitest"` in `test-counts.json` (a describe or a loop that
lost its tests); raise the floor as the project grows. After the browser suite, `npm run check:test-results`
reads `tests/.run/e2e-results.json` and fails on a test skipped at run time
(`testInfo.skip()`), one that did not run behind a failure in a serial file, a flaky one, a
failure, an error outside any test (such as a global teardown that could not sign a session
out), and a spec file whose number of tests is not the one in `test-counts.json`: change that
count in the same change that adds or deletes a test. `skip-allowlist.json` may excuse a test
that did not run or was flaky until its review date, with an owner and a reason; a skip has no
entry. The CI e2e job runs the check whether the suite passed or failed, and keeps the result
file. Run the check on a full run: a run of some spec files fails the counts. `npm run test:e2e`
first removes the last run's result file, so a run that never wrote one is "no report", not the
previous verdict. The quality job runs the stackless checks (`playwright.layout.config.ts`) and
then `npm run check:test-results -- --counts layout`, which reads `tests/.run/layout-results.json`
against the `"layout"` counts.

## What CI runs

`.github/workflows/ci.yml` has four jobs. The quality job runs lint, `npm run format:check`, `check:docs`, `check:migrations`, typecheck, the unit tests, the component tests, the stackless browser checks and their results gate, the build and the audit. The integration job starts PostgreSQL, Keycloak and the worker, runs `npm run verify:oidc` against the real Keycloak, then `npm run test:integration`. The secret scan is its own job. The end-to-end job (the full browser suite, then `npm run check:test-results`) runs only when started by hand or when the repository variable `RUN_E2E` is "true". The steps added on 2026-11-23 (the stackless browser checks and their gate, `verify:oidc`) had not run in GitHub Actions on 2026-11-23.

## Adding a test

A new test in a Vitest project (unit, component or integration) needs no registration: the project's file globs find it, and `tests/test-counts.json` holds only a floor under `"vitest"` that a full run must reach, which the reporter checks. After adding tests, run the project in full (`npm test`, `npm run test:component` or `npm run test:integration`) and read its `Tests N passed` line; raise that project's floor to N in the same change (a test under `apps/api/test` also counts toward `"api-integration"`: run `npm run test:integration -w @tinnox/api` and raise that floor too), because a floor left below the count lets the same number of tests vanish unnoticed. `npx vitest list` is not the number: it does not expand `it.each`. A browser test needs its spec file's count under `"e2e"` (or `"layout"` for `tests/playwright.layout.config.ts`) in the same change, as the gate says. `npx playwright test --list -c tests/playwright.config.ts tests/e2e/<file>.spec.ts` prints `Total: N tests in 1 file` without a stack; give `-c tests/playwright.layout.config.ts` and no file for the layout suite.

## What is substituted, and where

- `integration/`: operator sessions are created through the same `sec.session_create`
  function the sign-in callback uses, instead of driving Keycloak (the E2E suite does the
  real sign-in). Every file except `media-worker.test.ts` writes worker verdicts into the
  outbox itself; `media-worker.test.ts` runs the real worker container.
- `e2e/`: nothing. Faults are injected with Playwright request interception on the
  player's media downloads (corrupt bytes, a transfer cut after half the file) and with
  the browser context's offline switch.

## E2E run state

`tests/.run/` (gitignored, owner-only) holds the API pid and log, the JSON result file,
the E2E API's media directory (`media/`), the last TOTP time step used and, during a run,
the saved browser state of each test user. Global teardown signs those sessions out (API
and Keycloak) and deletes the state files. Screenshots of key states and
`e2e-measurements.json` (measured outage length and recovery times) go to
`tests/.run/evidence/`, or to the directory named by `E2E_EVIDENCE_DIR` (the validation
record's evidence was produced with `E2E_EVIDENCE_DIR=docs/evidence`). Traces and videos
are off because they would record the sign-in form.

The run uses its own database, `tinnox_e2e_test`, rebuilt from the migrations and the seed
at the start (created once as the PostgreSQL superuser), so the development database gets
no test rows. It still restarts the shared PostgreSQL container once (E2E 13).

The E2E API's environment is an allow-list (`e2eApiEnvironment` in `e2e/support/stack.ts`):
its addresses, database, media directory and the local Mailpit are set there, the secrets and
the Keycloak client come from the root `.env`, and every other name the API reads is passed
empty, so nothing exported in the shell reaches it. Before anything else, global set-up refuses
to run unless every host and URL of the run (those settings, the database set-up's connection,
the previews, Mailpit and the API origin, which `playwright.config.ts` also gives the player
build as `VITE_API_BASE_URL`) is `localhost`, 127.0.0.0/8 or `::1`, including any `host` or
`hostaddr` parameter of a database URL (EAX-09; the rules are in
`scripts/lib/loopback-targets.ts`). The previews are started by
Playwright just before global set-up; they listen on 127.0.0.1 only.

Keycloak accepts each one-time code once, so a run that starts within the same 30 seconds
as the previous sign-in of that user waits for the next code.
