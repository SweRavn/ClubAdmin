# 0040 — Responsiveness: request budgets independent of hardware, one connection per request, cache-first apps

**Status:** Accepted.

**Context.** Responsiveness for the person using ClubAdmin is the main
quality goal, and most people will use the mobile app. The production
environment is not decided (hosted service or a club's own server), so
timings measured on CI machines say little about it. What can be measured
anywhere is how much work a request causes: how many SQL statements and how
many database pages (8 KB blocks) they read, and whether that grows with the
amount of data. The planning size is 1,000 clubs with about 120 members
each (the `load` scenario: 1,000 clubs, about 200,000 people with parents).
Measuring this exposed requests whose cost grew with all events in the
system, a query plan that walked other people's notifications, and a
request that held two database connections at once.

**Decision.**

- **Request budgets.** `apps/api/src/request-budgets.integration.test.ts`
  measures every endpoint the mobile app calls (checked against the app's
  source) through the HTTP stack, as the app role with row-level security,
  with Valkey and one warm database connection: the SQL statements
  (`pg_stat_statements`, top level, without transaction control) and the
  pages they read. Each endpoint has a budget for both. It measures on the
  demo data and again after adding 40 load clubs and the club of 10,000
  members: the statements must be the same and the pages must not grow
  with the data (at most half again plus ten pages). These numbers do not
  depend on the machine.
- **Queries start from the person.** A request for one person, club or
  group starts from their rows through an index (memberships, group
  members, registrations, the inbox) and joins outwards; it never filters a
  whole table (events, notifications) by conditions on the person.
- **One connection per request at a time.** A transaction is never opened
  inside another (`withSystem` inside `withActor`): it holds two pool
  connections for one request, and under load requests wait on each other.
  `@clubadmin/db` throws outside production when it happens.
- **Policies compare with arrays computed once.** Row-level security that
  asked `app.has_club_relationship(club_id)` for every row (four or five
  lookups each) now compares with `app.related_club_ids()`, computed once
  per statement (migration 0019); the same rules, read with the caller's
  own row-level security.
- **Planner statistics** are part of the schema where ANALYZE's sample
  misleads the planner (`n_distinct` on `notifications.recipient_person_id`,
  migration 0018).
- **Cache-first apps.** The app persists its query cache (encrypted, 30
  days) and shows it at once; it prefetches the coming week's activities
  with their answers and the events on the schedule while it is open and
  online (`apps/mobile/src/state/prefetch.ts`, at most 12 activities, fresh
  for 10 minutes); a push notification refreshes the inbox and the
  schedule; answers and attendance go through the offline outbox (ADR
  0035).
- **Development tooling.** `pnpm db:seed --scenario load --size n --add`
  adds load clubs on top of the demo data, to look at plans and request
  costs with the demo personas on volume; `DATABASE_POOL_MAX` sets the API's
  connections.

**Consequences.**

- A change that adds a statement or makes a request read more pages fails
  the test, and the budget is raised only with a reason in the review.
- Concurrency (many people at once) still needs load tests on a production
  sized machine once it is chosen (k6, issue #10); the budgets keep the work
  per request small and flat so that those tests start from a good place.
- Prefetching costs requests while the app is open (at most about 25 per
  refresh of the schedule, then nothing for 10 minutes), in exchange for
  taps that do not wait for the network.
