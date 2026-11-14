# Performance

Existing club systems are often slow. ClubAdmin aims to feel instant. These
budgets are requirements; CI measures them. Responsiveness for the person
using it is the main quality goal, and most people use the app, so the app
comes first (docs/vision.md, ADR 0040). Planning size: 1,000 clubs with about
120 members each (the `load` scenario).

## Rules for every change

1. **Every endpoint the apps call has a request budget**
   (`apps/api/src/request-budgets.integration.test.ts`): at most so many SQL
   statements and so many database pages (8 KB blocks) read, measured
   through the HTTP stack with row-level security. These numbers do not
   depend on the hardware. The test fails when an endpoint the app calls is
   missing.
2. **The cost does not grow with the data.** The same test measures again
   after adding about 30 times the data: the statements must be the same and
   the pages may grow by index levels only (at most 2.5 times plus 20 pages),
   never in proportion. Queries start from the person, club or group through
   an index and join outwards; a whole table (events, notifications,
   activities) is never filtered by conditions on the person.
3. **No N+1, no per-row lookups in policies.** Statements per request do not
   depend on the size of the result. Row-level security policies compare
   with arrays computed once per statement (`app.self_and_wards()`,
   `app.related_club_ids()`, wrapped in a scalar subquery), never call a
   function with its own lookups for every row (migration 0019).
4. **One transaction at a time per request.** Never `withSystem`/`withActor`
   inside another, nor several in parallel for one request: each holds a
   pool connection, and under load requests wait on each other.
   `@clubadmin/db` throws outside production when it happens.
5. **The app is cache first.** It shows cached data at once, refreshes in
   the background, prefetches what is likely opened next (the coming week's
   activities and their answers, events on the schedule), and saves writes
   that can wait (answers, attendance) in its outbox. A tap never waits for
   the network when cached data could be shown. New screens use the shared
   query options in `apps/mobile/src/api/queries.ts`, so prefetched data is
   the data the screen reads.
6. **A budget is raised only with a reason** in the commit (what the
   request now does that it did not before).

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
| Waiting lists (P1.10b) | The owners' list of a group with 500 entries < 100 ms (order index, keyset); the summary one grouped statement; `/me/waitlists` with positions < 50 ms (one `app.waitlist_positions` call); offer, admit, accept < 200 ms; `waitlists:offers` set-based, one statement to expire and one to offer per club with work, < 1 s on the load scenario; query plans in `waitlist-plans.integration.test.ts`, request budgets for the reads |
| Calendar feeds (P1.11) | A feed (`GET /cal/<secret>.ics`) < 50 ms p95: one lookup by hash, the owner's relationship set from Valkey, one schedule statement for the family (up to 3,000 entries, 30 days back and 370 ahead) or one read of `schedule_entries` by group or club, rendered body cached 60 s in Valkey (`CALENDAR_FEED_CACHE_SECONDS`), `ETag`/`304`; `last_fetched_at` written at most hourly; `calendar:retention` two statements on partial indexes |
| Protected identity (P1.12) | The flag PUTs < 150 ms (one lock, one update, audit and outbox); a profile view adds one upsert (`app.record_profile_view`); the person's access log < 50 ms for 50 rows (one function call on `profile_views_viewed_idx`, roles and names per club on the page); the club log < 100 ms for 50 rows with 100,000 rows in the club (`profile_views_club_idx`; query plans in `profile-views-plans.integration.test.ts`); anonymising a leaver one statement per role column |
| History panels, first page (P1.9) | < 300 ms p95; club-wide changes and the audit log < 500 ms p95 (volume tests, Nightly; ADR 0042) |

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

  Measured (P1.7, `notifications-plans.integration.test.ts` in the API and
  the worker, as the app role with row-level security): on 503,000 notices
  a typical inbox page, its next page and the unread filter use
  `notifications_inbox_idx` or `notifications_unread_idx`; a recipient with
  3,000 recent notices reads under 25,000 rows per page; the first page
  and the unread count answer within the 50 ms budget (CI margin 75 ms). In
  the worker, on 1.5 million deliveries: due push and email come from
  `notification_deliveries_due_idx`, one person's daily email from their
  inbox index, the hourly push budget from
  `notification_deliveries_push_sent_idx`, the answer-reminder scan from
  `activities_reminder_idx`, and daily retention from the creation
  indexes.

- Chat (P2.1): "Mina kanaler" finds a page of the person's chats by their
  own memberships (`chat_members_person_idx`), then reads each club's
  columns in that club (the latest message by `chats.last_message_id`: one
  partition; unread counts stop at 99). A chat's messages are pages of
  `chat_messages_chat_idx` (`chat_id, id DESC`) in every month's partition;
  `after` and `cursor` bound the ID range, so old months are pruned. The
  members' facts (child, leader, guardian of whom) are looked up per
  member by their own index entries (`app.chat_member_facts`): a join let
  the planner scan `group_memberships` and `people`, which grew with the
  data. The group's channel is created on first use; its members follow the
  group in the worker, never in a read. Real-time events carry IDs only;
  clients fetch the content (one request per event, batched by `after`).
- Announcements (P2.3): "Anslagstavlan" (`app.my_announcements`) reads the
  person's clubs one at a time and, in each, a page of the club's and of
  each of the person's groups' announcements from the board indexes
  (`announcements_club_board_idx`, `announcements_group_board_idx`) before
  the audience check; a group's board starts from the group. Club and group
  names are looked up by primary key per row (a join let the planner scan
  `clubs` and `groups`, which grew with the data). Fan-out happens in the
  worker in batches of 1,000 notices. Request budgets cover the board, a
  group's board, one announcement and marking it read.
- Documents (P2.2): a folder lists its documents by name (keyset on the
  ID) from `documents_folder_idx`; who may read is decided in SQL
  (`app.document_readable`, the audience functions) for the page's rows,
  not per row in code. "Mina dokument" (`app.my_documents`) reads the
  person's clubs one at a time by the published indexes, so its cost
  follows the person's clubs and groups, not the club's files. Request
  budgets cover "Mina dokument", the club's and a group's folders, a
  folder, a file, a download link, a notice's documents and marking seen.
- "Download my data" (P1.8b): the export is read one part at a time (the
  platform's, then each club's, all by the person's indexes) and deflated
  into a multipart upload, so memory stays bounded by one club's rows. The
  cross-club facts of the deletion preview (`app.erasure_assignments`,
  `app.ward_logins`) look names and logins up by key: a join let the
  planner scan `people` and `accounts` under their policies, which grew
  with the data (40 → 195 pages before, flat now).
- Privacy retention (P1.8a, `privacy-plans.integration.test.ts` in the
  worker, as `clubadmin_retention`): on 100,000 members in 100 clubs, 15 %
  of them former members, and 600,000 audit events, a club's former members
  past the period come from `club_memberships_left_idx`, the orphans due
  for erasure from `people_orphaned_idx`, and a batch of audit retention
  from `events_created_idx`, deleted by primary key (`id = ANY(ARRAY(...))`;
  `id IN (subquery)` scanned the whole table).

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

- Request budgets (ADR 0040), on the demo data and after adding 40 load clubs
  and the club of 10,000 members, with Valkey and one warm connection
  (`DATABASE_POOL_MAX=1`): statements and pages per request. At the time of
  writing (pages before → after the extra data):

  | Request | Statements | Pages |
  |---|---|---|
  | `GET /me` (with a pending deletion, P1.8b) | 3 | 3 → 4 |
  | `GET /me/clubs`, `/me/groups`, `/me/wards` | 1–3 | 6–15 → 14–32 |
  | `GET /me/schedule` (four weeks) | 4 | 84 → 163 |
  | `GET /me/events` | 17 | 134 → 264 (was 940 before the rewrite) |
  | `GET /me/notifications`, unread count | 4, 1 | 5 → 9, 1 → 3 |
  | `GET /activities/:id` | 7 | 61 → 99 |
  | `GET /activities/:id/responses` (leaders) | 6 | 133 → 240 |
  | `GET /events/:id` | 14 | 76 → 128 |
  | `PUT` an answer | 9 | 105 → 166 |
  | `GET /me/consents` (P1.8a) | 4 | 51 → 107 |
  | `GET /me/data-exports` (P1.8b) | 2 | 3 → 4 |
  | `GET /me/account/deletion` (P1.8b) | 3 | 42 → 63 |
  | `GET /me/wards/{personId}/erasure` (P1.8b) | 4 | 40 → 58 |
  | `GET /groups/:id/consents` (a team) | 5 | 176 → 290 |
  | `GET /people/:id/consents`, `PUT` a consent | 7, 6 | 36, 35 → 36, 34 |
  | Club privacy page, policy, decisions, texts | 2–6 | 3–9 → 4–12 |
  | Assignments, leave preview | 4, 5 | 6, 8 → 9, 12 |
  | History of a member, group, activity (P1.9) | 8, 6, 7 | 334 → 713, 154 → 193, 95 → 138 |
  | Club-wide changes, audit log (P1.9) | 4, 4 | 40 → 51, 20 → 33 |
  | `GET /me/calendar-feeds` (P1.11) | 2 | 3 → 4 |
  | `GET /people/:id` (with the view log and the protection state, P1.12) | 7 | 67 → 86 |
  | `GET /people/:id/access-log`, `GET /clubs/:id/profile-views` (P1.12) | 3, 4 | 15 → 16, 9 → 20 |
  | A "My schedule" feed, a group feed (rendered, no cache; P1.11) | 6, 10 | 138 → 227, 174 → 305 |

  History reads go to their own pool (ADR 0042); their pages are mostly one
  index probe per record and monthly partition, bounded by the panel's scope
  and the retention, not by the club's size.

  The busiest requests have room for fewer statements (an event's page reads
  each part separately); none grows with the data.

- History and audit on volume (P1.9, ADR 0042; Nightly and by hand, not
  CI): `pnpm db:reset --scenario load && pnpm db:seed --history-volume &&
  pnpm --filter @clubadmin/api test:volume`. Storklubben with two years of
  history (5 million rows) and audit events (500,000): no sequential scans
  of history partitions or the audit log, the club index newest first over
  the partitions, a 90-day period prunes partitions, and the time budgets
  above.
  Measured at P1.9 (local Docker PostgreSQL 18, warm): p95 of a member's
  panel 10 ms, the club-wide changes 10 ms (filtered to 90 days 6 ms), the
  audit log 3 ms (by actor 6 ms); seeding the volume about 1.5 minutes.
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
  Since P1.15 (ADR 0046) the relationship set also reads each assignment's
  role permissions in the same statement (`role_permissions_unique` by
  role ID, the `own_roles` policy by the person indexes, no sequential
  scan); `app.holds_permission` and the worker's `clubHolders(...)` use
  `club_role_assignments_role_idx` / `group_memberships_role_idx` and
  `role_permissions_unique`. The schedule, rosters, attendance and
  recipients read `group_memberships.participates` / `leads` instead of
  joining roles. Request budgets are unchanged. A2 adds budgets for
  `/me/permissions` (one statement after the cached relationship set), the
  roles page (four statements: roles with permissions and holder counts by
  the role indexes, the template, the people who gave themselves a role)
  and the holders of a permission (two statements, keyset by person). A
  role's change invalidates its holders through the worker (one bump per
  holder), not every relationship set.
  A3: `app.club_administrators` reads the club's assignments of roles with
  `club.roles.manage` (`role_permissions_club_permission_idx`, the
  assignments' role index) and the holders' people and accounts by key; the
  administrators page has a budget (three statements). Every new membership
  asks `app.club_needs_administrators` once (one statement, a handful of
  pages); the minimum's triggers run at commit only for assignments of
  administrator roles. `administrators:daily` lists its clubs through
  `app.administrator_job_clubs` (open requests past their deadline by
  `administrator_suspensions_expires_idx`, clubs with a grace period).
  A4: the invitation form's options (`GET /clubs/:clubId/invitation-options`,
  a budget of three statements) read the club's active groups
  (`groups_club_idx`), its roles with their permissions (no holder counts)
  and the groups' ancestors in one recursive statement; they grow with the
  club's groups, not with the data. Creating an invitation checks up to 50
  rows with the same two statements; accepting reads the invitation's rows
  by `invitation_groups_unique` and adds each group in a savepoint. A group
  owner's invitation list filters the club's invitations by creator.
  B: the club types' catalogue (`GET /club-types`, one statement: each
  type's roles by `club_type_roles_key_unique`, their permissions by
  `club_type_role_permissions_unique`) is small and global. The roles page
  reads the club's type by the club's row (two more statements: the
  template and the archived roles' keys).
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
  each for deletes, updates and inserts. P1.14: a series' sessions exist at
  most 13 months ahead; `activities:extend_series` finds the series behind
  the horizon through `activity_series_extend_idx` (partial, only series
  with something left to make) and extends each in its own transaction, so
  a run costs per series extended, not per series in the system; the answer
  request job reads `activities_request_idx (club_id, request_at)`, partial
  on unsent requests of scheduled activities. The load scenario has 32 trainings
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
    P1.14: also the home page of someone with something "In progress"
    (Peter, a manager hand-over waiting). Its largest paint was that
    section, about 1.6 s: the page sat in the `(app)/loading.tsx` Suspense
    boundary, and React 19.2 holds back a streamed boundary's reveal for
    about 300 ms after the shell's first paint. The home page now has no
    loading boundary (the other sections keep theirs, `route-loading.tsx`)
    and fetches "In progress" with the rest of the page, so everything paints
    at once (about 1.28 s). Content above the fold must not sit in a Suspense
    boundary that streams after the shell.
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
    variant and fails above 20 MiB of Hermes bytecode (4.6 MiB until P1.8a;
    an upper bound against accidental growth, cold start has its own
    budget), or if development-only code is in it. At P0.10: 4.16 MiB on Android (4.2 MB on iOS). React
    Native, Expo Router and React Navigation make up most of it; the
    catalogues of all three languages and the licence list are about 0.1 MiB.
    At P1.8a: 4.56 MiB, with the message namespaces only the web app, emails
    and the server use left out of the app's catalogues
    (`apps/mobile/src/i18n/web-only-namespaces.json`, applied by
    `apps/mobile/metro-transformer.js`; a test keeps the app from using
    them).
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
