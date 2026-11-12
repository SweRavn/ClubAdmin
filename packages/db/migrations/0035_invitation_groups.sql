-- P1.15 part A4 (ADR 0046): an invitation to several groups, each with a
-- group role. Accepting adds every row in one transaction. The old
-- invitations.group_id and role_preset keep working (ADR 0029); a club role
-- to give is now also a role ID (invitations.club_role_id).

ALTER TABLE public.invitations
  ADD COLUMN club_role_id uuid REFERENCES public.roles(id);
--> statement-breakpoint

CREATE TABLE public.invitation_groups (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  -- Deleted with the invitation (joining:retention).
  invitation_id uuid NOT NULL REFERENCES public.invitations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.groups(id),
  role_id uuid NOT NULL REFERENCES public.roles(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT invitation_groups_unique UNIQUE (invitation_id, group_id)
);
-- A group's invitations (the group page, archiving).
CREATE INDEX invitation_groups_group_idx ON public.invitation_groups (group_id);
CREATE INDEX invitation_groups_role_idx ON public.invitation_groups (role_id);
SELECT app.enable_tenant_rls('public.invitation_groups');
SELECT app.enable_updated_at('public.invitation_groups');
SELECT history.enable_history('public.invitation_groups');
