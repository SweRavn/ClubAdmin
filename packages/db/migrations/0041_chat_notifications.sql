-- P2.1 part C: a notification category for chat (new messages, push only,
-- per channel's setting). The check is replaced without blocking writes:
-- added NOT VALID, then validated (existing rows already satisfy it).
ALTER TABLE public.notifications DROP CONSTRAINT notifications_category;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category CHECK (category IN (
  'schedule', 'responses', 'leader', 'events', 'membership', 'club_admin', 'family', 'account',
  'waitlist', 'chat')) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_category;
