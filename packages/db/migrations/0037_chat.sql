-- Chat (P2.1, ADR 0016, ADR 0047): channels in groups and the club, direct
-- messages, messages with every edit kept, reactions and read receipts.
--
-- - A chat belongs to one club. Its members are its own list (chat_members)
--   with the reason they are in it; the groups it was made for are its
--   context (chat_groups), so chats across groups need no new model.
-- - Messages are partitioned by month on their ID (UUIDv7 starts with the
--   time), so a message's partition follows from its ID alone and
--   references to it need no second column. app.ensure_chat_message_partitions
--   keeps the coming months ready (the worker runs it daily).
-- - Nothing disappears (ADR 0047): a message its sender deletes is hidden,
--   an edit keeps the earlier text in chat_message_versions. Bodies are
--   redacted in record history: the versions table is the record.
-- - Read receipts and the chats' latest message are bookkeeping: their
--   updates write no record history.

CREATE TABLE public.chats (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  kind text NOT NULL CONSTRAINT chats_kind CHECK (kind IN ('channel', 'direct')),
  name text CONSTRAINT chats_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  description text CONSTRAINT chats_description_length CHECK (char_length(description) <= 500),
  -- Open: the people of its groups see it and may join; closed: only those added.
  visibility text CONSTRAINT chats_visibility CHECK (visibility IN ('open', 'closed')),
  -- The group's default channel (everyone in the group), at most one per group.
  default_for_group_id uuid REFERENCES public.groups(id),
  created_by_person_id uuid REFERENCES public.people(id),
  archived_at timestamptz,
  archived_by_person_id uuid REFERENCES public.people(id),
  -- Children are active members (app.chat_enforce_guardians keeps it; push
  -- shows no text, guardians may join).
  has_children boolean NOT NULL DEFAULT false,
  -- The latest message (Mina kanaler's order and preview).
  last_message_id uuid,
  last_message_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chats_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT chats_channel_fields CHECK (
    kind = 'direct' OR (name IS NOT NULL AND visibility IS NOT NULL)),
  CONSTRAINT chats_direct_fields CHECK (
    kind = 'channel' OR (visibility IS NULL AND default_for_group_id IS NULL))
);
CREATE UNIQUE INDEX chats_default_for_group_unique ON public.chats (default_for_group_id)
  WHERE default_for_group_id IS NOT NULL;
CREATE INDEX chats_club_idx ON public.chats (club_id, last_message_at DESC);
CREATE INDEX chats_created_by_idx ON public.chats (created_by_person_id);
CREATE INDEX chats_archived_by_idx ON public.chats (archived_by_person_id)
  WHERE archived_by_person_id IS NOT NULL;

-- The groups a chat was made for (none for direct messages and club channels).
CREATE TABLE public.chat_groups (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.groups(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_groups_chat_fk FOREIGN KEY (club_id, chat_id)
    REFERENCES public.chats (club_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_groups_unique UNIQUE (chat_id, group_id)
);
-- A group's channels (the group page).
CREATE INDEX chat_groups_group_idx ON public.chat_groups (group_id, chat_id);

CREATE TABLE public.chat_members (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  -- active: in the chat; offered: a protected person who has not accepted yet
  -- (ADR 0022); left: left or removed (the row keeps the history).
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT chat_members_status CHECK (status IN ('active', 'offered', 'left')),
  -- Why the person is in it (shown to everyone in the chat, ADR 0047).
  reason text NOT NULL CONSTRAINT chat_members_reason CHECK (reason IN (
    'creator', 'added', 'joined', 'group', 'guardian_auto', 'guardian_joined', 'leader_joined')),
  role text NOT NULL DEFAULT 'member' CONSTRAINT chat_members_role CHECK (role IN ('owner', 'member')),
  added_by_person_id uuid REFERENCES public.people(id),
  joined_at timestamptz DEFAULT now() NOT NULL,
  left_at timestamptz,
  removed_by_person_id uuid REFERENCES public.people(id),
  last_read_message_id uuid,
  last_read_at timestamptz,
  -- Push per channel (P2.1 C): every message, mentions only, none.
  push text NOT NULL DEFAULT 'all' CONSTRAINT chat_members_push CHECK (push IN ('all', 'mentions', 'off')),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_members_chat_fk FOREIGN KEY (club_id, chat_id)
    REFERENCES public.chats (club_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_members_unique UNIQUE (chat_id, person_id),
  CONSTRAINT chat_members_left CHECK ((status = 'left') = (left_at IS NOT NULL))
);
-- Mina kanaler and the real-time connection start from the person.
CREATE INDEX chat_members_person_idx ON public.chat_members (person_id, chat_id)
  WHERE status <> 'left';
CREATE INDEX chat_members_added_by_idx ON public.chat_members (added_by_person_id)
  WHERE added_by_person_id IS NOT NULL;
CREATE INDEX chat_members_removed_by_idx ON public.chat_members (removed_by_person_id)
  WHERE removed_by_person_id IS NOT NULL;
--> statement-breakpoint

-- The lowest UUIDv7 of a moment: partitions of messages are ranges of IDs.
CREATE FUNCTION app.uuidv7_floor(p_at timestamptz) RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (lpad(to_hex((extract(epoch FROM p_at) * 1000)::bigint), 12, '0')
    || '00000000000000000000')::uuid
$$;

CREATE TABLE public.chat_messages (
  id uuid DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  -- NULL for system messages (someone joined, guardians were added).
  sender_person_id uuid REFERENCES public.people(id),
  kind text NOT NULL DEFAULT 'text' CONSTRAINT chat_messages_kind CHECK (kind IN ('text', 'system')),
  body text NOT NULL DEFAULT ''
    CONSTRAINT chat_messages_body_length CHECK (char_length(body) <= 4000),
  -- System messages: what happened, IDs only ({"type": "joined", "personIds": [...]}).
  event jsonb,
  reply_to_message_id uuid,
  edited_at timestamptz,
  -- Hidden by the sender (deleted) or a moderator; never removed (ADR 0047).
  hidden_at timestamptz,
  hidden_by_person_id uuid REFERENCES public.people(id),
  hidden_reason text CONSTRAINT chat_messages_hidden_reason CHECK (hidden_reason IN ('sender', 'moderator')),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_chat_fk FOREIGN KEY (club_id, chat_id)
    REFERENCES public.chats (club_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_reply_fk FOREIGN KEY (reply_to_message_id)
    REFERENCES public.chat_messages (id),
  CONSTRAINT chat_messages_sender CHECK ((kind = 'text') = (sender_person_id IS NOT NULL))
) PARTITION BY RANGE (id);
-- A chat's pages (keyset on the ID, newest first).
CREATE INDEX chat_messages_chat_idx ON public.chat_messages (chat_id, id DESC);
CREATE INDEX chat_messages_sender_idx ON public.chat_messages (sender_person_id)
  WHERE sender_person_id IS NOT NULL;
CREATE INDEX chat_messages_hidden_by_idx ON public.chat_messages (hidden_by_person_id)
  WHERE hidden_by_person_id IS NOT NULL;
CREATE INDEX chat_messages_reply_idx ON public.chat_messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
-- Rows outside every month's partition (should stay empty: the worker keeps months ready).
CREATE TABLE public.chat_messages_default PARTITION OF public.chat_messages DEFAULT;
REVOKE ALL ON public.chat_messages_default FROM clubadmin_app, clubadmin_operator, clubadmin_retention;
--> statement-breakpoint

-- Creates the month partitions of chat_messages from last month to p_ahead
-- months ahead (idempotent). Partitions are reached only through the parent:
-- the application roles have no privileges on them (row-level security is
-- the parent's). A month whose rows already landed in the default partition
-- is skipped (and reported by the count of skipped months).
CREATE FUNCTION app.ensure_chat_message_partitions(p_ahead integer DEFAULT 3,
    OUT created integer, OUT skipped integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_month date := date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '1 month')::date;
  v_last date := date_trunc('month', (now() AT TIME ZONE 'UTC') + make_interval(months => p_ahead))::date;
  v_name text;
  v_from uuid;
  v_to uuid;
BEGIN
  created := 0;
  skipped := 0;
  WHILE v_month <= v_last LOOP
    v_name := 'chat_messages_' || to_char(v_month, 'YYYY_MM');
    v_from := app.uuidv7_floor(v_month::timestamp AT TIME ZONE 'UTC');
    v_to := app.uuidv7_floor((v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC');
    IF to_regclass('public.' || v_name) IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.chat_messages_default WHERE id >= v_from AND id < v_to) THEN
        skipped := skipped + 1;
      ELSE
        EXECUTE format('CREATE TABLE public.%I PARTITION OF public.chat_messages FOR VALUES FROM (%L) TO (%L)',
          v_name, v_from, v_to);
        EXECUTE format('REVOKE ALL ON public.%I FROM clubadmin_app, clubadmin_operator, clubadmin_retention',
          v_name);
        created := created + 1;
      END IF;
    END IF;
    v_month := (v_month + interval '1 month')::date;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION app.ensure_chat_message_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_chat_message_partitions(integer) TO clubadmin_app;
SELECT * FROM app.ensure_chat_message_partitions(3);
--> statement-breakpoint

-- Every earlier text of an edited message (ADR 0047: nothing an edit replaces is lost).
CREATE TABLE public.chat_message_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  message_id uuid NOT NULL REFERENCES public.chat_messages(id),
  body text NOT NULL,
  -- When this text was written (the message's created_at or an earlier edit).
  written_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX chat_message_versions_message_idx ON public.chat_message_versions (message_id, written_at);

-- Files on a message: prepared, not accepted in the first revision (P2.1;
-- the storage of P2.2 serves them later).
CREATE TABLE public.chat_message_attachments (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  message_id uuid NOT NULL REFERENCES public.chat_messages(id),
  object_key text NOT NULL,
  file_name text NOT NULL CONSTRAINT chat_message_attachments_name_length CHECK (char_length(file_name) <= 255),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CONSTRAINT chat_message_attachments_size CHECK (size_bytes >= 0),
  scan_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT chat_message_attachments_scan CHECK (scan_status IN ('pending', 'clean', 'infected')),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX chat_message_attachments_message_idx ON public.chat_message_attachments (message_id);

CREATE TABLE public.chat_reactions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  message_id uuid NOT NULL REFERENCES public.chat_messages(id),
  person_id uuid NOT NULL REFERENCES public.people(id),
  emoji text NOT NULL CONSTRAINT chat_reactions_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_reactions_unique UNIQUE (message_id, person_id, emoji)
);
CREATE INDEX chat_reactions_person_idx ON public.chat_reactions (person_id);
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.chats'), app.enable_updated_at('public.chats'),
  history.enable_history('public.chats',
    ignore => ARRAY['last_message_id', 'last_message_at', 'has_children']);
SELECT app.enable_tenant_rls('public.chat_groups'), app.enable_updated_at('public.chat_groups'),
  history.enable_history('public.chat_groups');
SELECT app.enable_tenant_rls('public.chat_members'), app.enable_updated_at('public.chat_members'),
  history.enable_history('public.chat_members', ignore => ARRAY['last_read_message_id', 'last_read_at']);
-- A message's insert is its own record (sender, time); edits, hiding and
-- erasure are history; the text is in chat_message_versions.
SELECT app.enable_tenant_rls('public.chat_messages'), app.enable_updated_at('public.chat_messages'),
  history.enable_history('public.chat_messages', redact => ARRAY['body'], skip_insert => true);
SELECT app.enable_tenant_rls('public.chat_message_versions'),
  app.enable_updated_at('public.chat_message_versions'),
  history.enable_history('public.chat_message_versions', redact => ARRAY['body'], skip_insert => true);
SELECT app.enable_tenant_rls('public.chat_message_attachments'),
  app.enable_updated_at('public.chat_message_attachments'),
  history.enable_history('public.chat_message_attachments');
SELECT app.enable_tenant_rls('public.chat_reactions'), app.enable_updated_at('public.chat_reactions'),
  history.enable_history('public.chat_reactions');
--> statement-breakpoint

-- Outside a club context ("Mina kanaler", the real-time connection), a person
-- reads their own (and their wards') memberships, and the chats those are in.
-- Everything else about a chat (its other members, messages) is read in the
-- chat's club. The first condition keeps club transactions from evaluating
-- the check for every row.
CREATE POLICY member_read ON public.chat_members FOR SELECT
  USING (app.current_club_id() IS NULL AND person_id = ANY ((SELECT app.self_and_wards())::uuid[]));
CREATE POLICY member_read ON public.chats FOR SELECT
  USING (app.current_club_id() IS NULL AND EXISTS (
    SELECT 1 FROM public.chat_members cm
    WHERE cm.chat_id = chats.id AND cm.status <> 'left'
      AND cm.person_id = ANY ((SELECT app.self_and_wards())::uuid[])));
--> statement-breakpoint

-- A chat for the authorization module (route :chatId within :clubId): its
-- kind, visibility, state and groups. IDs only.
CREATE FUNCTION app.chat_scope(p_chat uuid)
  RETURNS TABLE (club_id uuid, kind text, visibility text, archived boolean,
    created_by_person_id uuid, default_for_group_id uuid, has_children boolean, group_ids uuid[])
  LANGUAGE sql STABLE AS $$
  SELECT c.club_id, c.kind, c.visibility, c.archived_at IS NOT NULL, c.created_by_person_id,
    c.default_for_group_id, c.has_children,
    coalesce(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}')
  FROM public.chats c LEFT JOIN public.chat_groups g ON g.chat_id = c.id
  WHERE c.id = p_chat
  GROUP BY c.id
$$;
--> statement-breakpoint

-- Chat permissions in the built-in template (P1.15 decision 5): the full
-- template, as in @clubadmin/shared BUILT_IN_ROLE_TEMPLATE (a test compares).
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
    ('safeguarding_officer', 'club', NULL),
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

-- New permissions reach the roles with their template key, in every club type
-- and every club (never custom roles; none of them is sensitive).
INSERT INTO public.club_type_role_permissions (club_type_role_id, permission)
SELECT r.id, t.permission
FROM app.builtin_role_template() t
JOIN public.club_type_roles r ON r.scope = t.scope AND r.key = t.template_key
WHERE t.permission IN ('group.channels.create', 'group.channels.manage', 'club.channels.create')
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
      WHERE t.permission IN ('group.channels.create', 'group.channels.manage', 'club.channels.create')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Erasure (P1.8b, ADR 0047): the person leaves every chat; replayed from the
-- deletion ledger after a restore like the rest.
GRANT SELECT, UPDATE ON public.chat_members TO clubadmin_retention;
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

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;
--> statement-breakpoint

-- Child safety in SQL (ADR 0047 rule 3: no adult alone with a child). In a
-- chat with a child member (below the club's country pack's adult age) and
-- an adult member who is not a full guardian of a child member, or who leads
-- a group a child member is in (a coach, also one who is a parent), every
-- full guardian (parent, legal guardian) of every child
-- member is a member, with the whole history; guardians added for this
-- reason leave when it no longer holds. A guardian with protected identity is
-- offered instead (ADR 0022) and not again once declined. Children-only chats, and parents joining their
-- child's chat, add nobody. Runs in the chat's club context, after every
-- change to a chat's members (the API) and to groups and guardianships (the
-- worker). Returns who was added or removed.
CREATE FUNCTION app.chat_enforce_guardians(p_chat uuid)
  RETURNS TABLE (person_id uuid, change text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_club uuid;
  v_country text;
  v_cutoff date;
  v_needed uuid[];
  v_added uuid[];
  v_offered uuid[];
  v_removed uuid[];
BEGIN
  SELECT c.club_id, cl.country INTO v_club, v_country
  FROM public.chats c JOIN public.clubs cl ON cl.id = c.club_id
  WHERE c.id = p_chat;
  IF v_club IS NULL THEN
    RETURN;
  END IF;
  v_cutoff := (now() AT TIME ZONE 'UTC')::date - make_interval(years => app.adult_age(v_country));

  WITH m AS (
    SELECT cm.person_id FROM public.chat_members cm
    WHERE cm.chat_id = p_chat AND cm.status = 'active'),
  kids AS (
    SELECT m.person_id FROM m JOIN public.people p ON p.id = m.person_id
    WHERE p.birth_date IS NOT NULL AND p.birth_date > v_cutoff),
  fg AS (
    SELECT g.guardian_person_id, g.ward_person_id FROM public.guardianships g
    WHERE g.ward_person_id IN (SELECT k.person_id FROM kids k)
      AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active' AND g.valid_to IS NULL),
  -- Adults who count: not a full guardian of a child in the chat, or a
  -- leader of a group a child in the chat is in (a coach who is also a parent).
  adults AS (
    SELECT m.person_id FROM m
    WHERE m.person_id NOT IN (SELECT k.person_id FROM kids k)
      AND (m.person_id NOT IN (SELECT fg.guardian_person_id FROM fg)
        OR EXISTS (
          SELECT 1 FROM public.group_memberships l
          JOIN public.group_memberships c ON c.group_id = l.group_id AND c.valid_to IS NULL
            AND c.person_id IN (SELECT k.person_id FROM kids k)
          WHERE l.club_id = v_club AND l.person_id = m.person_id AND l.leads
            AND l.valid_to IS NULL)))
  SELECT coalesce(array_agg(DISTINCT fg.guardian_person_id), '{}') INTO v_needed
  FROM fg WHERE EXISTS (SELECT 1 FROM adults);

  UPDATE public.chats c SET has_children = EXISTS (
    SELECT 1 FROM public.chat_members cm JOIN public.people p ON p.id = cm.person_id
    WHERE cm.chat_id = p_chat AND cm.status = 'active'
      AND p.birth_date IS NOT NULL AND p.birth_date > v_cutoff)
  WHERE c.id = p_chat;

  -- Guardians no longer needed (their child left, or no other adult is left).
  WITH gone AS (
    UPDATE public.chat_members cm SET status = 'left', left_at = now()
    WHERE cm.chat_id = p_chat AND cm.reason = 'guardian_auto' AND cm.status <> 'left'
      AND NOT cm.person_id = ANY (v_needed)
    RETURNING cm.person_id)
  SELECT coalesce(array_agg(gone.person_id), '{}') INTO v_removed FROM gone;

  -- Guardians needed and not in the chat (a guardian who left is added again:
  -- the rule holds whatever they chose; they can turn push off).
  WITH want AS (
    SELECT n AS pid,
      coalesce(p.protected_identity, false) OR coalesce(cp.protected_identity_club, false) AS prot
    FROM unnest(v_needed) AS n
    JOIN public.people p ON p.id = n
    LEFT JOIN public.club_profiles cp ON cp.club_id = v_club AND cp.person_id = n
    WHERE NOT EXISTS (
      SELECT 1 FROM public.chat_members cm
      WHERE cm.chat_id = p_chat AND cm.person_id = n AND cm.status = 'active')
      AND NOT EXISTS (
      SELECT 1 FROM public.chat_members cm
      WHERE cm.chat_id = p_chat AND cm.person_id = n AND cm.status = 'offered')
      -- A protected guardian who declined is not offered again.
      AND (NOT (coalesce(p.protected_identity, false) OR coalesce(cp.protected_identity_club, false))
        OR NOT EXISTS (
          SELECT 1 FROM public.chat_members cm
          WHERE cm.chat_id = p_chat AND cm.person_id = n AND cm.status = 'left'
            AND cm.removed_by_person_id = n))),
  upserted AS (
    INSERT INTO public.chat_members AS cm (club_id, chat_id, person_id, status, reason)
    SELECT v_club, p_chat, w.pid, CASE WHEN w.prot THEN 'offered' ELSE 'active' END, 'guardian_auto'
    FROM want w
    ON CONFLICT (chat_id, person_id) DO UPDATE
      SET status = excluded.status, reason = 'guardian_auto', left_at = NULL,
          removed_by_person_id = NULL, joined_at = now()
    RETURNING cm.person_id, cm.status)
  SELECT coalesce(array_agg(u.person_id) FILTER (WHERE u.status = 'active'), '{}'),
    coalesce(array_agg(u.person_id) FILTER (WHERE u.status = 'offered'), '{}')
  INTO v_added, v_offered FROM upserted u;

  IF cardinality(v_added) > 0 THEN
    INSERT INTO public.chat_messages (club_id, chat_id, kind, event)
    VALUES (v_club, p_chat, 'system',
      jsonb_build_object('type', 'guardians_added', 'personIds', to_jsonb(v_added)));
    UPDATE public.chats SET last_message_at = now() WHERE id = p_chat;
  END IF;

  RETURN QUERY
    SELECT a, 'added' FROM unnest(v_added) a
    UNION ALL SELECT o, 'offered' FROM unnest(v_offered) o
    UNION ALL SELECT r, 'removed' FROM unnest(v_removed) r;
END
$$;
REVOKE ALL ON FUNCTION app.chat_enforce_guardians(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_enforce_guardians(uuid) TO clubadmin_app;
--> statement-breakpoint

-- A group's default channel (P2.1 rule 1): everyone in the group, created on
-- first use, archived with the group. People who left it themselves (or
-- declined, protected identity) are not added again; protected people are
-- offered it (ADR 0022). Then the guardian rule. Runs in the group's club
-- context. Returns the chat (NULL for an archived group without one).
CREATE FUNCTION app.chat_sync_group(p_group uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_club uuid;
  v_name text;
  v_archived timestamptz;
  v_chat uuid;
BEGIN
  SELECT g.club_id, g.name, g.archived_at INTO v_club, v_name, v_archived
  FROM public.groups g WHERE g.id = p_group;
  IF v_club IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.id INTO v_chat FROM public.chats c WHERE c.default_for_group_id = p_group;
  IF v_chat IS NULL THEN
    IF v_archived IS NOT NULL THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.chats (club_id, kind, name, visibility, default_for_group_id)
    VALUES (v_club, 'channel', left(v_name, 80), 'open', p_group)
    RETURNING id INTO v_chat;
    INSERT INTO public.chat_groups (club_id, chat_id, group_id) VALUES (v_club, v_chat, p_group);
  END IF;
  IF v_archived IS NOT NULL THEN
    UPDATE public.chats SET archived_at = coalesce(archived_at, now()) WHERE id = v_chat;
    RETURN v_chat;
  END IF;

  WITH people_now AS (
    SELECT DISTINCT gm.person_id,
      coalesce(p.protected_identity, false) OR coalesce(cp.protected_identity_club, false) AS prot
    FROM public.group_memberships gm
    JOIN public.people p ON p.id = gm.person_id
    LEFT JOIN public.club_profiles cp ON cp.club_id = v_club AND cp.person_id = gm.person_id
    WHERE gm.group_id = p_group AND gm.valid_to IS NULL)
  INSERT INTO public.chat_members AS cm (club_id, chat_id, person_id, status, reason)
  SELECT v_club, v_chat, n.person_id, CASE WHEN n.prot THEN 'offered' ELSE 'active' END, 'group'
  FROM people_now n
  ON CONFLICT (chat_id, person_id) DO UPDATE
    SET status = excluded.status, reason = 'group', left_at = NULL, removed_by_person_id = NULL,
        joined_at = now()
  WHERE cm.status = 'left' AND cm.removed_by_person_id IS DISTINCT FROM cm.person_id;

  UPDATE public.chat_members cm SET status = 'left', left_at = now()
  WHERE cm.chat_id = v_chat AND cm.reason = 'group' AND cm.status <> 'left'
    AND NOT EXISTS (
      SELECT 1 FROM public.group_memberships gm
      WHERE gm.group_id = p_group AND gm.person_id = cm.person_id AND gm.valid_to IS NULL);

  PERFORM app.chat_enforce_guardians(v_chat);
  RETURN v_chat;
END
$$;
REVOKE ALL ON FUNCTION app.chat_sync_group(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_sync_group(uuid) TO clubadmin_app;
--> statement-breakpoint

-- A person's chats in a club after their groups, guardianships or club
-- relationship changed (the worker, on role.changed, guardianship.changed
-- and membership.changed): the default channels of their groups, then the
-- guardian rule in every chat they or their wards are in; someone with no
-- relationship to the club any more leaves its chats. Runs in the club's
-- context. Returns the chats whose members changed.
CREATE FUNCTION app.chat_sync_person(p_person uuid)
  RETURNS TABLE (chat_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_club uuid := app.current_club_id();
  v_group uuid;
  v_chat uuid;
BEGIN
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'chat_sync_person runs in a club context';
  END IF;
  IF NOT privacy.has_club_relationship(p_person, v_club) THEN
    RETURN QUERY
      UPDATE public.chat_members cm SET status = 'left', left_at = now()
      WHERE cm.club_id = v_club AND cm.person_id = p_person AND cm.status <> 'left'
      RETURNING cm.chat_id;
  END IF;
  -- Default channels of groups they are in, or were in (the rows say which).
  FOR v_group IN
    SELECT gm.group_id FROM public.group_memberships gm
    WHERE gm.club_id = v_club AND gm.person_id = p_person AND gm.valid_to IS NULL
    UNION
    SELECT c.default_for_group_id FROM public.chat_members cm
    JOIN public.chats c ON c.id = cm.chat_id
    WHERE cm.club_id = v_club AND cm.person_id = p_person AND cm.reason = 'group'
      AND cm.status <> 'left' AND c.default_for_group_id IS NOT NULL
  LOOP
    v_chat := app.chat_sync_group(v_group);
    IF v_chat IS NOT NULL THEN
      chat_id := v_chat;
      RETURN NEXT;
    END IF;
  END LOOP;
  -- The guardian rule where they or their wards (or guardians) are members.
  FOR v_chat IN
    SELECT DISTINCT cm.chat_id FROM public.chat_members cm
    WHERE cm.club_id = v_club AND cm.status <> 'left'
      AND (cm.person_id = p_person OR cm.person_id IN (
        SELECT g.ward_person_id FROM public.guardianships g
        WHERE g.guardian_person_id = p_person AND g.valid_to IS NULL
        UNION
        SELECT g.guardian_person_id FROM public.guardianships g
        WHERE g.ward_person_id = p_person AND g.valid_to IS NULL))
  LOOP
    IF EXISTS (SELECT 1 FROM app.chat_enforce_guardians(v_chat)) THEN
      chat_id := v_chat;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION app.chat_sync_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_sync_person(uuid) TO clubadmin_app;
--> statement-breakpoint

-- What everyone in a chat sees about its members (ADR 0047: openness): who is
-- a child, who leads one of the chat's groups or a group another member is
-- in, and whose full guardian each member is among the members. IDs and flags only; names go through the presenter.
-- Runs in the chat's club context.
CREATE FUNCTION app.chat_member_facts(p_chat uuid)
  RETURNS TABLE (person_id uuid, child boolean, leader boolean, guardian_of uuid[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  -- Per member, by the person's own index entries: never a scan of a whole table.
  WITH c AS (
    SELECT (now() AT TIME ZONE 'UTC')::date - make_interval(years => app.adult_age(cl.country)) AS cutoff
    FROM public.chats ch JOIN public.clubs cl ON cl.id = ch.club_id WHERE ch.id = p_chat),
  m AS MATERIALIZED (
    SELECT cm.person_id FROM public.chat_members cm WHERE cm.chat_id = p_chat AND cm.status <> 'left')
  SELECT m.person_id,
    coalesce((SELECT p.birth_date FROM public.people p WHERE p.id = m.person_id) > c.cutoff, false),
    EXISTS (
      SELECT 1 FROM public.group_memberships l
      WHERE l.person_id = m.person_id AND l.valid_to IS NULL AND l.leads
        AND (EXISTS (SELECT 1 FROM public.chat_groups cg
                     WHERE cg.chat_id = p_chat AND cg.group_id = l.group_id)
          OR EXISTS (SELECT 1 FROM public.group_memberships o
                     WHERE o.group_id = l.group_id AND o.valid_to IS NULL
                       AND o.person_id <> m.person_id
                       AND o.person_id IN (SELECT m2.person_id FROM m m2)))),
    coalesce((
      SELECT array_agg(g.ward_person_id ORDER BY g.ward_person_id) FROM public.guardianships g
      WHERE g.guardian_person_id = m.person_id AND g.valid_to IS NULL
        AND g.ward_person_id IN (SELECT m3.person_id FROM m m3)
        AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active'), '{}')
  FROM m CROSS JOIN c
$$;
REVOKE ALL ON FUNCTION app.chat_member_facts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_member_facts(uuid) TO clubadmin_app;
--> statement-breakpoint

-- Whether p_from may start a direct message with p_to (ADR 0047 rules 3–5),
-- in the club context: NULL when allowed, else the reason. Adults write to
-- adults; to a child only the child's full guardian, a leader of a group the
-- child is in (the guardian rule then adds the child's guardians) or another
-- child of one of the child's groups; a child writes to children of their
-- groups, their full guardians and their groups' leaders.
CREATE FUNCTION app.chat_direct_refusal(p_from uuid, p_to uuid)
  RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_club uuid := app.current_club_id();
  v_cutoff date;
  v_from_child boolean;
  v_to_child boolean;
BEGIN
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'chat_direct_refusal runs in a club context';
  END IF;
  IF p_from = p_to THEN
    RETURN 'chat_self';
  END IF;
  IF NOT privacy.has_club_relationship(p_to, v_club) THEN
    RETURN 'chat_not_in_club';
  END IF;
  SELECT (now() AT TIME ZONE 'UTC')::date - make_interval(years => app.adult_age(c.country))
  INTO v_cutoff FROM public.clubs c WHERE c.id = v_club;
  SELECT coalesce(birth_date > v_cutoff, false) INTO v_from_child FROM public.people WHERE id = p_from;
  SELECT coalesce(birth_date > v_cutoff, false) INTO v_to_child FROM public.people WHERE id = p_to;
  IF NOT v_from_child AND NOT v_to_child THEN
    RETURN NULL;
  END IF;
  -- A full guardian and their child.
  IF EXISTS (
    SELECT 1 FROM public.guardianships g
    WHERE g.kind IN ('parent', 'legal_guardian') AND g.status = 'active' AND g.valid_to IS NULL
      AND ((g.guardian_person_id = p_from AND g.ward_person_id = p_to)
        OR (g.guardian_person_id = p_to AND g.ward_person_id = p_from))) THEN
    RETURN NULL;
  END IF;
  -- Two children of one group, or a leader and a child of a group they lead.
  IF EXISTS (
    SELECT 1 FROM public.group_memberships a
    JOIN public.group_memberships b ON b.group_id = a.group_id AND b.valid_to IS NULL
    WHERE a.club_id = v_club AND a.valid_to IS NULL
      AND a.person_id = p_from AND b.person_id = p_to
      AND ((v_from_child AND v_to_child)
        OR (v_to_child AND NOT v_from_child AND a.leads)
        OR (v_from_child AND NOT v_to_child AND b.leads))) THEN
    RETURN NULL;
  END IF;
  RETURN 'chat_child_protected';
END
$$;
REVOKE ALL ON FUNCTION app.chat_direct_refusal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_direct_refusal(uuid, uuid) TO clubadmin_app;
--> statement-breakpoint

-- Whom p_by may add to a channel (P2.1 rules 1, 5): people of its groups (in
-- one of them, or a full guardian of someone who is: "the team's parents");
-- for club channels anyone related to the club. A child adds only children
-- who share one of the channel's groups with them (rule 5, "for now"). Runs in
-- the club context; returns the people of p_people who may not be added.
CREATE FUNCTION app.chat_unaddable(p_chat uuid, p_by uuid, p_people uuid[])
  RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_club uuid := app.current_club_id();
  v_cutoff date;
  v_groups uuid[];
  v_by_child boolean;
  v_refused uuid[];
BEGIN
  SELECT (now() AT TIME ZONE 'UTC')::date - make_interval(years => app.adult_age(cl.country))
  INTO v_cutoff FROM public.chats c JOIN public.clubs cl ON cl.id = c.club_id
  WHERE c.id = p_chat AND c.club_id = v_club;
  IF v_cutoff IS NULL THEN
    RETURN p_people;
  END IF;
  SELECT coalesce(array_agg(g.group_id), '{}') INTO v_groups
  FROM public.chat_groups g WHERE g.chat_id = p_chat;
  SELECT coalesce(birth_date > v_cutoff, false) INTO v_by_child FROM public.people WHERE id = p_by;

  SELECT coalesce(array_agg(n), '{}') INTO v_refused
  FROM unnest(p_people) AS n
  WHERE NOT (
    CASE
      WHEN v_by_child THEN
        EXISTS (SELECT 1 FROM public.people p WHERE p.id = n AND p.birth_date > v_cutoff)
        AND EXISTS (
          SELECT 1 FROM public.group_memberships a
          JOIN public.group_memberships b ON b.group_id = a.group_id AND b.valid_to IS NULL
          WHERE a.person_id = p_by AND b.person_id = n AND a.valid_to IS NULL
            AND a.group_id = ANY (v_groups))
      WHEN cardinality(v_groups) = 0 THEN privacy.has_club_relationship(n, v_club)
      ELSE EXISTS (
          SELECT 1 FROM public.group_memberships gm
          WHERE gm.group_id = ANY (v_groups) AND gm.valid_to IS NULL AND gm.person_id = n)
        OR EXISTS (
          SELECT 1 FROM public.group_memberships gm
          JOIN public.guardianships g ON g.ward_person_id = gm.person_id
          WHERE gm.group_id = ANY (v_groups) AND gm.valid_to IS NULL
            AND g.guardian_person_id = n AND g.kind IN ('parent', 'legal_guardian')
            AND g.status = 'active' AND g.valid_to IS NULL)
    END);
  RETURN v_refused;
END
$$;
REVOKE ALL ON FUNCTION app.chat_unaddable(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_unaddable(uuid, uuid, uuid[]) TO clubadmin_app;
--> statement-breakpoint

-- People with protected identity (globally or in the club) among p_people:
-- they are offered a chat, never added (ADR 0022). IDs only.
CREATE FUNCTION app.chat_protected_people(p_club uuid, p_people uuid[])
  RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(p.id), '{}') FROM public.people p
  LEFT JOIN public.club_profiles cp ON cp.club_id = p_club AND cp.person_id = p.id
  WHERE p.id = ANY (p_people)
    AND (p.protected_identity OR coalesce(cp.protected_identity_club, false))
$$;
REVOKE ALL ON FUNCTION app.chat_protected_people(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.chat_protected_people(uuid, uuid[]) TO clubadmin_app;
