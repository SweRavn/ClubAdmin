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
| Backups | No effect on the API budgets above (pgBackRest with 2 processes, zstd); measured under the load scenario: [#14](https://github.com/SweRavn/ClubAdmin/issues/14) |
| Restore (RTO planning) | < 30 minutes for a 10 GB database (docs/operations/backup-restore.md) |

## Design rules

### Database
- Every query on a club table filters on `club_id` first; composite indexes
  start with `club_id`.
- Keyset pagination only (no `OFFSET` on large tables).
- Precomputed read models for hot screens (e.g. `schedule_entries`, one row
  per activity and group, written in the same transaction as the activity;
  ADR 0034) instead of multi-join queries on every app open.
- `pg_stat_statements` + slow-query log; CI integration tests fail on queries
  without index usage on seeded large-volume data (`pnpm db:seed --scenario load`).
- PgBouncer in transaction mode in front of Postgres for the hosted service.
- JIT compilation is off for the application roles (`db:bootstrap`): for
  short OLTP queries it costs more than it saves (about 90 ms on a page of a
  10,000-member register).

### API
- Permission set loaded once per request, cached in Valkey with version
  invalidation.
- Response shaping: endpoints return what the screen needs (`include=`), not
  entire object graphs.
- ETags and `304 Not Modified`; compression (Brotli) at the proxy.
- Heavy work (emails to 500 members, exports, report generation, image
  resizing) always in the worker, never in the request.
- Notifications (P1.7): the inbox is keyset-paginated on
  `(recipient_person_id, id DESC)`; the unread count stops at 100 on a
  partial index; the bell reads only the count. Fan-out resolves
  recipients with one statement per question and inserts notices and
  deliveries in bulk (`jsonb_to_recordset`); answer reminders use a partial
  index on `activities (coalesce(respond_by, starts_at))` for requested,
  scheduled activities.

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
- Persisted query cache (MMKV, encrypted per account; ADR 0028): the app
  shows the last known data instantly, refreshes in background.
- Screens request what they need in parallel (Home: `/me`, `/me/clubs`,
  `/me/groups`, `/me/wards`; `/meta/client` alongside, never blocking).
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
- Member register (P1.2, `register-plans.integration.test.ts`: one club with
  10,000 members among 100,000 people, as the club's registrar with row-level
  security): p95 of a 50-row page sorted by name about 80–95 ms, search as you
  type about 70–90 ms, a group with missing consent about 20 ms, facets about
  35 ms (budget 100 ms; the test allows 150 ms on shared runners). A page
  is one statement (filters, count, groups, roles, consents and guardians of
  its people) plus the names and the cached protected set. Sorting the whole
  club by name dominates; the register view reaches people through the
  club's memberships (no per-row `can_see_person`), and its outer joins let
  counts skip people. The query plans use indexes for every club table and,
  for searches and filters, for people. Exports of 10,000 members take about
  a second in the worker (batches of 1,000 into a multipart upload).
- The tests that measure time against a budget (the register, the schedule
  and the import's performance test) run after the other integration tests,
  one file at a time (`vitest --mode timed` in `pnpm test:integration`):
  run next to files that load data, the register's page measured up to
  160 ms on CI.
- Activities (P1.4, `schedule-plans.integration.test.ts`: 200 clubs, 1,600
  teams of 20 children, 64,000 activities): a guardian's "My schedule" over
  two clubs (four weeks, row-level security included) about 6 ms p95 (budget
  50 ms; the test allows 75 ms); it is one statement over the reader's open
  group memberships and `schedule_entries (group_id, starts_at)`. The group
  calendar reads the same index, the club calendar `activities (club_id,
  starts_at)`; the query plans have no sequential scan of `activities`,
  `activity_groups`, `schedule_entries` or `group_memberships`. A series is
  created with all its sessions in three statements (sessions, their groups,
  calendar entries); changing it is a comparison by date and one statement
  each for deletes, updates and inserts. The load scenario has 32 trainings
  per team (256,000 activities); `pnpm db:reset --scenario load` took about
  210 s locally at P1.4.
- Responses and attendance (P1.5, the same test with answers to each team's
  first ten sessions and attendance for eight, 320,000 answers and 256,000
  marks): "My schedule" with each person's answer about 8 ms p95 (the
  answers are a subquery of the same statement on `activity_responses
  (person_id, activity_id)`; call-ups, ADR 0036, add a check on
  `activity_invitees (person_id, activity_id)` that runs only for entries
  with `invitees_only`). The roster with its answers and a group's
  attendance summary have no sequential scan of `activity_responses`,
  `attendance_records` or `group_memberships` (rosters by date use
  `group_memberships (group_id, valid_from)`). The group calendar's counts
  are one grouped statement per page; saving attendance is two statements
  (the current marks, one upsert of the changes) however many marks are
  sent. The load scenario has attendance for each team's six latest
  sessions and answers to the next four (816,000 marks, 241,000 answers):
  `pnpm db:reset --scenario load` takes about 410 s locally (budget 10
  minutes; each row also writes record history, about 0.2 ms per row in
  this bulk insert, so every past session, 2.4 million marks, took
  700 s).
- Events with sign-up (P1.6, ADR 0038): every change of places locks the
  event row, so 100 parallel sign-ups for 20 places give exactly 20 places
  and 80 in the queue (`events.integration.test.ts`). Lists and "My events"
  are keyset pages by `(starts_at, id)` on `events (club_id, starts_at)`;
  counts per page are one grouped statement on `event_registrations
  (club_id, event_id, status, queued_at)`, a person's registrations use
  `(person_id, event_id)`, offers to expire the partial index on
  `offer_expires_at`. The load scenario has a cup per club with the first
  team signed up. Timing and query-plan tests for the event endpoints are
  still to come ([#20](https://github.com/SweRavn/ClubAdmin/issues/20)).
- Member imports (P1.3b, `member-imports.performance.integration.test.ts`:
  10,000 rows, each a child with a guardian shared by two siblings, through
  the same code as the import jobs): reading, sealing and validating the file
  about 3 s (budget 30 s); adding the members about 60 s locally (budget
  3 minutes). A row costs about 14 statements (person, profile, membership,
  group, guardian, their audit and outbox events); the checks the import has
  already done are not repeated per row, the row updates are one statement
  per batch, and a batch runs without savepoints unless one of its rows
  fails. Batches of 100 run four at a time (`MEMBER_IMPORT_BATCH_CONCURRENCY`):
  rows that share a new guardian stay in one batch, and member numbers are
  reserved per batch so the batches never wait on the club's counter. The
  duplicate checks are three hash joins over the club's people (one
  statement for the whole file); the preview pages by row number on
  `member_import_rows (import_id, status, row_number)`.
- Seeding (P0.8): `pnpm db:reset` with the demo scenario about 7 s including
  the build (budget 15 s; the seed itself about 4 s); `pnpm db:reset --scenario
  load` (1,000 clubs, 200,000 people, plus one club of 10,000 members for the
  register, 256,000 activities since P1.4, attendance and answers since P1.5) about 410 s locally (budget 10 minutes,
  nightly workflow). The nightly job only seeds so far; measuring the budgets
  against that data is [#10](https://github.com/SweRavn/ClubAdmin/issues/10).
- Web (P0.9, ADR 0027), on the production build behind Caddy in CI:
  - `pnpm --filter @clubadmin/web bundle:check` sums the gzip size of all
    JavaScript a page loads before it is interactive (script tags and the
    client chunks named in the RSC payload) and fails above 150 KB. At P0.9:
    about 133 KB for `/login`, 136 KB for home, club and profile pages,
    137 KB for a group page. React and Next.js alone are about 128 KB, so
    every library on all pages counts: next-intl stays on the server (client
    components get translated texts as props), the Radix UI menus load on
    first use, TanStack Query and the API client only for rosters longer
    than one page, list virtualisation only above 200 rows.
  - Lighthouse CI (`pnpm --filter @clubadmin/web lighthouse`,
    `apps/web/lighthouserc.json`): home and a group page, three runs each on
    the mobile profile (simulated 4G, 4× CPU slowdown); medians must meet
    LCP < 1.5 s, CLS < 0.1, script transfer < 150 KB, accessibility ≥ 0.95.
    Runs are cold (no cache), stricter than the "cached" budget. At P0.9:
    LCP about 1.3 s, CLS 0, scripts 137 KB. Total Blocking Time (190–230 ms,
    mostly React's hydration) is reported as a warning above 200 ms.
  - INP: the production end-to-end spec (`E2E_PRODUCTION=1`) interacts with a
    group page (menus, tooltip) at 4× CPU slowdown and fails if an
    interaction takes 200 ms or more to paint (Event Timing). At P0.9 the
    slowest took about 100 ms.
- Rate limits (P0.10): an authenticated request pays one Valkey round trip
  for the per-account counter (fixed window: `INCR`, `PEXPIRE NX`, `PTTL` in
  one transaction), about 0.12 ms median and 0.22 ms p95 locally; bulk reads
  two more; mobile requests one more for the session deny list, at most
  every 10 seconds per session and instance. The pipeline benchmark
  (`/health/live`, not rate limited) is unchanged: p95 0.44 ms.
- Mobile (P0.10, ADR 0028):
  - `pnpm --filter @clubadmin/mobile bundle:check` bundles the production
    variant and fails above 4.6 MiB of Hermes bytecode, or if development-only
    code is in it. At P0.10: 4.16 MiB on Android (4.2 MB on iOS). React
    Native, Expo Router and React Navigation make up most of it; the
    catalogues of all three languages and the licence list are about 0.1 MiB.
  - Cold start to Home with cached data, on a release build of the
    development variant on the CI Android emulator (API 34, x86_64,
    software rendering, no network needed for the first frame):
    `apps/mobile/scripts/measure-cold-start.sh` force-stops the app five
    times and takes the time from the activity start to the app's "home ready
    (cache)" log line; the median must stay under 2 s (shown in the job
    summary). First measurement (P0.10, CI run 31): median 989 ms (857–1049 ms
    over five runs).
- k6 load tests against the `load` seed scenario (1,000 clubs, 200,000 people)
  in nightly CI.
- OpenTelemetry traces in production; alerts when budgets are exceeded.
