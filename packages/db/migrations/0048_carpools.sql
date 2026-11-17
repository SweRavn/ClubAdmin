-- P2.5 part A (ADR 0048): car pooling. An activity (or a series, inherited
-- by its sessions; an event's sessions are activities) has a transport
-- mode: own transport opens the car pool. Adults offer cars (seats, a
-- departure place and time, or "willing to drive"), with a return trip of
-- their own; seats are booked for oneself, for a child, or by a child from
-- the age their guardians allow. One adult alone with a single child not
-- their own needs the child's guardian's confirmation (the rule of two).
-- Places have a distance from the club's starting place for mileage.

ALTER TABLE public.activities ADD COLUMN transport_mode text
  CONSTRAINT activities_transport_mode CHECK (transport_mode IN ('own', 'shared'));
ALTER TABLE public.activity_series ADD COLUMN transport_mode text
  CONSTRAINT activity_series_transport_mode CHECK (transport_mode IN ('own', 'shared'));
ALTER TABLE public.locations ADD COLUMN distance_km numeric(6, 1)
  CONSTRAINT locations_distance_km CHECK (distance_km >= 0 AND distance_km <= 5000);
-- The group's car-pool statistics are public in the group (members settle among themselves).
ALTER TABLE public.groups ADD COLUMN carpool_stats_public boolean NOT NULL DEFAULT false;
-- From which age the ward books seats themselves (the guardian's choice; none: the pack's).
ALTER TABLE public.guardianships ADD COLUMN carpool_self_booking_age integer
  CONSTRAINT guardianships_carpool_self_booking_age CHECK (carpool_self_booking_age BETWEEN 7 AND 18);
-- The place distances are measured from (a manager setting).
ALTER TABLE public.clubs ADD COLUMN carpool_start_location_id uuid;
ALTER TABLE public.clubs ADD CONSTRAINT clubs_carpool_start_location_fk
  FOREIGN KEY (id, carpool_start_location_id) REFERENCES public.locations (club_id, id) NOT VALID;
ALTER TABLE public.clubs VALIDATE CONSTRAINT clubs_carpool_start_location_fk;

CREATE TABLE public.carpool_offers (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  activity_id uuid NOT NULL,
  driver_person_id uuid NOT NULL REFERENCES public.people(id),
  direction text NOT NULL CONSTRAINT carpool_offers_direction CHECK (direction IN ('out', 'back')),
  -- A return trip's outward offer (copied from it, then edited on its own).
  outward_offer_id uuid,
  -- Only willing to drive if needed: no seats yet.
  willing_only boolean NOT NULL DEFAULT false,
  seats integer NOT NULL CONSTRAINT carpool_offers_seats CHECK (seats BETWEEN 0 AND 8),
  departure_place text CONSTRAINT carpool_offers_departure_place CHECK (char_length(departure_place) <= 200),
  departure_at timestamptz,
  -- The driver's correction after the trip (none: the place's distance).
  distance_km numeric(6, 1) CONSTRAINT carpool_offers_distance_km CHECK (distance_km >= 0 AND distance_km <= 5000),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT carpool_offers_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT carpool_offers_activity_fk FOREIGN KEY (club_id, activity_id)
    REFERENCES public.activities (club_id, id) ON DELETE CASCADE,
  CONSTRAINT carpool_offers_outward_fk FOREIGN KEY (club_id, outward_offer_id)
    REFERENCES public.carpool_offers (club_id, id) ON DELETE SET NULL (outward_offer_id),
  CONSTRAINT carpool_offers_shape CHECK ((willing_only AND seats = 0) OR (NOT willing_only AND seats >= 1)),
  CONSTRAINT carpool_offers_return CHECK (outward_offer_id IS NULL OR direction = 'back')
);
-- An activity's cars; a driver's drives ("Mina samåkningar", statistics).
CREATE INDEX carpool_offers_activity_idx ON public.carpool_offers (activity_id, direction);
CREATE INDEX carpool_offers_driver_idx ON public.carpool_offers (driver_person_id);
CREATE INDEX carpool_offers_outward_idx ON public.carpool_offers (outward_offer_id) WHERE outward_offer_id IS NOT NULL;

CREATE TABLE public.carpool_bookings (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  offer_id uuid NOT NULL,
  passenger_person_id uuid NOT NULL REFERENCES public.people(id),
  booked_by_person_id uuid REFERENCES public.people(id),
  -- held | pending_guardian (one adult with a single child not their own) | cancelled.
  status text NOT NULL DEFAULT 'held' CONSTRAINT carpool_bookings_status
    CHECK (status IN ('held', 'pending_guardian', 'cancelled')),
  confirmed_by_person_id uuid REFERENCES public.people(id),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT carpool_bookings_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT carpool_bookings_offer_fk FOREIGN KEY (club_id, offer_id)
    REFERENCES public.carpool_offers (club_id, id) ON DELETE CASCADE,
  CONSTRAINT carpool_bookings_confirmed CHECK ((confirmed_by_person_id IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT carpool_bookings_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- One live seat per passenger and car.
CREATE UNIQUE INDEX carpool_bookings_live_unique ON public.carpool_bookings (offer_id, passenger_person_id)
  WHERE status <> 'cancelled';
CREATE INDEX carpool_bookings_offer_idx ON public.carpool_bookings (offer_id);
-- "Mina samåkningar": a person's seats, and those they booked.
CREATE INDEX carpool_bookings_passenger_idx ON public.carpool_bookings (passenger_person_id);
CREATE INDEX carpool_bookings_booked_by_idx ON public.carpool_bookings (booked_by_person_id)
  WHERE booked_by_person_id IS NOT NULL;
CREATE INDEX carpool_bookings_confirmed_by_idx ON public.carpool_bookings (confirmed_by_person_id)
  WHERE confirmed_by_person_id IS NOT NULL;

-- The car-pool notices' category.
ALTER TABLE public.notifications DROP CONSTRAINT notifications_category;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category CHECK (category IN (
  'schedule', 'responses', 'leader', 'events', 'membership', 'club_admin', 'family', 'account',
  'waitlist', 'chat', 'documents', 'announcements', 'carpool')) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_category;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.carpool_offers'), app.enable_updated_at('public.carpool_offers'),
  history.enable_history('public.carpool_offers');
SELECT app.enable_tenant_rls('public.carpool_bookings'), app.enable_updated_at('public.carpool_bookings'),
  history.enable_history('public.carpool_bookings');
--> statement-breakpoint

-- "Mina samåkningar": the drives of the caller and the seats of the caller
-- and their wards on activities from yesterday on, across their clubs (each
-- read in turn, tenant RLS, as app.my_tasks), soonest first. By the
-- person's own offers and bookings; never a scan of a club.
CREATE FUNCTION app.my_carpools(p_limit integer)
  RETURNS TABLE (club_id uuid, club_name text, activity_id uuid, activity_title text,
    starts_at timestamptz, offer_id uuid, direction text, driver_person_id uuid,
    booking_id uuid, passenger_person_id uuid, status text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := app.current_person_id();
  v_people uuid[];
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_club uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN;
  END IF;
  v_people := app.self_and_wards();
  FOREACH v_club IN ARRAY app.my_clubs_for(v_people) LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    RETURN QUERY
    WITH mine AS (
      SELECT o.id AS offer_id, NULL::uuid AS booking_id, NULL::uuid AS passenger, NULL::text AS status
      FROM public.carpool_offers o WHERE o.driver_person_id = v_me AND o.club_id = v_club
      UNION ALL
      SELECT b.offer_id, b.id, b.passenger_person_id, b.status
      FROM public.carpool_bookings b
      WHERE b.passenger_person_id = ANY (v_people) AND b.club_id = v_club AND b.status <> 'cancelled')
    SELECT o.club_id, (SELECT cl.name FROM public.clubs cl WHERE cl.id = o.club_id), a.id, a.title,
      a.starts_at, o.id, o.direction, o.driver_person_id, mine.booking_id, mine.passenger, mine.status
    FROM mine
    JOIN public.carpool_offers o ON o.id = mine.offer_id
    JOIN public.activities a ON a.id = o.activity_id
    WHERE a.ends_at > now() - interval '1 day' AND a.status <> 'cancelled'
    ORDER BY a.starts_at, o.direction, o.id
    LIMIT p_limit;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_carpools(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_carpools(integer) TO clubadmin_app;

-- The club of one of the caller's wards' bookings, for confirming it
-- (null: not a ward's). Each of the caller's wards' clubs in turn.
CREATE FUNCTION app.ward_booking_club(p_booking uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_people uuid[] := app.self_and_wards();
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_club uuid;
  v_found uuid;
BEGIN
  IF app.current_person_id() IS NULL THEN
    RETURN NULL;
  END IF;
  FOREACH v_club IN ARRAY app.my_clubs_for(v_people) LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    SELECT b.club_id INTO v_found FROM public.carpool_bookings b
    WHERE b.id = p_booking AND b.passenger_person_id = ANY (v_people);
    EXIT WHEN v_found IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
  RETURN v_found;
END
$$;
REVOKE ALL ON FUNCTION app.ward_booking_club(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ward_booking_club(uuid) TO clubadmin_app;
--> statement-breakpoint

-- The car pools' permission in the template (the template of 0045 with
-- these rows), in every club type and every club: deleting old car-pool
-- data and the starting place for club managers and treasurers.
CREATE OR REPLACE FUNCTION app.builtin_role_template()
  RETURNS TABLE (template_key text, scope text, permission text)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM (VALUES
    ('club_manager', 'club', 'club.settings.update'),
    ('club_manager', 'club', 'club.roles.manage'),
    ('club_manager', 'club', 'club.roles.read'),
    ('club_manager', 'club', 'club.people.protected'),
    ('club_manager', 'club', 'club.members.read'),
    ('club_manager', 'club', 'club.join_requests.manage'),
    ('club_manager', 'club', 'club.invitations.manage'),
    ('club_manager', 'club', 'club.waitlists.read'),
    ('club_manager', 'club', 'club.groups.archived.read'),
    ('club_manager', 'club', 'club.groups.create'),
    ('club_manager', 'club', 'group.update'),
    ('club_manager', 'club', 'group.owners.manage'),
    ('club_manager', 'club', 'group.members.read'),
    ('club_manager', 'club', 'group.members.manage'),
    ('club_manager', 'club', 'group.waitlist.manage'),
    ('club_manager', 'club', 'group.activities.read'),
    ('club_manager', 'club', 'group.activities.manage'),
    ('club_manager', 'club', 'club.activities.read'),
    ('club_manager', 'club', 'club.locations.manage'),
    ('club_manager', 'club', 'club.locations.create'),
    ('club_manager', 'club', 'club.events.create'),
    ('club_manager', 'club', 'event.read'),
    ('club_manager', 'club', 'event.manage'),
    ('club_manager', 'club', 'person.protection.set'),
    ('club_manager', 'club', 'person.merge'),
    ('club_manager', 'club', 'club.guardianships.end'),
    ('club_manager', 'club', 'club.history.read'),
    ('club_manager', 'club', 'club.audit.read'),
    ('club_manager', 'club', 'group.history.read'),
    ('club_manager', 'club', 'activity.history.read'),
    ('club_manager', 'club', 'event.history.read'),
    ('club_manager', 'club', 'club.profile_views.read'),
    ('club_manager', 'club', 'club.profile_views.configure'),
    ('club_manager', 'club', 'billing.subscription.read'),
    ('club_manager', 'club', 'billing.subscription.change'),
    ('club_manager', 'club', 'billing.account.manage'),
    ('club_manager', 'club', 'billing.invoices.read'),
    ('club_manager', 'club', 'club.channels.create'),
    ('club_manager', 'club', 'club.documents.manage'),
    ('club_manager', 'club', 'club.announcements.send'),
    ('club_manager', 'club', 'club.carpools.manage'),
    ('registrar', 'club', 'club.people.details'),
    ('registrar', 'club', 'club.people.protected'),
    ('registrar', 'club', 'club.members.read'),
    ('registrar', 'club', 'club.members.manage'),
    ('registrar', 'club', 'club.members.export'),
    ('registrar', 'club', 'club.members.add'),
    ('registrar', 'club', 'club.members.import'),
    ('registrar', 'club', 'club.join_requests.manage'),
    ('registrar', 'club', 'club.invitations.manage'),
    ('registrar', 'club', 'club.guardians.manage'),
    ('registrar', 'club', 'club.waitlists.read'),
    ('registrar', 'club', 'club.groups.archived.read'),
    ('registrar', 'club', 'club.activities.read'),
    ('registrar', 'club', 'group.members.read'),
    ('registrar', 'club', 'group.activities.read'),
    ('registrar', 'club', 'group.attendance.read'),
    ('registrar', 'club', 'activity.attendance.manage'),
    ('registrar', 'club', 'event.read'),
    ('registrar', 'club', 'event.registrations.read'),
    ('registrar', 'club', 'person.own_login.invite'),
    ('registrar', 'club', 'person.consents.read'),
    ('registrar', 'club', 'person.consents.manage'),
    ('registrar', 'club', 'group.consents.read'),
    ('registrar', 'club', 'person.history.read'),
    ('registrar', 'club', 'group.history.read'),
    ('registrar', 'club', 'activity.history.read'),
    ('registrar', 'club', 'event.history.read'),
    ('registrar', 'club', 'club.members.routine'),
    ('registrar', 'club', 'club.roles.read'),
    ('chair', 'club', 'club.members.read'),
    ('chair', 'club', 'club.activities.read'),
    ('chair', 'club', 'club.events.create'),
    ('chair', 'club', 'club.managers.claim'),
    ('chair', 'club', 'club.roles.read'),
    ('chair', 'club', 'club.channels.create'),
    ('chair', 'club', 'club.announcements.send'),
    ('chair', 'club', 'club.governing_documents.manage'),
    ('chair', 'club', 'club.governing_documents.adopt'),
    ('vice_chair', 'club', 'club.members.read'),
    ('vice_chair', 'club', 'club.activities.read'),
    ('vice_chair', 'club', 'club.events.create'),
    ('treasurer', 'club', 'club.members.read'),
    ('treasurer', 'club', 'club.activities.read'),
    ('treasurer', 'club', 'club.events.create'),
    ('treasurer', 'club', 'billing.subscription.read'),
    ('treasurer', 'club', 'billing.account.manage'),
    ('treasurer', 'club', 'billing.invoices.read'),
    ('treasurer', 'club', 'club.carpools.manage'),
    ('secretary', 'club', 'club.members.read'),
    ('secretary', 'club', 'club.activities.read'),
    ('secretary', 'club', 'club.events.create'),
    ('secretary', 'club', 'club.documents.manage'),
    ('secretary', 'club', 'club.announcements.send'),
    ('secretary', 'club', 'club.governing_documents.manage'),
    ('secretary', 'club', 'club.governing_documents.adopt'),
    ('board_member', 'club', 'club.members.read'),
    ('board_member', 'club', 'club.activities.read'),
    ('board_member', 'club', 'club.events.create'),
    ('deputy_board_member', 'club', 'club.members.read'),
    ('deputy_board_member', 'club', 'club.activities.read'),
    ('deputy_board_member', 'club', 'club.events.create'),
    ('auditor', 'club', NULL),
    ('nomination_committee', 'club', NULL),
    ('safeguarding_officer', 'club', 'club.safeguarding.handle'),
    ('communications', 'club', 'club.announcements.send'),
    ('staff', 'club', NULL),
    ('member', 'group', 'group.participate'),
    ('member', 'group', 'group.channels.create'),
    ('head_coach', 'group', 'group.lead'),
    ('head_coach', 'group', 'group.people.details'),
    ('head_coach', 'group', 'person.consents.read'),
    ('head_coach', 'group', 'group.consents.read'),
    ('head_coach', 'group', 'group.activities.manage'),
    ('head_coach', 'group', 'activity.responses.read'),
    ('head_coach', 'group', 'group.channels.create'),
    ('head_coach', 'group', 'group.channels.manage'),
    ('head_coach', 'group', 'group.documents.manage'),
    ('head_coach', 'group', 'group.announcements.send'),
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.channels.create'),
    ('assistant_coach', 'group', 'group.documents.manage'),
    ('assistant_coach', 'group', 'group.announcements.send'),
    ('team_manager', 'group', 'group.lead'),
    ('team_manager', 'group', 'group.people.details'),
    ('team_manager', 'group', 'person.consents.read'),
    ('team_manager', 'group', 'group.consents.read'),
    ('team_manager', 'group', 'group.activities.manage'),
    ('team_manager', 'group', 'activity.responses.read'),
    ('team_manager', 'group', 'group.channels.create'),
    ('team_manager', 'group', 'group.documents.manage'),
    ('team_manager', 'group', 'group.announcements.send'),
    ('physio', 'group', 'group.lead'),
    ('physio', 'group', 'group.people.details'),
    ('physio', 'group', 'person.consents.read'),
    ('physio', 'group', 'group.consents.read'),
    ('other_leader', 'group', 'group.lead'),
    ('other_leader', 'group', 'group.people.details'),
    ('other_leader', 'group', 'person.consents.read'),
    ('other_leader', 'group', 'group.consents.read'),
    ('other_leader', 'group', 'activity.responses.read')
  ) AS t (template_key, scope, permission)
$$;
--> statement-breakpoint

INSERT INTO public.club_type_role_permissions (club_type_role_id, permission)
SELECT r.id, t.permission
FROM app.builtin_role_template() t
JOIN public.club_type_roles r ON r.scope = t.scope AND r.key = t.template_key
WHERE t.permission = 'club.carpools.manage'
ON CONFLICT (club_type_role_id, permission) DO NOTHING;

DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs ORDER BY id LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    WITH added AS (
      INSERT INTO public.role_permissions (club_id, role_id, permission)
      SELECT v_club, r.id, t.permission
      FROM app.builtin_role_template() t
      JOIN public.roles r ON r.club_id = v_club AND r.scope = t.scope AND r.template_key = t.template_key
      WHERE t.permission = 'club.carpools.manage'
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Erasure (P1.8b): the meeting place of the person's drives is cleared (the
-- function of 0037 with that step); replayed from the deletion ledger.
GRANT SELECT, UPDATE ON public.carpool_offers TO clubadmin_retention;
CREATE OR REPLACE FUNCTION privacy.erase_person(p_person_id uuid, p_reason text, p_replay boolean DEFAULT false)
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
  v_response_keys CONSTANT text[] := ARRAY['note'];
  v_registration_keys CONSTANT text[] := ARRAY['answers', 'sensitive_answers'];
  v_join_keys CONSTANT text[] := ARRAY['message', 'decision_message'];
  v_waitlist_keys CONSTANT text[] := ARRAY['applicant_note', 'owner_note'];
  v_guardianship_keys CONSTANT text[] := ARRAY['consent_note', 'ended_reason'];
  v_consent_keys CONSTANT text[] := ARRAY['club_note'];
  v_carpool_keys CONSTANT text[] := ARRAY['departure_place'];
  v_erased_email CONSTANT text := 'erased-' || p_person_id || '@erased.invalid';
  v_email text;
  v_invitation_ids uuid[];
  v_guardian_invitation_ids uuid[];
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

  -- The login address, before it is replaced: invitations sent to it go too.
  SELECT email INTO v_email FROM public.accounts
  WHERE person_id = p_person_id AND email <> v_erased_email;

  UPDATE public.people
  SET given_name = '', family_name = '',
      birth_date = date_trunc('year', birth_date)::date,
      personal_identity_number = NULL, personal_identity_number_hash = NULL,
      phone = NULL, address = NULL, orphaned_since = NULL,
      anonymized_at = coalesce(anonymized_at, now())
  WHERE id = p_person_id
    AND (given_name <> '' OR family_name <> ''
      OR birth_date IS DISTINCT FROM date_trunc('year', birth_date)::date
      OR personal_identity_number IS NOT NULL OR phone IS NOT NULL OR address IS NOT NULL
      OR anonymized_at IS NULL);
  v_changed := FOUND;

  UPDATE public.accounts
  SET email = v_erased_email, idp_subject = NULL, notification_settings = '{}'
  WHERE person_id = p_person_id AND email <> v_erased_email;
  v_changed := v_changed OR FOUND;

  UPDATE public.club_profiles
  SET emergency_contacts = '[]', notes = NULL
  WHERE person_id = p_person_id AND (emergency_contacts <> '[]' OR notes IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Invitations sent to the person's email address.
  DELETE FROM public.account_invitations WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  WITH changed AS (
    UPDATE public.guardian_invitations
    SET email = v_erased_email, revoked_at = coalesce(revoked_at, CASE WHEN accepted_at IS NULL THEN now() END)
    WHERE email <> v_erased_email
      AND (accepted_by_person_id = p_person_id OR (v_email IS NOT NULL AND email = v_email))
    RETURNING id)
  SELECT array_agg(id) INTO v_guardian_invitation_ids FROM changed;
  v_changed := v_changed OR v_guardian_invitation_ids IS NOT NULL;
  WITH changed AS (
    UPDATE public.invitations SET email = v_erased_email
    WHERE v_email IS NOT NULL AND email = v_email
    RETURNING id)
  SELECT array_agg(id) INTO v_invitation_ids FROM changed;
  v_changed := v_changed OR v_invitation_ids IS NOT NULL;

  -- Notes to the leaders on the person's answers (P1.5; they may be about health).
  UPDATE public.activity_responses SET note = NULL
  WHERE person_id = p_person_id AND note IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- Answers to events' sign-up forms (P1.6): the sensitive ones deleted, the others cleared.
  UPDATE public.event_registrations SET answers = '{}', sensitive_answers = NULL
  WHERE person_id = p_person_id AND (answers <> '{}' OR sensitive_answers IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Join requests, waiting lists and guardianships: free text about the person (P1.8a).
  UPDATE public.join_requests SET message = NULL, decision_message = NULL
  WHERE person_id = p_person_id AND (message IS NOT NULL OR decision_message IS NOT NULL);
  v_changed := v_changed OR FOUND;
  UPDATE public.group_waitlist_entries SET applicant_note = NULL, owner_note = NULL
  WHERE person_id = p_person_id AND (applicant_note IS NOT NULL OR owner_note IS NOT NULL);
  v_changed := v_changed OR FOUND;
  UPDATE public.guardianships SET consent_note = NULL, ended_reason = NULL
  WHERE (ward_person_id = p_person_id OR guardian_person_id = p_person_id)
    AND (consent_note IS NOT NULL OR ended_reason IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Open consents end with the person (P1.8a); the club's notes on them go.
  UPDATE public.consents
  SET revoked_at = now(), revoked_reason = 'erased', club_note = NULL
  WHERE person_id = p_person_id AND revoked_at IS NULL;
  v_changed := v_changed OR FOUND;
  UPDATE public.consents SET club_note = NULL
  WHERE person_id = p_person_id AND club_note IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- Notifications (P1.7): the person's inbox, its deliveries (cascade) and
  -- push devices; the person is taken out of others' notices about them.
  DELETE FROM public.notifications WHERE recipient_person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.notifications SET about_person_ids = array_remove(about_person_ids, p_person_id)
  WHERE about_person_ids @> ARRAY[p_person_id];
  v_changed := v_changed OR FOUND;
  DELETE FROM public.push_devices d USING public.accounts a
  WHERE a.id = d.account_id AND a.person_id = p_person_id;
  v_changed := v_changed OR FOUND;

  -- Calendar feeds (P1.11): the person's feeds and their history; the person
  -- is taken out of others' feeds that name them.
  DELETE FROM history.record_changes h USING public.calendar_feeds f
  WHERE h.table_name = 'public.calendar_feeds' AND h.record_id = f.id AND f.person_id = p_person_id;
  DELETE FROM public.calendar_feeds WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.calendar_feeds SET person_ids = array_remove(person_ids, p_person_id)
  WHERE person_ids @> ARRAY[p_person_id];
  v_changed := v_changed OR FOUND;

  -- Protected identity (P1.12): who set a flag; the profile view log names
  -- nobody erased, in any club (the deletion ledger replays this too).
  UPDATE public.people SET protected_identity_set_by_person_id = NULL
  WHERE protected_identity_set_by_person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.club_profiles SET protected_identity_club_set_by_person_id = NULL
  WHERE protected_identity_club_set_by_person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  IF privacy.anonymize_profile_views(p_person_id, NULL, false) > 0 THEN
    v_changed := true;
  END IF;

  -- Chat (P2.1, ADR 0047): the person leaves every chat; their messages and
  -- reactions stay, shown as from "a former member" (the person row is
  -- anonymised above). Names written in others' messages are not rewritten.
  UPDATE public.chat_members SET status = 'left', left_at = now()
  WHERE person_id = p_person_id AND status <> 'left';
  v_changed := v_changed OR FOUND;

  -- Car pools (P2.5, ADR 0048): the person stays in drives and statistics
  -- as the anonymised person above; the free text of their drives' meeting
  -- place goes (it may say where they live).
  UPDATE public.carpool_offers SET departure_place = NULL
  WHERE driver_person_id = p_person_id AND departure_place IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- "Download my data" requests (P1.8b): the job deleted their files first.
  DELETE FROM public.data_exports
  WHERE subject_person_id = p_person_id OR requested_by_person_id = p_person_id;
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
         AND (p_person_id::text IN (old_values ->> 'accepted_by_person_id', new_values ->> 'accepted_by_person_id')
              OR record_id = ANY (coalesce(v_guardian_invitation_ids, '{}'))))
     OR (table_name = 'public.invitations' AND record_id = ANY (coalesce(v_invitation_ids, '{}')));

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_response_keys),
      new_values = privacy.scrub(h.new_values, v_response_keys)
  FROM public.activity_responses r
  WHERE r.person_id = p_person_id AND h.table_name = 'public.activity_responses'
    AND h.record_id = r.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_registration_keys),
      new_values = privacy.scrub(h.new_values, v_registration_keys)
  FROM public.event_registrations r
  WHERE r.person_id = p_person_id AND h.table_name = 'public.event_registrations'
    AND h.record_id = r.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_join_keys),
      new_values = privacy.scrub(h.new_values, v_join_keys)
  FROM public.join_requests j
  WHERE j.person_id = p_person_id AND h.table_name = 'public.join_requests' AND h.record_id = j.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_waitlist_keys),
      new_values = privacy.scrub(h.new_values, v_waitlist_keys)
  FROM public.group_waitlist_entries w
  WHERE w.person_id = p_person_id AND h.table_name = 'public.group_waitlist_entries'
    AND h.record_id = w.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_guardianship_keys),
      new_values = privacy.scrub(h.new_values, v_guardianship_keys)
  FROM public.guardianships g
  WHERE (g.ward_person_id = p_person_id OR g.guardian_person_id = p_person_id)
    AND h.table_name = 'public.guardianships' AND h.record_id = g.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_consent_keys),
      new_values = privacy.scrub(h.new_values, v_consent_keys)
  FROM public.consents c
  WHERE c.person_id = p_person_id AND h.table_name = 'public.consents' AND h.record_id = c.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_carpool_keys),
      new_values = privacy.scrub(h.new_values, v_carpool_keys)
  FROM public.carpool_offers o
  WHERE o.driver_person_id = p_person_id AND h.table_name = 'public.carpool_offers'
    AND h.record_id = o.id;

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;
