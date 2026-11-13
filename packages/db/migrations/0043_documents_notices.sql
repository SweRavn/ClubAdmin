-- P2.2 part B (ADR 0049 decisions 4b, 6, 8, 9): documents attached to the
-- notices of activities and events (being invited lets a person read them
-- while they are attached), "Mina dokument" (what is new in one's groups
-- and clubs, and when one last looked), the club's own storage limits (for
-- the club and per group), deletion dates, and push for a new document when
-- the uploader asks.

-- A document attached to an activity's or an event's notice.
CREATE TABLE public.notice_attachments (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  activity_id uuid,
  event_id uuid,
  document_id uuid NOT NULL,
  attached_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT notice_attachments_one_notice CHECK ((activity_id IS NULL) <> (event_id IS NULL)),
  CONSTRAINT notice_attachments_activity_fk FOREIGN KEY (club_id, activity_id)
    REFERENCES public.activities (club_id, id) ON DELETE CASCADE,
  CONSTRAINT notice_attachments_event_fk FOREIGN KEY (club_id, event_id)
    REFERENCES public.events (club_id, id) ON DELETE CASCADE,
  CONSTRAINT notice_attachments_document_fk FOREIGN KEY (club_id, document_id)
    REFERENCES public.documents (club_id, id)
);
CREATE UNIQUE INDEX notice_attachments_activity_unique ON public.notice_attachments (activity_id, document_id)
  WHERE activity_id IS NOT NULL;
CREATE UNIQUE INDEX notice_attachments_event_unique ON public.notice_attachments (event_id, document_id)
  WHERE event_id IS NOT NULL;
-- Who may read a document through its notices (app.document_readable).
CREATE INDEX notice_attachments_document_idx ON public.notice_attachments (document_id);
CREATE INDEX notice_attachments_attached_by_idx ON public.notice_attachments (attached_by_person_id)
  WHERE attached_by_person_id IS NOT NULL;

-- The club's own storage limits: the club's (group_id null) within the
-- operator's, and per group within the club's.
CREATE TABLE public.storage_quotas (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  group_id uuid,
  limit_bytes bigint NOT NULL CONSTRAINT storage_quotas_limit CHECK (limit_bytes > 0),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT storage_quotas_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id)
);
CREATE UNIQUE INDEX storage_quotas_unique ON public.storage_quotas
  (club_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX storage_quotas_group_idx ON public.storage_quotas (group_id) WHERE group_id IS NOT NULL;

-- When a person last looked at the documents of a club (group_id null) or a group.
CREATE TABLE public.document_views (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  person_id uuid NOT NULL REFERENCES public.people(id),
  group_id uuid,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT document_views_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id)
);
CREATE UNIQUE INDEX document_views_unique ON public.document_views
  (person_id, club_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX document_views_club_idx ON public.document_views (club_id);
CREATE INDEX document_views_group_idx ON public.document_views (group_id) WHERE group_id IS NOT NULL;

-- When a file's current version became visible ("Mina dokument" orders by
-- it), its deletion date, the notice a week before it, and whether the
-- uploader asked for push for a version.
ALTER TABLE public.documents
  ADD COLUMN published_at timestamptz,
  ADD COLUMN delete_after date,
  ADD COLUMN deletion_notice_sent_at timestamptz;
UPDATE public.documents d SET published_at = v.scanned_at
FROM public.document_versions v WHERE v.id = d.current_version_id AND d.published_at IS NULL;
ALTER TABLE public.document_versions ADD COLUMN notify boolean NOT NULL DEFAULT false;
-- "Mina dokument": a group's and a club's newest files.
CREATE INDEX documents_group_published_idx ON public.documents (group_id, published_at DESC, id DESC)
  WHERE deleted_at IS NULL AND published_at IS NOT NULL AND group_id IS NOT NULL;
CREATE INDEX documents_club_published_idx ON public.documents (club_id, published_at DESC, id DESC)
  WHERE deleted_at IS NULL AND published_at IS NOT NULL AND group_id IS NULL;
-- Deletion dates due (the worker's daily job).
CREATE INDEX documents_delete_after_idx ON public.documents (delete_after)
  WHERE delete_after IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.notice_attachments'), app.enable_updated_at('public.notice_attachments'),
  history.enable_history('public.notice_attachments');
SELECT app.enable_tenant_rls('public.storage_quotas'), app.enable_updated_at('public.storage_quotas'),
  history.enable_history('public.storage_quotas');
-- A bookmark per person (no history: rewritten on every visit; IDs and times only).
SELECT app.enable_tenant_rls('public.document_views'), app.enable_updated_at('public.document_views');
-- The worker finds deletion dates due across clubs.
CREATE POLICY system_read ON public.documents FOR SELECT USING (app.is_system());

ALTER TABLE public.notifications DROP CONSTRAINT notifications_category;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category CHECK (category IN (
  'schedule', 'responses', 'leader', 'events', 'membership', 'club_admin', 'family', 'account',
  'waitlist', 'chat', 'documents')) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_category;
--> statement-breakpoint

-- The people whose notices a document is attached to may read it while it
-- is attached: an activity's call-up (or, without one, its groups' members),
-- a published event's groups (or the whole club), and the guardians of
-- those whose link receives messages.
CREATE FUNCTION app.notice_reader(p_document uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH who AS MATERIALIZED (
    SELECT p_person AS person_id
    UNION
    SELECT g.ward_person_id FROM public.guardianships g
    WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL
      AND 'receive_messages' = ANY (g.rights)),
  na AS MATERIALIZED (
    SELECT n.activity_id, n.event_id FROM public.notice_attachments n WHERE n.document_id = p_document)
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
REVOKE ALL ON FUNCTION app.notice_reader(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_reader(uuid, uuid) TO clubadmin_app;

-- Whether a person reads a document: its audience, or a notice it is attached to.
CREATE FUNCTION app.document_readable(p_document uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.audience_includes(app.document_audience(p_document), p_person)
    OR app.notice_reader(p_document, p_person)
$$;
REVOKE ALL ON FUNCTION app.document_readable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.document_readable(uuid, uuid) TO clubadmin_app;

-- The people an audience includes (push for a new document), with the
-- guardians whose link receives messages; the public entry adds nobody.
CREATE FUNCTION app.audience_people(p_audience uuid) RETURNS TABLE (person_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH e AS MATERIALIZED (
    SELECT e.kind, e.club_id, e.group_id, e.role_ids, e.role_id
    FROM public.audience_entries e WHERE e.audience_id = p_audience),
  direct AS (
    SELECT m.person_id FROM e JOIN public.club_memberships m ON m.club_id = e.club_id
    WHERE e.kind = 'club' AND m.valid_to IS NULL AND m.status IN ('active', 'paused')
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm ON gm.club_id = e.club_id
    WHERE e.kind = 'club' AND gm.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm ON gm.group_id = e.group_id
    WHERE e.kind = 'group' AND gm.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm ON gm.group_id = e.group_id
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
REVOKE ALL ON FUNCTION app.audience_people(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audience_people(uuid) TO clubadmin_app;

-- "Mina dokument": the newest visible files of the caller's groups (and
-- their wards' whose link receives messages) and of their clubs, that they
-- read; keyset on (published_at, id) descending after the cursor document.
-- Club data is read in each of the caller's clubs in turn (tenant RLS,
-- app.club_id set per club and restored), by the person's own entries and
-- the published indexes; never a scan of a club. At most p_limit files per
-- club (the caller merges and cuts); each group and club gives at most
-- three times that before the audience check, so a page may hold fewer
-- files than asked.
CREATE FUNCTION app.my_documents(p_cursor uuid, p_limit integer)
  RETURNS TABLE (document_id uuid, club_id uuid, club_name text, group_id uuid, group_name text,
    folder_id uuid, name text, kind text, own_audience boolean, published_at timestamptz,
    updated_at timestamptz, delete_after date, current_version jsonb, is_new boolean)
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
  IF p_cursor IS NOT NULL THEN
    FOREACH v_club IN ARRAY v_clubs LOOP
      PERFORM set_config('app.club_id', v_club::text, true);
      SELECT d.published_at, d.id INTO v_at, v_id FROM public.documents d WHERE d.id = p_cursor;
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
        SELECT d.id, d.published_at FROM public.documents d
        WHERE d.group_id = g.group_id AND d.deleted_at IS NULL AND d.published_at IS NOT NULL
          AND (v_id IS NULL OR (d.published_at, d.id) < (v_at, v_id))
        ORDER BY d.published_at DESC, d.id DESC LIMIT p_limit * 3) c
      UNION ALL
      (SELECT d.id, d.published_at FROM public.documents d
       WHERE d.club_id = v_club AND d.group_id IS NULL AND d.deleted_at IS NULL
         AND d.published_at IS NOT NULL
         AND (v_id IS NULL OR (d.published_at, d.id) < (v_at, v_id))
       ORDER BY d.published_at DESC, d.id DESC LIMIT p_limit * 3)),
    pick AS (
      SELECT c.id, c.published_at FROM candidates c
      WHERE app.document_readable(c.id, v_me)
      ORDER BY c.published_at DESC, c.id DESC
      LIMIT p_limit)
    SELECT d.id, d.club_id, cl.name, d.group_id, g.name, d.folder_id, d.name, d.kind,
      d.audience_id IS NOT NULL, d.published_at, d.updated_at, d.delete_after,
      jsonb_build_object('id', v.id, 'document_id', v.document_id, 'number', v.number,
        'object_key', v.object_key, 'file_name', v.file_name, 'size', v.size::text,
        'content_type', v.content_type, 'sha256', v.sha256, 'status', v.status,
        'uploaded_by_person_id', v.uploaded_by_person_id, 'uploaded_at', v.uploaded_at::text,
        'created_at', v.created_at::text),
      d.published_at > coalesce((
        SELECT w.last_seen_at FROM public.document_views w
        WHERE w.person_id = v_me AND w.club_id = d.club_id
          AND w.group_id IS NOT DISTINCT FROM d.group_id), '-infinity')
    FROM pick
    JOIN public.documents d ON d.id = pick.id
    JOIN public.clubs cl ON cl.id = d.club_id
    LEFT JOIN public.groups g ON g.id = d.group_id
    JOIN public.document_versions v ON v.id = d.current_version_id;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_documents(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_documents(uuid, integer) TO clubadmin_app;

-- Marks the caller's documents of a club (group null) or a group as seen.
CREATE FUNCTION app.mark_documents_seen(p_club uuid, p_group uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO public.document_views (club_id, person_id, group_id, last_seen_at)
  SELECT p_club, app.current_person_id(), p_group, now()
  WHERE app.current_person_id() IS NOT NULL
  ON CONFLICT (person_id, club_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now()
$$;
REVOKE ALL ON FUNCTION app.mark_documents_seen(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_documents_seen(uuid, uuid) TO clubadmin_app;

-- The caller's own bookmarks are readable outside a club (Mina dokument).
CREATE POLICY own_read ON public.document_views FOR SELECT
  USING (person_id = app.current_person_id());

-- Public documents of a club (its public pages, Phase 3): files whose
-- audience (their own or their folder's, inherited down the folders)
-- includes `public`.
CREATE FUNCTION app.public_documents(p_club uuid) RETURNS TABLE (document_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE tree AS (
    SELECT f.id, f.audience_id AS effective, 0 AS depth FROM public.document_folders f
    WHERE f.club_id = p_club AND f.parent_id IS NULL AND f.deleted_at IS NULL
    UNION ALL
    SELECT f.id, coalesce(f.audience_id, tree.effective), tree.depth + 1
    FROM tree JOIN public.document_folders f ON f.parent_id = tree.id AND f.deleted_at IS NULL
    WHERE tree.depth < 20),
  public_audiences AS (
    SELECT DISTINCT e.audience_id FROM public.audience_entries e
    WHERE e.club_id = p_club AND e.kind = 'public')
  SELECT d.id FROM tree
  JOIN public.documents d ON d.folder_id = tree.id AND d.deleted_at IS NULL
    AND d.current_version_id IS NOT NULL
  WHERE coalesce(d.audience_id, tree.effective) IN (SELECT audience_id FROM public_audiences)
$$;
REVOKE ALL ON FUNCTION app.public_documents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.public_documents(uuid) TO clubadmin_app;
CREATE INDEX audience_entries_public_idx ON public.audience_entries (club_id) WHERE kind = 'public';
