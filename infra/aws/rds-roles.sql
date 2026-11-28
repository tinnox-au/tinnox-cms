-- The three database roles and the database, on Amazon RDS. It is what
-- infra/postgres/init/01-roles.sh does for the local database, changed where RDS differs:
--   * the RDS master user is not a superuser. It may create roles, BYPASSRLS included
--     (tested on PostgreSQL 17.9, 25 November 2026), but it must be given SET on
--     tinnox_migrator before it can create a database that role owns, and the database's
--     own settings are made as its owner;
--   * there is no tinnox_test database;
--   * passwords arrive as SCRAM-SHA-256 verifiers, made by infra/aws/bootstrap.sh, so no
--     password is in this text, in the server's log or in the database's log.
--
-- Run by infra/aws/bootstrap.sh as the master user, in database "postgres", with psql:
--   -v migrator_verifier=...  -v app_verifier=...
-- An empty verifier leaves that role's password as it is (bootstrap.sh always gives both,
-- from what Parameter Store holds). The script may be run again:
-- it creates what is missing, checks the attributes of what exists and sets every grant
-- and setting to what is written here.
\set ON_ERROR_STOP on

SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tinnox_migrator') AS make_migrator,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tinnox_app') AS make_app,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tinnox_definer') AS make_definer,
       :'migrator_verifier' <> '' AS set_migrator_password,
       :'app_verifier' <> '' AS set_app_password
\gset

-- A verifier, not a password: refuse anything else before it could be stored as one.
SELECT (:'migrator_verifier' = '' OR :'migrator_verifier' ~ '^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$')
   AND (:'app_verifier' = '' OR :'app_verifier' ~ '^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$')
       AS verifiers_well_formed
\gset
\if :verifiers_well_formed
\else
  DO $$ BEGIN RAISE EXCEPTION 'a verifier is not a SCRAM-SHA-256 verifier'; END $$;
\endif

\if :make_migrator
  \if :set_migrator_password
  \else
    DO $$ BEGIN RAISE EXCEPTION 'tinnox_migrator does not exist and no password was given: run bootstrap.sh with --rotate-database-passwords'; END $$;
  \endif
  CREATE ROLE tinnox_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
\endif
\if :make_app
  \if :set_app_password
  \else
    DO $$ BEGIN RAISE EXCEPTION 'tinnox_app does not exist and no password was given: run bootstrap.sh with --rotate-database-passwords'; END $$;
  \endif
  CREATE ROLE tinnox_app      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
\endif
\if :make_definer
  CREATE ROLE tinnox_definer  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION;
\endif

-- The attributes of AGENTS.md, section 1. They are given when a role is created; a user
-- who is not a superuser may not state some of them again with ALTER ROLE, not even to
-- say NOSUPERUSER. So a role that already exists is checked, and anything else stops here.
DO $$
DECLARE
  wrong text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO wrong
    FROM pg_roles
   WHERE rolname IN ('tinnox_migrator', 'tinnox_app', 'tinnox_definer')
     AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
          OR rolcanlogin IS DISTINCT FROM (rolname <> 'tinnox_definer')
          OR rolbypassrls IS DISTINCT FROM (rolname = 'tinnox_definer'));
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'these roles do not have the attributes of AGENTS.md, section 1: %', wrong;
  END IF;
END $$;

-- The migrator may hand function ownership to tinnox_definer (needs SET), but does not
-- inherit its privileges.
GRANT tinnox_definer TO tinnox_migrator WITH INHERIT FALSE, SET TRUE;

-- No other membership may exist for the three roles: tinnox_app in tinnox_definer, or
-- any of them in a role such as pg_read_all_data, would be a way round row-level
-- security that the attributes above do not show. The script does not remove such a
-- grant, since it cannot know why it is there: it stops and names it.
DO $$
DECLARE
  wrong text;
BEGIN
  SELECT string_agg(format('%s in %s', m.member::regrole, m.roleid::regrole), ', ') INTO wrong
    FROM pg_auth_members m
   WHERE m.member IN ('tinnox_migrator'::regrole, 'tinnox_app'::regrole, 'tinnox_definer'::regrole)
     AND NOT (m.roleid = 'tinnox_definer'::regrole AND m.member = 'tinnox_migrator'::regrole
              AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option);
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected role membership: %. Revoke it, then run this again', wrong;
  END IF;
END $$;

-- The master user needs SET on tinnox_migrator to create its database and to act as the
-- owner below. It is taken away again at the end.
GRANT tinnox_migrator TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;

SELECT 'CREATE DATABASE tinnox OWNER tinnox_migrator ENCODING ''UTF8'''
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tinnox')
\gexec

SET ROLE tinnox_migrator;
REVOKE ALL ON DATABASE tinnox FROM PUBLIC;
GRANT CONNECT ON DATABASE tinnox TO tinnox_app;
ALTER DATABASE tinnox SET timezone = 'UTC';
RESET ROLE;

REVOKE tinnox_migrator FROM CURRENT_USER;

-- Defaults for ad-hoc sessions. A role may change its own defaults, so the API also sends
-- the same timeouts (and row_security = on) when it connects (packages/db createPool).
ALTER ROLE tinnox_app      SET statement_timeout = '15s';
ALTER ROLE tinnox_app      SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE tinnox_app      SET lock_timeout = '5s';
ALTER ROLE tinnox_migrator SET lock_timeout = '30s';

-- Passwords last, after everything that can fail.
\if :set_migrator_password
  ALTER ROLE tinnox_migrator PASSWORD :'migrator_verifier';
\endif
\if :set_app_password
  ALTER ROLE tinnox_app PASSWORD :'app_verifier';
\endif

-- What exists now, for the person who ran this.
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
  FROM pg_roles WHERE rolname LIKE 'tinnox\_%' ORDER BY rolname;
SELECT d.datname, r.rolname AS owner, d.datacl
  FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'tinnox';
SELECT m.roleid::regrole AS role, m.member::regrole AS member, m.grantor::regrole AS grantor,
       m.admin_option, m.inherit_option, m.set_option
  FROM pg_auth_members m WHERE m.roleid::regrole::text LIKE 'tinnox\_%' ORDER BY 1, 2, 3;
