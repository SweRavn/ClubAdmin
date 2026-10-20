-- SPDX-License-Identifier: AGPL-3.0-only
-- Cluster-level database roles (docs/security.md, ADR 0004). Idempotent.
-- Run by `pnpm db:bootstrap` as a superuser, which afterwards sets LOGIN and a
-- password for each role whose password is configured in the environment.
--
--   clubadmin_owner      owns schemas and tables, runs migrations; never used by the apps
--   clubadmin_app        API and worker; subject to row-level security; DML only
--   clubadmin_operator   audited operator tooling; must identify itself as an operator
--   clubadmin_retention  retention and erasure jobs; may delete or scrub history and audit rows

DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['clubadmin_owner', 'clubadmin_app', 'clubadmin_operator', 'clubadmin_retention'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
    -- Never superuser, never able to bypass row-level security.
    EXECUTE format(
      'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
      role_name
    );
  END LOOP;
END
$roles$;

-- Abort transactions that are left open by a crashed request or job.
ALTER ROLE clubadmin_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE clubadmin_operator SET idle_in_transaction_session_timeout = '60s';
