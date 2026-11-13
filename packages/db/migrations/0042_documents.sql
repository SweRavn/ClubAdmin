-- P2.2 part A (ADR 0049 decisions 1A, 2, 6–8): the file archive. Folders at
-- club or group level (subfolders inherit their parent's audience unless they
-- have their own), files with every version kept, and audiences: lists of
-- entries (the whole club with its members' guardians, a group optionally
-- limited to some of its roles, a club role, public) shared with
-- announcements (P2.3). A version is visible only after a clean scan
-- (ClamAV, the worker). Deleted folders and files keep their rows (history,
-- audit); the worker deletes their objects.

CREATE TABLE public.audiences (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT audiences_club_id_unique UNIQUE (club_id, id)
);

CREATE TABLE public.audience_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  audience_id uuid NOT NULL,
  kind text NOT NULL CONSTRAINT audience_entries_kind
    CHECK (kind IN ('club', 'group', 'group_roles', 'club_role', 'public')),
  group_id uuid,
  -- group_roles: the group roles whose holders are included (roles of scope group).
  role_ids uuid[],
  -- club_role: the club role whose holders are included.
  role_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT audience_entries_audience_fk FOREIGN KEY (club_id, audience_id)
    REFERENCES public.audiences (club_id, id),
  CONSTRAINT audience_entries_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id),
  CONSTRAINT audience_entries_role_fk FOREIGN KEY (club_id, role_id) REFERENCES public.roles (club_id, id),
  CONSTRAINT audience_entries_shape CHECK (
    (kind IN ('club', 'public') AND group_id IS NULL AND role_ids IS NULL AND role_id IS NULL)
    OR (kind = 'group' AND group_id IS NOT NULL AND role_ids IS NULL AND role_id IS NULL)
    OR (kind = 'group_roles' AND group_id IS NOT NULL AND cardinality(role_ids) BETWEEN 1 AND 20
        AND role_id IS NULL)
    OR (kind = 'club_role' AND role_id IS NOT NULL AND group_id IS NULL AND role_ids IS NULL))
);
CREATE INDEX audience_entries_audience_idx ON public.audience_entries (audience_id);
CREATE INDEX audience_entries_group_idx ON public.audience_entries (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX audience_entries_role_idx ON public.audience_entries (role_id) WHERE role_id IS NOT NULL;

CREATE TABLE public.document_folders (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  -- The group whose folder it is (none: the club's); a subfolder has its parent's.
  group_id uuid,
  parent_id uuid,
  name text NOT NULL CONSTRAINT document_folders_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  -- None: the parent's audience (a top-level folder always has one).
  audience_id uuid,
  -- `notices`: the folder for files uploaded to notices (P2.2 part B).
  purpose text NOT NULL DEFAULT 'files' CONSTRAINT document_folders_purpose CHECK (purpose IN ('files', 'notices')),
  created_by_person_id uuid REFERENCES public.people(id),
  deleted_at timestamptz,
  deleted_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT document_folders_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT document_folders_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id),
  CONSTRAINT document_folders_parent_fk FOREIGN KEY (club_id, parent_id) REFERENCES public.document_folders (club_id, id),
  CONSTRAINT document_folders_audience_fk FOREIGN KEY (club_id, audience_id) REFERENCES public.audiences (club_id, id),
  CONSTRAINT document_folders_root_audience CHECK (parent_id IS NOT NULL OR audience_id IS NOT NULL)
);
-- The top-level folders of the club or a group, and a folder's subfolders, by name.
CREATE INDEX document_folders_root_idx ON public.document_folders (club_id, group_id, name, id)
  WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE INDEX document_folders_parent_idx ON public.document_folders (parent_id, name, id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX document_folders_name_unique ON public.document_folders
  (club_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX document_folders_group_idx ON public.document_folders (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX document_folders_audience_idx ON public.document_folders (audience_id) WHERE audience_id IS NOT NULL;
CREATE INDEX document_folders_created_by_idx ON public.document_folders (created_by_person_id)
  WHERE created_by_person_id IS NOT NULL;
CREATE INDEX document_folders_deleted_by_idx ON public.document_folders (deleted_by_person_id)
  WHERE deleted_by_person_id IS NOT NULL;

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  folder_id uuid NOT NULL,
  -- The folder's group (none: the club's), kept for storage use per group.
  group_id uuid,
  kind text NOT NULL DEFAULT 'file' CONSTRAINT documents_kind CHECK (kind IN ('file', 'governing')),
  name text NOT NULL CONSTRAINT documents_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  -- None: the folder's audience.
  audience_id uuid,
  -- The latest clean version (none until the first scan is clean).
  current_version_id uuid,
  created_by_person_id uuid REFERENCES public.people(id),
  deleted_at timestamptz,
  deleted_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT documents_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT documents_folder_fk FOREIGN KEY (club_id, folder_id) REFERENCES public.document_folders (club_id, id),
  CONSTRAINT documents_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id),
  CONSTRAINT documents_audience_fk FOREIGN KEY (club_id, audience_id) REFERENCES public.audiences (club_id, id)
);
-- A folder's files by name (keyset on name and ID).
CREATE INDEX documents_folder_idx ON public.documents (folder_id, name, id) WHERE deleted_at IS NULL;
CREATE INDEX documents_group_idx ON public.documents (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX documents_audience_idx ON public.documents (audience_id) WHERE audience_id IS NOT NULL;
CREATE INDEX documents_created_by_idx ON public.documents (created_by_person_id)
  WHERE created_by_person_id IS NOT NULL;
CREATE INDEX documents_deleted_by_idx ON public.documents (deleted_by_person_id)
  WHERE deleted_by_person_id IS NOT NULL;

CREATE TABLE public.document_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  document_id uuid NOT NULL,
  group_id uuid,
  number integer NOT NULL CONSTRAINT document_versions_number CHECK (number >= 1),
  -- documents/<club_id>/<document_id>/<version_id> in the files bucket.
  object_key text NOT NULL,
  file_name text NOT NULL CONSTRAINT document_versions_file_name CHECK (char_length(file_name) BETWEEN 1 AND 200),
  size bigint NOT NULL CONSTRAINT document_versions_size CHECK (size > 0),
  content_type text NOT NULL,
  sha256 text,
  -- uploading (link issued) → pending (uploaded, being scanned) → clean |
  -- infected | failed (missing, or not what it said it was).
  status text NOT NULL DEFAULT 'uploading' CONSTRAINT document_versions_status
    CHECK (status IN ('uploading', 'pending', 'clean', 'infected', 'failed')),
  uploaded_by_person_id uuid REFERENCES public.people(id),
  uploaded_at timestamptz,
  scanned_at timestamptz,
  -- The object was deleted (the file or folder was deleted, or the scan refused it).
  object_deleted_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT document_versions_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT document_versions_document_fk FOREIGN KEY (club_id, document_id) REFERENCES public.documents (club_id, id),
  CONSTRAINT document_versions_number_unique UNIQUE (document_id, number),
  CONSTRAINT document_versions_object_key_unique UNIQUE (object_key)
);
-- Storage use of the club and of each group: the stored objects' sizes.
CREATE INDEX document_versions_usage_idx ON public.document_versions (club_id, group_id) INCLUDE (size)
  WHERE object_deleted_at IS NULL;
-- Uploads never finished (the worker's cleanup).
CREATE INDEX document_versions_uploading_idx ON public.document_versions (created_at)
  WHERE status = 'uploading';
CREATE INDEX document_versions_uploaded_by_idx ON public.document_versions (uploaded_by_person_id)
  WHERE uploaded_by_person_id IS NOT NULL;

ALTER TABLE public.documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (club_id, current_version_id) REFERENCES public.document_versions (club_id, id);
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.audiences'), app.enable_updated_at('public.audiences'),
  history.enable_history('public.audiences');
SELECT app.enable_tenant_rls('public.audience_entries'), app.enable_updated_at('public.audience_entries'),
  history.enable_history('public.audience_entries');
SELECT app.enable_tenant_rls('public.document_folders'), app.enable_updated_at('public.document_folders'),
  history.enable_history('public.document_folders');
SELECT app.enable_tenant_rls('public.documents'), app.enable_updated_at('public.documents'),
  history.enable_history('public.documents');
SELECT app.enable_tenant_rls('public.document_versions'), app.enable_updated_at('public.document_versions'),
  history.enable_history('public.document_versions');
-- The worker finds abandoned uploads across clubs (documents:cleanup).
CREATE POLICY system_read ON public.document_versions FOR SELECT USING (app.is_system());
--> statement-breakpoint

-- Whether an audience includes a person: their own membership, group role
-- or club role, or as a guardian of someone the club or group entries
-- include (ADR 0049 decision 2: "members and their guardians"; guardians
-- whose link receives messages: parents and legal guardians always, others
-- when given that right). A group entry is the group's own members (not its
-- child groups'). By the person's own index entries; never a scan of the club.
CREATE FUNCTION app.audience_includes(p_audience uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH who AS MATERIALIZED (
    SELECT p_person AS person_id
    UNION
    SELECT g.ward_person_id FROM public.guardianships g
    WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL
      AND 'receive_messages' = ANY (g.rights)),
  e AS MATERIALIZED (
    SELECT e.kind, e.club_id, e.group_id, e.role_ids, e.role_id
    FROM public.audience_entries e WHERE e.audience_id = p_audience)
  SELECT p_person IS NOT NULL AND EXISTS (
    SELECT 1 FROM e
    WHERE e.kind = 'public'
      OR (e.kind = 'club' AND (
        EXISTS (SELECT 1 FROM public.club_memberships m JOIN who ON who.person_id = m.person_id
                WHERE m.club_id = e.club_id AND m.valid_to IS NULL AND m.status IN ('active', 'paused'))
        OR EXISTS (SELECT 1 FROM public.group_memberships gm JOIN who ON who.person_id = gm.person_id
                   WHERE gm.club_id = e.club_id AND gm.valid_to IS NULL)
        OR EXISTS (SELECT 1 FROM public.club_role_assignments r
                   WHERE r.person_id = p_person AND r.club_id = e.club_id AND r.valid_to IS NULL)))
      OR (e.kind = 'group' AND EXISTS (
        SELECT 1 FROM public.group_memberships gm JOIN who ON who.person_id = gm.person_id
        WHERE gm.group_id = e.group_id AND gm.valid_to IS NULL))
      OR (e.kind = 'group_roles' AND EXISTS (
        SELECT 1 FROM public.group_memberships gm JOIN who ON who.person_id = gm.person_id
        WHERE gm.group_id = e.group_id AND gm.valid_to IS NULL AND gm.role_id = ANY (e.role_ids)))
      OR (e.kind = 'club_role' AND EXISTS (
        SELECT 1 FROM public.club_role_assignments r
        WHERE r.person_id = p_person AND r.role_id = e.role_id AND r.valid_to IS NULL)))
$$;
REVOKE ALL ON FUNCTION app.audience_includes(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audience_includes(uuid, uuid) TO clubadmin_app;

-- The audience that applies to a folder: its own, or the nearest ancestor's.
CREATE FUNCTION app.folder_audience(p_folder uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT f.parent_id, f.audience_id, 0 AS depth FROM public.document_folders f WHERE f.id = p_folder
    UNION ALL
    SELECT f.parent_id, f.audience_id, up.depth + 1
    FROM up JOIN public.document_folders f ON f.id = up.parent_id
    WHERE up.audience_id IS NULL AND up.depth < 20)
  SELECT up.audience_id FROM up WHERE up.audience_id IS NOT NULL ORDER BY up.depth LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.folder_audience(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.folder_audience(uuid) TO clubadmin_app;

-- A document's audience: its own, or its folder's.
CREATE FUNCTION app.document_audience(p_document uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(d.audience_id, app.folder_audience(d.folder_id))
  FROM public.documents d WHERE d.id = p_document
$$;
REVOKE ALL ON FUNCTION app.document_audience(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.document_audience(uuid) TO clubadmin_app;

-- Whether an audience is narrower than the club (downloads are then audited).
CREATE FUNCTION app.audience_is_narrow(p_audience uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.audience_entries e
    WHERE e.audience_id = p_audience AND e.kind IN ('club', 'public'))
$$;
REVOKE ALL ON FUNCTION app.audience_is_narrow(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audience_is_narrow(uuid) TO clubadmin_app;
--> statement-breakpoint

-- The file archive's permissions in the template (the template of 0040 with
-- these rows), in every club type and every club: the club's documents for
-- club managers and secretaries, a group's for its head coach, assistant
-- coaches and team managers (owners through the policies).
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
    ('secretary', 'club', 'club.documents.manage'),
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
    ('head_coach', 'group', 'group.documents.manage'),
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.channels.create'),
    ('assistant_coach', 'group', 'group.documents.manage'),
    ('team_manager', 'group', 'group.lead'),
    ('team_manager', 'group', 'group.people.details'),
    ('team_manager', 'group', 'person.consents.read'),
    ('team_manager', 'group', 'group.consents.read'),
    ('team_manager', 'group', 'group.activities.manage'),
    ('team_manager', 'group', 'activity.responses.read'),
    ('team_manager', 'group', 'group.channels.create'),
    ('team_manager', 'group', 'group.documents.manage'),
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
WHERE t.permission IN ('club.documents.manage', 'group.documents.manage')
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
      WHERE t.permission IN ('club.documents.manage', 'group.documents.manage')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
