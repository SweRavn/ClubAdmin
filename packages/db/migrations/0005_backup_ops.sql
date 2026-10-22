-- SPDX-License-Identifier: AGPL-3.0-only
-- Backups and restores (P0.11, docs/operations/backup-restore.md):
-- - ops.backup_runs and ops.restore_verifications, written by the backup
--   sidecar and `pnpm ops:verify-backup` (superuser), read by the API
--   (GET /api/v1/ops/backup-status);
-- - ops.key_table_counts(): the row-count snapshot taken with every backup;
-- - privacy.erase_person(): the core of GDPR erasure, which the restore
--   procedure re-applies for every person in the deletion ledger
--   (privacy.replay_deletion_ledger()). The erasure job of P1.8 builds on it.

CREATE SCHEMA ops;
GRANT USAGE ON SCHEMA ops TO clubadmin_app;
--> statement-breakpoint
CREATE TABLE ops.backup_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- full/diff: pgBackRest repo1 (PITR); monthly: repo2 (12 months);
  -- files: object storage replication; ledger: deletion ledger export.
  kind text NOT NULL CHECK (kind IN ('full', 'diff', 'incr', 'monthly', 'files', 'ledger')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- pgBackRest backup label, when known.
  label text,
  size_bytes bigint,
  -- ops.key_table_counts() when the run started (database backups only).
  row_counts jsonb,
  -- Tool output on failure: error codes and messages, never data.
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_runs_finished CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX backup_runs_kind_idx ON ops.backup_runs (kind, status, started_at DESC);
SELECT app.enable_updated_at('ops.backup_runs');
--> statement-breakpoint
CREATE TABLE ops.restore_verifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Point in time restored to (null: the latest backup and WAL).
  target_time timestamptz,
  -- pgBackRest label of the backup the restore started from.
  label text,
  -- [{ name, status: passed|failed|warning|skipped, detail }]
  checks jsonb NOT NULL DEFAULT '[]',
  -- Where it ran (host name, CI run); not a person.
  initiated_by text NOT NULL,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restore_verifications_finished CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX restore_verifications_status_idx ON ops.restore_verifications (status, started_at DESC);
SELECT app.enable_updated_at('ops.restore_verifications');
--> statement-breakpoint
-- No personal data, no club data: readable by the app role for the status endpoint.
ALTER TABLE ops.backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.restore_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_read ON ops.backup_runs FOR SELECT TO clubadmin_app USING (true);
CREATE POLICY app_read ON ops.restore_verifications FOR SELECT TO clubadmin_app USING (true);
GRANT SELECT ON ops.backup_runs, ops.restore_verifications TO clubadmin_app;
--> statement-breakpoint
-- Exact row counts of the key tables, compared after a restore. Runs with the
-- caller's rights: the backup tooling calls it as superuser (row-level
-- security would hide club rows from anyone else).
CREATE FUNCTION ops.key_table_counts() RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_table text;
  v_count bigint;
  v_result jsonb := '{}';
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.clubs', 'public.people', 'public.accounts', 'public.club_profiles',
    'public.club_memberships', 'public.groups', 'public.group_memberships',
    'public.guardianships', 'privacy.deletion_ledger', 'audit.events'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %s', v_table) INTO v_count;
    v_result := v_result || jsonb_build_object(v_table, v_count);
  END LOOP;
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION ops.key_table_counts() FROM PUBLIC;
--> statement-breakpoint
-- Replaces the given keys of a history values object with "[erased]".
CREATE FUNCTION privacy.scrub(p_values jsonb, p_keys text[]) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE WHEN p_values IS NULL THEN NULL ELSE (
    SELECT coalesce(jsonb_object_agg(
      e.key, CASE WHEN e.key = ANY (p_keys) THEN to_jsonb('[erased]'::text) ELSE e.value END
    ), '{}'::jsonb)
    FROM jsonb_each(p_values) AS e
  ) END
$$;
--> statement-breakpoint
-- GDPR erasure of one person (docs/gdpr.md, "Erasure"): the people row is
-- anonymised (names emptied, birth date kept as the year only, identity
-- number, phone and address removed), the login email replaced and unlinked
-- from the identity provider, club-specific notes and emergency contacts
-- removed, invitations to the person's email removed or their address
-- replaced, and the personal values scrubbed from the record history.
-- Facts (memberships, roles, that a change happened) stay.
-- Idempotent. Records the person in the deletion ledger unless replaying.
-- Run as clubadmin_retention (or a superuser during a restore).
-- P1.8 extends this function as modules with personal data arrive.
CREATE FUNCTION privacy.erase_person(p_person_id uuid, p_reason text, p_replay boolean DEFAULT false)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_people_keys CONSTANT text[] := ARRAY[
    'given_name', 'family_name', 'birth_date', 'personal_identity_number',
    'personal_identity_number_hash', 'phone', 'address'];
  v_account_keys CONSTANT text[] := ARRAY['email', 'idp_subject'];
  v_profile_keys CONSTANT text[] := ARRAY['emergency_contacts', 'notes'];
  v_invitation_keys CONSTANT text[] := ARRAY['email'];
  v_changed boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE id = p_person_id) THEN
    -- Not in this database (for example created after the restore point).
    IF NOT p_replay THEN
      RAISE EXCEPTION 'person % does not exist', p_person_id USING ERRCODE = 'no_data_found';
    END IF;
    RETURN false;
  END IF;

  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.request_id',
    CASE WHEN p_replay THEN 'privacy:ledger-replay' ELSE 'privacy:erasure' END, true);

  IF NOT p_replay THEN
    INSERT INTO privacy.deletion_ledger (person_id, reason)
    VALUES (p_person_id, p_reason)
    ON CONFLICT (person_id) DO NOTHING;
  END IF;

  UPDATE public.people
  SET given_name = '', family_name = '',
      birth_date = date_trunc('year', birth_date)::date,
      personal_identity_number = NULL, personal_identity_number_hash = NULL,
      phone = NULL, address = NULL,
      anonymized_at = coalesce(anonymized_at, now())
  WHERE id = p_person_id
    AND (given_name <> '' OR family_name <> ''
      OR birth_date IS DISTINCT FROM date_trunc('year', birth_date)::date
      OR personal_identity_number IS NOT NULL OR phone IS NOT NULL OR address IS NOT NULL
      OR anonymized_at IS NULL);
  v_changed := FOUND;

  UPDATE public.accounts
  SET email = 'erased-' || p_person_id || '@erased.invalid', idp_subject = NULL,
      notification_settings = '{}'
  WHERE person_id = p_person_id AND email <> 'erased-' || p_person_id || '@erased.invalid';
  v_changed := v_changed OR FOUND;

  UPDATE public.club_profiles
  SET emergency_contacts = '[]', notes = NULL
  WHERE person_id = p_person_id AND (emergency_contacts <> '[]' OR notes IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Invitations sent to the person's email address.
  DELETE FROM public.account_invitations WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.guardian_invitations
  SET email = 'erased-' || p_person_id || '@erased.invalid'
  WHERE accepted_by_person_id = p_person_id AND email <> 'erased-' || p_person_id || '@erased.invalid';
  v_changed := v_changed OR FOUND;

  -- Record history, including the rows the statements above just wrote.
  UPDATE history.record_changes
  SET old_values = privacy.scrub(old_values, v_people_keys),
      new_values = privacy.scrub(new_values, v_people_keys)
  WHERE table_name = 'public.people' AND record_id = p_person_id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_account_keys),
      new_values = privacy.scrub(h.new_values, v_account_keys)
  FROM public.accounts a
  WHERE a.person_id = p_person_id AND h.table_name = 'public.accounts' AND h.record_id = a.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_profile_keys),
      new_values = privacy.scrub(h.new_values, v_profile_keys)
  FROM public.club_profiles p
  WHERE p.person_id = p_person_id AND h.table_name = 'public.club_profiles' AND h.record_id = p.id;
  UPDATE history.record_changes
  SET old_values = privacy.scrub(old_values, v_invitation_keys),
      new_values = privacy.scrub(new_values, v_invitation_keys)
  WHERE (table_name = 'public.account_invitations'
         AND p_person_id::text IN (old_values ->> 'person_id', new_values ->> 'person_id'))
     OR (table_name = 'public.guardian_invitations'
         AND p_person_id::text IN (old_values ->> 'accepted_by_person_id', new_values ->> 'accepted_by_person_id'));

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;
REVOKE ALL ON FUNCTION privacy.erase_person(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.erase_person(uuid, text, boolean) TO clubadmin_retention;
GRANT UPDATE ON public.people, public.accounts, public.club_profiles TO clubadmin_retention;
GRANT UPDATE ON public.guardian_invitations TO clubadmin_retention;
GRANT DELETE ON public.account_invitations TO clubadmin_retention;
GRANT INSERT ON audit.events TO clubadmin_retention;
--> statement-breakpoint
-- Ledger entries whose person still has personal data in this database
-- (should always be empty; checked by `pnpm ops:verify-backup`).
CREATE FUNCTION privacy.unerased_people() RETURNS TABLE (person_id uuid)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT l.person_id
  FROM privacy.deletion_ledger l
  JOIN public.people p ON p.id = l.person_id
  WHERE p.anonymized_at IS NULL OR p.given_name <> '' OR p.family_name <> ''
     OR p.personal_identity_number IS NOT NULL OR p.phone IS NOT NULL OR p.address IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.accounts a
                WHERE a.person_id = l.person_id AND a.email <> 'erased-' || l.person_id || '@erased.invalid')
     OR EXISTS (SELECT 1 FROM public.club_profiles c
                WHERE c.person_id = l.person_id AND (c.emergency_contacts <> '[]' OR c.notes IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION privacy.unerased_people() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.unerased_people() TO clubadmin_retention;
--> statement-breakpoint
-- After a restore: merges ledger entries kept outside the backup (p_external:
-- [{ "person_id": ..., "erased_at": ..., "reason": ... }], from the ledger
-- export and the production database), then erases every person in the
-- ledger again. Returns how many were in the ledger and how many changed.
CREATE FUNCTION privacy.replay_deletion_ledger(p_external jsonb DEFAULT '[]')
  RETURNS TABLE (ledger_entries integer, added integer, erased integer)
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_entry record;
BEGIN
  ledger_entries := 0;
  added := 0;
  erased := 0;
  INSERT INTO privacy.deletion_ledger (person_id, erased_at, reason)
  SELECT (e ->> 'person_id')::uuid, coalesce((e ->> 'erased_at')::timestamptz, now()),
         coalesce(e ->> 'reason', 'restored')
  FROM jsonb_array_elements(coalesce(p_external, '[]')) AS e
  ON CONFLICT (person_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;

  FOR v_entry IN SELECT person_id, reason FROM privacy.deletion_ledger ORDER BY erased_at LOOP
    ledger_entries := ledger_entries + 1;
    IF privacy.erase_person(v_entry.person_id, v_entry.reason, true) THEN
      erased := erased + 1;
    END IF;
  END LOOP;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION privacy.replay_deletion_ledger(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.replay_deletion_ledger(jsonb) TO clubadmin_retention;
