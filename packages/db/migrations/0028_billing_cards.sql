-- Card payments (P1.13 part B, ADR 0045): the club's saved card at the
-- provider, charge attempts of card invoices (issue, then days 1, 3 and 7),
-- and the lookup of due charges for the daily job. Payment terms and
-- dunning are those of invoices (30 days); after the last failed attempt
-- the club pays by bankgiro or the pay link.

ALTER TABLE billing.accounts ADD COLUMN provider_payment_method_id text;

ALTER TABLE billing.invoices
  ADD COLUMN card_attempts smallint NOT NULL DEFAULT 0
    CONSTRAINT invoices_card_attempts CHECK (card_attempts BETWEEN 0 AND 10),
  ADD COLUMN next_card_attempt_at timestamptz;
CREATE INDEX invoices_card_due_idx ON billing.invoices (next_card_attempt_at)
  WHERE status = 'open' AND next_card_attempt_at IS NOT NULL;
--> statement-breakpoint

-- Card invoices whose next attempt has come, across clubs (system jobs only).
CREATE FUNCTION billing.due_card_charges(p_now timestamptz, p_limit integer)
  RETURNS TABLE (club_id uuid, invoice_id uuid)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM set_config('app.lookup', 'billing_due', true);
  RETURN QUERY
  SELECT i.club_id, i.id FROM billing.invoices i
  WHERE i.status = 'open' AND i.next_card_attempt_at <= p_now
  ORDER BY i.next_card_attempt_at, i.id
  LIMIT p_limit;
  PERFORM set_config('app.lookup', '', true);
END
$$;
REVOKE ALL ON FUNCTION billing.due_card_charges(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.due_card_charges(timestamptz, integer) TO clubadmin_app;
