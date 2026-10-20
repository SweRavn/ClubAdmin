-- SPDX-License-Identifier: AGPL-3.0-only
-- Foundation: schemas, request context, tenant isolation helpers, record
-- history (ADR 0017), audit events, transactional outbox and the deletion
-- ledger. Runs as clubadmin_owner (see packages/db/src/migrate.ts).

CREATE SCHEMA app;
CREATE SCHEMA history;
CREATE SCHEMA audit;
CREATE SCHEMA outbox;
CREATE SCHEMA privacy;

GRANT USAGE ON SCHEMA public, app, history, audit, outbox, privacy
  TO clubadmin_app, clubadmin_operator, clubadmin_retention;

-- New application tables in `public` are readable and writable by the app
-- roles; row-level security decides which rows.
ALTER DEFAULT PRIVILEGES FOR ROLE clubadmin_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clubadmin_app, clubadmin_operator;
ALTER DEFAULT PRIVILEGES FOR ROLE clubadmin_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO clubadmin_app, clubadmin_operator;
ALTER DEFAULT PRIVILEGES FOR ROLE clubadmin_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO clubadmin_retention;

-------------------------------------------------------------------------------
-- Request context: transaction-local settings written by withTenant/withActor/
-- withSystem (set_config(..., true)), so PgBouncer transaction pooling works.
-------------------------------------------------------------------------------

CREATE FUNCTION app.setting(name text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting(name, true), '') $$;

CREATE FUNCTION app.current_club_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT app.setting('app.club_id')::uuid $$;

CREATE FUNCTION app.current_person_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT app.setting('app.person_id')::uuid $$;

CREATE FUNCTION app.current_on_behalf_of() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT app.setting('app.on_behalf_of')::uuid $$;

CREATE FUNCTION app.current_actor_kind() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT app.setting('app.actor_kind') $$;

CREATE FUNCTION app.current_request_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT app.setting('app.request_id') $$;

-------------------------------------------------------------------------------
-- Table helpers, called from migrations:
--   SELECT app.enable_tenant_rls('public.groups');
--   SELECT app.enable_updated_at('public.groups');
--   SELECT history.enable_history('public.groups', redact => ARRAY['secret_column']);
-------------------------------------------------------------------------------

CREATE FUNCTION app.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION app.enable_updated_at(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = 'updated_at' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '% has no updated_at column', target;
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', target);
  EXECUTE format(
    'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
    target
  );
END
$$;

-- Tenant isolation (CLAUDE.md rule 1): rows are visible and writable only
-- within the club set by withTenant. FORCE applies the policy to the table
-- owner too. Retention jobs work across clubs.
CREATE FUNCTION app.enable_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = target AND attname = 'club_id' AND atttypid = 'uuid'::regtype AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '% has no club_id uuid column', target;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (club_id = app.current_club_id()) '
    'WITH CHECK (club_id = app.current_club_id())',
    target
  );
  EXECUTE format('DROP POLICY IF EXISTS retention_access ON %s', target);
  EXECUTE format(
    'CREATE POLICY retention_access ON %s TO clubadmin_retention USING (true) WITH CHECK (true)',
    target
  );
END
$$;

-------------------------------------------------------------------------------
-- Record history (ADR 0017)
-------------------------------------------------------------------------------

CREATE TABLE history.record_changes (
  id uuid NOT NULL DEFAULT uuidv7(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  club_id uuid,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_columns text[] NOT NULL,
  old_values jsonb,
  new_values jsonb,
  actor_person_id uuid,
  on_behalf_of_person_id uuid,
  actor_kind text NOT NULL,
  request_id text,
  transaction_id bigint NOT NULL,
  db_role text NOT NULL,
  PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

COMMENT ON TABLE history.record_changes IS
  'Who changed what, when: one row per inserted, updated or deleted record (ADR 0017). Partitioned by month.';

CREATE INDEX record_changes_record_idx ON history.record_changes (table_name, record_id, changed_at DESC, id DESC);
CREATE INDEX record_changes_club_idx ON history.record_changes (club_id, changed_at DESC);

-- Safety net: if partition maintenance has not run, rows land here instead of
-- failing the write. history.maintain_partitions() moves them out.
CREATE TABLE history.record_changes_default PARTITION OF history.record_changes DEFAULT;

ALTER TABLE history.record_changes ENABLE ROW LEVEL SECURITY;
-- Club members see the history of their club's records (field-level filtering
-- happens in the API). History of global tables (club_id IS NULL) is only
-- reached through dedicated functions with their own checks (P0.7).
CREATE POLICY club_read ON history.record_changes FOR SELECT
  TO clubadmin_app, clubadmin_operator
  USING (club_id = app.current_club_id());
CREATE POLICY retention_all ON history.record_changes
  TO clubadmin_retention
  USING (true) WITH CHECK (true);

GRANT SELECT ON history.record_changes TO clubadmin_app, clubadmin_operator;
GRANT SELECT, UPDATE, DELETE ON history.record_changes TO clubadmin_retention;

-- Writes history rows, one set-based INSERT per statement (statement-level
-- triggers with transition tables: far cheaper than row triggers for bulk
-- changes). SECURITY DEFINER: the app roles cannot insert into the history
-- table themselves, only through this trigger.
CREATE FUNCTION history.capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  -- Transition tables have no statistics; keep the planner from choosing a
  -- nested loop for the old/new join on large updates.
  SET enable_nestloop = off
  AS $$
DECLARE
  -- v_ prefix: never collide with columns of the audited table.
  v_redacted text[] := CASE WHEN TG_NARGS > 0 THEN TG_ARGV[0]::text[] ELSE '{}'::text[] END;
  v_marker CONSTANT jsonb := to_jsonb('[changed]'::text);
  v_actor_kind text := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'db_role');
  v_table text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_person uuid := nullif(current_setting('app.person_id', true), '')::uuid;
  v_on_behalf_of uuid := nullif(current_setting('app.on_behalf_of', true), '')::uuid;
  v_request text := nullif(current_setting('app.request_id', true), '');
  v_transaction bigint := pg_current_xact_id()::text::bigint;
BEGIN
  IF session_user = 'clubadmin_operator' AND v_actor_kind IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'clubadmin_operator must set app.actor_kind = ''operator'' and app.person_id before changing data';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role
    )
    SELECT v_table, nr.id, (n.j ->> 'club_id')::uuid, 'UPDATE', d.cols, d.old_vals, d.new_vals,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user
    -- Join on the uuid id column (hash join); enable_history guarantees it exists.
    FROM new_rows AS nr
    JOIN old_rows AS orw ON orw.id = nr.id
    CROSS JOIN LATERAL (SELECT to_jsonb(nr) AS j) AS n
    CROSS JOIN LATERAL (SELECT to_jsonb(orw) AS j) AS o
    CROSS JOIN LATERAL (
      SELECT
        array_agg(e.key ORDER BY e.key) AS cols,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE o.j -> e.key END) AS old_vals,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE e.value END) AS new_vals
      FROM jsonb_each(n.j) AS e
      WHERE e.key <> 'updated_at' AND e.value IS DISTINCT FROM o.j -> e.key
    ) AS d
    WHERE d.cols IS NOT NULL; -- rows where nothing but updated_at changed are skipped
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role
    )
    SELECT v_table, (n.j ->> 'id')::uuid, (n.j ->> 'club_id')::uuid, 'INSERT', d.cols, NULL, d.vals,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user
    FROM (SELECT to_jsonb(r) AS j FROM new_rows AS r) AS n
    CROSS JOIN LATERAL (
      SELECT
        array_agg(e.key ORDER BY e.key) AS cols,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE e.value END) AS vals
      FROM jsonb_each(n.j) AS e
    ) AS d;
  ELSE
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role
    )
    SELECT v_table, (o.j ->> 'id')::uuid, (o.j ->> 'club_id')::uuid, 'DELETE', d.cols, d.vals, NULL,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user
    FROM (SELECT to_jsonb(r) AS j FROM old_rows AS r) AS o
    CROSS JOIN LATERAL (
      SELECT
        array_agg(e.key ORDER BY e.key) AS cols,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE e.value END) AS vals
      FROM jsonb_each(o.j) AS e
    ) AS d;
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION history.capture() FROM PUBLIC;

-- Attaches the history triggers. `redact` columns are stored as "[changed]"
-- (use for encrypted or sensitive columns). `skip_insert` for append-heavy
-- tables whose rows already carry created_by/created_at.
CREATE FUNCTION history.enable_history(
  target regclass,
  redact text[] DEFAULT '{}',
  skip_insert boolean DEFAULT false
) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  missing text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = target AND attname = 'id' AND atttypid = 'uuid'::regtype AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'record history needs a uuid "id" column on %', target;
  END IF;
  SELECT string_agg(r, ', ') INTO missing FROM unnest(redact) AS r
    WHERE NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = r AND NOT attisdropped);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'redacted columns do not exist on %: %', target, missing;
  END IF;

  EXECUTE format('DROP TRIGGER IF EXISTS record_history_insert ON %s', target);
  EXECUTE format('DROP TRIGGER IF EXISTS record_history_update ON %s', target);
  EXECUTE format('DROP TRIGGER IF EXISTS record_history_delete ON %s', target);
  IF NOT skip_insert THEN
    EXECUTE format(
      'CREATE TRIGGER record_history_insert AFTER INSERT ON %s REFERENCING NEW TABLE AS new_rows '
      'FOR EACH STATEMENT EXECUTE FUNCTION history.capture(%L)',
      target, redact::text
    );
  END IF;
  EXECUTE format(
    'CREATE TRIGGER record_history_update AFTER UPDATE ON %s REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows '
    'FOR EACH STATEMENT EXECUTE FUNCTION history.capture(%L)',
    target, redact::text
  );
  EXECUTE format(
    'CREATE TRIGGER record_history_delete AFTER DELETE ON %s REFERENCING OLD TABLE AS old_rows '
    'FOR EACH STATEMENT EXECUTE FUNCTION history.capture(%L)',
    target, redact::text
  );
END
$$;

-- Creates monthly partitions `months_ahead` months ahead (moving any rows for
-- those months out of the default partition) and drops partitions older than
-- `retention_months`. Called daily by the worker (history:maintain_partitions)
-- and once below.
CREATE FUNCTION history.maintain_partitions(months_ahead integer DEFAULT 3, retention_months integer DEFAULT 24)
  RETURNS TABLE (action text, partition_name text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  current_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  cutoff date := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => retention_months))::date;
  month_start date;
  lower_bound timestamptz;
  upper_bound timestamptz;
  name text;
  part record;
BEGIN
  IF months_ahead < 0 OR retention_months < 1 THEN
    RAISE EXCEPTION 'invalid arguments: months_ahead >= 0 and retention_months >= 1 required';
  END IF;

  FOR i IN 0..months_ahead LOOP
    month_start := (current_month + make_interval(months => i))::date;
    name := 'record_changes_' || to_char(month_start, 'YYYY_MM');
    IF to_regclass('history.' || name) IS NULL THEN
      lower_bound := month_start::timestamp AT TIME ZONE 'UTC';
      upper_bound := (month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      CREATE TEMP TABLE moved_rows (LIKE history.record_changes) ON COMMIT DROP;
      INSERT INTO moved_rows
        SELECT * FROM history.record_changes_default WHERE changed_at >= lower_bound AND changed_at < upper_bound;
      DELETE FROM history.record_changes_default WHERE changed_at >= lower_bound AND changed_at < upper_bound;
      EXECUTE format(
        'CREATE TABLE history.%I PARTITION OF history.record_changes FOR VALUES FROM (%L) TO (%L)',
        name, lower_bound, upper_bound
      );
      INSERT INTO history.record_changes SELECT * FROM moved_rows;
      -- expand-contract: temporary table of this function
      DROP TABLE moved_rows;
      action := 'created';
      partition_name := name;
      RETURN NEXT;
    END IF;
  END LOOP;

  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'history.record_changes'::regclass
      AND c.relname ~ '^record_changes_[0-9]{4}_[0-9]{2}$'
  LOOP
    IF to_date(substring(part.relname FROM '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM') < cutoff THEN
      -- expand-contract: retention drops expired history partitions
      EXECUTE format('DROP TABLE history.%I', part.relname);
      action := 'dropped';
      partition_name := part.relname;
      RETURN NEXT;
    END IF;
  END LOOP;

  DELETE FROM history.record_changes_default WHERE changed_at < cutoff::timestamp AT TIME ZONE 'UTC';
END
$$;

REVOKE ALL ON FUNCTION history.maintain_partitions(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history.maintain_partitions(integer, integer) TO clubadmin_app;

SELECT * FROM history.maintain_partitions(3, 24);

-------------------------------------------------------------------------------
-- Audit events: business-level "who did what" (docs/security.md). Append-only
-- for the app roles.
-------------------------------------------------------------------------------

CREATE TABLE audit.events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  created_at timestamptz NOT NULL DEFAULT now(),
  club_id uuid,
  actor_person_id uuid,
  on_behalf_of_person_id uuid,
  actor_kind text NOT NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_type text NOT NULL,
  resource_id uuid,
  changed_fields text[] NOT NULL DEFAULT '{}',
  ip_hash text,
  request_id text
);

CREATE INDEX events_club_idx ON audit.events (club_id, created_at DESC, id DESC);
CREATE INDEX events_resource_idx ON audit.events (resource_type, resource_id, created_at DESC);

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY club_read ON audit.events FOR SELECT
  TO clubadmin_app, clubadmin_operator
  USING (club_id = app.current_club_id());
CREATE POLICY club_insert ON audit.events FOR INSERT
  TO clubadmin_app, clubadmin_operator
  WITH CHECK (club_id IS NOT DISTINCT FROM app.current_club_id());
CREATE POLICY retention_all ON audit.events
  TO clubadmin_retention
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON audit.events TO clubadmin_app, clubadmin_operator;
GRANT SELECT, UPDATE, DELETE ON audit.events TO clubadmin_retention;

-------------------------------------------------------------------------------
-- Transactional outbox: domain events written in the same transaction as the
-- change. The trigger enqueues a Graphile Worker job in that transaction, so a
-- rolled-back event is never dispatched. Payloads contain IDs only.
-------------------------------------------------------------------------------

CREATE TABLE outbox.events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  created_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  club_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  dispatched_at timestamptz,
  last_error text
);

CREATE INDEX events_pending_idx ON outbox.events (created_at) WHERE status <> 'done';

-- One row per (event, handler) that has run, written in the handler's
-- transaction: a handler never runs twice for the same event.
CREATE TABLE outbox.deliveries (
  event_id uuid NOT NULL REFERENCES outbox.events (id) ON DELETE CASCADE,
  handler text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, handler)
);

CREATE FUNCTION outbox.enqueue_dispatch() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'outbox:dispatch',
    json_build_object('eventId', NEW.id),
    job_key := 'outbox:' || NEW.id::text,
    max_attempts := 10
  );
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION outbox.enqueue_dispatch() FROM PUBLIC;

CREATE TRIGGER enqueue_dispatch AFTER INSERT ON outbox.events
  FOR EACH ROW EXECUTE FUNCTION outbox.enqueue_dispatch();

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox.events, outbox.deliveries TO clubadmin_app;

-------------------------------------------------------------------------------
-- Deletion ledger: IDs of erased people, kept outside per-club exports and
-- re-applied after every restore (docs/operations/backup-restore.md).
-------------------------------------------------------------------------------

CREATE TABLE privacy.deletion_ledger (
  person_id uuid PRIMARY KEY,
  erased_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL
);

GRANT SELECT, INSERT ON privacy.deletion_ledger TO clubadmin_app, clubadmin_retention;
