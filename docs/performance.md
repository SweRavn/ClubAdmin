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

- Lighthouse CI on key web pages per PR.
- k6 load tests against the `load` seed scenario (1,000 clubs, 200,000 people)
  in nightly CI.
- OpenTelemetry traces in production; alerts when budgets are exceeded.
