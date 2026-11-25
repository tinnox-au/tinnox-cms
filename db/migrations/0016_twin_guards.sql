-- 0016: the row-local twins of a contract rule hold the contract's own rule in the database
-- (adoption plan step 31, decision D7). 0001 to 0015 are unchanged.
--
--   1. member_invite_email_shape and alert_recipient_email_shape: the shape of InviteEmailSchema
--      (packages/contracts/src/members.ts), one "@" and a dot in the domain, no whitespace,
--      with no ASCII restriction: the contract takes 'ü@example.de', so must the database.
--      Before, both accepted 'a@b' and 'a@b@c'. The alert check keeps lower() and its banned
--      characters (AlertEmailSchema, packages/contracts/src/alerts.ts).
--   2. media_availability_year: both ends of a media window lie in the years 1000 to 9999,
--      which LocalDateTimeSchema (packages/contracts/src/ids.ts) and every reader
--      (to_char ... 'YYYY', the manifest) take. Before, timestamp(0) held year 999 or 10000,
--      and buildManifest threw on it.
--
-- PostgreSQL's [:space:] is not JavaScript's \s. On PostgreSQL 17 on Alpine (musl, the image of
-- infra/docker-compose.yml and CI) it lacks U+00A0, U+1680, U+2007, U+202F and U+FEFF, which \s
-- has, and has U+0085, which the contract refuses as a control character. So the database stays
-- looser than the contract on those characters (and on other control and text-direction
-- characters), never stricter: tests/integration/twins.test.ts holds that, with its
-- allow-list.
--
-- Existing rows. Only the API writes these columns, after the contract (members.ts,
-- alert-recipients.ts, media.ts); a row the old shapes let in but the new ones refuse could come
-- only from SQL by hand or a contract older than the database. Such a row is tenant data, so
-- this migration neither deletes nor rewrites it: it stops, names each row by table and id
-- (never the address), and changes nothing. Deciding what the row should become is for a person.
-- Row-level security is forced on all three tables, so even their owner sees no row without an
-- organisation; FORCE is lifted for the one read that spans every organisation and put back
-- before anything else runs, as 0013 does. The catalogue and the runner's schema invariants
-- check it is back.
--
-- Plain ADD CONSTRAINT, not NOT VALID followed by VALIDATE CONSTRAINT: the runner applies the
-- whole file in one transaction, so the ACCESS EXCLUSIVE lock that ADD CONSTRAINT takes is held
-- to the COMMIT either way, and splitting would only add a statement.
--
-- Locks: ACCESS EXCLUSIVE on member_invite, alert_recipient and media until commit (ALTER TABLE
-- ... FORCE ROW LEVEL SECURITY, DROP CONSTRAINT and ADD CONSTRAINT). No table is rewritten; each
-- is read twice in full, once by the check below and once to validate its new constraint.
-- member_invite holds pending invites only with an address and alert_recipient at most 20 rows
-- per organisation; media holds one row per uploaded file, so the scan grows with the library.
-- Run it while the API is stopped or idle.

ALTER TABLE public.member_invite NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.alert_recipient NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.media NO FORCE ROW LEVEL SECURITY;

-- The predicates are the CHECKs below, negated; a row they miss would still fail ADD CONSTRAINT,
-- with PostgreSQL's message, which names no row.
DO $$
DECLARE
  shape CONSTANT text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  found text;
BEGIN
  SELECT string_agg(format('%s %s', t.tbl, t.id), ', ' ORDER BY t.tbl, t.id) INTO found
  FROM (
    SELECT 'member_invite' AS tbl, id FROM public.member_invite
    WHERE email IS NOT NULL AND email !~ shape
    UNION ALL
    SELECT 'alert_recipient', id FROM public.alert_recipient
    WHERE email !~ shape
    UNION ALL
    SELECT 'media', id FROM public.media
    WHERE available_from NOT BETWEEN '1000-01-01 00:00:00' AND '9999-12-31 23:59:59'
       OR available_until NOT BETWEEN '1000-01-01 00:00:00' AND '9999-12-31 23:59:59'
  ) t;
  IF found IS NOT NULL THEN
    -- The message, not a HINT: the runner's error carries the message alone.
    RAISE EXCEPTION 'migration 0016 changed nothing: these rows break the rule it adds (an address like name@example.com, a media window year from 1000 to 9999): %. Each is tenant data: correct, close or remove it with its organisation, then run the migrations again.', found
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE public.media FORCE ROW LEVEL SECURITY;
ALTER TABLE public.alert_recipient FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_invite FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------ 1. the address shapes

-- Twin of InviteEmailSchema's shape (packages/contracts/src/members.ts). NULL once the invite
-- has closed (member_invite_open).
ALTER TABLE public.member_invite DROP CONSTRAINT member_invite_email_shape,
  ADD CONSTRAINT member_invite_email_shape
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- Twin of AlertEmailSchema: the invite shape, lower case, and no RFC 5322 name, group, list or
-- quoted forms, which the mailer would deliver to another mailbox than the stored string.
ALTER TABLE public.alert_recipient DROP CONSTRAINT alert_recipient_email_shape,
  ADD CONSTRAINT alert_recipient_email_shape CHECK (
    email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    AND email = lower(email)
    AND email !~ '[][<>()\\,;:"[:space:]]'
  );

-- ------------------------------------------------------------ 2. the media window year

-- Twin of LocalDateTimeSchema's years. timestamp(0) has whole seconds, so the last second of
-- 9999 is the last value; NULL is no limit on that side (media_availability_order).
ALTER TABLE public.media
  ADD CONSTRAINT media_availability_year CHECK (
    (available_from IS NULL
      OR available_from BETWEEN '1000-01-01 00:00:00' AND '9999-12-31 23:59:59')
    AND (available_until IS NULL
      OR available_until BETWEEN '1000-01-01 00:00:00' AND '9999-12-31 23:59:59')
  );
