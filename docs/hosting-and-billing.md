# Hosting and billing

## Two ways to run ClubAdmin

| | Hosted service | Self-hosted |
|---|---|---|
| Who runs it | The project operator | A federation, municipality, large club or company |
| Target users | Most clubs (no technical skills needed) | Organisations with their own IT operations |
| Tenancy | Many clubs in one installation | One or many clubs |
| Billing | Optional; can charge clubs | Off by default (`BILLING_ENABLED=false`) |
| Updates | Continuous | Tagged releases, semantic versioning, migration notes |
| Support | Operator | Community / own staff |

Both run the **same code and the same images**. Nothing in the hosted service is
closed source (AGPL-3.0).

## Configuration

Everything is configured by environment variables (documented in
`.env.example`). Key flags:

| Variable | Default | Meaning |
|---|---|---|
| `DEPLOYMENT_MODE` | `self_hosted` | `hosted` enables public club sign-up, operator console |
| `BILLING_ENABLED` | `false` | Enables plans, subscriptions, invoices, payment provider |
| `USER_SIGNUP` | `open` | `open`: anyone can create an account; `invite_only`: accounts only via invitation |
| `CLUB_CREATION` | `open` if hosted, else `operators_only` | `open`: any signed-up person can create a club and becomes its manager; `approval`: operator approves new clubs; `operators_only` |
| `DEFAULT_COUNTRY` | `SE` | Country pack for new clubs |
| `FEATURE_*` | `true` | Turn a feature off for the whole installation: `FEATURE_CHAT`, `FEATURE_CALENDAR_FEEDS`, `FEATURE_STREAMING`, `FEATURE_DOCUMENTS`, `FEATURE_FINANCE`, `FEATURE_SPONSORS`. Its routes then answer 404 |
| `BILLING_DEFAULT_PLAN` | `free` | Billing on: plan key for clubs without a (current) subscription, and the plan of a new club's trial |
| `BILLING_TRIAL_DAYS` | `30` | Billing on, hosted: length of the trial a new club starts with |

## Billing module design

Billing must be easy to ignore. It is built in two layers (ADR 0013, ADR 0031):

1. **Entitlements** (always present, `apps/api/src/modules/entitlements`).
   The rest of the code asks `EntitlementsService.has(clubId, "streaming")`,
   `.limit(clubId, "storage_gb")` or `.snapshot(clubId)`, or declares
   `@RequiresEntitlement("streaming")` on an endpoint; never the billing
   tables (CLAUDE.md rule 11). The catalogue is in
   `packages/shared/src/entitlements.ts`:

   | Features | Limits |
   |---|---|
   | `chat`, `calendar_feeds`, `streaming`, `documents`, `finance`, `sponsors` | `members_max`, `storage_gb`, `streaming_hours` (null: unlimited) |

   - With billing disabled (`FlagsEntitlements`), every feature enabled by its
     `FEATURE_*` flag is granted, with no limits.
   - With billing enabled (`PlanEntitlements`), entitlements come from the
     club's plan plus add-ons: a feature is granted if one of them enables it,
     a limit is the highest value among them (a limit no plan sets is
     unlimited). Without a subscription, or a cancelled one, the default plan
     (`BILLING_DEFAULT_PLAN`) applies.
   - A feature switched off with `FEATURE_*=false` is off in both modes, and
     its routes answer `404 not-found`. A feature the plan does not include
     answers `402 entitlement-required` (apps show an upgrade hint).
   - Results are cached per API instance (no database query per request;
     `has()` well under 0.1 ms) and invalidated on every change of plan,
     subscription status or access state, on all instances through Valkey.
   - `GET /api/v1/clubs/:clubId/entitlements` (anyone related to the club)
     lets apps adapt their UI.
2. **Club access state** (always present): `clubs.access_state` is `active`,
   `read_only` or `suspended`. Read-only clubs refuse every change
   (`409 club-read-only`); suspended clubs refuse everything
   (`409 club-suspended`); **exports always work** (endpoints declared with
   `clubAccess: "export"`), and nothing is ever deleted. Only operators change
   it (`PUT /api/v1/clubs/:clubId/access-state`, with a second factor); with
   billing on, the subscription status also sets it.
3. **Billing** (optional module, `apps/api/src/modules/billing`, loaded only
   when `BILLING_ENABLED=true`; its tables exist in every installation and
   stay empty without it):
   - `billing.plans` (key, name, `base` or `add_on`, price per period in
     integer minor units with an ISO 4217 currency) and
     `billing.plan_entitlements` (what each plan grants),
   - `billing.subscriptions` (one per club: plan, add-ons, status
     `trial` → `active` → `past_due` → `read_only` → `cancelled`, trial end,
     period),
   - `billing.plan_prices` (active prices per plan, currency and period,
     excluding VAT; added or deactivated, never edited), `billing.accounts`
     (the club's billing details: legal name, organisation number checked by
     the country pack, VAT number, address, invoice email, reference,
     invoice language, payment method, accepted terms version),
   - `billing.invoices` and `billing.invoice_lines` (issued by the ledger,
     ADR 0045: VAT per line, seller and buyer snapshots, a gapless number,
     Bankgiro OCR reference, immutable after issue; credit notes in the same
     series), `billing.payments` (bank payments recorded by operators; card
     in part B) and `billing.invoice_number_series`,
   - **plans and choice** (P1.13): club managers choose a plan, add-ons and
     monthly or yearly billing with a second factor and the terms accepted;
     upgrades apply at once (the difference prorated on the next invoice),
     downgrades, period changes and cancellations at the period end;
     treasurers and club managers keep the billing details,
   - **periods** are calendar months or years in the club's time zone; the
     first is prorated by day; invoices are issued on the first day of a
     period by `billing:daily` (04:41 UTC), which also ends trials (7- and
     1-day reminders; at the end the chosen plan, else the default plan) and
     steps through dunning,
   - **the invoice** is rendered as a PDF (`pdfkit`) in the account's
     language, stored in the files bucket (`billing/`, eight-year lifecycle
     rule) and emailed as an attachment to the invoice address (credit notes
     and reminders too); `BILLING_INVOICE_EMAIL_LINK=true` adds a link to the
     club's billing page (login required). Club managers and treasurers get
     notices for new invoices, reminders, past due, read-only and restored;
     club managers for the trial's end,
   - **dunning** (decision 8): due 30 days after issue; day 1 overdue:
     reminder and `past_due` (a banner for managers and treasurers, full
     access); day 14: second reminder with the read-only date; day 30:
     `read_only` (`clubs.access_state_source = billing`, every member sees
     the banner, exports work). Paying everything overdue restores `active`
     at once; a restriction an operator set is never lifted by a payment,
   - a trial on `BILLING_TRIAL_PLAN` (default `BILLING_DEFAULT_PLAN`) for every
     new club on the hosted service (worker, on `club.created`),
   - the club's billing page `/clubs/<club>/billing` (plan and status,
     choosing, details, invoices and PDFs, payment instructions with copy
     buttons) and the operator console `/ops/billing` (subscriptions with
     filters, latest invoices and payments, CSV exports for bookkeeping,
     plans; per club: assign a plan, change the status, extend the trial,
     record a bank payment, credit note, resend). The mobile app shows the
     read-only and past-due notices as text only (no plans or payments in
     the app),
   - operator routes: `GET/POST /api/v1/billing/plans`,
     `PATCH /api/v1/billing/plans/:planId`, `GET /api/v1/billing/subscriptions`,
     `GET /api/v1/billing/invoices` (and `.csv`), `GET /api/v1/billing/payments`
     (and `.csv`), `POST /api/v1/billing/invoices/:invoiceId/payments`,
     `/credit-note`, `/resend`, `PUT /api/v1/clubs/:clubId/subscription`,
     `/status` and `/trial`; club routes: `GET /api/v1/clubs/:clubId/subscription`,
     `/billing/plans`, `/billing/account` (and `PUT`), `/invoices`,
     `/invoices/:invoiceId` (and `/pdf`), `PUT /subscription/selection`,
     `POST /subscription/cancel` and `/resume`, `POST /billing/payment-method`,
   - **retention**: invoices, credit notes, lines, payments and PDFs are
     accounting records, kept seven years after the end of the invoice's
     year (`billing:retention`, yearly) — **never delete club data for
     non-payment**; export always remains available,
   - `PaymentProvider` for cards (Stripe) follows in P1.13 part B.

### Seller configuration (billing on)

| Variable | Meaning |
|---|---|
| `BILLING_SELLER_NAME`, `_ORGANIZATION_NUMBER`, `_STREET`, `_POSTAL_CODE`, `_CITY`, `_BANKGIRO` | Required in production with billing on (the API and worker refuse to start without them) |
| `BILLING_SELLER_VAT_NUMBER`, `_EMAIL`, `_COUNTRY` (default `SE`), `_F_TAX` | Printed on invoices ("Godkänd för F-skatt") |
| `BILLING_INVOICE_PREFIX` (default `CA-`), `BILLING_VAT_RATE_BP` (2500), `BILLING_PAYMENT_TERMS_DAYS` (30) | Number series, VAT rate, payment terms |
| `BILLING_TERMS_VERSION`, `BILLING_TERMS_URL` | The terms a club manager accepts when choosing a paid plan |
| `BILLING_TRIAL_PLAN`, `BILLING_TRIAL_DAYS` | The trial |
| `BILLING_INVOICE_EMAIL_LINK` (default false) | Invoice emails also link to the billing page |

Development and tests use a fictional seller (`DEMO_SELLER`); the maintainer
supplies the real values before the hosted service charges anyone.

Billing data concerns the club as a customer (organisation), not its members,
and is separated from club data with its own permissions (`club_manager` /
`treasurer` see their club's subscription and invoices; operators see billing
but not member data; row-level security enforces both). The billing tables
reference no person (a test guards this). Operator actions are audited
(`billing.subscription.*`, `club.access_state.changed`).

Note: *member fees* (clubs charging their own members) are a separate feature in
the `finance` module, available regardless of `BILLING_ENABLED`.

CI runs the API integration suite twice, with billing off and on. With
`BILLING_ENABLED=true`, `pnpm db:seed` also gives the demo plans (monthly and
yearly prices): SVK on Standard with the Streaming add-on, billing details
and three invoices (two paid, one late after a reminder, the current one
open) and a credit note; IKN on Free; FIL in a trial ending in ten days.
See ADR 0045.

## Hosted service: suggested setup

- EU providers only. Example: application and database at one EU provider
  (e.g. Hetzner, UpCloud, Scaleway, or Swedish Elastx/Safespring), backups at a
  **different** provider in another EU country.
- Start: 2 app nodes, managed or replicated PostgreSQL (primary + streaming
  replica), Valkey, object storage, CDN. Docker Compose per node, deployments
  via CI. Move to Kubernetes only when scale requires it.
- Status page, uptime monitoring, published sub-processor list, DPA template.

## Self-hosting: what we provide

- `infra/docker/compose.yml` with all services, including Zitadel, object
  storage (Garage), Valkey, Caddy with automatic TLS, backup sidecar.
- `docs/self-hosting.md` (Phase 0): requirements (e.g. 4 vCPU / 8 GB RAM for
  ~5,000 members), install, upgrade, backup/restore, monitoring.
- An installer CLI (`clubadmin-setup`) that generates secrets and the `.env`.
