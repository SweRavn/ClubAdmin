# 0006 — In-process relationship-based authorization

**Status:** Accepted

**Context.** Permissions depend on relationships: role in club, function in
team, guardian of child, employee. Simple role lists cannot express "parent of
a player in team T". External engines (OpenFGA, SpiceDB) add a network hop on
every check, which conflicts with performance budgets, and add a service for
self-hosters.

**Decision.** An `authorization` module in the API:
- relationships are read from the core tables (memberships, roles, team
  memberships, guardianships, employments) into a per-person relationship set,
  one query, cached in Valkey with a version counter bumped on change;
- permissions are declared in code as policies (`can(actor, 'activity.update', activity)`),
  each with allow/deny tests;
- every controller method must declare a policy (enforced by a lint rule and a
  startup check);
- guardian actions carry `actor` and `on_behalf_of`.

The model is kept close to Zanzibar/OpenFGA concepts so it can move to an
external engine if ever needed.

**Consequences.** Fast checks (memory), no extra service. We own the correctness
of the engine, so it gets thorough tests.
