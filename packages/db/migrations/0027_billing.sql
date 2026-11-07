-------------------------------------------------------------------------------
-- Billing (P1.13, ADR 0045): the club's billing details, prices per currency
-- and period, invoices with VAT and credit notes, payments, provider events,
-- a gapless invoice number series and where a club's restriction came from.
-- Expand only: billing.plans keeps price_minor/currency/period (backfilled
-- into plan_prices; contract later). No person references in `billing` (a
-- test guards this): who did what is in audit and history.
-------------------------------------------------------------------------------

-- Who restricted the club: an operator by hand, or billing for non-payment.
-- A payment lifts only billing's restriction (null when active).
ALTER TABLE public.clubs ADD COLUMN access_state_source text
  CONSTRAINT clubs_access_state_source CHECK (access_state_source IN ('operator', 'billing'));
UPDATE public.clubs SET access_state_source = 'operator' WHERE access_state <> 'active';
--> statement-breakpoint

-- Prices per plan, currency and period (excluding VAT). Added or deactivated,
-- never edited in place.
CREATE TABLE billing.plan_prices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plan_id uuid NOT NULL REFERENCES billing.plans (id),
  currency text NOT NULL CONSTRAINT plan_prices_currency CHECK (currency ~ '^[A-Z]{3}$'),
  period text NOT NULL CONSTRAINT plan_prices_period CHECK (period IN ('month', 'year')),
  price_minor bigint NOT NULL CONSTRAINT plan_prices_price CHECK (price_minor >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plan_prices_unique ON billing.plan_prices (plan_id, currency, period) WHERE active;
CREATE INDEX plan_prices_plan_idx ON billing.plan_prices (plan_id);
ALTER TABLE billing.plan_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalogue_read ON billing.plan_prices FOR SELECT USING (true);
CREATE POLICY catalogue_write ON billing.plan_prices FOR INSERT
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_update ON billing.plan_prices FOR UPDATE
  USING (app.is_system() OR app.is_platform_operator());
CREATE POLICY retention_access ON billing.plan_prices TO clubadmin_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON billing.plan_prices TO clubadmin_app;
GRANT SELECT ON billing.plan_prices TO clubadmin_retention;
SELECT app.enable_updated_at('billing.plan_prices'), history.enable_history('billing.plan_prices');
-- The existing monthly prices; yearly at ten months (decision 3).
INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
SELECT id, currency, period, price_minor FROM billing.plans;
INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
SELECT id, currency, 'year', price_minor * 10 FROM billing.plans WHERE period = 'month';
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  ADD COLUMN billing_period text NOT NULL DEFAULT 'month'
    CONSTRAINT subscriptions_billing_period CHECK (billing_period IN ('month', 'year')),
  ADD COLUMN currency text NOT NULL DEFAULT 'SEK'
    CONSTRAINT subscriptions_currency CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN scheduled_plan_id uuid REFERENCES billing.plans (id),
  ADD COLUMN scheduled_add_on_plan_ids uuid[],
  ADD COLUMN scheduled_billing_period text
    CONSTRAINT subscriptions_scheduled_period CHECK (scheduled_billing_period IN ('month', 'year')),
  -- When the scheduled change takes effect: now (upgrades, starting a paid
  -- period during the trial), the trial's or the period's end (downgrades).
  -- The billing job applies it and issues the invoice.
  ADD COLUMN scheduled_effective_at timestamptz,
  -- The latest choice of a club manager (the terms were accepted with it).
  ADD COLUMN selected_at timestamptz,
  ADD COLUMN past_due_since timestamptz,
  -- Trial reminders sent (0, 7 days, 1 day before the end).
  ADD COLUMN trial_reminder_level smallint NOT NULL DEFAULT 0;
CREATE INDEX subscriptions_due_idx ON billing.subscriptions (status, current_period_end);
CREATE INDEX subscriptions_scheduled_idx ON billing.subscriptions (scheduled_effective_at)
  WHERE scheduled_effective_at IS NOT NULL;
CREATE INDEX subscriptions_trial_idx ON billing.subscriptions (trial_ends_at) WHERE status = 'trial';
--> statement-breakpoint

-- The club as a customer: invoice details and payment method. Organisation
-- data; the invoice email and reference are an organisation address and a
-- role (the form says so). Club managers and treasurers write it.
CREATE TABLE billing.accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  club_id uuid NOT NULL REFERENCES public.clubs (id),
  legal_name text NOT NULL CONSTRAINT accounts_legal_name CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  organization_number text,
  vat_number text,
  address jsonb,
  invoice_email text CONSTRAINT accounts_invoice_email
    CHECK (invoice_email IS NULL OR (length(invoice_email) <= 254 AND invoice_email ~ '^[^@\s]+@[^@\s]+$')),
  reference text CONSTRAINT accounts_reference CHECK (reference IS NULL OR char_length(reference) <= 60),
  invoice_locale text NOT NULL DEFAULT 'sv' CONSTRAINT accounts_locale CHECK (invoice_locale IN ('sv', 'en', 'nb')),
  payment_method text NOT NULL DEFAULT 'invoice'
    CONSTRAINT accounts_payment_method CHECK (payment_method IN ('invoice', 'card')),
  provider text,
  provider_customer_id text,
  card_brand text,
  card_last4 text CONSTRAINT accounts_card_last4 CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  card_exp_month smallint,
  card_exp_year smallint,
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_club_unique ON billing.accounts (club_id);
--> statement-breakpoint

-- Invoices: credit notes, VAT, snapshots of seller and buyer at issue, OCR,
-- the PDF and dunning. The number is assigned when the invoice is issued.
ALTER TABLE billing.invoices
  ALTER COLUMN number DROP NOT NULL,
  ADD COLUMN kind text NOT NULL DEFAULT 'invoice'
    CONSTRAINT invoices_kind CHECK (kind IN ('invoice', 'credit_note')),
  ADD COLUMN credited_invoice_id uuid REFERENCES billing.invoices (id),
  ADD COLUMN subtotal_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN vat_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN seller jsonb,
  ADD COLUMN buyer jsonb,
  ADD COLUMN payment_method text,
  ADD COLUMN ocr_reference text,
  ADD COLUMN credit_reason text,
  ADD COLUMN pdf_object_key text,
  ADD COLUMN pdf_sha256 text,
  ADD COLUMN reminder_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN last_reminded_at timestamptz,
  ADD CONSTRAINT invoices_total CHECK (total_minor = subtotal_minor + vat_minor),
  ADD CONSTRAINT invoices_credit CHECK ((kind = 'credit_note') = (credited_invoice_id IS NOT NULL)),
  ADD CONSTRAINT invoices_issued CHECK (status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL));
-- One invoice per subscription and period (the daily job is idempotent).
CREATE UNIQUE INDEX invoices_period_unique ON billing.invoices (subscription_id, period_start)
  WHERE kind = 'invoice' AND status <> 'void';
CREATE INDEX invoices_open_due_idx ON billing.invoices (due_at) WHERE status = 'open';
CREATE INDEX invoices_issued_idx ON billing.invoices (issued_at DESC, id DESC) WHERE issued_at IS NOT NULL;
CREATE INDEX invoices_credited_idx ON billing.invoices (credited_invoice_id) WHERE credited_invoice_id IS NOT NULL;

ALTER TABLE billing.invoice_lines
  ADD COLUMN plan_id uuid REFERENCES billing.plans (id),
  ADD COLUMN period_start timestamptz,
  ADD COLUMN period_end timestamptz,
  ADD COLUMN proration boolean NOT NULL DEFAULT false,
  ADD COLUMN vat_rate_bp integer NOT NULL DEFAULT 0 CONSTRAINT invoice_lines_vat_rate CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  ADD COLUMN vat_minor bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

-- An issued invoice is the accounting record: only its status, payment,
-- dunning and PDF columns change afterwards; corrections are credit notes.
CREATE FUNCTION billing.guard_issued_invoice() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.vat_minor IS DISTINCT FROM OLD.vat_minor
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.period_start IS DISTINCT FROM OLD.period_start
    OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.seller IS DISTINCT FROM OLD.seller
    OR NEW.buyer IS DISTINCT FROM OLD.buyer OR NEW.ocr_reference IS DISTINCT FROM OLD.ocr_reference
    OR NEW.credited_invoice_id IS DISTINCT FROM OLD.credited_invoice_id
    OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR (NEW.status = 'draft')) THEN
    RAISE EXCEPTION 'an issued invoice cannot be changed; issue a credit note' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_issued BEFORE UPDATE ON billing.invoices
  FOR EACH ROW EXECUTE FUNCTION billing.guard_issued_invoice();
CREATE FUNCTION billing.guard_issued_lines() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing.invoices i
             WHERE i.id = coalesce(NEW.invoice_id, OLD.invoice_id) AND i.status <> 'draft') THEN
    RAISE EXCEPTION 'the lines of an issued invoice cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER guard_issued_lines BEFORE INSERT OR UPDATE ON billing.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION billing.guard_issued_lines();
--> statement-breakpoint

-- Payments against an invoice (bank payments recorded by operators; card in PR B).
CREATE TABLE billing.payments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  club_id uuid NOT NULL REFERENCES public.clubs (id),
  invoice_id uuid NOT NULL REFERENCES billing.invoices (id),
  provider text NOT NULL CONSTRAINT payments_provider CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
  provider_reference text NOT NULL,
  amount_minor bigint NOT NULL CONSTRAINT payments_amount CHECK (amount_minor > 0),
  currency text NOT NULL CONSTRAINT payments_currency CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CONSTRAINT payments_status CHECK (status IN ('pending', 'succeeded', 'failed')),
  failure_code text,
  received_on date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_reference_unique ON billing.payments (provider, provider_reference);
CREATE INDEX payments_invoice_idx ON billing.payments (invoice_id);
CREATE INDEX payments_recorded_idx ON billing.payments (recorded_at DESC, id DESC);
CREATE INDEX payments_club_idx ON billing.payments (club_id);
--> statement-breakpoint

-- Club billing tables as in 0006: isolated per club, read in the club by
-- club managers and treasurers, written by operators and jobs; billing
-- details also by club managers and treasurers. Nothing deleted by the app.
DO $billing$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing.accounts', 'billing.payments'] LOOP
    PERFORM app.enable_tenant_rls(t::regclass);
    PERFORM app.enable_updated_at(t::regclass);
    PERFORM history.enable_history(t::regclass);
    EXECUTE format(
      'CREATE POLICY operator_access ON %s USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator())', t);
    EXECUTE format(
      'CREATE POLICY billing_readers ON %s AS RESTRICTIVE FOR SELECT TO clubadmin_app '
      'USING (app.is_system() OR app.is_platform_operator() OR app.has_club_role(ARRAY[''club_manager'', ''treasurer'']))', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO clubadmin_app', t);
    EXECUTE format('GRANT SELECT, UPDATE, DELETE ON %s TO clubadmin_retention', t);
  END LOOP;
END
$billing$;
CREATE POLICY billing_writers ON billing.accounts AS RESTRICTIVE FOR INSERT TO clubadmin_app
  WITH CHECK (app.is_system() OR app.is_platform_operator()
    OR app.has_club_role(ARRAY['club_manager', 'treasurer']));
CREATE POLICY billing_updaters ON billing.accounts AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator()
    OR app.has_club_role(ARRAY['club_manager', 'treasurer']));
CREATE POLICY billing_writers ON billing.payments AS RESTRICTIVE FOR INSERT TO clubadmin_app
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY billing_updaters ON billing.payments AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator());
-- Club managers choose plans (P1.13): they may update their club's
-- subscription, but only its selection columns (the guard below); the billing
-- job applies the selection, changes the status and issues the invoices.
DROP POLICY billing_updaters ON billing.subscriptions;
CREATE POLICY billing_updaters ON billing.subscriptions AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator() OR app.has_club_role(ARRAY['club_manager']));
CREATE FUNCTION billing.guard_subscription_selection() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  selection text[] := ARRAY['scheduled_plan_id', 'scheduled_add_on_plan_ids',
    'scheduled_billing_period', 'scheduled_effective_at', 'cancel_at_period_end',
    'selected_at', 'updated_at'];
BEGIN
  IF app.is_system() OR app.is_platform_operator() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - selection) IS DISTINCT FROM (to_jsonb(OLD) - selection) THEN
    RAISE EXCEPTION 'club managers only change the plan selection' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_selection BEFORE UPDATE ON billing.subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing.guard_subscription_selection();
-- Retention (accounting records, 7 years) deletes through the retention role.
GRANT DELETE ON billing.invoices, billing.invoice_lines TO clubadmin_retention;
GRANT SELECT, UPDATE ON billing.invoices, billing.invoice_lines, billing.subscriptions TO clubadmin_retention;
--> statement-breakpoint

-- One gapless number series per seller (credit notes in the same series):
-- numbers are taken in the issuing transaction under the row lock.
CREATE TABLE billing.invoice_number_series (
  key text PRIMARY KEY,
  prefix text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CONSTRAINT invoice_number_series_next CHECK (next_value > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing.invoice_number_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY series_access ON billing.invoice_number_series
  USING (app.is_system() OR app.is_platform_operator())
  WITH CHECK (app.is_system() OR app.is_platform_operator());
GRANT SELECT, INSERT, UPDATE ON billing.invoice_number_series TO clubadmin_app;
SELECT app.enable_updated_at('billing.invoice_number_series');

CREATE FUNCTION billing.next_invoice_number(p_key text, p_prefix text) RETURNS text
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_value bigint;
BEGIN
  INSERT INTO billing.invoice_number_series (key, prefix) VALUES (p_key, p_prefix)
  ON CONFLICT (key) DO NOTHING;
  UPDATE billing.invoice_number_series SET next_value = next_value + 1
  WHERE key = p_key
  RETURNING next_value - 1 INTO v_value;
  RETURN p_prefix || lpad(v_value::text, 6, '0');
END
$$;
REVOKE ALL ON FUNCTION billing.next_invoice_number(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.next_invoice_number(text, text) TO clubadmin_app;
--> statement-breakpoint

-- Card provider events (PR B): verified webhook events by ID, no payload
-- (it may contain contact data); deleted after 90 days.
CREATE TABLE billing.provider_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  provider text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_events_unique ON billing.provider_events (provider, event_id);
CREATE INDEX provider_events_received_idx ON billing.provider_events (received_at);
ALTER TABLE billing.provider_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_access ON billing.provider_events
  USING (app.is_system() OR app.is_platform_operator() OR app.setting('app.lookup') = 'provider_event')
  WITH CHECK (app.is_system() OR app.is_platform_operator() OR app.setting('app.lookup') = 'provider_event');
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.provider_events TO clubadmin_app;
SELECT app.enable_updated_at('billing.provider_events');
