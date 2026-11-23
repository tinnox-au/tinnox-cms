# Bugbot review rules for TINNOX CMS

## Code Review Rules

`.cursor/BUGBOT.md` is generated from this section by `npm run check:docs -- --write`; `npm run check:docs` fails when they differ. Edit `AGENTS.md` only, and keep every rule in this one file: no nested or override rule files.

Report findings as Critical, High, Medium, Low or Observation. Cite `path:line` for every finding. Say what you could not verify by reading alone and mark it "unverified pending runtime". Check `docs/decisions-2026-11.md`, `docs/security/control-matrix.md` and earlier rounds under `docs/reviews/` first: a known, documented residual is reported as such, not as a new finding.

### 1. Three database roles

The roles are created in `infra/postgres/init/01-roles.sh`.

- `tinnox_app` is the only runtime role. It has no superuser, no `BYPASSRLS` and owns nothing. Flag any runtime code that connects as another role, any grant that lets `tinnox_app` own, alter or bypass RLS on a table, and any widening of its grants beyond what a feature needs.
- `tinnox_migrator` owns the schema. Only offline tools connect as it: the migration runner (`packages/db/src/migrate.ts`, also the test reset), the development seed (`scripts/seed.ts`) and TINNOX's provisioning script (`scripts/provision-member.ts`, from a controlled host); each connects through `connectMigrator`, which refuses any other role. Integration test helpers also connect as it, with plain clients, to arrange data (`TEST_DATABASE_MIGRATOR_URL`); that is test code, outside this rule. The e2e setup uses it only through the runner, the test reset and the seed. Its credentials, and the provisioning reader secret, never reach the API, the media worker or the player. The database administrator runs the incident scripts `scripts/revoke-all-sessions.sql` and `scripts/revoke-subject-sessions.sql`, as the superuser or `tinnox_migrator`; they work only under `SET LOCAL ROLE tinnox_definer`, which `tinnox_app` cannot take.
- `tinnox_definer` cannot log in, has `BYPASSRLS`, and only owns the narrow `sec.*` `SECURITY DEFINER` functions that must read before the organisation is known (session, device token, pairing, e-mail alerts). Every new or changed `sec.*` function must pin `search_path`, take only what it needs, return the minimum, and be granted `EXECUTE` to `tinnox_app` only. Migration 0013 grants it `UPDATE (first_signed_in_at, sessions_valid_after)` on `membership`, which its `sec.*` functions write. It also grants a read of `member_invite` and `UPDATE (status)` on it. Only `provision-member` uses these, under `SET LOCAL ROLE tinnox_definer`; no `sec.*` function does. Migration 0014 adds `sec.display_alert_orgs()`, which returns organisation ids only, for the alert check that runs with no session, and `sec.alert_recipient_by_token_hash(bytea)`, which returns the organisation and recipient id of an unexpired, unconfirmed alert address for a confirmation link, never the address; it grants `tinnox_definer` `SELECT` on five `alert_recipient` columns, not `email`. A new cross-organisation read is High until justified.

### 2. Tenant isolation

- Every tenant query runs inside `withOrg` (`packages/db/src/tx.ts`), which sets `app.org_id` for that transaction only. `withoutOrg` and `poolAsTx` are only for `sec.*` calls before the organisation is known. Flag any tenant query outside `withOrg`.
- The organisation id comes from the verified session membership or the device credential, never from a path, query, body or header. Flag any route that reads an `orgId` or `org_id` from the request.
- Cross-organisation ids answer 404, never 403. A refusal by role is decided before any lookup and is the same 403 for every id (DEC-35). Each new table or route gets a case in `packages/db/test/rls.integration.test.ts` or `tests/integration/cross-org.test.ts`.
- Media, signed URLs, publications and player endpoints are tenant data too: check that a signed URL or device token for one organisation cannot reach another's objects.

### 3. Audit record in the same transaction as the change

- A state change that must be audited (sign-in and sign-out, pairing, revocation, upload, publishing, membership, and any new security-relevant action) writes its `audit_event` row with `auditScoped` or `auditUnscoped` (`packages/db/src/sec.ts`) on the same `Tx` as the change, so both commit or neither does. Writing the change in one transaction and the audit in a later one is a finding (see CX-01 in `docs/reviews/2026-11-16-backend-round-1/`). Two exceptions, both refusals where nothing changed: `auditStandalone` (unscoped sign-in and device-credential refusals) and the scoped refusal-only transaction (SCR-32) (D2).
- Audit rows carry actor, organisation, object and result. They never contain content, secrets, tokens, signed URLs or query strings. `occurred_at` is set by the database, so code must not pass a time.
- `audit_event` is append-only. Flag any `UPDATE` or `DELETE` on it and any change to its trigger.

### 4. Migration history

- Migrations live in `db/migrations/NNNN_description.sql`, are applied in order, and each runs in one transaction with its `schema_migrations` row. A migration that has been merged to `main` is never edited, renamed or deleted: `npm run check:migrations` fails such a change in CI (against `origin/main` on a branch or pull request, against the first-parent history of `HEAD` on `main`), and the runner rejects a changed checksum on any database that applied it. Fixes go in a new migration with the next number.
- Flag a migration that depends on data only present in development, and non-transactional statements (`CREATE INDEX CONCURRENTLY`, `VACUUM`) that cannot run inside the runner's transaction.
- Ownership changes on `sec.*` functions use `SET LOCAL ROLE tinnox_definer` and `RESET ROLE`, as in migrations 0003, 0004, 0010, 0012, 0013 and 0014.
- Locks: flag table rewrites or long `ACCESS EXCLUSIVE` locks on large tables. `tinnox_migrator` has `lock_timeout = '30s'`.
- Each migration that changes tables, policies, grants or functions has an integration test like `packages/db/test/migration-0005.integration.test.ts` when it upgrades existing data.

### 5. Skills for each kind of round

- Frontend rounds (portal, player, `packages/app-render`): also apply `.agents/skills/web-design-guidelines/`.
- Database rounds (migrations, RLS, `packages/db`): also apply `.agents/skills/postgres-best-practices/`. Its examples use Supabase's `authenticated` and `service_role` roles and `auth.uid()`. In this repo those map to `tinnox_app` with `app.org_id`, and there is no service role: nothing at runtime may bypass RLS except the `sec.*` functions above. Ignore advice that only applies to Supabase's hosted platform.
