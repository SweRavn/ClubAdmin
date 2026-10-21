-- Seed mode (P0.8, ADR 0026): the demo seed replays changes with past times
-- so the History panel has content. Only a database with a row in
-- app_meta.seed_mode honours app.seed_time / app.seed_skip_history; the row is
-- written by `pnpm db:reset` / `pnpm db:seed` as superuser in development and
-- never exists in production. The app roles cannot write it.
CREATE TABLE app_meta.seed_mode (
  enabled boolean PRIMARY KEY DEFAULT true CHECK (enabled),
  set_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_meta.seed_mode FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.seed_mode() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM app_meta.seed_mode) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION history.capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  SET enable_nestloop = off
  AS $$
DECLARE
  -- v_ prefix: never collide with columns of the audited table.
  v_redacted text[] := CASE WHEN TG_NARGS > 0 THEN TG_ARGV[0]::text[] ELSE '{}'::text[] END;
  -- Ignored columns: an UPDATE changing only these (and updated_at) writes no history row.
  v_ignored text[] := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1]::text[] ELSE '{}'::text[] END;
  v_marker CONSTANT jsonb := to_jsonb('[changed]'::text);
  v_actor_kind text := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'db_role');
  v_table text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  -- The clubs table is keyed by id; its history belongs to that club.
  v_club_is_id boolean := TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'clubs';
  v_person uuid := nullif(current_setting('app.person_id', true), '')::uuid;
  v_on_behalf_of uuid := nullif(current_setting('app.on_behalf_of', true), '')::uuid;
  v_request text := nullif(current_setting('app.request_id', true), '');
  v_transaction bigint := pg_current_xact_id()::text::bigint;
  -- Seeding only (app.seed_mode()): replayed changes carry their past time,
  -- and backdating a seeded row's validity writes no history of its own.
  v_seed boolean := app.seed_mode();
  v_changed_at timestamptz := CASE
    WHEN v_seed AND nullif(current_setting('app.seed_time', true), '') IS NOT NULL
      THEN current_setting('app.seed_time', true)::timestamptz
    ELSE now()
  END;
BEGIN
  IF v_seed AND current_setting('app.seed_skip_history', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF session_user = 'clubadmin_operator' AND v_actor_kind IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'clubadmin_operator must set app.actor_kind = ''operator'' and app.person_id before changing data';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role,
      changed_at
    )
    SELECT v_table, nr.id,
           CASE WHEN v_club_is_id THEN nr.id ELSE (n.j ->> 'club_id')::uuid END,
           'UPDATE', d.cols, d.old_vals, d.new_vals,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user, v_changed_at
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
      WHERE e.key <> 'updated_at' AND NOT e.key = ANY (v_ignored)
        AND e.value IS DISTINCT FROM o.j -> e.key
    ) AS d
    WHERE d.cols IS NOT NULL;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role,
      changed_at
    )
    SELECT v_table, (n.j ->> 'id')::uuid,
           (CASE WHEN v_club_is_id THEN n.j ->> 'id' ELSE n.j ->> 'club_id' END)::uuid,
           'INSERT', d.cols, NULL, d.vals,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user, v_changed_at
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
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role,
      changed_at
    )
    SELECT v_table, (o.j ->> 'id')::uuid,
           (CASE WHEN v_club_is_id THEN o.j ->> 'id' ELSE o.j ->> 'club_id' END)::uuid,
           'DELETE', d.cols, d.vals, NULL,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user, v_changed_at
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
