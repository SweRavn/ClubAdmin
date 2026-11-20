-- P2.7e: a group event is sent to the people the organiser ticks. The form
-- lists the groups' players, all ticked; those unticked are not invited:
-- the event has invitees_only and its invitees (as an activity's call-up,
-- ADR 0036). Only they (and their guardians for them) sign up, and the
-- notice of publication goes to them.

ALTER TABLE public.events ADD COLUMN invitees_only boolean NOT NULL DEFAULT false;

CREATE TABLE public.event_invitees (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  event_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  invited_by_person_id uuid NOT NULL REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT event_invitees_event_fk FOREIGN KEY (club_id, event_id)
    REFERENCES public.events (club_id, id) ON DELETE CASCADE,
  CONSTRAINT event_invitees_unique UNIQUE (event_id, person_id)
);
CREATE INDEX event_invitees_event_idx ON public.event_invitees (club_id, event_id);
-- "Mina evenemang": is this person invited?
CREATE INDEX event_invitees_person_idx ON public.event_invitees (person_id, event_id);
CREATE INDEX event_invitees_inviter_idx ON public.event_invitees (invited_by_person_id);
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.event_invitees'), app.enable_updated_at('public.event_invitees'),
  history.enable_history('public.event_invitees');
--> statement-breakpoint

-- "Mina evenemang" reads whether I and my wards are invited, across clubs
-- (as activity_invitees' and event_registrations' own_read).
CREATE POLICY own_read ON public.event_invitees FOR SELECT
  USING (person_id = ANY ((SELECT app.self_and_wards())::uuid[]));
