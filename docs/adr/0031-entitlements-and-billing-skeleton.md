# 0031 — Entitlements service, club access state and the billing skeleton

**Status:** Accepted (P0.12). Implements ADR 0013.

**Context.** ADR 0013 decided that features ask an entitlements service and
that billing is an optional module. Implementing it raised questions:
how fast the check must be (it runs on many requests), how a plan change
reaches every API instance, what status codes clients get, how "read-only
on non-payment" is enforced everywhere, and how the billing module is
optional without the schema differing between installations.

**Decision.**

- **One service, two sources.** `EntitlementsService` (always loaded) asks an
  `EntitlementSource` chosen at startup: `FlagsEntitlements` (billing off:
  every feature enabled by `FEATURE_*`, no limits) or the billing module's
  `PlanEntitlements` (plan plus add-ons; features OR-ed, limits the highest,
  unset limits unlimited; the default plan without a subscription).
  `FEATURE_*=false` wins in both modes.
- **Cached per instance, invalidated by pub/sub.** Snapshots (features,
  limits, plan, subscription status, access state) are kept in memory per
  club for at most a minute; changes invalidate the entry locally and publish
  the club ID on the Valkey channel `entitlements:invalidate`, which every
  instance listens to; the worker publishes on `club.entitlements.changed`
  too. A check is a map lookup (no query per request); a change applies from
  the next request.
- **Status codes.** A feature switched off for the installation answers
  `404 not-found` (the route does not exist there); a feature the plan lacks
  `402 entitlement-required` (`detail`: the feature key); a read-only club
  `409 club-read-only` for changes; a suspended club `409 club-suspended`.
- **Access state in the request pipeline.** The `AuthGuard`, after
  authorization, checks the access state of the club of the endpoint's
  resource (club, group or person in a club) and the endpoint's
  `@RequiresEntitlement`. Endpoints declare `clubAccess: "export"` (always
  allowed) or `"exempt"` (operator endpoints that change the restriction,
  and the entitlements read itself). Reads are always allowed for read-only
  clubs. The database refuses access-state changes by anyone but operators
  and jobs (trigger on `clubs.access_state`).
- **Operators act as operators.** Operator endpoints run their transactions
  with actor kind `operator`; `app.is_platform_operator()` (registered
  operator *and* acting as one) opens the billing tables to them in
  row-level security. The same person acting as a member sees nothing.
- **Same schema everywhere.** The `billing` schema is created by migration
  0006 in every installation and stays empty with billing off; only the
  module (routes, services, the plan source) is loaded on demand. Club
  billing tables are tenant-isolated; inside a club only club managers and
  treasurers read them (restrictive policy); writes only by operators and
  jobs. They hold no person references: a billing contact, when needed,
  is declared in `billing.references.ts` for merges and erasure.
- **The OpenAPI document includes the billing routes** (generated with
  billing on), so the typed client knows them; installations without billing
  answer 404.
- **Trials on the hosted service** start in the worker on `club.created`
  (billing on, `DEPLOYMENT_MODE=hosted`), idempotently.

**Consequences.** Every request to a club's resources does one in-memory
lookup more; a club's first request per minute and instance loads the
snapshot (two small queries). A lost pub/sub message delays a change by at
most a minute. Payment providers, invoices, dunning and the trial's end are
P1.13; the interfaces (`PaymentProvider`, `InvoiceGenerator`) and the
monthly worker job are placeholders until then.
