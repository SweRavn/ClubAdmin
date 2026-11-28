-- P2.9 (ADR 0054): programmes and templates.
-- - programmes: a club-owned container of activities and duty shifts (any
--   kind, with or without an event; one event has at most one programme);
--   programme_groups for "the programmes of my groups".
-- - programme_templates (a group's or the club's), their group slots and
--   items: relative days and wall-clock times in the club's time zone,
--   places by reference, duty shifts by type and need. No people.
-- - activities.programme_id and tasks.programme_id (expand only).
-- - club.programmes.manage for club managers.

CREATE TABLE public.programme_templates (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  -- Null: a club template (club managers; every team uses it for its groups).
  group_id uuid,
  name text NOT NULL CONSTRAINT programme_templates_name CHECK (length(name) BETWEEN 1 AND 120),
  description text CONSTRAINT programme_templates_description CHECK (length(description) <= 2000),
  day_count integer NOT NULL CONSTRAINT programme_templates_day_count CHECK (day_count BETWEEN 1 AND 31),
  -- The event to lay out with it (title, audience, capacity, questions,
  -- sign-up as days before the first day), or null.
  event_settings jsonb,
  archived_at timestamptz,
  created_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT programme_templates_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT programme_templates_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id)
);
CREATE INDEX programme_templates_club_idx ON public.programme_templates (club_id, group_id, id);
CREATE INDEX programme_templates_creator_idx ON public.programme_templates (created_by_person_id);

CREATE TABLE public.programme_template_slots (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  template_id uuid NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  key text NOT NULL CONSTRAINT programme_template_slots_key CHECK (key ~ '^[a-z0-9_-]{1,40}$'),
  label text NOT NULL CONSTRAINT programme_template_slots_label CHECK (length(label) BETWEEN 1 AND 60),
  default_group_id uuid,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT programme_template_slots_unique UNIQUE (template_id, key),
  CONSTRAINT programme_template_slots_template_fk FOREIGN KEY (club_id, template_id)
    REFERENCES public.programme_templates (club_id, id) ON DELETE CASCADE,
  CONSTRAINT programme_template_slots_group_fk FOREIGN KEY (club_id, default_group_id)
    REFERENCES public.groups (club_id, id)
);

CREATE TABLE public.programme_template_items (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  template_id uuid NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  kind text NOT NULL CONSTRAINT programme_template_items_kind CHECK (kind IN ('activity', 'duty_shift')),
  -- A shift on an activity item.
  parent_item_id uuid REFERENCES public.programme_template_items(id) ON DELETE CASCADE,
  sort integer NOT NULL DEFAULT 0,
  day_offset integer NOT NULL CONSTRAINT programme_template_items_day CHECK (day_offset BETWEEN 0 AND 30),
  start_time time NOT NULL,
  end_day_offset integer NOT NULL CONSTRAINT programme_template_items_end_day CHECK (end_day_offset BETWEEN 0 AND 30),
  end_time time NOT NULL,
  slot_keys text[] NOT NULL DEFAULT '{}',
  -- Activities.
  activity_kind text CONSTRAINT programme_template_items_activity_kind
    CHECK (activity_kind IN ('training', 'match', 'meeting', 'other')),
  kind_label text CONSTRAINT programme_template_items_kind_label CHECK (length(kind_label) BETWEEN 1 AND 60),
  title text NOT NULL CONSTRAINT programme_template_items_title CHECK (length(title) BETWEEN 1 AND 200),
  notes text CONSTRAINT programme_template_items_notes CHECK (length(notes) <= 2000),
  location_id uuid,
  location_text text CONSTRAINT programme_template_items_location_text CHECK (length(location_text) <= 200),
  meet_minutes_before integer CONSTRAINT programme_template_items_meet CHECK (meet_minutes_before BETWEEN 0 AND 600),
  meet_place text CONSTRAINT programme_template_items_meet_place CHECK (length(meet_place) <= 200),
  transport_mode text CONSTRAINT programme_template_items_transport CHECK (transport_mode IN ('own', 'shared')),
  home_away text CONSTRAINT programme_template_items_home_away CHECK (home_away IN ('home', 'away', 'neutral')),
  opponent text CONSTRAINT programme_template_items_opponent CHECK (length(opponent) <= 120),
  response_mode text CONSTRAINT programme_template_items_response CHECK (response_mode IN ('none', 'optional', 'requested')),
  -- Duty shifts.
  duty_type_id uuid,
  needed integer CONSTRAINT programme_template_items_needed CHECK (needed BETWEEN 1 AND 50),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT programme_template_items_template_fk FOREIGN KEY (club_id, template_id)
    REFERENCES public.programme_templates (club_id, id) ON DELETE CASCADE,
  CONSTRAINT programme_template_items_location_fk FOREIGN KEY (club_id, location_id)
    REFERENCES public.locations (club_id, id),
  CONSTRAINT programme_template_items_duty_type_fk FOREIGN KEY (club_id, duty_type_id)
    REFERENCES public.duty_types (club_id, id),
  CONSTRAINT programme_template_items_end CHECK (end_day_offset >= day_offset),
  CONSTRAINT programme_template_items_activity CHECK (kind <> 'activity' OR
    (activity_kind IS NOT NULL AND response_mode IS NOT NULL AND parent_item_id IS NULL
      AND duty_type_id IS NULL AND needed IS NULL)),
  CONSTRAINT programme_template_items_shift CHECK (kind <> 'duty_shift' OR
    (duty_type_id IS NOT NULL AND needed IS NOT NULL AND activity_kind IS NULL)),
  CONSTRAINT programme_template_items_kind_label_other CHECK (kind_label IS NULL OR activity_kind = 'other')
);
CREATE INDEX programme_template_items_template_idx ON public.programme_template_items (template_id, sort);
CREATE INDEX programme_template_items_parent_idx ON public.programme_template_items (parent_item_id)
  WHERE parent_item_id IS NOT NULL;
CREATE INDEX programme_template_items_location_idx ON public.programme_template_items (club_id, location_id)
  WHERE location_id IS NOT NULL;
CREATE INDEX programme_template_items_duty_type_idx ON public.programme_template_items (club_id, duty_type_id)
  WHERE duty_type_id IS NOT NULL;

CREATE TABLE public.programmes (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  title text NOT NULL CONSTRAINT programmes_title CHECK (length(title) BETWEEN 1 AND 200),
  template_id uuid,
  edition text CONSTRAINT programmes_edition CHECK (length(edition) BETWEEN 1 AND 60),
  event_id uuid,
  first_day date NOT NULL,
  last_day date NOT NULL,
  created_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT programmes_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT programmes_event_unique UNIQUE (event_id),
  CONSTRAINT programmes_days CHECK (last_day >= first_day),
  CONSTRAINT programmes_template_fk FOREIGN KEY (club_id, template_id)
    REFERENCES public.programme_templates (club_id, id),
  CONSTRAINT programmes_event_fk FOREIGN KEY (club_id, event_id) REFERENCES public.events (club_id, id)
);
CREATE INDEX programmes_club_idx ON public.programmes (club_id, first_day, id);
CREATE INDEX programmes_template_idx ON public.programmes (template_id, first_day)
  WHERE template_id IS NOT NULL;
CREATE INDEX programmes_creator_idx ON public.programmes (created_by_person_id);

CREATE TABLE public.programme_groups (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  programme_id uuid NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  group_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT programme_groups_unique UNIQUE (programme_id, group_id),
  CONSTRAINT programme_groups_programme_fk FOREIGN KEY (club_id, programme_id)
    REFERENCES public.programmes (club_id, id) ON DELETE CASCADE,
  CONSTRAINT programme_groups_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id)
);
CREATE INDEX programme_groups_group_idx ON public.programme_groups (group_id, programme_id);

ALTER TABLE public.activities ADD COLUMN programme_id uuid;
ALTER TABLE public.activities ADD CONSTRAINT activities_programme_fk FOREIGN KEY (club_id, programme_id)
  REFERENCES public.programmes (club_id, id);
CREATE INDEX activities_programme_idx ON public.activities (programme_id, starts_at)
  WHERE programme_id IS NOT NULL;
ALTER TABLE public.tasks ADD COLUMN programme_id uuid;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_programme_fk FOREIGN KEY (club_id, programme_id)
  REFERENCES public.programmes (club_id, id);
CREATE INDEX tasks_programme_idx ON public.tasks (programme_id, starts_at)
  WHERE programme_id IS NOT NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.programme_templates'),
  app.enable_updated_at('public.programme_templates'),
  history.enable_history('public.programme_templates');
SELECT app.enable_tenant_rls('public.programme_template_slots'),
  app.enable_updated_at('public.programme_template_slots'),
  history.enable_history('public.programme_template_slots');
SELECT app.enable_tenant_rls('public.programme_template_items'),
  app.enable_updated_at('public.programme_template_items'),
  history.enable_history('public.programme_template_items');
SELECT app.enable_tenant_rls('public.programmes'),
  app.enable_updated_at('public.programmes'),
  history.enable_history('public.programmes');
SELECT app.enable_tenant_rls('public.programme_groups'),
  app.enable_updated_at('public.programme_groups'),
  history.enable_history('public.programme_groups');
--> statement-breakpoint

-- The built-in template (copied from 0059) with club.programmes.manage.
CREATE OR REPLACE FUNCTION app.builtin_role_template()
  RETURNS TABLE (template_key text, scope text, permission text)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM (VALUES
    ('club_manager', 'club', 'club.settings.update'),
    ('club_manager', 'club', 'club.programmes.manage'),
    ('club_manager', 'club', 'club.roles.manage'),
    ('club_manager', 'club', 'club.roles.read'),
    ('club_manager', 'club', 'club.people.protected'),
    ('club_manager', 'club', 'club.people.contact.edit'),
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
    ('club_manager', 'club', 'club.duties.manage'),
    ('club_manager', 'club', 'club.duty_types.manage'),
    ('club_manager', 'club', 'club.plugins.manage'),
    ('club_manager', 'club', 'club.grants.read'),
    ('club_manager', 'club', 'club.background_checks.manage'),
    ('registrar', 'club', 'club.people.details'),
    ('registrar', 'club', 'club.people.contact.edit'),
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
    ('registrar', 'club', 'club.grants.read'),
    ('registrar', 'club', 'club.grants.report'),
    ('registrar', 'club', 'club.background_checks.manage'),
    ('registrar', 'club', 'club.background_checks.verify'),
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
    ('treasurer', 'club', 'club.expenses.attest'),
    ('treasurer', 'club', 'club.grants.read'),
    ('treasurer', 'club', 'club.grants.report'),
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
    ('safeguarding_officer', 'club', 'club.background_checks.verify'),
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
    ('head_coach', 'group', 'group.expenses.attest'),
    ('head_coach', 'group', 'group.duties.manage'),
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.channels.create'),
    ('assistant_coach', 'group', 'group.documents.manage'),
    ('assistant_coach', 'group', 'group.announcements.send'),
    ('assistant_coach', 'group', 'group.duties.manage'),
    ('team_manager', 'group', 'group.lead'),
    ('team_manager', 'group', 'group.people.details'),
    ('team_manager', 'group', 'person.consents.read'),
    ('team_manager', 'group', 'group.consents.read'),
    ('team_manager', 'group', 'group.activities.manage'),
    ('team_manager', 'group', 'activity.responses.read'),
    ('team_manager', 'group', 'group.channels.create'),
    ('team_manager', 'group', 'group.documents.manage'),
    ('team_manager', 'group', 'group.announcements.send'),
    ('team_manager', 'group', 'group.expenses.attest'),
    ('team_manager', 'group', 'group.duties.manage'),
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
WHERE t.permission = 'club.programmes.manage'
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
      WHERE t.permission = 'club.programmes.manage'
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
