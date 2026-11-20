-- P2.7f (ADR 0048 amended): car-pool defaults.
-- - An adult's own settings (seats, departure place, a note to passengers,
--   minutes after an activity's end to leave for home), on their account
--   (own_account policy, history), used to offer a car with one tap.
-- - When the way home leaves: the activity's minutes after its end, else
--   the driver's, else the club's, else 15 minutes.

ALTER TABLE public.accounts ADD COLUMN carpool_settings jsonb;
ALTER TABLE public.activities ADD COLUMN carpool_return_minutes integer
  CONSTRAINT activities_carpool_return_minutes CHECK (carpool_return_minutes BETWEEN 0 AND 240);
ALTER TABLE public.clubs ADD COLUMN carpool_return_minutes integer
  CONSTRAINT clubs_carpool_return_minutes CHECK (carpool_return_minutes BETWEEN 0 AND 240);
