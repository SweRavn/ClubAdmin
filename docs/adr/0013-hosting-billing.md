# 0013 — Hosted + self-hosted from the same code; optional billing

**Status:** Accepted

**Context.** Most clubs cannot run servers, so the maintainer will operate a
hosted service. Large organisations should be able to self-host. The business
model is undecided, but charging clubs on the hosted service must be possible.

**Decision.** One codebase and one set of images. Behaviour differs only by
configuration (`DEPLOYMENT_MODE`, `BILLING_ENABLED`, `FEATURE_*`). Features
check an `entitlements` service; when billing is disabled all enabled features
are granted without limits. The billing module (plans, subscriptions,
invoices, payment provider) is only loaded when enabled. Non-payment leads to
read-only mode, never data deletion.

**Consequences.** Self-hosters never see billing. Hosted-service code is fully
open source.
