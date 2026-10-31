DROP INDEX "notification_deliveries_receipts_idx";--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "session_handle" text;--> statement-breakpoint
CREATE INDEX "notification_deliveries_push_sent_idx" ON "notification_deliveries" USING btree ("sent_at") WHERE "notification_deliveries"."channel" = 'push' AND "notification_deliveries"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "push_devices_session_idx" ON "push_devices" USING btree ("session_handle") WHERE "push_devices"."session_handle" IS NOT NULL;--> statement-breakpoint

-- Hand-written (P1.7, ADR 0039). A device remembers the app's login session
-- (the handle in the sessions list), so ending that session from the list
-- removes the device. A new signature: the four-argument function stays for
-- API instances that run during the deployment (expand/contract).
CREATE FUNCTION app.claim_push_device(p_token_hash text, p_token_sealed text, p_platform text,
    p_app_variant text, p_session_handle text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_account FROM public.accounts WHERE person_id = app.current_person_id();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'no account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.push_devices (account_id, token_hash, token_sealed, platform, app_variant,
    session_handle)
  VALUES (v_account, p_token_hash, p_token_sealed, p_platform, p_app_variant, p_session_handle)
  ON CONFLICT (token_hash) DO UPDATE
    SET account_id = EXCLUDED.account_id, token_sealed = EXCLUDED.token_sealed,
        platform = EXCLUDED.platform, app_variant = EXCLUDED.app_variant,
        session_handle = EXCLUDED.session_handle, last_seen_at = now(), disabled_at = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION app.claim_push_device(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_push_device(text, text, text, text, text) TO clubadmin_app;
--> statement-breakpoint

-- The inbox (P1.7): ANALYZE's sample sees far fewer recipients than there are
-- (a few dozen notices each among millions), so the planner expected
-- thousands of rows per recipient and walked the primary key backwards past
-- other people's notices. About one recipient per 40 notices.
ALTER TABLE public.notifications ALTER COLUMN recipient_person_id SET (n_distinct = -0.025);
