# 0034 — Activities: materialised series and a per-group schedule read model

**Status:** Accepted (P1.4).

**Context.** P1.4 adds the club's locations, single activities (matches,
meetings), weekly training series, the group and club calendars and "My
schedule": the activities of my groups and my wards' groups across clubs,
the screen the mobile app opens on. Its budget is 50 ms p95
(`docs/performance.md`). Later steps build on the activities: attendance
(P1.5) refers to sessions, notifications (P1.7) react to changes, calendar
feeds (P1.11) need stable IDs and a sequence number. The draft prompt
proposed a per-person read model (`person_schedule`, one row per person and
activity, maintained by the worker from domain events) and a rolling
400-day horizon extended nightly.

**Decision.**

- **Sessions are materialised.** A series (`activity_series`) stores its
  rules: weekly slots (ISO weekday, local start time, length; one slot per
  weekday), first and last date, skipped dates and whether the country
  pack's public holidays are skipped (`CountryPack.publicHolidays(year)`,
  se and no). Creating it inserts every session in one statement
  (`activities` with `series_id` and `occurrence_on`, the local date, unique
  per series). A series covers **at most 400 days**
  (`series_too_long`); a longer season is a second series. There is no
  horizon and no nightly job: what the calendar shows is what is stored,
  attendance can refer to any session, and nothing depends on a job having
  run.
- **Local times stay local.** Sessions are computed in the club's IANA
  time zone with Intl only (`zonedTime` in `packages/shared`): 18:00 stays
  18:00 across the daylight-saving changes; a time that does not exist on a
  day (02:30 on the spring change) is refused (`nonexistent_local_time`);
  an ambiguous one is the first of the two.
- **Changing a series** applies from a date (default today in the club's
  zone; never in the past, `series_change_in_past`). Its sessions from then
  on are compared with the new rules by `occurrence_on`: matching dates are
  updated (keeping their IDs, status and cancellation), dates no longer in
  the pattern are deleted, new ones inserted. **Detached** sessions (edited
  on their own) are left alone, and their dates are not filled again.
  Deleting a session of a series adds its date to the series' skipped dates
  so later changes do not bring it back. Past sessions are never rewritten.
  A session with answers or attendance (P1.5) is never deleted: a change
  that drops it cancels it, and deleting it is refused (ADR 0035).
- **"This and following"** splits at a session on date D (not in the
  past): the series ends on D-1, a new series with the changes starts on D,
  and the sessions from D on move to it (same IDs; then the same comparison
  as above). At the first session the whole series is changed instead.
- **Read model: `schedule_entries`, one row per activity and group,** not
  per person. It holds what calendars and schedules show (kind, title,
  status, cancellation reason, times, place, `changed_at`) and no people.
  It is club-owned (tenant RLS) and rewritten **in the same transaction** as
  every change to an activity, its groups or a location's name (one delete
  and one insert-select per statement, never per person). "My schedule"
  joins the reader's open `group_memberships` to it (index
  `(group_id, starts_at)`), across clubs, in one statement; an extra
  `member_read` policy lets members of a group and their guardians read the
  group's entries without the club's context (`app.self_and_wards()`, the
  path `group_memberships` already has). Consequences:
  - joining or leaving a group changes the schedule at once (no worker, no
    events to process, no rebuild);
  - a right that is revoked (a relative's `view_schedule`) takes effect at
    once: the API decides whose schedule it reads (me, and wards with
    `view_schedule`; only the ward when acting on behalf);
  - a joint activity is one row per group and appears once (grouped by
    activity);
  - the table is excluded from record history (derived from `activities`
    and `activity_groups`, which have it; `history-exclusions.ts`).
  Measured: a guardian's schedule over two clubs answers in about 6 ms p95
  with 1,600 teams and 64,000 activities (`schedule-plans.integration.test.ts`).
- **No inheritance down the group tree.** An activity belongs to the groups
  it names; a joint training of two teams names both, and its creator must
  manage each (`group_not_managed`).
- **Authorization.** A new resource kind `activity` (`:activityId` or
  `:seriesId`) carries the club and the activity's groups with their
  ancestors. Reading needs one readable group (members and leaders of any
  function, owners, club managers and registrars, guardians with
  `view_schedule`); managing needs every group manageable (club managers,
  owners of the group or a parent group, head and assistant coaches, team
  managers). The resource is resolved outside a club context through an
  `insider_read` policy on the four activity tables
  (`app.current_club_id() IS NULL AND app.has_club_relationship(club_id)`,
  as for groups; the first condition keeps club transactions from paying for
  it). `leaderNotes` are only in responses for those who manage the
  activity. The club calendar and double bookings are for administrators
  and the board; locations are managed by club managers and archived, never
  deleted.
- **Events and sequence.** Every change publishes `activity.changed`
  (`created`, `updated`, `cancelled`, `restored`, `deleted`) or
  `activity_series.changed` (`created`, `updated`, `split`) with IDs only;
  nothing consumes them yet (P1.7 sends notifications, P1.11 feeds). A
  change a calendar must show (time, place, title, kind, notes, match
  details, status) increments the activity's `sequence` and sets
  `changed_at`; "My schedule" marks entries changed after `changedSince`.
  Audit: one event per series operation (`activity.series.created`,
  `.updated`, `.split`), not per session, and one per single-activity
  change; `location.created` and `.updated`.

**Consequences.**

- The prompt's `person_schedule` and horizon job are not built; the prompt
  is updated to match.
- A club's activities over a season are tens of thousands of rows (40 teams,
  two trainings a week); the load scenario has 256,000 activities and
  `pnpm db:reset --scenario load` takes about 210 s (budget 10 minutes).
- Rule changes that apply from a future date leave the series' stored rules
  describing the later sessions; sessions between today and that date keep
  the rules they were created with. "This and following" is the way to make
  that visible as two series.
- Recurrence is weekly only. Other rules (every other week, monthly) are a
  later addition to the slot format; the API ignores nothing silently (a
  slot it does not know is a validation error).
