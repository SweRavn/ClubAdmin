ALTER TABLE "clubs" ADD COLUMN "access_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_access_state" CHECK ("clubs"."access_state" IN ('active', 'read_only', 'suspended'));--> statement-breakpoint
-------------------------------------------------------------------------------
-- Hand-written part (P0.12): club access state and the billing schema
-- (docs/hosting-and-billing.md, ADR 0013). The billing tables exist in every
-- installation so the schema is the same everywhere; they stay empty with
-- BILLING_ENABLED=false. They hold organisation data only, no person
-- references (a test guards this; a billing contact, when P1.13 needs one,
-- is declared in billing.references.ts for merges and erasure).
-------------------------------------------------------------------------------

-- The acting person is a platform operator acting as one (operator endpoints
-- set app.actor_kind = 'operator').
CREATE FUNCTION app.is_platform_operator() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT app.current_actor_kind() = 'operator' AND app.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.platform_operators o
    WHERE o.person_id = app.current_person_id() AND o.valid_to IS NULL
  )
$$;
--> statement-breakpoint

-- The acting person holds one of the roles in the current club.
CREATE FUNCTION app.has_club_role(p_roles text[]) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT app.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_role_assignments r
    WHERE r.club_id = app.current_club_id() AND r.person_id = app.current_person_id()
      AND r.role = ANY (p_roles) AND r.valid_to IS NULL
  )
$$;
--> statement-breakpoint

-- Only operators (and jobs, e.g. the billing module's status changes) change
-- a club's access state; club managers cannot unlock their own club.
CREATE FUNCTION app.guard_club_access_state() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.access_state IS DISTINCT FROM OLD.access_state
     AND NOT (app.is_system() OR app.is_platform_operator() OR session_user <> 'clubadmin_app') THEN
    RAISE EXCEPTION 'only operators change a club''s access state' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_access_state BEFORE UPDATE OF access_state ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION app.guard_club_access_state();
--> statement-breakpoint

CREATE SCHEMA billing;
GRANT USAGE ON SCHEMA billing TO clubadmin_app, clubadmin_operator, clubadmin_retention;
--> statement-breakpoint

-- Plans and add-ons: the catalogue, readable by everyone, changed by operators.
CREATE TABLE billing.plans (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL CONSTRAINT plans_key_shape CHECK (key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'base' CONSTRAINT plans_kind CHECK (kind IN ('base', 'add_on')),
  -- Integer minor units (öre, cents) and ISO 4217 currency.
  currency text NOT NULL CONSTRAINT plans_currency CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor bigint NOT NULL DEFAULT 0 CONSTRAINT plans_price CHECK (price_minor >= 0),
  period text NOT NULL DEFAULT 'month' CONSTRAINT plans_period CHECK (period IN ('month', 'year')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plans_key_unique ON billing.plans (key);
--> statement-breakpoint

-- What a plan grants: a feature (enabled) or a limit (null: unlimited).
CREATE TABLE billing.plan_entitlements (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  plan_id uuid NOT NULL REFERENCES billing.plans (id),
  key text NOT NULL,
  kind text NOT NULL CONSTRAINT plan_entitlements_kind CHECK (kind IN ('feature', 'limit')),
  enabled boolean,
  limit_value bigint CONSTRAINT plan_entitlements_limit CHECK (limit_value IS NULL OR limit_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_entitlements_shape CHECK (
    (kind = 'feature' AND enabled IS NOT NULL AND limit_value IS NULL)
    OR (kind = 'limit' AND enabled IS NULL)
  )
);
CREATE UNIQUE INDEX plan_entitlements_unique ON billing.plan_entitlements (plan_id, key);
--> statement-breakpoint

-- One subscription per club (its history is in the record history).
CREATE TABLE billing.subscriptions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  club_id uuid NOT NULL REFERENCES public.clubs (id),
  plan_id uuid NOT NULL REFERENCES billing.plans (id),
  add_on_plan_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL CONSTRAINT subscriptions_status
    CHECK (status IN ('trial', 'active', 'past_due', 'read_only', 'cancelled')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_trial CHECK (status <> 'trial' OR trial_ends_at IS NOT NULL),
  CONSTRAINT subscriptions_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX subscriptions_club_unique ON billing.subscriptions (club_id);
CREATE INDEX subscriptions_plan_idx ON billing.subscriptions (plan_id);
--> statement-breakpoint

CREATE TABLE billing.invoices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  club_id uuid NOT NULL REFERENCES public.clubs (id),
  subscription_id uuid NOT NULL REFERENCES billing.subscriptions (id),
  number text NOT NULL,
  currency text NOT NULL CONSTRAINT invoices_currency CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CONSTRAINT invoices_status
    CHECK (status IN ('draft', 'open', 'paid', 'void')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_period CHECK (period_end > period_start)
);
CREATE UNIQUE INDEX invoices_number_unique ON billing.invoices (number);
CREATE INDEX invoices_club_idx ON billing.invoices (club_id, period_start DESC, id DESC);
CREATE INDEX invoices_subscription_idx ON billing.invoices (subscription_id);
--> statement-breakpoint

CREATE TABLE billing.invoice_lines (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  club_id uuid NOT NULL REFERENCES public.clubs (id),
  invoice_id uuid NOT NULL REFERENCES billing.invoices (id),
  -- Message key of the line's text (translated when the invoice is rendered).
  description_key text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CONSTRAINT invoice_lines_quantity CHECK (quantity > 0),
  unit_minor bigint NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_lines_invoice_idx ON billing.invoice_lines (invoice_id);
CREATE INDEX invoice_lines_club_idx ON billing.invoice_lines (club_id);
--> statement-breakpoint

-- Catalogue: everyone reads (entitlements), operators and jobs write.
ALTER TABLE billing.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.plan_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalogue_read ON billing.plans FOR SELECT USING (true);
CREATE POLICY catalogue_read ON billing.plan_entitlements FOR SELECT USING (true);
CREATE POLICY catalogue_write ON billing.plans FOR INSERT
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_update ON billing.plans FOR UPDATE
  USING (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_write ON billing.plan_entitlements FOR INSERT
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_update ON billing.plan_entitlements FOR UPDATE
  USING (app.is_system() OR app.is_platform_operator());
CREATE POLICY retention_access ON billing.plans TO clubadmin_retention USING (true) WITH CHECK (true);
CREATE POLICY retention_access ON billing.plan_entitlements TO clubadmin_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON billing.plans, billing.plan_entitlements TO clubadmin_app;
GRANT SELECT ON billing.plans, billing.plan_entitlements TO clubadmin_retention;
SELECT app.enable_updated_at('billing.plans'), history.enable_history('billing.plans');
SELECT app.enable_updated_at('billing.plan_entitlements'), history.enable_history('billing.plan_entitlements');
--> statement-breakpoint

-- Club billing data: isolated per club; within the club only club managers
-- and treasurers read it; operators read and change all of it (never member
-- data); jobs (entitlements, invoicing) work across clubs. Nothing is deleted.
DO $billing$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing.subscriptions', 'billing.invoices', 'billing.invoice_lines'] LOOP
    PERFORM app.enable_tenant_rls(t::regclass);
    PERFORM app.enable_updated_at(t::regclass);
    PERFORM history.enable_history(t::regclass);
    EXECUTE format(
      'CREATE POLICY operator_access ON %s USING (app.is_platform_operator()) WITH CHECK (app.is_platform_operator())', t);
    EXECUTE format(
      'CREATE POLICY billing_readers ON %s AS RESTRICTIVE FOR SELECT TO clubadmin_app '
      'USING (app.is_system() OR app.is_platform_operator() OR app.has_club_role(ARRAY[''club_manager'', ''treasurer'']))', t);
    EXECUTE format(
      'CREATE POLICY billing_writers ON %s AS RESTRICTIVE FOR INSERT TO clubadmin_app '
      'WITH CHECK (app.is_system() OR app.is_platform_operator())', t);
    EXECUTE format(
      'CREATE POLICY billing_updaters ON %s AS RESTRICTIVE FOR UPDATE TO clubadmin_app '
      'USING (app.is_system() OR app.is_platform_operator())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO clubadmin_app', t);
    EXECUTE format('REVOKE DELETE ON %s FROM clubadmin_app', t);
  END LOOP;
END
$billing$;
