-- P2.4 part A (ADR 0049 decisions 1B, 3–5; ADR 0037): governing documents.
-- A series (statutes, annual meeting minutes, board minutes, policies, the
-- club's own) is a top-level folder of the purpose `series`, so audiences,
-- "Mina dokument" and the archive work unchanged. Its documents are of the
-- kind `governing`: Markdown versions (no stored object) that are drafted,
-- adopted (date, meeting, effective date; the version is then locked),
-- superseded by another document or archived, never deleted. Settings the
-- adopted text marks become board decisions (club_setting_decisions) that
-- point at the version.

-- Series folders: top level, with a kind.
ALTER TABLE public.document_folders DROP CONSTRAINT document_folders_purpose;
ALTER TABLE public.document_folders ADD CONSTRAINT document_folders_purpose
  CHECK (purpose IN ('files', 'notices', 'series')) NOT VALID;
ALTER TABLE public.document_folders VALIDATE CONSTRAINT document_folders_purpose;
ALTER TABLE public.document_folders ADD COLUMN series_kind text
  CONSTRAINT document_folders_series_kind
    CHECK (series_kind IN ('statutes', 'annual_meeting_minutes', 'board_minutes', 'policies', 'other'));
ALTER TABLE public.document_folders ADD CONSTRAINT document_folders_series_shape
  CHECK ((purpose = 'series') = (series_kind IS NOT NULL) AND (purpose <> 'series' OR parent_id IS NULL)) NOT VALID;
ALTER TABLE public.document_folders VALIDATE CONSTRAINT document_folders_series_shape;

-- Governing documents: their status and what superseded them.
ALTER TABLE public.documents ADD COLUMN governing_status text
  CONSTRAINT documents_governing_status
    CHECK (governing_status IN ('draft', 'adopted', 'superseded', 'archived'));
ALTER TABLE public.documents ADD COLUMN superseded_by_document_id uuid;
ALTER TABLE public.documents ADD CONSTRAINT documents_superseded_by_fk
  FOREIGN KEY (club_id, superseded_by_document_id) REFERENCES public.documents (club_id, id) NOT VALID;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_superseded_by_fk;
ALTER TABLE public.documents ADD CONSTRAINT documents_governing_shape
  CHECK ((kind = 'governing') = (governing_status IS NOT NULL)
    AND (superseded_by_document_id IS NULL OR governing_status IN ('superseded', 'archived'))) NOT VALID;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_governing_shape;
CREATE INDEX documents_superseded_by_idx ON public.documents (superseded_by_document_id)
  WHERE superseded_by_document_id IS NOT NULL;

-- Versions: a Markdown body instead of a stored object (file name, size,
-- type and hash describe the text), and the adoption of the version.
ALTER TABLE public.document_versions ALTER COLUMN object_key DROP NOT NULL;
ALTER TABLE public.document_versions ADD COLUMN body text
  CONSTRAINT document_versions_body CHECK (char_length(body) <= 200000);
ALTER TABLE public.document_versions DROP CONSTRAINT document_versions_size;
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_size
  CHECK (size > 0 OR body IS NOT NULL) NOT VALID;
ALTER TABLE public.document_versions VALIDATE CONSTRAINT document_versions_size;
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_content
  CHECK ((body IS NULL) = (object_key IS NOT NULL)) NOT VALID;
ALTER TABLE public.document_versions VALIDATE CONSTRAINT document_versions_content;
-- The meeting's date, when it applies, the meeting (an activity or an
-- event, or none), and who recorded it when.
ALTER TABLE public.document_versions ADD COLUMN adopted_on date;
ALTER TABLE public.document_versions ADD COLUMN effective_from date;
ALTER TABLE public.document_versions ADD COLUMN adopted_activity_id uuid;
ALTER TABLE public.document_versions ADD COLUMN adopted_event_id uuid;
ALTER TABLE public.document_versions ADD COLUMN adopted_by_person_id uuid REFERENCES public.people(id);
ALTER TABLE public.document_versions ADD COLUMN adopted_at timestamptz;
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_adopted_activity_fk
  FOREIGN KEY (club_id, adopted_activity_id) REFERENCES public.activities (club_id, id) NOT VALID;
ALTER TABLE public.document_versions VALIDATE CONSTRAINT document_versions_adopted_activity_fk;
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_adopted_event_fk
  FOREIGN KEY (club_id, adopted_event_id) REFERENCES public.events (club_id, id) NOT VALID;
ALTER TABLE public.document_versions VALIDATE CONSTRAINT document_versions_adopted_event_fk;
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_adoption
  CHECK ((adopted_on IS NULL) = (adopted_at IS NULL)
    AND (adopted_on IS NULL) = (effective_from IS NULL)
    AND (effective_from IS NULL OR effective_from >= adopted_on)
    AND (adopted_activity_id IS NULL OR adopted_event_id IS NULL)
    AND (adopted_on IS NOT NULL OR (adopted_activity_id IS NULL AND adopted_event_id IS NULL))
    AND (adopted_on IS NULL OR body IS NOT NULL)) NOT VALID;
ALTER TABLE public.document_versions VALIDATE CONSTRAINT document_versions_adoption;
CREATE INDEX document_versions_adopted_activity_idx ON public.document_versions (adopted_activity_id)
  WHERE adopted_activity_id IS NOT NULL;
CREATE INDEX document_versions_adopted_event_idx ON public.document_versions (adopted_event_id)
  WHERE adopted_event_id IS NOT NULL;
CREATE INDEX document_versions_adopted_by_idx ON public.document_versions (adopted_by_person_id)
  WHERE adopted_by_person_id IS NOT NULL;

-- Board decisions written by adopting a governing document (ADR 0037).
ALTER TABLE public.club_setting_decisions ADD COLUMN document_version_id uuid;
ALTER TABLE public.club_setting_decisions ADD CONSTRAINT club_setting_decisions_document_version_fk
  FOREIGN KEY (club_id, document_version_id) REFERENCES public.document_versions (club_id, id) NOT VALID;
ALTER TABLE public.club_setting_decisions VALIDATE CONSTRAINT club_setting_decisions_document_version_fk;
CREATE INDEX club_setting_decisions_document_version_idx
  ON public.club_setting_decisions (document_version_id) WHERE document_version_id IS NOT NULL;
--> statement-breakpoint

-- An adopted version is locked: its text and adoption never change (a
-- change is a new version, adopted again). Erasure leaves it too (ADR 0049
-- decision 7); only the person columns may be cleared.
CREATE FUNCTION app.lock_adopted_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.adopted_on IS NOT NULL AND (
    NEW.body IS DISTINCT FROM OLD.body
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.adopted_on IS DISTINCT FROM OLD.adopted_on
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.adopted_activity_id IS DISTINCT FROM OLD.adopted_activity_id
    OR NEW.adopted_event_id IS DISTINCT FROM OLD.adopted_event_id
    OR NEW.adopted_at IS DISTINCT FROM OLD.adopted_at) THEN
    RAISE EXCEPTION 'document version % is adopted and locked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_versions_lock_adopted BEFORE UPDATE ON public.document_versions
  FOR EACH ROW WHEN (OLD.adopted_on IS NOT NULL) EXECUTE FUNCTION app.lock_adopted_version();
--> statement-breakpoint

-- The governing documents' permissions in the template (the template of
-- 0044 with these rows), in every club type and every club: drafting and
-- adopting for chairs and secretaries.
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
WHERE t.permission IN ('club.governing_documents.manage', 'club.governing_documents.adopt')
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
      WHERE t.permission IN ('club.governing_documents.manage', 'club.governing_documents.adopt')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
