-- P2.3 (ADR 0053): announcements. One message from the club or a group to
-- an audience (the shared list of ADR 0049), on the board, by push and/or
-- by email: drafts, scheduled sending, editing after sending (marked
-- edited), withdrawing, read status per person, and the counts of what was
-- delivered. Recipients are resolved by the worker into notices of the
-- category `announcements` (ADR 0039); push never carries the text.

CREATE TABLE public.announcements (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  -- The group whose announcement it is (none: the club's).
  group_id uuid,
  audience_id uuid NOT NULL,
  title text NOT NULL CONSTRAINT announcements_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 150),
  -- Markdown limited to paragraphs, emphasis, lists and links (the shared renderer).
  body text NOT NULL CONSTRAINT announcements_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000),
  channels text[] NOT NULL CONSTRAINT announcements_channels
    CHECK (cardinality(channels) BETWEEN 1 AND 3 AND channels <@ ARRAY['board', 'push', 'email']),
  -- Emailed to everyone in the audience whatever their settings (not to bounced addresses).
  important boolean NOT NULL DEFAULT false,
  pinned_until timestamptz,
  -- Hidden from the board from then on (kept in the archive).
  expires_at timestamptz,
  -- Sent then by the worker (none: a draft until sent).
  scheduled_at timestamptz,
  sent_at timestamptz,
  edited_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_by_person_id uuid REFERENCES public.people(id),
  created_by_person_id uuid REFERENCES public.people(id),
  -- Counted by the worker when sent (IDs never kept here).
  recipient_count integer,
  email_count integer,
  push_count integer,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT announcements_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT announcements_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id),
  CONSTRAINT announcements_audience_fk FOREIGN KEY (club_id, audience_id) REFERENCES public.audiences (club_id, id)
);
-- The board: a club's and a group's sent announcements, newest first.
CREATE INDEX announcements_club_board_idx ON public.announcements (club_id, sent_at DESC, id DESC)
  WHERE sent_at IS NOT NULL AND withdrawn_at IS NULL AND group_id IS NULL;
CREATE INDEX announcements_group_board_idx ON public.announcements (group_id, sent_at DESC, id DESC)
  WHERE sent_at IS NOT NULL AND withdrawn_at IS NULL AND group_id IS NOT NULL;
-- The archive (drafts, scheduled and sent, newest first).
CREATE INDEX announcements_archive_idx ON public.announcements (club_id, created_at DESC, id DESC);
-- Scheduled announcements due (the worker, across clubs).
CREATE INDEX announcements_due_idx ON public.announcements (scheduled_at)
  WHERE sent_at IS NULL AND withdrawn_at IS NULL AND scheduled_at IS NOT NULL;
-- Announcement emails sent in a club lately (the per-club limit).
CREATE INDEX announcements_email_idx ON public.announcements (club_id, sent_at)
  WHERE email_count IS NOT NULL;
CREATE INDEX announcements_audience_idx ON public.announcements (audience_id);
CREATE INDEX announcements_created_by_idx ON public.announcements (created_by_person_id)
  WHERE created_by_person_id IS NOT NULL;
CREATE INDEX announcements_withdrawn_by_idx ON public.announcements (withdrawn_by_person_id)
  WHERE withdrawn_by_person_id IS NOT NULL;

-- Who read an announcement, and when.
CREATE TABLE public.announcement_reads (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  announcement_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  read_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT announcement_reads_announcement_fk FOREIGN KEY (club_id, announcement_id)
    REFERENCES public.announcements (club_id, id) ON DELETE CASCADE,
  CONSTRAINT announcement_reads_unique UNIQUE (announcement_id, person_id)
);
CREATE INDEX announcement_reads_person_idx ON public.announcement_reads (person_id);

-- An announcement's notices (the recipients endpoint counts their deliveries).
CREATE INDEX notifications_announcement_idx ON public.notifications (subject_id)
  WHERE subject_type = 'announcement';
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.announcements'), app.enable_updated_at('public.announcements'),
  history.enable_history('public.announcements');
-- Read marks (no history: IDs and times, written on every first read).
SELECT app.enable_tenant_rls('public.announcement_reads'), app.enable_updated_at('public.announcement_reads');
-- The worker finds scheduled announcements due, and an email's text, across clubs.
CREATE POLICY system_read ON public.announcements FOR SELECT USING (app.is_system());

ALTER TABLE public.notifications DROP CONSTRAINT notifications_category;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category CHECK (category IN (
  'schedule', 'responses', 'leader', 'events', 'membership', 'club_admin', 'family', 'account',
  'waitlist', 'chat', 'documents', 'announcements')) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_category;
--> statement-breakpoint

-- Whether a person reads an announcement: sent, not withdrawn, and its
-- audience includes them (or a ward whose link receives messages).
CREATE FUNCTION app.announcement_readable(p_announcement uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((
    SELECT a.sent_at IS NOT NULL AND a.withdrawn_at IS NULL
      AND app.audience_includes(a.audience_id, p_person)
    FROM public.announcements a WHERE a.id = p_announcement), false)
$$;
REVOKE ALL ON FUNCTION app.announcement_readable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.announcement_readable(uuid, uuid) TO clubadmin_app;

-- Whether the person read it: on the board, or its notice in the inbox.
CREATE FUNCTION app.announcement_read(p_announcement uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.announcement_reads r
                 WHERE r.announcement_id = p_announcement AND r.person_id = p_person)
    OR EXISTS (SELECT 1 FROM public.notifications n
               WHERE n.recipient_person_id = p_person
                 AND n.dedupe_key = 'announcement:' || p_announcement::text
                 AND n.read_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION app.announcement_read(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.announcement_read(uuid, uuid) TO clubadmin_app;

-- The people an audience given as entries would include (the composer's
-- preview, before anything is stored), as app.audience_people.
CREATE FUNCTION app.entries_people(p_club uuid, p_entries jsonb) RETURNS TABLE (person_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH e AS MATERIALIZED (
    SELECT x.kind, p_club AS club_id, x."groupId" AS group_id,
      coalesce(x."roleIds", '{}') AS role_ids, x."roleId" AS role_id
    FROM jsonb_to_recordset(p_entries) AS x(kind text, "groupId" uuid, "roleIds" uuid[], "roleId" uuid)),
  direct AS (
    SELECT m.person_id FROM e JOIN public.club_memberships m ON m.club_id = e.club_id
    WHERE e.kind = 'club' AND m.valid_to IS NULL AND m.status IN ('active', 'paused')
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm ON gm.club_id = e.club_id
    WHERE e.kind = 'club' AND gm.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm
      ON gm.group_id = e.group_id AND gm.club_id = e.club_id
    WHERE e.kind = 'group' AND gm.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm
      ON gm.group_id = e.group_id AND gm.club_id = e.club_id
    WHERE e.kind = 'group_roles' AND gm.valid_to IS NULL AND gm.role_id = ANY (e.role_ids)),
  roles AS (
    SELECT r.person_id FROM e JOIN public.club_role_assignments r
      ON r.club_id = e.club_id AND (e.kind = 'club' OR (e.kind = 'club_role' AND r.role_id = e.role_id))
    WHERE e.kind IN ('club', 'club_role') AND r.valid_to IS NULL)
  SELECT person_id FROM direct
  UNION
  SELECT g.guardian_person_id FROM direct JOIN public.guardianships g ON g.ward_person_id = direct.person_id
  WHERE g.status = 'active' AND g.valid_to IS NULL AND 'receive_messages' = ANY (g.rights)
  UNION
  SELECT person_id FROM roles
$$;
REVOKE ALL ON FUNCTION app.entries_people(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.entries_people(uuid, jsonb) TO clubadmin_app;

-- How many of an audience's people (given as entries) have an account with
-- an address and an active push device: the composer's counts per channel.
CREATE FUNCTION app.entries_reach(p_club uuid, p_entries jsonb)
  RETURNS TABLE (people integer, with_email integer, with_app integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH p AS MATERIALIZED (SELECT person_id FROM app.entries_people(p_club, p_entries))
  SELECT (SELECT count(*)::int FROM p),
    (SELECT count(*)::int FROM p JOIN public.accounts a ON a.person_id = p.person_id
     WHERE a.email_verified_at IS NOT NULL),
    (SELECT count(*)::int FROM p JOIN public.accounts a ON a.person_id = p.person_id
     WHERE EXISTS (SELECT 1 FROM public.push_devices d WHERE d.account_id = a.id AND d.disabled_at IS NULL))
$$;
REVOKE ALL ON FUNCTION app.entries_reach(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.entries_reach(uuid, jsonb) TO clubadmin_app;

-- "Anslagstavlan": the sent announcements of the caller's clubs and groups
-- (and their wards' whose link receives messages) that they read, not
-- expired; pinned ones (p_pinned) or the newest after the cursor. Club data
-- is read in each of the caller's clubs in turn (tenant RLS, app.club_id
-- set per club and restored), by the person's own entries and the board
-- indexes; never a scan of a club. At most p_limit per club (the caller
-- merges and cuts); each group and club gives at most three times that
-- before the audience check.
CREATE FUNCTION app.my_announcements(p_cursor uuid, p_limit integer, p_pinned boolean)
  RETURNS TABLE (announcement_id uuid, club_id uuid, club_name text, group_id uuid,
    group_name text, title text, body text, channels text[], important boolean,
    pinned_until timestamptz, expires_at timestamptz, sent_at timestamptz,
    edited_at timestamptz, created_by_person_id uuid, is_read boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := app.current_person_id();
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_clubs uuid[];
  v_club uuid;
  v_at timestamptz;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(array_agg(DISTINCT c), '{}') INTO v_clubs FROM (
    SELECT m.club_id AS c FROM public.club_memberships m
    WHERE m.person_id = ANY (app.self_and_wards()) AND m.valid_to IS NULL
      AND m.status IN ('active', 'paused')
    UNION SELECT gm.club_id FROM public.group_memberships gm
    WHERE gm.person_id = ANY (app.self_and_wards()) AND gm.valid_to IS NULL
    UNION SELECT r.club_id FROM public.club_role_assignments r
    WHERE r.person_id = v_me AND r.valid_to IS NULL) x;
  IF p_cursor IS NOT NULL AND NOT p_pinned THEN
    FOREACH v_club IN ARRAY v_clubs LOOP
      PERFORM set_config('app.club_id', v_club::text, true);
      SELECT a.sent_at, a.id INTO v_at, v_id FROM public.announcements a WHERE a.id = p_cursor;
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
    WITH who AS MATERIALIZED (
      SELECT v_me AS person_id
      UNION
      SELECT g.ward_person_id FROM public.guardianships g
      WHERE g.guardian_person_id = v_me AND g.status = 'active' AND g.valid_to IS NULL
        AND 'receive_messages' = ANY (g.rights)),
    my_groups AS MATERIALIZED (
      SELECT DISTINCT gm.group_id FROM public.group_memberships gm
      JOIN who ON who.person_id = gm.person_id
      WHERE gm.valid_to IS NULL AND gm.club_id = v_club),
    candidates AS (
      SELECT c.* FROM my_groups g CROSS JOIN LATERAL (
        SELECT a.id, a.sent_at, a.audience_id FROM public.announcements a
        WHERE a.group_id = g.group_id AND a.sent_at IS NOT NULL AND a.withdrawn_at IS NULL
          AND (a.expires_at IS NULL OR a.expires_at > now())
          AND (NOT p_pinned OR a.pinned_until > now())
          AND (v_id IS NULL OR (a.sent_at, a.id) < (v_at, v_id))
        ORDER BY a.sent_at DESC, a.id DESC LIMIT p_limit * 3) c
      UNION ALL
      (SELECT a.id, a.sent_at, a.audience_id FROM public.announcements a
       WHERE a.club_id = v_club AND a.group_id IS NULL AND a.sent_at IS NOT NULL
         AND a.withdrawn_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())
         AND (NOT p_pinned OR a.pinned_until > now())
         AND (v_id IS NULL OR (a.sent_at, a.id) < (v_at, v_id))
       ORDER BY a.sent_at DESC, a.id DESC LIMIT p_limit * 3)),
    pick AS (
      SELECT c.id, c.sent_at FROM candidates c
      WHERE app.audience_includes(c.audience_id, v_me)
      ORDER BY c.sent_at DESC, c.id DESC
      LIMIT p_limit)
    SELECT a.id, a.club_id, cl.name, a.group_id, g.name, a.title, a.body, a.channels,
      a.important, a.pinned_until, a.expires_at, a.sent_at, a.edited_at,
      a.created_by_person_id, app.announcement_read(a.id, v_me)
    FROM pick
    JOIN public.announcements a ON a.id = pick.id
    JOIN public.clubs cl ON cl.id = a.club_id
    LEFT JOIN public.groups g ON g.id = a.group_id;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_announcements(uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_announcements(uuid, integer, boolean) TO clubadmin_app;

-- The announcements' permissions in the template (the template of 0042 with
-- these rows), in every club type and every club: the club's announcements
-- for club managers, chairs, secretaries and communications, a group's for
-- its head coach, assistant coaches and team managers (owners through the
-- policies).
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
    ('vice_chair', 'club', 'club.members.read'),
    ('vice_chair', 'club', 'club.activities.read'),
    ('vice_chair', 'club', 'club.events.create'),
    ('treasurer', 'club', 'club.members.read'),
    ('treasurer', 'club', 'club.activities.read'),
    ('treasurer', 'club', 'club.events.create'),
    ('treasurer', 'club', 'billing.subscription.read'),
    ('treasurer', 'club', 'billing.account.manage'),
    ('treasurer', 'club', 'billing.invoices.read'),
    ('secretary', 'club', 'club.members.read'),
    ('secretary', 'club', 'club.activities.read'),
    ('secretary', 'club', 'club.events.create'),
    ('secretary', 'club', 'club.documents.manage'),
    ('secretary', 'club', 'club.announcements.send'),
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
WHERE t.permission IN ('club.announcements.send', 'group.announcements.send')
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
      WHERE t.permission IN ('club.announcements.send', 'group.announcements.send')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
