# 0045 — Billing: invoices issued by ClubAdmin, calendar periods, VAT by seller, dunning to read-only

**Status:** Accepted (P1.13 part A; decisions with the maintainer on
2026-11-08, all as recommended). Builds on ADR 0013 (hosted and
self-hosted from one codebase; non-payment leads to read-only, never
deletion) and ADR 0031 (entitlements, the club access state and the
billing skeleton), which it amends. Part B (the card provider) follows.

**Context.** The hosted service charges clubs for plans and add-ons
(ADR 0031). Swedish associations expect an invoice with bankgiro and an
OCR reference; Swedish law (mervärdesskattelagen 2023:200,
Bokföringslagen) sets what an invoice contains, that it is never changed
after issue and that it is kept for seven years. Billing is optional
(CLAUDE.md rule 11): self-hosted installations with `BILLING_ENABLED=false`
must see nothing of it. Clubs invoicing their members is a separate,
later module (Phase 3) and is not touched here.

**Decision.**

- **ClubAdmin issues the invoices**, not the payment provider: one ledger
  for invoice and card payers, the same documents and numbers, and no
  provider needed for the invoice method (self-hosters who charge their
  clubs can use it with nothing external). The ledger lives in
  `@clubadmin/db` (`ledger`): the API (operators: payments, credit notes)
  and the worker (`billing:daily`, the selection handler) run the same
  code in the caller's transaction, in the club's tenant, as a system job
  or an operator.
- **Seller** from configuration (`BILLING_SELLER_*`, required in production
  with billing on; a fictional demo seller otherwise). The seller and buyer
  are snapshotted on the invoice at issue, so later changes never alter an
  issued document.
- **Periods** are calendar months or years in the club's time zone. The
  first period is prorated by day; invoices are issued in advance on the
  first day of a period (by the daily job), once per subscription and
  period (unique index). **Upgrades** (a base plan at least as expensive,
  added add-ons, nothing removed, the same billing period) apply at once:
  the difference for the rest of the period goes on the next period's
  invoice (a draft invoice holds it), or, when the current period was free,
  a prorated invoice is issued at once. **Downgrades**, removed add-ons, a
  change of billing period and cancellations apply at the period end. No
  refunds; corrections are credit notes by operators.
- **Club managers choose, the worker applies.** A club manager (MFA,
  terms accepted, complete billing details for a paid plan) writes only the
  selection columns of the subscription (a guard trigger refuses other
  columns for anyone but jobs and operators) and publishes
  `billing.subscription.changed` (`selected`); the worker's handler runs the
  ledger for the club at once. The daily job does the same for anything
  due (trial end, period end), so a lost event delays, never loses, a
  change.
- **Trials** end on `BILLING_TRIAL_PLAN` (default `BILLING_DEFAULT_PLAN`):
  reminders 7 and 1 days before; at the end the selected plan when it can
  be invoiced, otherwise the default plan, never read-only.
- **VAT** by a pure `vatFor(seller, buyer)` (`@clubadmin/shared`): the
  seller's rate (configuration, basis points) for buyers in the seller's
  country; reverse charge for EU buyers with a VAT number; outside the
  scope for buyers outside the EU. Paid plans only for clubs in the
  seller's country (decision 5, until the Norwegian VOEC question is
  settled). VAT is computed per line and rounded half away from zero; the
  totals are the sums of the lines (tests).
- **Numbers and immutability.** One gapless series per seller
  (`billing.invoice_number_series`, taken under its row lock in the issuing
  transaction; credit notes in the same series), prefix from configuration.
  A trigger refuses changes to an issued invoice except its status, payment,
  dunning and PDF columns, and changes to its lines. The OCR reference is
  the number's digits with a length digit and a Luhn check digit.
- **Payments** (`billing.payments`): operators record bank payments
  (idempotent by the bank reference); an invoice is paid when succeeded
  payments and credit notes cover it. Card payments arrive in part B
  through the `PaymentProvider` interface and `billing.provider_events`.
- **Dunning** (decision 8): due 30 days after issue; day 1 overdue: first
  reminder and `past_due` (banner for managers and treasurers, full access);
  day 14: second reminder naming the read-only date; day 30: `read_only`
  with `clubs.access_state_source = billing`. Paying everything overdue
  restores `active` at once. A restriction an operator set
  (`access_state_source = operator`) is never lifted by a payment. No new
  invoices are issued while a club is read-only; nothing is ever deleted
  for non-payment.
- **Documents and email.** The worker renders the PDF with `pdfkit` (MIT) in
  the account's invoice language, stores it under
  `billing/<club>/<invoice>.pdf` with its SHA-256 (eight-year lifecycle
  rule), and emails it as an attachment to the club's invoice address
  (invoices, credit notes, reminders); with `BILLING_INVOICE_EMAIL_LINK=true`
  the email also links to the billing page (login required; never a
  public or pre-signed link in an email). Club managers and treasurers get
  catalogue notices (`club_admin`, mandatory email).
- **Operators** read billing across clubs, and clubs by name, country and
  access state only through `billing.club_refs` (never member data); the
  daily job finds the clubs with work through `billing.due_clubs` (system
  jobs only), then works club by club, one transaction each.
- **Retention.** Invoices, credit notes, lines, payments and PDFs are kept
  seven years after the end of the invoice's calendar year
  (`billing:retention`, yearly, through the retention role that sees every
  club, as the other retention jobs; not a separate `SECURITY DEFINER`
  function). Billing contact fields are cleared when no records remain.

**Consequences.** Billing stays invisible with billing off: the module,
routes, jobs and handlers are not loaded and the web and app show nothing
(`billingEnabled`). The first period is cheaper and an upgrade costs the
difference only, which is fair and explainable on the invoice. Operators
need no database access to run the service (console, CSV exports for the
books). Bank reconciliation stays manual until BgMax files or open banking
are added; e-invoicing (Peppol) and bookkeeping integrations are later.
