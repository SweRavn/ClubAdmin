-- P1.15 part A3 (ADR 0046): at least two administrators; suspending one.
--
-- - An administrator holds club.roles.manage through an open assignment
--   (any role), has an account (not erased) and is an adult by the club's
--   country pack (a person without a birth date counts). Distinct people.
-- - A club with fewer than two is "needs an administrator" (it cannot add
--   members) unless it is within its grace period
--   (clubs.administrators_grace_until). Clubs with fewer than two at this
--   migration get 30 days and their administrators are told.
-- - A deferred constraint trigger refuses a change that takes a counting
--   administrator away from a club (outside its grace period) and leaves it
--   with fewer than two, unless another administrator was appointed in the
--   same transaction (the one-to-one hand-over). The exception for a confirmed suspension or an
--   erasure is a row in app.administrator_minimum_exceptions for the current
--   transaction, which only the SECURITY DEFINER functions below can write:
--   the application role has no privilege on the table and cannot execute
--   app.allow_fewer_administrators.
-- - administrator_suspensions: the two-person rule's requests;
--   app.confirm_administrator_suspension does the confirmation's database
--   work in the caller's transaction.

ALTER TABLE public.clubs
  ADD COLUMN administrators_grace_until timestamptz,
  ADD COLUMN administrators_grace_extended_at timestamptz;
-- A creation request names the second administrator to invite on approval;
-- cleared when the request is decided (and never in history).
ALTER TABLE public.club_creation_requests ADD COLUMN second_administrator_email text;
SELECT history.enable_history('public.club_creation_requests',
  redact => ARRAY['second_administrator_email']);
--> statement-breakpoint

-- The country packs' adult age (@clubadmin/country-packs ageRules.adultAge;
-- a test compares them).
CREATE FUNCTION app.adult_age(p_country text) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_country WHEN 'SE' THEN 18 WHEN 'NO' THEN 18 ELSE 18 END
$$;
GRANT EXECUTE ON FUNCTION app.adult_age(text) TO clubadmin_app, clubadmin_retention;
--> statement-breakpoint

-- The club's holders of club.roles.manage, whether each counts and why not
-- ('no_account', 'minor'). For the caller's club (or a system job).
CREATE FUNCTION app.club_administrators(p_club uuid)
  RETURNS TABLE (person_id uuid, counts boolean, reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text := app.setting('app.actor_kind');
  v_club text := app.setting('app.club_id');
BEGIN
  IF NOT coalesce(app.is_system() OR p_club = app.current_club_id(), false) THEN
    RETURN;
  END IF;
  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.club_id', p_club::text, true);
  RETURN QUERY
  WITH holders AS (
    SELECT DISTINCT r.person_id
    FROM public.club_role_assignments r
    JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.role_id
    WHERE r.club_id = p_club AND r.valid_to IS NULL AND r.valid_from <= now()
      AND rp.permission = 'club.roles.manage'),
  facts AS (
    SELECT h.person_id,
      CASE
        WHEN p.anonymized_at IS NOT NULL
          OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = h.person_id)
          THEN 'no_account'
        WHEN p.birth_date IS NOT NULL
          AND p.birth_date > (now() AT TIME ZONE c.time_zone)::date
            - make_interval(years => app.adult_age(c.country))
          THEN 'minor'
      END AS reason
    FROM holders h
    JOIN public.people p ON p.id = h.person_id
    JOIN public.clubs c ON c.id = p_club)
  SELECT f.person_id, f.reason IS NULL, f.reason FROM facts f;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
  PERFORM set_config('app.club_id', coalesce(v_club, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.club_administrators(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.club_administrators(uuid) TO clubadmin_app;
--> statement-breakpoint

-- Whether the club is "needs an administrator": fewer than two counting and
-- not within its grace period.
CREATE FUNCTION app.club_needs_administrators(p_club uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
  v_grace timestamptz;
  v_kind text := app.setting('app.actor_kind');
  v_club text := app.setting('app.club_id');
BEGIN
  IF NOT coalesce(app.is_system() OR p_club = app.current_club_id(), false) THEN
    RETURN false;
  END IF;
  SELECT count(*) FILTER (WHERE a.counts) INTO v_count FROM app.club_administrators(p_club) a;
  IF v_count >= 2 THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.actor_kind', 'system_job', true);
  SELECT administrators_grace_until INTO v_grace FROM public.clubs WHERE id = p_club;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
  PERFORM set_config('app.club_id', coalesce(v_club, ''), true);
  RETURN v_grace IS NULL OR v_grace <= now();
END
$$;
REVOKE ALL ON FUNCTION app.club_needs_administrators(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.club_needs_administrators(uuid) TO clubadmin_app;
--> statement-breakpoint

-- The exception: one row per transaction and club, written only by the
-- SECURITY DEFINER functions of a confirmed suspension or an erasure.
CREATE TABLE app.administrator_minimum_exceptions (
  txid xid8 NOT NULL,
  club_id uuid NOT NULL,
  reason text NOT NULL CONSTRAINT administrator_minimum_exceptions_reason
    CHECK (reason IN ('suspension', 'erasure')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (txid, club_id)
);
REVOKE ALL ON TABLE app.administrator_minimum_exceptions FROM PUBLIC;
REVOKE ALL ON TABLE app.administrator_minimum_exceptions FROM clubadmin_app;
REVOKE ALL ON TABLE app.administrator_minimum_exceptions FROM clubadmin_retention;
--> statement-breakpoint

CREATE FUNCTION app.allow_fewer_administrators(p_club uuid, p_reason text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  -- Rows of finished transactions are of no use: clear them on the way.
  DELETE FROM app.administrator_minimum_exceptions
  WHERE txid < pg_snapshot_xmin(pg_current_snapshot());
  INSERT INTO app.administrator_minimum_exceptions (txid, club_id, reason)
  VALUES (pg_current_xact_id(), p_club, p_reason)
  ON CONFLICT DO NOTHING;
$$;
REVOKE ALL ON FUNCTION app.allow_fewer_administrators(uuid, text) FROM PUBLIC;
--> statement-breakpoint

-- An erasure (P1.8b) may leave a club with fewer than two: the person must
-- be part of an erasure request the job is running.
CREATE FUNCTION app.allow_fewer_administrators_for_erasure(p_club uuid, p_person uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text := app.setting('app.actor_kind');
  v_due boolean;
BEGIN
  IF NOT app.is_system() THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.erasure_requests r
    WHERE r.status = 'running' AND r.scheduled_for <= now()
      AND (r.person_id = p_person OR p_person = ANY (r.include_ward_ids)))
  INTO v_due;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
  IF v_due THEN
    PERFORM app.allow_fewer_administrators(p_club, 'erasure');
  END IF;
  RETURN v_due;
END
$$;
REVOKE ALL ON FUNCTION app.allow_fewer_administrators_for_erasure(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.allow_fewer_administrators_for_erasure(uuid, uuid) TO clubadmin_app;
--> statement-breakpoint

-- The invariant, checked at commit after locking the club row (as
-- club_has_manager, ADR 0018).
CREATE FUNCTION app.check_club_administrators() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_club uuid := OLD.club_id;
  v_person uuid;
  v_status text;
  v_grace timestamptz;
  v_count integer;
  v_refuse boolean := false;
  v_kind text := app.setting('app.actor_kind');
  v_club_setting text := app.setting('app.club_id');
BEGIN
  IF TG_TABLE_NAME = 'club_role_assignments' THEN
    v_person := OLD.person_id;
  END IF;
  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.club_id', v_club::text, true);
  SELECT status, administrators_grace_until INTO v_status, v_grace
  FROM public.clubs WHERE id = v_club FOR UPDATE;
  IF FOUND AND v_status = 'active' AND (v_grace IS NULL OR v_grace <= now())
      -- An assignment counts only if its role holds club.roles.manage.
      AND (TG_TABLE_NAME <> 'club_role_assignments' OR EXISTS (
        SELECT 1 FROM public.role_permissions rp
        WHERE rp.club_id = v_club AND rp.role_id = OLD.role_id
          AND rp.permission = 'club.roles.manage'))
      AND NOT EXISTS (SELECT 1 FROM app.administrator_minimum_exceptions e
                      WHERE e.txid = pg_current_xact_id() AND e.club_id = v_club)
      -- A person who is still an administrator, or never counted (no
      -- account, erased, a minor), takes nothing away.
      AND NOT (v_person IS NOT NULL AND (
        EXISTS (SELECT 1 FROM app.club_administrators(v_club) a WHERE a.person_id = v_person)
        OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = v_person)
        OR EXISTS (SELECT 1 FROM public.people p JOIN public.clubs c ON c.id = v_club
                   WHERE p.id = v_person AND (p.anonymized_at IS NOT NULL
                     OR p.birth_date > (now() AT TIME ZONE c.time_zone)::date
                       - make_interval(years => app.adult_age(c.country))))))
  THEN
    SELECT count(*) FILTER (WHERE a.counts) INTO v_count FROM app.club_administrators(v_club) a;
    -- A one-to-one swap in one transaction (the hand-over, ADR 0018): another
    -- counting administrator's assignment was created in this transaction.
    v_refuse := v_count < 2 AND NOT EXISTS (
      SELECT 1 FROM app.club_administrators(v_club) a
      JOIN public.club_role_assignments r ON r.club_id = v_club AND r.person_id = a.person_id
      JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.role_id
      WHERE a.counts AND a.person_id IS DISTINCT FROM v_person AND r.valid_to IS NULL
        AND r.created_at = now() AND rp.permission = 'club.roles.manage');
  END IF;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
  PERFORM set_config('app.club_id', coalesce(v_club_setting, ''), true);
  IF v_refuse THEN
    RAISE EXCEPTION 'a club must keep at least two administrators'
      USING ERRCODE = '23514', CONSTRAINT = 'club_administrators_minimum';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER club_administrators_on_update AFTER UPDATE ON public.club_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.valid_to IS NULL AND (NEW.valid_to IS NOT NULL
    OR NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.person_id IS DISTINCT FROM OLD.person_id))
  EXECUTE FUNCTION app.check_club_administrators();
CREATE CONSTRAINT TRIGGER club_administrators_on_delete AFTER DELETE ON public.club_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.valid_to IS NULL)
  EXECUTE FUNCTION app.check_club_administrators();
CREATE CONSTRAINT TRIGGER club_administrators_on_permission AFTER DELETE ON public.role_permissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.permission = 'club.roles.manage')
  EXECUTE FUNCTION app.check_club_administrators();
--> statement-breakpoint

-- Someone became an administrator (P1.15 A3.5): an assignment of a role
-- with club.roles.manage, or club.roles.manage added to a role people hold.
-- The administrators and the chair are told (administrator.added), and a
-- club that now has two administrators who count leaves its grace period.
CREATE FUNCTION app.end_administrators_grace(p_club uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text := app.setting('app.actor_kind');
  v_club text := app.setting('app.club_id');
  v_count integer;
BEGIN
  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.club_id', p_club::text, true);
  SELECT count(*) FILTER (WHERE a.counts) INTO v_count FROM app.club_administrators(p_club) a;
  IF v_count >= 2 THEN
    UPDATE public.clubs SET administrators_grace_until = NULL
    WHERE id = p_club AND administrators_grace_until IS NOT NULL;
  END IF;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
  PERFORM set_config('app.club_id', coalesce(v_club, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.end_administrators_grace(uuid) FROM PUBLIC;
-- It only ends a grace period the club no longer needs: the worker may call it.
GRANT EXECUTE ON FUNCTION app.end_administrators_grace(uuid) TO clubadmin_app;

CREATE FUNCTION app.on_administrator_added() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'club_role_assignments' THEN
    IF EXISTS (SELECT 1 FROM public.role_permissions rp
               WHERE rp.club_id = NEW.club_id AND rp.role_id = NEW.role_id
                 AND rp.permission = 'club.roles.manage') THEN
      INSERT INTO outbox.events (id, type, club_id, payload, idempotency_key)
      VALUES (uuidv7(), 'administrator.added', NEW.club_id,
        jsonb_build_object('clubId', NEW.club_id, 'personId', NEW.person_id),
        'administrator.added:' || NEW.id)
      ON CONFLICT (idempotency_key) DO NOTHING;
      PERFORM app.end_administrators_grace(NEW.club_id);
    END IF;
  ELSE
    INSERT INTO outbox.events (id, type, club_id, payload, idempotency_key)
    SELECT uuidv7(), 'administrator.added', NEW.club_id,
      jsonb_build_object('clubId', NEW.club_id, 'personId', r.person_id),
      'administrator.added:' || NEW.id || ':' || r.person_id
    FROM (SELECT DISTINCT r.person_id FROM public.club_role_assignments r
          WHERE r.club_id = NEW.club_id AND r.role_id = NEW.role_id AND r.valid_to IS NULL) r
    ON CONFLICT (idempotency_key) DO NOTHING;
    PERFORM app.end_administrators_grace(NEW.club_id);
  END IF;
  RETURN NULL;
END
$$;
-- At commit, so that a hand-over (one in, one out) is counted as it ends.
CREATE CONSTRAINT TRIGGER club_role_assignments_administrator_added
  AFTER INSERT ON public.club_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.valid_to IS NULL)
  EXECUTE FUNCTION app.on_administrator_added();
CREATE CONSTRAINT TRIGGER role_permissions_administrator_added
  AFTER INSERT ON public.role_permissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.permission = 'club.roles.manage')
  EXECUTE FUNCTION app.on_administrator_added();
--> statement-breakpoint

CREATE TABLE public.administrator_suspensions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  target_person_id uuid NOT NULL REFERENCES public.people(id),
  requested_by_person_id uuid NOT NULL REFERENCES public.people(id),
  confirmed_by_person_id uuid REFERENCES public.people(id),
  reason text NOT NULL CONSTRAINT administrator_suspensions_reason
    CHECK (reason IN ('compromised', 'left_task', 'other')),
  note text,
  demote boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'requested' CONSTRAINT administrator_suspensions_status
    CHECK (status IN ('requested', 'confirmed', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT administrator_suspensions_not_self CHECK (target_person_id <> requested_by_person_id),
  CONSTRAINT administrator_suspensions_decided CHECK ((status = 'requested') = (decided_at IS NULL))
);
-- One open request per target.
CREATE UNIQUE INDEX administrator_suspensions_open_unique
  ON public.administrator_suspensions (club_id, target_person_id) WHERE status = 'requested';
CREATE INDEX administrator_suspensions_club_idx
  ON public.administrator_suspensions (club_id, created_at DESC);
-- The expiry job: open requests by their deadline.
CREATE INDEX administrator_suspensions_expires_idx
  ON public.administrator_suspensions (expires_at) WHERE status = 'requested';
CREATE INDEX administrator_suspensions_requested_by_idx
  ON public.administrator_suspensions (requested_by_person_id);
CREATE INDEX administrator_suspensions_confirmed_by_idx
  ON public.administrator_suspensions (confirmed_by_person_id)
  WHERE confirmed_by_person_id IS NOT NULL;
CREATE INDEX administrator_suspensions_target_idx
  ON public.administrator_suspensions (target_person_id);
SELECT app.enable_tenant_rls('public.administrator_suspensions');
SELECT app.enable_updated_at('public.administrator_suspensions');
SELECT history.enable_history('public.administrator_suspensions', redact => ARRAY['note']);
--> statement-breakpoint

-- The daily job's clubs (administrators:daily): open requests past their
-- deadline, and clubs with a grace period. A system lookup across clubs.
CREATE POLICY administrator_jobs_lookup ON public.administrator_suspensions FOR SELECT
  USING (app.is_system() AND app.setting('app.lookup') = 'administrator_jobs');
CREATE FUNCTION app.administrator_job_clubs() RETURNS TABLE (club_id uuid)
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT app.is_system() THEN
    RETURN;
  END IF;
  PERFORM set_config('app.lookup', 'administrator_jobs', true);
  RETURN QUERY
  SELECT s.club_id FROM public.administrator_suspensions s
  WHERE s.status = 'requested' AND s.expires_at <= now()
  UNION
  SELECT c.id FROM public.clubs c
  WHERE c.administrators_grace_until IS NOT NULL AND c.status = 'active';
  PERFORM set_config('app.lookup', '', true);
END
$$;
GRANT EXECUTE ON FUNCTION app.administrator_job_clubs() TO clubadmin_app;
--> statement-breakpoint

-- Confirms a suspension in the caller's transaction: the two-person rule is
-- checked again here (not the target, not the initiator; an administrator,
-- the chair when the club has exactly two, or an operator), the exception is
-- set, and the target's administrator roles (with `demote` every club role
-- and group leader role) end, their hand-overs are cancelled and their open
-- invitations with a role revoked. Returns the target and the number of
-- assignments ended.
CREATE FUNCTION app.confirm_administrator_suspension(p_suspension uuid,
    OUT target_person_id uuid, OUT ended_roles integer, OUT ended_group_roles integer,
    OUT demote boolean, OUT reason text, OUT idp_subject text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_me uuid := app.current_person_id();
  v_club uuid := app.current_club_id();
  v_kind text := app.setting('app.actor_kind');
  v_operator boolean := app.is_platform_operator();
  v_row public.administrator_suspensions;
  v_admins integer;
  v_me_admin boolean;
  v_me_chair boolean;
BEGIN
  IF v_me IS NULL OR v_club IS NULL THEN
    RAISE EXCEPTION 'suspension_not_allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.administrator_suspensions s
  WHERE s.id = p_suspension AND s.club_id = v_club FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'requested' OR v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'suspension_not_open' USING ERRCODE = '55000';
  END IF;
  IF v_me IN (v_row.target_person_id, v_row.requested_by_person_id) THEN
    RAISE EXCEPTION 'suspension_not_allowed' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) FILTER (WHERE a.counts), coalesce(bool_or(a.person_id = v_me), false)
  INTO v_admins, v_me_admin FROM app.club_administrators(v_club) a;
  v_me_chair := app.holds_permission(v_club, 'club.managers.claim');
  IF NOT (v_me_admin OR (v_me_chair AND v_admins = 2) OR (v_operator AND v_admins <= 2)) THEN
    RAISE EXCEPTION 'suspension_not_allowed' USING ERRCODE = '42501';
  END IF;

  PERFORM app.allow_fewer_administrators(v_club, 'suspension');
  target_person_id := v_row.target_person_id;
  demote := v_row.demote;
  reason := v_row.reason;

  UPDATE public.club_role_assignments r SET valid_to = now(), ended_by_person_id = v_me
  WHERE r.club_id = v_club AND r.person_id = v_row.target_person_id AND r.valid_to IS NULL
    AND (v_row.demote OR EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.club_id = r.club_id AND rp.role_id = r.role_id
        AND rp.permission = 'club.roles.manage'));
  GET DIAGNOSTICS ended_roles = ROW_COUNT;
  ended_group_roles := 0;
  IF v_row.demote THEN
    UPDATE public.group_memberships gm SET valid_to = now()
    WHERE gm.club_id = v_club AND gm.person_id = v_row.target_person_id
      AND gm.valid_to IS NULL AND gm.leads;
    GET DIAGNOSTICS ended_group_roles = ROW_COUNT;
  END IF;
  UPDATE public.club_manager_handovers h SET status = 'cancelled', decided_at = now()
  WHERE h.club_id = v_club AND h.status = 'proposed'
    AND v_row.target_person_id IN (h.from_person_id, h.to_person_id);
  UPDATE public.invitations i SET revoked_at = now()
  WHERE i.club_id = v_club AND i.created_by_person_id = v_row.target_person_id
    AND i.role_preset IS NOT NULL AND i.revoked_at IS NULL
    AND (i.max_uses IS NULL OR i.uses < i.max_uses) AND i.expires_at > now();
  UPDATE public.administrator_suspensions s
  SET status = 'confirmed', confirmed_by_person_id = v_me, decided_at = now()
  WHERE s.id = p_suspension;
  -- The login whose identity provider sessions end (compromised); read as
  -- the system, outside the club's rows.
  PERFORM set_config('app.actor_kind', 'system_job', true);
  SELECT a.idp_subject INTO idp_subject FROM public.accounts a
  WHERE a.person_id = v_row.target_person_id;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.confirm_administrator_suspension(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.confirm_administrator_suspension(uuid) TO clubadmin_app;
--> statement-breakpoint

-- Existing clubs with fewer than two administrators: 30 days' grace; their
-- administrators and chair are told (an outbox event per club).
DO $$
DECLARE
  v_club uuid;
  v_count integer;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs WHERE status = 'active' ORDER BY id LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    SELECT count(*) FILTER (WHERE a.counts) INTO v_count FROM app.club_administrators(v_club) a;
    IF v_count < 2 THEN
      UPDATE public.clubs SET administrators_grace_until = now() + interval '30 days'
      WHERE id = v_club;
      INSERT INTO outbox.events (id, type, club_id, payload, idempotency_key)
      VALUES (uuidv7(), 'club.administrators.grace_started', v_club,
        jsonb_build_object('clubId', v_club), 'club.administrators.grace_started:' || v_club)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
