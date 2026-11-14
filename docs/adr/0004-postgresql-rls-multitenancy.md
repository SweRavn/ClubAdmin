# 0004 — PostgreSQL, Drizzle, shared-schema multi-tenancy with RLS

**Status:** Accepted

**Context.** Thousands of clubs on the hosted service; a cross-club leak would
be catastrophic. Self-hosters need one database to operate.

**Decision.**
- PostgreSQL 18+ (built-in `uuidv7()`) as the only system of record (also for
  jobs and search initially). *(Amended before implementation: 17+ → 18+.)*
- Drizzle ORM and SQL migrations (forward-only, expand/contract).
- Shared schema; club-owned tables have `club_id`; RLS policies on all of them
  based on `SET LOCAL app.club_id` / `app.person_id` inside each request
  transaction.
- DB roles: `clubadmin_owner` (migrations), `clubadmin_app` (no BYPASSRLS),
  `clubadmin_operator` (audited tooling).
- UUIDv7 primary keys (index-friendly, sortable).

**Consequences.** Two independent barriers (policies + RLS). Every request needs
a transaction; compatible with PgBouncer transaction mode. Cross-club features
(people across clubs, plan library) need explicit global tables and policies.
Schema-per-tenant was rejected (migration cost, connection overhead at scale).
