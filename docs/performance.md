# Performance

Existing club systems are often slow. ClubAdmin aims to feel instant. These
budgets are requirements; CI measures them.

## Budgets

| Measure | Budget |
|---|---|
| API read endpoints, p95 server time | < 100 ms (< 50 ms for "my schedule", "my teams") |
| API write endpoints, p95 | < 200 ms |
| Database queries per request | ≤ 5 typical, never proportional to result size (no N+1) |
| Web: Largest Contentful Paint, mid-range phone, 4G | < 1.5 s (cached) / < 2.5 s (cold) |
| Web: Interaction to Next Paint | < 200 ms |
| Web: initial JS for member pages | < 150 KB compressed |
| Mobile: cold start to usable schedule | < 2 s; cached data shown immediately |
| Chat message delivery (online recipient) | < 300 ms |
| Calendar feed (`.ics`) request, p95 | < 50 ms (served from precomputed schedule, ETag/`304`) |

## Design rules

### Database
- Every query on a club table filters on `club_id` first; composite indexes
  start with `club_id`.
- Keyset pagination only (no `OFFSET` on large tables).
- Precomputed read models for hot screens (e.g. `person_schedule` view of upcoming
  activities per person, maintained by the worker on events) instead of
  multi-join queries on every app open.
- `pg_stat_statements` + slow-query log; CI integration tests fail on queries
  without index usage on seeded large-volume data (`pnpm db:seed --scenario load`).
- PgBouncer in transaction mode in front of Postgres for the hosted service.

### API
- Permission set loaded once per request, cached in Valkey with version
  invalidation.
- Response shaping: endpoints return what the screen needs (`include=`), not
  entire object graphs.
- ETags and `304 Not Modified`; compression (Brotli) at the proxy.
- Heavy work (emails to 500 members, exports, report generation, image
  resizing) always in the worker, never in the request.

### Web
- React Server Components and streaming for first load; client components only
  where interactive.
- TanStack Query for client cache; optimistic updates for common actions
  (attending/not attending, chat, sign-up).
- WebSocket invalidation events instead of polling.
- Images resized and served in modern formats (AVIF/WebP) via an image proxy
  (imgproxy) and CDN; lazy loaded.
- Route-level code splitting; heavy admin features (finance, reports) never in
  the member bundle.

### Mobile
- Persisted query cache (MMKV/SQLite): app shows the last known schedule
  instantly, refreshes in background.
- Offline outbox for attendance and chat messages taken without coverage
  (sports halls often have bad reception).
- Push notifications carry IDs, not data; the app fetches the data.

## Measurement

- `pnpm --filter @clubadmin/api build && pnpm --filter @clubadmin/api bench [path] [seconds] [connections]`
  measures the request pipeline (validation, problem details, logging, security
  headers, rate limiting) without a database. Baseline at P0.3 on a development
  container: `/health/live` p95 0.5 ms and p99 0.9 ms with one connection;
  about 3,000 req/s (client and server sharing one process).
- `pnpm --filter @clubadmin/db bench`: tenant transactions and record history
  on a throwaway database. Baseline at P0.4 (local Docker PostgreSQL 18):
  - `withTenant` overhead: about 0.6 ms per transaction (one round trip for
    `BEGIN` plus the context settings, one for `COMMIT`), on top of the queries.
  - Record history (statement-level triggers): inserting 10,000 rows takes
    about 0.34 s with history vs 0.05 s without (about 30 µs per row); updating
    10,000 rows about 0.8 s vs 0.09 s (about 80 µs per row, mostly comparing
    each row's columns). Single-row writes pay well under 0.1 ms. Bulk jobs that
    rewrite many rows should update only rows that actually change.

- Query plans of the hot paths (P0.5, `apps/api/src/query-plans.integration.test.ts`,
  10k rows per table, as the app role with row-level security): "my clubs"
  (`club_memberships_person_active_idx`), "my groups"
  (`group_memberships_person_idx`), "members of group"
  (`group_memberships_group_idx`), "guardians of person"
  (`guardianships_ward_idx`), "wards of person"
  (`guardianships_guardian_idx`). The test fails on sequential scans and keeps
  the plans as snapshots; the nightly job reruns it on the `load` scenario
  once P0.8 provides it.
- Authorization (P0.7, `authorization.integration.test.ts`, local Docker,
  requests injected in-process): the relationship set is one query (none with
  a warm Valkey cache); a permission check with a warm cache takes about
  0.002 ms (budget 0.2 ms); `GET /groups/:id/members` for 41 members, four of
  them protected, runs 3 queries (group scope, roster page, names; the
  protected set comes from the cache): median about 15 ms, p95 about 21 ms
  (budget 50 ms). Row-level security dominates; its helpers check one
  condition per statement (ADR 0025), which took the median from 32 ms. Queries are
  counted with `countQueries` from `@clubadmin/db/testing` (statements, not
  BEGIN/COMMIT). A role change reaches the API through the worker in well
  under a second (`worker.integration.test.ts`). The query-plans test also
  covers the relationship set, a roster page and a club's protected set.
- Seeding (P0.8): `pnpm db:reset` with the demo scenario about 7 s including
  the build (budget 15 s; the seed itself about 4 s); `pnpm db:reset --scenario
  load` (1,000 clubs, 200,000 people) about 100 s locally (budget 10 minutes,
  nightly workflow). The nightly job only seeds so far; measuring the budgets
  against that data is [#10](https://github.com/SweRavn/ClubAdmin/issues/10).
- Lighthouse CI on key web pages per PR.
- k6 load tests against the `load` seed scenario (1,000 clubs, 200,000 people)
  in nightly CI.
- OpenTelemetry traces in production; alerts when budgets are exceeded.
