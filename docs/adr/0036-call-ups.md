# 0036 — Call-ups: only the people called up take part in an activity

**Status:** Accepted (after P1.5, [#19](https://github.com/SweRavn/ClubAdmin/issues/19)).

**Context.** In P1.5 (ADR 0035) the roster of an activity is everyone in
its groups on its start. Matches often need a squad ("kallelse"): only some
of the team's members are called up, and only they should answer, be
counted and see the match in their schedule.

**Decision.**

- **A per-activity selection.** `activities.invitees_only` says whether only
  those called up take part; `activity_invitees` (club-owned, one row per
  activity and person, IDs only, record history) holds who they are. With
  `invitees_only` off the table is empty and the whole groups take part, as
  before. A series has no call-up: it is set on one session (or a single
  activity) and does not detach it from its series.
- **The roster narrows.** With a call-up, the roster's participants are the
  people called up who are members of the activity's groups on its start;
  the leaders (other functions) stay. Everything built on the roster
  follows without its own rules: who may answer (`not_on_roster` for
  others), the counts and the leaders' list, the group calendar's counts,
  the attendance sheet and its suggestions, and the LOK-stöd hints. Group
  members who were not called up but came are marked as guests.
- **Answers are kept.** Someone no longer called up keeps their answer; it
  is not counted while they are not on the roster, and counts again if they
  are called up again or the call-up is removed.
- **"My schedule"** leaves out an activity with a call-up for members who
  are not called up (the read model `schedule_entries` carries
  `invitees_only`; an `own_read` policy on `activity_invitees` lets the
  schedule's cross-club statement see whether I and my wards are called
  up). Leaders keep it. The group calendar shows it to everyone who may read
  the group's activities, with a note that only those called up take part.
- **Who sets it.** Those who manage the activity (`activity.manage`) set it
  with `PUT /activities/:id/invitees` (the whole list, at most 200; idempotent
  by content); the leaders who see the answers (`activity.responses.read`)
  read it. Only for activities that are not cancelled and have not ended
  (`activity_ended`). A call-up is not a calendar change: neither `sequence`
  nor `changed_at` moves.
- **Audit and events.** `activity.invitees.changed` in the audit log, and
  the domain event `activity.invitees.changed` with the IDs added and
  removed, for P1.7 to tell those newly called up.
- **Retention.** The retention job (#18) also deletes who was called up to
  activities past the club's period.

**Consequences.**

- Reserves (called up to step in) are not modelled; a leader calls up more
  people, or adds a member who came as a guest when taking attendance.
- Notifications to those called up come with P1.7 (the event is there).
- Calendar feeds (P1.11) must apply the same rule as "My schedule".
