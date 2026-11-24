-- Ends every live session of one operator (an OIDC subject), in every organisation.
-- Incident runbook: docs/security/operations-and-release-checklist.md, section 1.3.
--
-- Run as the database superuser (or as tinnox_migrator, which may SET ROLE
-- tinnox_definer), with psql -v ON_ERROR_STOP=1 -v subject='<oidc subject>'.
-- It also sets the member's cut-off, so a browser still signed in at the identity provider
-- must enter the password and one-time code again. End the user's sessions at the identity
-- provider too.
--
-- Sessions are marked revoked rather than deleted, so they stay as evidence. In the same
-- transaction the membership gets one membership.sessions_end audit event (also when it had no
-- live session), and each membership that had a live session one auth.logout event.

BEGIN;
-- Exactly the rights of the security functions' owner: it may run sec.session_revoke_membership,
-- INSERT into audit_event, and read past row-level security on every table.
SET LOCAL ROLE tinnox_definer;

-- The member's organisation: sec.session_revoke_membership works on a member of the current
-- organisation only. oidc_sub is unique (0001), so this is one row. No row: no membership has
-- this subject, and nothing below changes anything.
SELECT set_config('app.org_id', m.org_id::text, true) IS NOT NULL AS member_found
FROM public.membership m WHERE m.oidc_sub = :'subject';

-- The function (0015) locks the member row, takes the cut-off once it holds it and ends the live
-- sessions, all for one member id, as the API's "Sign out everywhere" does: sessions created, and
-- sign-ins authenticated, before the cut-off are refused, also one authenticated while this
-- waited for the row. A cut-off never moves back. If the member was provisioned after the
-- statement above, the function refuses (no organisation context) and the script stops with
-- nothing changed: run it again.
WITH cut AS MATERIALIZED (
  SELECT m.id, m.org_id, sec.session_revoke_membership(m.id) AS sessions
  FROM public.membership m WHERE m.oidc_sub = :'subject'
)
INSERT INTO public.audit_event (org_id, actor_type, actor_id, action, object_type, object_id, result, detail)
SELECT cut.org_id, 'system', NULL, event.action, 'membership', cut.id::text, 'success', event.detail
FROM cut
CROSS JOIN LATERAL (VALUES
  ('membership.sessions_end', jsonb_build_object('reason', 'incident_revocation'), true),
  ('auth.logout', jsonb_build_object('reason', 'incident_revocation', 'sessions', cut.sessions),
   cut.sessions > 0)
) AS event (action, detail, wanted)
WHERE event.wanted;

COMMIT;
