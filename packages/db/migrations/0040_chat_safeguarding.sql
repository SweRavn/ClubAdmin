-- P2.1 part B (ADR 0047 rules 7 and 11): child safety in chat. Reports from
-- a chat (one tap: a reason, optionally the message), the club's
-- safeguarding cases with the two-person rule for reading a reported chat
-- (a second safeguarding officer confirms; every read is an audit event), and
-- mutes (a member may not write in the club's chats for a time). The
-- reported person never learns who reported. Notes are redacted in history
-- views: the rows are the record.

CREATE TABLE public.chat_reports (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  chat_id uuid NOT NULL,
  -- The reported message (none: the whole chat).
  message_id uuid REFERENCES public.chat_messages(id),
  reporter_person_id uuid NOT NULL REFERENCES public.people(id),
  -- The sender of the reported message, when one was reported.
  reported_person_id uuid REFERENCES public.people(id),
  reason text NOT NULL CONSTRAINT chat_reports_reason
    CHECK (reason IN ('bullying', 'inappropriate', 'unsafe_contact', 'self_harm', 'other')),
  note text CONSTRAINT chat_reports_note_length CHECK (char_length(note) <= 1000),
  status text NOT NULL DEFAULT 'open' CONSTRAINT chat_reports_status CHECK (status IN ('open', 'closed')),
  outcome text CONSTRAINT chat_reports_outcome
    CHECK (outcome IN ('no_action', 'message_hidden', 'member_muted', 'referred')),
  outcome_note text CONSTRAINT chat_reports_outcome_note_length CHECK (char_length(outcome_note) <= 1000),
  closed_by_person_id uuid REFERENCES public.people(id),
  closed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_reports_chat_fk FOREIGN KEY (club_id, chat_id) REFERENCES public.chats (club_id, id),
  CONSTRAINT chat_reports_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL AND outcome IS NOT NULL))
);
-- The club's cases, newest first, open or closed (keyset on the ID).
CREATE INDEX chat_reports_club_idx ON public.chat_reports (club_id, status, id DESC);
CREATE INDEX chat_reports_chat_idx ON public.chat_reports (chat_id);
CREATE INDEX chat_reports_message_idx ON public.chat_reports (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX chat_reports_reporter_idx ON public.chat_reports (reporter_person_id);
CREATE INDEX chat_reports_reported_idx ON public.chat_reports (reported_person_id)
  WHERE reported_person_id IS NOT NULL;
CREATE INDEX chat_reports_closed_by_idx ON public.chat_reports (closed_by_person_id)
  WHERE closed_by_person_id IS NOT NULL;

-- Reading a reported chat: one safeguarding officer asks, another confirms
-- (never the same person); then both may read until expires_at.
CREATE TABLE public.chat_report_reads (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  report_id uuid NOT NULL REFERENCES public.chat_reports(id),
  requested_by_person_id uuid NOT NULL REFERENCES public.people(id),
  confirmed_by_person_id uuid REFERENCES public.people(id),
  confirmed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_report_reads_two_people CHECK (confirmed_by_person_id <> requested_by_person_id),
  CONSTRAINT chat_report_reads_confirmed
    CHECK ((confirmed_by_person_id IS NULL) = (confirmed_at IS NULL) AND (confirmed_at IS NULL) = (expires_at IS NULL))
);
CREATE INDEX chat_report_reads_report_idx ON public.chat_report_reads (report_id, id);
CREATE INDEX chat_report_reads_requested_by_idx ON public.chat_report_reads (requested_by_person_id);
CREATE INDEX chat_report_reads_confirmed_by_idx ON public.chat_report_reads (confirmed_by_person_id)
  WHERE confirmed_by_person_id IS NOT NULL;

-- A member who may not write in the club's chats until `until` (or lifted).
CREATE TABLE public.chat_mutes (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  person_id uuid NOT NULL REFERENCES public.people(id),
  muted_by_person_id uuid NOT NULL REFERENCES public.people(id),
  report_id uuid REFERENCES public.chat_reports(id),
  until timestamptz NOT NULL,
  lifted_at timestamptz,
  lifted_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
-- Is this person muted in this club (each write checks it)?
CREATE INDEX chat_mutes_person_idx ON public.chat_mutes (person_id, club_id, until) WHERE lifted_at IS NULL;
CREATE INDEX chat_mutes_club_idx ON public.chat_mutes (club_id, until) WHERE lifted_at IS NULL;
CREATE INDEX chat_mutes_muted_by_idx ON public.chat_mutes (muted_by_person_id);
CREATE INDEX chat_mutes_lifted_by_idx ON public.chat_mutes (lifted_by_person_id)
  WHERE lifted_by_person_id IS NOT NULL;
CREATE INDEX chat_mutes_report_idx ON public.chat_mutes (report_id) WHERE report_id IS NOT NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.chat_reports'), app.enable_updated_at('public.chat_reports'),
  history.enable_history('public.chat_reports', redact => ARRAY['note', 'outcome_note']);
SELECT app.enable_tenant_rls('public.chat_report_reads'), app.enable_updated_at('public.chat_report_reads'),
  history.enable_history('public.chat_report_reads');
SELECT app.enable_tenant_rls('public.chat_mutes'), app.enable_updated_at('public.chat_mutes'),
  history.enable_history('public.chat_mutes');
--> statement-breakpoint

-- The safeguarding officer's template role gets the permission (the
-- template of 0037 with that row), in every club type and every club.
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
    ('board_member', 'club', 'club.members.read'),
    ('board_member', 'club', 'club.activities.read'),
    ('board_member', 'club', 'club.events.create'),
    ('deputy_board_member', 'club', 'club.members.read'),
    ('deputy_board_member', 'club', 'club.activities.read'),
    ('deputy_board_member', 'club', 'club.events.create'),
    ('auditor', 'club', NULL),
    ('nomination_committee', 'club', NULL),
    ('safeguarding_officer', 'club', 'club.safeguarding.handle'),
    ('communications', 'club', NULL),
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
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.channels.create'),
    ('team_manager', 'group', 'group.lead'),
    ('team_manager', 'group', 'group.people.details'),
    ('team_manager', 'group', 'person.consents.read'),
    ('team_manager', 'group', 'group.consents.read'),
    ('team_manager', 'group', 'group.activities.manage'),
    ('team_manager', 'group', 'activity.responses.read'),
    ('team_manager', 'group', 'group.channels.create'),
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
WHERE t.permission = 'club.safeguarding.handle'
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
      WHERE t.permission = 'club.safeguarding.handle'
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
