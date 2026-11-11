-- P1.15 A1 follow-up (ADR 0046): the policies recreated in 0030 called
-- app.holds_permission(...) once per row (a function with its own
-- search_path is never inlined), so reading a club's invoices grew with the
-- number of rows. As an uncorrelated subquery it is an InitPlan, evaluated
-- once per statement: the caller's permission does not depend on the row.

DO $billing$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing.subscriptions', 'billing.invoices', 'billing.invoice_lines',
      'billing.accounts', 'billing.payments'] LOOP
    EXECUTE format('DROP POLICY billing_readers ON %s', t);
    EXECUTE format(
      'CREATE POLICY billing_readers ON %s AS RESTRICTIVE FOR SELECT TO clubadmin_app '
      'USING (app.is_system() OR app.is_platform_operator() '
      'OR (SELECT app.holds_permission(app.current_club_id(), ''billing.invoices.read'')))', t);
  END LOOP;
END
$billing$;
DROP POLICY billing_writers ON billing.accounts;
CREATE POLICY billing_writers ON billing.accounts AS RESTRICTIVE FOR INSERT TO clubadmin_app
  WITH CHECK (app.is_system() OR app.is_platform_operator()
    OR (SELECT app.holds_permission(app.current_club_id(), 'billing.account.manage')));
DROP POLICY billing_updaters ON billing.accounts;
CREATE POLICY billing_updaters ON billing.accounts AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator()
    OR (SELECT app.holds_permission(app.current_club_id(), 'billing.account.manage')));
DROP POLICY billing_updaters ON billing.subscriptions;
CREATE POLICY billing_updaters ON billing.subscriptions AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator()
    OR (SELECT app.holds_permission(app.current_club_id(), 'billing.subscription.change')));
DROP POLICY invitation_access ON public.guardian_invitations;
CREATE POLICY invitation_access ON public.guardian_invitations
  USING (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
    OR (club_id IS NOT NULL AND club_id = app.current_club_id()
      AND (SELECT app.holds_permission(app.current_club_id(), 'club.guardians.manage')))
  )
  WITH CHECK (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
    OR (club_id IS NOT NULL AND club_id = app.current_club_id()
      AND (SELECT app.holds_permission(app.current_club_id(), 'club.guardians.manage')))
  );
