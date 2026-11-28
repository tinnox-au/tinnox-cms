-- 0017: a screen can be deleted (CMS-41). 0001 to 0016 are unchanged.
--
--   1. display.deleted_at: a soft delete, as playlist has (0005). A display that was ever paired
--      or published is referenced for good (publication is immutable; player_registration,
--      pairing_session and display_alert have no cascade), so the row stays and every operator
--      query for live displays filters on the column. display_org_idx stays as it is: the alert
--      check reads every display of an organisation, deleted ones included, so that an open
--      episode of a deleted display still closes (alerts.ts). display_deleted_unassigned: a
--      deleted display has nothing assigned, as the delete leaves it.
--   2. display_deleted_guard: a deleted display is final. No write may change it again, so
--      neither an un-delete nor an edit that raced the delete can bring it back. A later
--      migration that updates display rows must filter on deleted_at IS NULL, or lift the guard
--      for its backfill and restore it in the same transaction (as 0005 did with FORCE).
--   3. sec.pairing_claim: a deleted display is not found, checked again once the display's
--      pairing lock is held. DELETE /api/displays/:id takes that lock first
--      (sec.pairing_cancel_claims, unchanged: the delete calls it while the row is still live,
--      and a deleted display has no claims left) and holds it to COMMIT; a claim that passed the
--      first check while the delete was open waits for the lock and then sees the delete (each
--      statement takes a fresh snapshot at READ COMMITTED).
--
-- sec.pairing_complete is not changed. Every claim of the display is cancelled under its
-- pairing lock in the delete's own transaction, and pairing_claim refuses the display after it,
-- so no claimed session can name a deleted display. A collection that holds its pairing row
-- (FOR UPDATE) first commits before the cancellation can write that row, and the delete's later
-- statement revokes the registration it made; one that comes second finds the claim expired. A
-- display check there would never fire, and could not be race-free anyway: FOR SHARE on display
-- needs an UPDATE grant that tinnox_definer does not hold.
--
-- Grants. tinnox_app gets UPDATE (deleted_at) on display, and still no DELETE. tinnox_definer
-- reads the new column through its table-wide SELECT on display (0001). CREATE OR REPLACE keeps
-- pairing_claim's owner, pinned search_path and EXECUTE for tinnox_app only.
--
-- Locks: ACCESS EXCLUSIVE on display until commit (ADD COLUMN, a nullable column with no default,
-- is a catalogue change; ADD CONSTRAINT; CREATE TRIGGER). Validating the CHECK reads display
-- once, and every row passes (deleted_at is NULL on all of them); nothing is rewritten. An API
-- from before 0017 keeps working (it never names the column), so migrate, then start the new API
-- and portal; run it while the API is idle.

-- ----------------------------------------------------------------------- 1. display

ALTER TABLE public.display ADD COLUMN deleted_at timestamptz;

-- The delete clears the assignments in the same UPDATE, so no write of ours trips this.
ALTER TABLE public.display ADD CONSTRAINT display_deleted_unassigned
  CHECK (deleted_at IS NULL OR num_nonnulls(assigned_playlist_id, assigned_schedule_id, assigned_layout_id) = 0);

-- display is granted column by column.
GRANT UPDATE (deleted_at) ON public.display TO tinnox_app;

-- ----------------------------------------------------------- 2. display_deleted_guard

-- The delete itself sets deleted_at on a live row, clearing the assignments in the same UPDATE;
-- every later UPDATE of the row is refused. The API never reaches this: each write locks the row
-- with deleted_at IS NULL first and answers 404.
CREATE FUNCTION public.display_deleted_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted display cannot be changed'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'display_deleted_guard';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER display_deleted_guard BEFORE UPDATE ON public.display
  FOR EACH ROW EXECUTE FUNCTION public.display_deleted_guard();

-- Trigger functions run as the writing role; nobody needs to call them directly.
REVOKE ALL ON FUNCTION public.display_deleted_guard() FROM PUBLIC;

-- -------------------------------------------------------------------- 3. sec.*

SET LOCAL ROLE tinnox_definer;

-- Same contract as 0013, plus: a deleted display is not found, before the display's pairing lock
-- and again once it is held, so a claim cannot slip in behind a delete that held the lock. Same
-- signature and OUT columns, so owner and grants stay.
CREATE OR REPLACE FUNCTION sec.pairing_claim(
  p_code text, p_display_id uuid, p_membership_id uuid, p_max_failures integer, p_window_seconds integer)
  RETURNS TABLE (outcome text, pairing_id uuid, replaced_registration_id uuid, cancelled_pairing_ids uuid[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_org uuid := public.app_org_id();
  v_failures integer;
  v_pairing uuid;
  v_replaced uuid;
  v_cancelled uuid[];
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'pairing_claim requires an organisation context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_max_failures IS NULL OR p_max_failures < 1 OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid claim limits' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.membership m
  WHERE m.id = p_membership_id AND m.org_id = v_org AND m.removed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership does not belong to the current organisation' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.display d
  WHERE d.id = p_display_id AND d.org_id = v_org AND d.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'display_not_found'::text, NULL::uuid, NULL::uuid, NULL::uuid[];
    RETURN;
  END IF;

  -- One claim per operator at a time, until commit: counting the failures and recording
  -- this one are then a single step, across connections and API processes (SCX-05).
  -- Taken after the membership check, so the key is a verified member of this organisation.
  PERFORM pg_advisory_xact_lock(hashtextextended('tinnox.pairing_claim:' || p_membership_id::text, 0));

  DELETE FROM public.pairing_claim_failure f WHERE f.failed_at < now() - interval '1 day';
  SELECT count(*) INTO v_failures FROM public.pairing_claim_failure f
  WHERE f.membership_id = p_membership_id AND f.failed_at > now() - make_interval(secs => p_window_seconds);
  IF v_failures >= p_max_failures THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::uuid, NULL::uuid[];
    RETURN;
  END IF;

  -- One claim or cancellation per display at a time (the same lock as
  -- sec.pairing_cancel_claims), so two claims cannot both miss each other (SCX-01).
  PERFORM pg_advisory_xact_lock(hashtextextended('tinnox.pairing_display:' || p_display_id::text, 0));

  -- A delete holds the lock above to its COMMIT: read the display again, in a statement of its
  -- own, so a delete that committed while this claim waited is seen (0017).
  PERFORM 1 FROM public.display d
  WHERE d.id = p_display_id AND d.org_id = v_org AND d.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'display_not_found'::text, NULL::uuid, NULL::uuid, NULL::uuid[];
    RETURN;
  END IF;

  UPDATE public.pairing_session ps
  SET status = 'claimed', org_id = v_org, display_id = p_display_id,
      claimed_at = now(), claimed_by_membership = p_membership_id,
      -- give the player time to collect its credential even if the code was about to expire
      expires_at = greatest(ps.expires_at, now() + interval '2 minutes')
  WHERE ps.code = p_code AND ps.status = 'pending' AND ps.expires_at > now()
  RETURNING ps.id INTO v_pairing;

  IF v_pairing IS NULL THEN
    INSERT INTO public.pairing_claim_failure (membership_id) VALUES (p_membership_id);
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::uuid[];
    RETURN;
  END IF;

  -- The newest claim is the only one that can complete: older claims of this display
  -- that were never collected are cancelled. Pairing rows are locked before
  -- registration rows, the order sec.pairing_complete uses.
  WITH cancelled AS (
    UPDATE public.pairing_session ps SET status = 'expired'
    WHERE ps.display_id = p_display_id AND ps.org_id = v_org AND ps.status = 'claimed'
      AND ps.id <> v_pairing
    RETURNING ps.id
  )
  SELECT coalesce(array_agg(cancelled.id), '{}') INTO v_cancelled FROM cancelled;

  -- The new player replaces any player currently registered to the display.
  UPDATE public.player_registration pr
  SET revoked_at = now(), revoked_reason = 'replaced'
  WHERE pr.display_id = p_display_id AND pr.org_id = v_org AND pr.revoked_at IS NULL
  RETURNING pr.id INTO v_replaced;

  RETURN QUERY SELECT 'claimed'::text, v_pairing, v_replaced, v_cancelled;
END $$;

RESET ROLE;
