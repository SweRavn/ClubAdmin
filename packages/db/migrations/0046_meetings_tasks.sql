-- P2.4 part B (ADR 0049 decisions 3–5, ADR 0052): meetings and tasks.
-- A board's or committee's meeting is an activity of its group, the annual
-- meeting an event for the club; both carry the same agenda: items (from
-- the club's templates, which start from the country pack's), the minutes
-- written per item, decisions per item and papers (documents) per item.
-- Assembling the minutes makes one governing document of the items
-- (meeting_minutes links the meeting to it). Action items are tasks
-- (ADR 0052): the shared tables that duty shifts (P2.6) join later.

CREATE TABLE public.agenda_templates (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  meeting_kind text NOT NULL CONSTRAINT agenda_templates_meeting_kind
    CHECK (meeting_kind IN ('annual_meeting', 'extra_meeting', 'board_meeting', 'other')),
  name text NOT NULL CONSTRAINT agenda_templates_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  -- [{ "title": "...", "durationMinutes": 5 }], at most 60 items.
  items jsonb NOT NULL CONSTRAINT agenda_templates_items
    CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 60),
  created_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT agenda_templates_club_id_unique UNIQUE (club_id, id)
);
CREATE UNIQUE INDEX agenda_templates_name_unique ON public.agenda_templates (club_id, lower(name));
CREATE INDEX agenda_templates_created_by_idx ON public.agenda_templates (created_by_person_id)
  WHERE created_by_person_id IS NOT NULL;

CREATE TABLE public.meeting_agenda_items (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  -- The meeting: an activity (a board's meeting) or an event (the annual meeting), exactly one.
  activity_id uuid,
  event_id uuid,
  position integer NOT NULL CONSTRAINT meeting_agenda_items_position CHECK (position BETWEEN 1 AND 200),
  title text NOT NULL CONSTRAINT meeting_agenda_items_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  presenter_person_id uuid REFERENCES public.people(id),
  duration_minutes integer CONSTRAINT meeting_agenda_items_duration CHECK (duration_minutes BETWEEN 1 AND 600),
  -- What was said, written during the meeting (Markdown).
  minutes text CONSTRAINT meeting_agenda_items_minutes CHECK (char_length(minutes) <= 50000),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT meeting_agenda_items_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT meeting_agenda_items_activity_fk FOREIGN KEY (club_id, activity_id) REFERENCES public.activities (club_id, id),
  CONSTRAINT meeting_agenda_items_event_fk FOREIGN KEY (club_id, event_id) REFERENCES public.events (club_id, id),
  CONSTRAINT meeting_agenda_items_meeting CHECK ((activity_id IS NULL) <> (event_id IS NULL))
);
-- A meeting's agenda in order.
CREATE INDEX meeting_agenda_items_activity_idx ON public.meeting_agenda_items (activity_id, position)
  WHERE activity_id IS NOT NULL;
CREATE INDEX meeting_agenda_items_event_idx ON public.meeting_agenda_items (event_id, position)
  WHERE event_id IS NOT NULL;
CREATE INDEX meeting_agenda_items_presenter_idx ON public.meeting_agenda_items (presenter_person_id)
  WHERE presenter_person_id IS NOT NULL;

CREATE TABLE public.meeting_decisions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  item_id uuid NOT NULL,
  position integer NOT NULL CONSTRAINT meeting_decisions_position CHECK (position BETWEEN 1 AND 100),
  text text NOT NULL CONSTRAINT meeting_decisions_text CHECK (char_length(btrim(text)) BETWEEN 1 AND 5000),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT meeting_decisions_item_fk FOREIGN KEY (club_id, item_id)
    REFERENCES public.meeting_agenda_items (club_id, id) ON DELETE CASCADE
);
CREATE INDEX meeting_decisions_item_idx ON public.meeting_decisions (item_id, position);

-- An item's papers: read by the meeting's readers while attached (app.notice_reader).
CREATE TABLE public.agenda_item_documents (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  item_id uuid NOT NULL,
  document_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT agenda_item_documents_unique UNIQUE (item_id, document_id),
  CONSTRAINT agenda_item_documents_item_fk FOREIGN KEY (club_id, item_id)
    REFERENCES public.meeting_agenda_items (club_id, id) ON DELETE CASCADE,
  CONSTRAINT agenda_item_documents_document_fk FOREIGN KEY (club_id, document_id)
    REFERENCES public.documents (club_id, id)
);
CREATE INDEX agenda_item_documents_document_idx ON public.agenda_item_documents (document_id);

-- The minutes a meeting's agenda was assembled into (a governing document).
CREATE TABLE public.meeting_minutes (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  activity_id uuid,
  event_id uuid,
  document_id uuid NOT NULL,
  assembled_by_person_id uuid REFERENCES public.people(id),
  assembled_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT meeting_minutes_activity_fk FOREIGN KEY (club_id, activity_id) REFERENCES public.activities (club_id, id),
  CONSTRAINT meeting_minutes_event_fk FOREIGN KEY (club_id, event_id) REFERENCES public.events (club_id, id),
  CONSTRAINT meeting_minutes_document_fk FOREIGN KEY (club_id, document_id) REFERENCES public.documents (club_id, id),
  CONSTRAINT meeting_minutes_meeting CHECK ((activity_id IS NULL) <> (event_id IS NULL))
);
CREATE UNIQUE INDEX meeting_minutes_activity_unique ON public.meeting_minutes (activity_id)
  WHERE activity_id IS NOT NULL;
CREATE UNIQUE INDEX meeting_minutes_event_unique ON public.meeting_minutes (event_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX meeting_minutes_document_idx ON public.meeting_minutes (document_id);
CREATE INDEX meeting_minutes_assembled_by_idx ON public.meeting_minutes (assembled_by_person_id)
  WHERE assembled_by_person_id IS NOT NULL;

-- Tasks (ADR 0052): something a person has been given to do.
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  group_id uuid,
  kind text NOT NULL CONSTRAINT tasks_kind CHECK (kind IN ('action_item')),
  title text NOT NULL CONSTRAINT tasks_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CONSTRAINT tasks_description CHECK (char_length(description) <= 10000),
  due_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  needed integer NOT NULL DEFAULT 1 CONSTRAINT tasks_needed CHECK (needed BETWEEN 1 AND 500),
  -- Where it comes from: a meeting's agenda item (action items), later an activity or event session.
  source_agenda_item_id uuid,
  source_activity_id uuid,
  source_event_id uuid,
  created_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT tasks_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT tasks_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id),
  CONSTRAINT tasks_agenda_item_fk FOREIGN KEY (source_agenda_item_id)
    REFERENCES public.meeting_agenda_items (id) ON DELETE SET NULL,
  CONSTRAINT tasks_activity_fk FOREIGN KEY (club_id, source_activity_id) REFERENCES public.activities (club_id, id),
  CONSTRAINT tasks_event_fk FOREIGN KEY (club_id, source_event_id) REFERENCES public.events (club_id, id),
  CONSTRAINT tasks_time CHECK (ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at > starts_at))
);
CREATE INDEX tasks_agenda_item_idx ON public.tasks (source_agenda_item_id) WHERE source_agenda_item_id IS NOT NULL;
CREATE INDEX tasks_activity_idx ON public.tasks (source_activity_id) WHERE source_activity_id IS NOT NULL;
CREATE INDEX tasks_event_idx ON public.tasks (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX tasks_group_idx ON public.tasks (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX tasks_created_by_idx ON public.tasks (created_by_person_id) WHERE created_by_person_id IS NOT NULL;

CREATE TABLE public.task_assignments (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  task_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  -- Whose quota it counts for (a player's, done by a parent; P2.6).
  counts_for_person_id uuid REFERENCES public.people(id),
  source text NOT NULL DEFAULT 'assigned' CONSTRAINT task_assignments_source
    CHECK (source IN ('assigned', 'signup', 'swap')),
  status text NOT NULL DEFAULT 'planned' CONSTRAINT task_assignments_status
    CHECK (status IN ('planned', 'done', 'missed')),
  marked_by_person_id uuid REFERENCES public.people(id),
  marked_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT task_assignments_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT task_assignments_task_fk FOREIGN KEY (club_id, task_id)
    REFERENCES public.tasks (club_id, id) ON DELETE CASCADE,
  CONSTRAINT task_assignments_unique UNIQUE (task_id, person_id)
);
-- "Mina uppgifter": a person's assignments.
CREATE INDEX task_assignments_person_idx ON public.task_assignments (person_id, status);
CREATE INDEX task_assignments_counts_for_idx ON public.task_assignments (counts_for_person_id)
  WHERE counts_for_person_id IS NOT NULL;
CREATE INDEX task_assignments_marked_by_idx ON public.task_assignments (marked_by_person_id)
  WHERE marked_by_person_id IS NOT NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.agenda_templates'), app.enable_updated_at('public.agenda_templates'),
  history.enable_history('public.agenda_templates');
SELECT app.enable_tenant_rls('public.meeting_agenda_items'), app.enable_updated_at('public.meeting_agenda_items'),
  history.enable_history('public.meeting_agenda_items');
SELECT app.enable_tenant_rls('public.meeting_decisions'), app.enable_updated_at('public.meeting_decisions'),
  history.enable_history('public.meeting_decisions');
SELECT app.enable_tenant_rls('public.agenda_item_documents'), app.enable_updated_at('public.agenda_item_documents'),
  history.enable_history('public.agenda_item_documents');
SELECT app.enable_tenant_rls('public.meeting_minutes'), app.enable_updated_at('public.meeting_minutes'),
  history.enable_history('public.meeting_minutes');
SELECT app.enable_tenant_rls('public.tasks'), app.enable_updated_at('public.tasks'),
  history.enable_history('public.tasks');
SELECT app.enable_tenant_rls('public.task_assignments'), app.enable_updated_at('public.task_assignments'),
  history.enable_history('public.task_assignments');
--> statement-breakpoint

-- The papers of a meeting's agenda items are read like the documents of its
-- notice (P2.2): by the activity's call-up or groups, or the published
-- event's audience, and their guardians whose link receives messages.
CREATE OR REPLACE FUNCTION app.notice_reader(p_document uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH who AS MATERIALIZED (
    SELECT p_person AS person_id
    UNION
    SELECT g.ward_person_id FROM public.guardianships g
    WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL
      AND 'receive_messages' = ANY (g.rights)),
  na AS MATERIALIZED (
    SELECT n.activity_id, n.event_id FROM public.notice_attachments n WHERE n.document_id = p_document
    UNION
    SELECT i.activity_id, i.event_id FROM public.agenda_item_documents d
    JOIN public.meeting_agenda_items i ON i.id = d.item_id
    WHERE d.document_id = p_document)
  SELECT p_person IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM na JOIN public.activities a ON a.id = na.activity_id
      WHERE CASE WHEN a.invitees_only THEN EXISTS (
          SELECT 1 FROM public.activity_invitees i JOIN who ON who.person_id = i.person_id
          WHERE i.activity_id = a.id)
        ELSE EXISTS (
          SELECT 1 FROM public.activity_groups ag
          JOIN public.group_memberships gm ON gm.group_id = ag.group_id AND gm.valid_to IS NULL
          JOIN who ON who.person_id = gm.person_id
          WHERE ag.activity_id = a.id) END)
    OR EXISTS (
      SELECT 1 FROM na JOIN public.events e ON e.id = na.event_id
      WHERE e.status <> 'draft' AND CASE WHEN e.audience = 'club' THEN (
          EXISTS (SELECT 1 FROM public.club_memberships m JOIN who ON who.person_id = m.person_id
                  WHERE m.club_id = e.club_id AND m.valid_to IS NULL AND m.status IN ('active', 'paused'))
          OR EXISTS (SELECT 1 FROM public.group_memberships gm JOIN who ON who.person_id = gm.person_id
                     WHERE gm.club_id = e.club_id AND gm.valid_to IS NULL))
        ELSE EXISTS (
          SELECT 1 FROM public.event_groups eg
          JOIN public.group_memberships gm ON gm.group_id = eg.group_id AND gm.valid_to IS NULL
          JOIN who ON who.person_id = gm.person_id
          WHERE eg.event_id = e.id) END))
$$;
--> statement-breakpoint

-- The clubs of these people (their memberships, groups and club roles), by
-- their own index entries: where their club data may be.
CREATE FUNCTION app.my_clubs_for(p_people uuid[]) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT c), '{}') FROM (
    SELECT m.club_id AS c FROM public.club_memberships m
    WHERE m.person_id = ANY (p_people) AND m.valid_to IS NULL
    UNION SELECT gm.club_id FROM public.group_memberships gm
    WHERE gm.person_id = ANY (p_people) AND gm.valid_to IS NULL
    UNION SELECT r.club_id FROM public.club_role_assignments r
    WHERE r.person_id = ANY (p_people) AND r.valid_to IS NULL) x
$$;
REVOKE ALL ON FUNCTION app.my_clubs_for(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_clubs_for(uuid[]) TO clubadmin_app;

-- "Mina uppgifter": the tasks assigned to the caller and their wards,
-- across their clubs (each club read in turn, tenant RLS as in
-- app.my_announcements), open ones (planned) or the others, by day
-- (due date or start, none last) and ID after the cursor's. By the
-- person's own assignments; never a scan of a club.
CREATE FUNCTION app.my_tasks(p_cursor uuid, p_limit integer, p_open boolean)
  RETURNS TABLE (assignment_id uuid, task_id uuid, club_id uuid, club_name text, group_id uuid,
    group_name text, kind text, title text, description text, due_date date,
    starts_at timestamptz, ends_at timestamptz, person_id uuid, status text,
    marked_at timestamptz, source_activity_id uuid, source_event_id uuid,
    meeting_title text, sort_day date)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := app.current_person_id();
  v_people uuid[];
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_clubs uuid[];
  v_club uuid;
  v_day date;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN;
  END IF;
  v_people := app.self_and_wards();
  v_clubs := app.my_clubs_for(v_people);
  IF p_cursor IS NOT NULL THEN
    FOREACH v_club IN ARRAY v_clubs LOOP
      PERFORM set_config('app.club_id', v_club::text, true);
      SELECT coalesce(t.due_date, (t.starts_at AT TIME ZONE 'UTC')::date, 'infinity'::date), a.id
        INTO v_day, v_id
      FROM public.task_assignments a JOIN public.tasks t ON t.id = a.task_id WHERE a.id = p_cursor;
      EXIT WHEN v_id IS NOT NULL;
    END LOOP;
    IF v_id IS NULL THEN
      PERFORM set_config('app.club_id', v_prev, true);
      RETURN;
    END IF;
  END IF;
  FOREACH v_club IN ARRAY v_clubs LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    RETURN QUERY
    WITH mine AS (
      SELECT a.id, a.task_id, a.person_id, a.status, a.marked_at,
        coalesce(t.due_date, (t.starts_at AT TIME ZONE 'UTC')::date, 'infinity'::date) AS day
      FROM public.task_assignments a JOIN public.tasks t ON t.id = a.task_id
      WHERE a.person_id = ANY (v_people) AND a.club_id = v_club
        AND (a.status = 'planned') = p_open),
    pick AS (
      SELECT * FROM mine
      WHERE v_id IS NULL OR (mine.day, mine.id) > (v_day, v_id)
      ORDER BY mine.day, mine.id LIMIT p_limit)
    SELECT pick.id, t.id, t.club_id, (SELECT cl.name FROM public.clubs cl WHERE cl.id = t.club_id),
      t.group_id, (SELECT g.name FROM public.groups g WHERE g.id = t.group_id), t.kind, t.title,
      t.description, t.due_date, t.starts_at, t.ends_at, pick.person_id, pick.status, pick.marked_at,
      coalesce(i.activity_id, t.source_activity_id), coalesce(i.event_id, t.source_event_id),
      coalesce((SELECT ac.title FROM public.activities ac WHERE ac.id = coalesce(i.activity_id, t.source_activity_id)),
        (SELECT ev.title FROM public.events ev WHERE ev.id = coalesce(i.event_id, t.source_event_id))),
      pick.day
    FROM pick JOIN public.tasks t ON t.id = pick.task_id
    LEFT JOIN public.meeting_agenda_items i ON i.id = t.source_agenda_item_id;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_tasks(uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_tasks(uuid, integer, boolean) TO clubadmin_app;

-- The club of one of the caller's (or their wards') assignments, for
-- marking it from "Mina uppgifter" (null: not theirs). Each of their clubs
-- in turn, as app.my_tasks.
CREATE FUNCTION app.my_task_assignment_club(p_assignment uuid) RETURNS uuid
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
    SELECT a.club_id INTO v_found FROM public.task_assignments a
    WHERE a.id = p_assignment AND a.person_id = ANY (v_people);
    EXIT WHEN v_found IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
  RETURN v_found;
END
$$;
REVOKE ALL ON FUNCTION app.my_task_assignment_club(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_task_assignment_club(uuid) TO clubadmin_app;
