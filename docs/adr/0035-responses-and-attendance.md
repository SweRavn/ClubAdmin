# 0035 — Responses and attendance: separate records, a roster by date, an offline outbox

**Status:** Accepted (P1.5).

**Context.** P1.5 lets members and guardians answer whether they are coming
to an activity, and leaders record who was there, also in a hall without
coverage. Answer links in calendar feeds (P1.11) and notifications (P1.7)
build on the answers; LOK-stöd reporting (Phase 2) on the attendance. Both
are personal data about children and must never reveal a protected member
(ADR 0022).

**Decision.**

- **Two records, not one.** `activity_responses` is intent (attending, not
  attending, a note to the leaders, who answered and when);
  `attendance_records` is fact (present, absent, excused; participant or
  leader; guest; who recorded it, when on the device, and the reason of a
  correction). One row per activity and person in each. An answer never
  becomes attendance by itself: the attendance screen suggests marks from
  the answers (attending → present, not attending → excused) and nothing
  is saved until the leader sends it.
- **The roster is who was in the activity's groups on its start**
  (`group_memberships` valid at `starts_at`): members are participants, the
  other functions leaders. Someone who joined later or left earlier is not
  on it; their answers are kept and not counted. Answers are only accepted
  for participants on the roster. Guests (not on the roster) must be
  active members of the club; their mark says so.
- **Response modes and deadlines.** `response_mode` (`none`, `optional`,
  `requested`; by kind: trainings optional, matches and meetings requested,
  other none) and `respond_by` on activities; a series has the mode and a
  deadline in minutes before each session, copied to its sessions and
  changed with the series rules of ADR 0034. Neither bumps `sequence` or
  `changed_at`: calendars do not show them. Until the deadline any answer;
  after it only "not attending" (illness), and withdrawing is closed.
  Cancelled activities keep their answers and take no new answers or
  marks; an activity that has ended takes no answers.
- **Who answers.** The member, and guardians with `sign_up` (full
  guardians hold every right); relatives with only `view_schedule` see the
  schedule without buttons. The policy (`activity.respond`) allows anyone
  who is a member of one of the activity's groups or a guardian with
  `sign_up` of one; the controller limits `personId` to the caller and
  those wards (404 otherwise), the service to the roster. A guardian's
  answer is recorded as on behalf of the ward in audit and history.
- **Who sees what.** Counts (attending, not attending, not answered,
  roster) for everyone who may read the activity, protected members
  included. Names of those attending for viewers who may read the group's
  roster, through the person presenter, so protected members are counted
  and never named for them. Notes only to leaders and to the person and
  their guardians. Leaders (`activity.responses.read`: those who manage
  the activity and `other_leader`, not physios) see every answer with its
  note; the group calendar carries the counts for those who manage.
- **The lock and corrections.** Leaders record from an hour before the
  start until `clubs.attendance_lock_days` (default 30) after it. Later,
  club managers and registrars correct, with a reason kept on the mark
  (`attendance.corrected` per mark). Attendance is never deleted (the app
  roles have no DELETE on the table).
- **Offline outbox and ordering.** The app's writes are TanStack Query
  mutations in one scope: while offline they pause, are persisted with the
  account's encrypted cache (ADR 0028) and run in order when online. Each
  carries an `Idempotency-Key` and the time it was made. The API needs no
  key store: its writes are **idempotent by content** (the same answer or
  mark again changes nothing and writes no audit event), so a resend after
  a lost response is harmless. Marks are ordered by the device's time
  (`recordedAt`, at most 7 days old and 5 minutes ahead of the server):
  an older mark than the stored one is not applied and comes back in the
  answer's `stale` list (the request succeeds for the others; one
  conflicting mark does not refuse a whole roster). Answers are ordered by
  arrival and the deadline is checked against the server's clock, never
  the device's. A refused write (deadline, lock) is shown in the app with
  its reason until dismissed.
- **Deleting and series changes.** An activity with answers or attendance
  cannot be deleted (`activity_has_responses`; cancel it). A series change
  that drops such a session cancels it instead of deleting it (ADR 0034
  amended); past sessions are never rewritten anyway.
- **Module boundary.** Responses and attendance live in the activities
  module (`attendance.*` files) rather than a separate `attendance`
  module: the delete check, series changes, the calendar counts and "My
  schedule" need them in the same transaction as the activities, and a
  separate module would need a dependency cycle.
- **"My schedule"** gets each person's answer in the same statement (a
  subquery on `activity_responses (person_id, activity_id)`, readable
  across clubs through an `own_read` policy for the actor and their wards)
  and whether the viewer may answer for them.
- **Grant rules in the country pack.** `CountryPack.grantRules` checks a
  recorded session: `se` has LOK-stöd's per-session rules (RF:s
  föreskrifter, version of 15 January 2023: at least 45 minutes, three
  participants aged 7–25 in the calendar year, a leader of 13 or more);
  `no` has none. The leaders see the codes as hints; reporting is Phase 2.
- **Events.** `activity.response.changed` and `attendance.recorded` (IDs
  only); P1.7 may tell leaders of a late "not attending". Answer links in
  feeds (P1.11) will call the same service as the API, with the deadline
  and roster rules above.

**Consequences.**

- **Retention** (decided after P1.5, [#18](https://github.com/SweRavn/ClubAdmin/issues/18)):
  answers and attendance are kept at least 12 months after the activity
  ended. The period is the club's `attendance_retention_months` (default
  12, at most 120; a club setting that no page sets yet), so a club that reports grants
  from its attendance can keep it as long as the grant rules require, and
  the default can change later without a migration of the data. The
  worker's `attendance:retention` job deletes both, club by club, through
  `app.purge_expired_attendance()`, the only way attendance is deleted (the
  app roles have no DELETE on it); the activities stay, and record history
  keeps the deleted rows for its own period (ADR 0017). Erasure
  (`privacy.erase_person`) already removes the notes on a person's answers
  and scrubs them from the history.
- Paused writes are persisted with the cache, whose buster includes the app
  version: writes left unsent across an app update are lost (rare; the app
  sends them as soon as it is online). Signing out with unsent writes asks
  first.
- Guests are added on the web; the app takes attendance for the roster.
- Call-ups (inviting only some members to a match) came afterwards: with
  one, the roster's participants are those called up (ADR 0036,
  [#19](https://github.com/SweRavn/ClubAdmin/issues/19)).

**Amendment (P1.6b): leaders answer for participants.** Leaders of an
activity's groups (those who lead its activities, `canLeadGroupActivities`)
may set a participant's answer (`activity.respond`), from the answers table
on the web and the leader's list in the app: a parent calls to say the child
is ill. The deadline binds members and guardians only; leaders answer also
after it. The answer records the leader as `responded_by_person_id` (shown
as "answered by …") and is audited as `activity.response.set_by_leader`,
not on behalf of anyone. Leaders do not withdraw answers (the person or a
guardian does). Leaving out the note when answering keeps the current note;
`null` clears it, so answering again never loses a note.
