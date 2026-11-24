-- 0015: sec.session_revoke_membership locks the member row itself, then takes the cut-off
-- (review round 6, RCX-02 / RCU-02, and its follow-up RFX-01:
-- docs/reviews/2026-11-20-stage-c-roles-round-6/). 0001 to 0014 are unchanged.
--
-- The 0013 function stamped statement_timestamp(), the start of the call, in the UPDATE that
-- also took the member row. That was late enough only because every caller had locked the row in
-- an earlier statement (lockTarget in the people routes, the locking SELECTs of
-- provision-member). A caller that did not would wait for the row inside the call, with the
-- cut-off already fixed at the start of the wait: a sign-in authenticated at the identity
-- provider during the wait, in a later second, passed sec.session_create once the revocation
-- had committed. The incident script had exactly this defect (RCX-02) and carried its own fix.
-- Now the function takes the lock in a statement of its own and reads clock_timestamp() in the
-- next one, so no caller can stamp before its wait. scripts/revoke-subject-sessions.sql calls
-- the function instead of repeating it, so it locks and stamps one member id (RFX-01).
--
-- No table, column, grant or data changes. Same signature and return type, so CREATE OR REPLACE
-- keeps the owner (tinnox_definer), the pinned search_path and EXECUTE for tinnox_app only.
--
-- Locks: none on a table. CREATE OR REPLACE FUNCTION locks only the function's own catalogue
-- row; a call in flight finishes with the old body. Safe while the API runs.

SET LOCAL ROLE tinnox_definer;

-- Ends every live session of one member of the current organisation and sets the member's
-- cut-off: sessions created, and sign-ins authenticated, before it are refused. Returns the
-- number of sessions ended; one that had already expired is left alone and not counted
-- (sec.session_purge_expired clears its ID token). tinnox_app has no rights on session, hence a
-- sec.* function.
--
-- The cut-off is the moment this call holds the member row, never earlier. The row is locked
-- first, in a statement of its own, and the clock is read in the next statement:
-- statement_timestamp() is the start of the caller's statement, and an UPDATE computes its new
-- values before it waits for the row, so either one alone stamps the start of the wait (review
-- round 6, RCX-02). A sign-in on another connection needs the same row lock
-- (sec.session_create, FOR NO KEY UPDATE). One that committed first is older than the cut-off
-- and visible to the last statement, which takes a fresh snapshot at READ COMMITTED, so it is
-- revoked. One that gets the row afterwards reads this cut-off and is refused unless it was
-- authenticated after it. greatest() skips NULL and never moves the cut-off back, so a
-- revocation that commits after a later one cannot let the sessions between the two back in.
--
-- Lock order: the member row (FOR NO KEY UPDATE), then that member's live session rows. These
-- are the locks the 0013 body took, in the same modes and order; only the statement that takes
-- the first one changed. Every other path takes the member row before any session row too: the
-- sign-in callback (its member row, the new session, then the session it replaces), the people
-- routes (the organisation's membership advisory lock, the actor's row FOR SHARE, the target
-- row, then this function, for which the row lock is already held), provision-member (the
-- advisory lock, the row, this function) and the incident script (this function only). A
-- caller's lock_timeout applies to the wait here as it did to the UPDATE.
CREATE OR REPLACE FUNCTION sec.session_revoke_membership(p_membership_id uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_org uuid := public.app_org_id();
  n integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'session_revoke_membership requires an organisation context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- An id from another organisation matches no row, so it takes no lock and waits for none
  -- (0012:11-13). The definer's 0013 UPDATE grant on the column allows the lock.
  PERFORM 1 FROM public.membership m
  WHERE m.id = p_membership_id AND m.org_id = v_org
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership does not belong to the current organisation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The row is held: read the clock now. Not in membership_guard's column list.
  UPDATE public.membership m
  SET sessions_valid_after = greatest(m.sessions_valid_after, clock_timestamp())
  WHERE m.id = p_membership_id AND m.org_id = v_org;
  -- shortcut: a session past the idle timeout (not known here) is still counted; pass the
  -- timeout in, as sec.session_by_id_hash takes it, if sessionsEnded must be exact.
  UPDATE public.session s SET revoked_at = now(), id_token = NULL
  WHERE s.membership_id = p_membership_id AND s.org_id = v_org AND s.revoked_at IS NULL
    AND s.expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

RESET ROLE;
