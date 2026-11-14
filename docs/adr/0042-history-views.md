# 0042 — History views: who reads history, the column policy, isolation from the everyday paths

**Status:** Accepted (P1.9; decisions with the maintainer on 2026-11-01 and
2026-11-05).

**Context.** Record history (ADR 0017) and the semantic audit log
(`security.md`, "Audit") have been captured since P0.4, but nothing read
them: no endpoints, no panels, no labels. ADR 0017 said "anyone who can view
a record can see who changed it", and that a club manager has a filterable
view. History is personal data about the actors and the subjects; it is
read rarely, and the history table is the largest table of the database. The
maintainer's priority: reading history must never burden the rest of the
system, and the catalogue must not grow by hundreds of hand-written sentences.

**Decision.**

- **Who reads history (narrows ADR 0017).** Club managers and registrars
  only: the panels of a member (in the club), a group, an activity, a
  series and an event; club managers with a second factor also the club's
  own panel, the club-wide changes and the audit log. Not group owners,
  leaders, event organisers, the person or their guardians: a person's
  right of access (GDPR Art. 15) to the history of their own rows is served
  by "download my data" (P1.8b, ADR 0041), which already includes it.
  Permissions `person.history.read`, `group.history.read`,
  `activity.history.read`, `event.history.read` (club managers and
  registrars) and `club.history.read`, `club.audit.read` (club managers,
  MFA). Person routes deny with 404 (ADR 0025).
- **Column policy** (`apps/api/src/modules/audit/history-columns.ts`). For
  every history-enabled table a panel or the club-wide view shows: its kind
  of record (one label, shared with the audit log's resource types), the
  detail page it links to, the columns naming whom and what it is about,
  and per column `hidden`, `name_only` ("Other fields changed"), `value`,
  `person`, `ref:<kind>`, `shared` (phone, address, gender: only while the
  person shares the field with the club; otherwise left out entirely) or
  `leader_notes` (notes on answers: club managers and those who read the
  activity's answers). Columns not listed are `name_only`, so a new column
  is never shown with values until classified. Name columns are never
  listed (names reach the API only through PersonPresenter, ADR 0022).
  Tables never shown are listed with a reason. Integration tests check the
  policy against the catalogue of history-enabled tables and their columns.
- **Values follow the current record**: a phone no longer shared is hidden
  in all its past values; redacted (`[changed]`) and erased (`[erased]`)
  values show as "Hidden" and "Erased". Rows about a person the viewer may
  not see are left out. Actors: `person`, `protected`, `erased` ("Deleted
  user"), `operator` (never named), `system` with the job's name.
- **Panel scope.** The record and its related rows, found by ID in one query
  (including ended rows; rows deleted outright are only in the club-wide
  view), capped at 2,000 records (`history_scope_too_large`). A person's
  panel covers their club rows (profile, membership, groups, roles,
  employment, consents, join requests, waiting-list places) and their
  global rows (the person, their guardianships), not answers and attendance.
- **Global rows** only through `history.read_global_changes(...)` (SECURITY
  DEFINER): people and guardianships, for records the caller may see in the
  club context (`app.can_see_person`, checked once per record), never
  accounts. People named in history are read without an actor
  (`PeopleService.historyPeople`): former members and erased people are no
  longer reachable through the club, but their actions are the club's own
  records; the presenter still decides what is shown.
- **Isolation from the everyday paths.**
  - Its own connection pool: `HISTORY_POOL_MAX` (default 2), read-only
    transactions, `HISTORY_STATEMENT_TIMEOUT_MS` (default 3 s; a timeout is
    the problem `history_timeout`), optionally a streaming replica
    (`HISTORY_DATABASE_URL`). One read-only transaction per request reads
    the page; the access log of protected people (`person.protected.viewed`
    with `changed_fields = ['history']` until P1.12) is a second, short
    transaction on the primary after it.
  - A per-account rate limit (`RATE_LIMIT_HISTORY_MAX`, 30 per minute).
  - One index change on the history table only: the club index gains the
    keyset tie-breaker (`record_changes_club_keyset_idx`, replacing
    `record_changes_club_idx`; same number of indexes, so the trigger's write
    cost does not grow). No actor or table indexes: filters by kind of
    record or person acting need a period of at most 90 days and run inside
    the club index's range. The audit log is small (one event per action)
    and gets its filter indexes.
  - Capture stays synchronous in the writing transaction (ADR 0017: the
    history is complete by construction); it is not made asynchronous.
  - The panels are pages of their own, opened by a link: the detail pages
    make no history call.
  - Volume tests (5 million history rows, 500,000 audit events) run in the
    Nightly workflow and by hand, not in CI; CI checks the request budgets
    on the normal data.
- **Few message keys.** Audit sentences are composed: the action's verb
  (its last segment, about 45 verbs) with the resource's label, plus a
  handful of actions with their own sentence; existing form and enum labels
  are reused; only `value` columns are labelled; `nb` falls back to English.
- **Index build.** In the migration's transaction (`CREATE INDEX` on the
  partitioned table builds every partition); only the current month's
  partition takes writes, so the short write block is accepted rather than
  adding non-transactional migrations now.

**Consequences.**
- About 245 new message keys (labels of 66 columns, 40 kinds of record, 46
  verbs, 19 own sentences, statuses, categories and the views), not one
  sentence per action and column.
- Owners, coaches and parents see no history; if a club asks for it, a later
  decision can grant a panel to a role without changing the views.
- A replica can lag a few seconds behind; the panels say so in their help.
- Exports of the audit log and the history are an issue for later
  (`security.md`, "Audit").

## Amendment (2026-11-14): the verb catalogue

The composed verbs reached the limit of the first version (fewer than 60,
when about 45 were expected). Verbs are display only: an audit row stores
the whole action, the verb is taken from its last segment when shown, and
no table, index, constraint or filter holds verbs, so more verbs cost only
their texts (and a check that "{actor} {verb} {resource}" reads right).
The test now allows at most 80 verbs and adds what the limit was really
for: every verb has its own text in sv and en, except synonyms approved by
name (sv: completed/finished "slutförde", deleted/removed/unassigned "tog
bort", recorded/registered "registrerade"). A new verb is added when no
existing one says the same; a near-duplicate fails the test.
