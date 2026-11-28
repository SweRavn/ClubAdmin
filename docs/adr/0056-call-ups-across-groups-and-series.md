# 0056 — Call-ups across groups, for series, and their revocation

**Status:** Proposed (2026-11-19; to be built in P2.10). Amends ADR 0036.

**Context.** A call-up (ADR 0036) narrows an activity's participants to
the members picked by a leader, but only among the members of the
activity's own groups, only on one activity at a time, and removing
someone is silent. Coaches asked for more (2026-11-19):

- calling up players from other teams of the club, often the same players
  every week (a younger player who trains up a year), without adding them
  to the team as ordinary members;
- deciding person by person who is called up to which activity;
- for a series, one call-up for all its sessions, with single sessions
  changed afterwards, until the call-up of that session has gone out;
- taking a call-up back up to the start of the session, with a warning
  that it has already gone out and a message to the person explaining why.

**Decision.**

1. **Permanent guests of a group.** A group can have guests: members of
   the club (any of its groups, or none) added to the group with the
   template group role `guest_player` ("Gästspelare"; the club may rename
   it, ADR 0046). It holds `group.participate` and nothing else and is
   marked as a guest role (`roles.guest`, a template property like
   `locked`; a club may mark its own group roles as guest roles too).
   Guests:
   - are participants on the roster of the group's activities (so they
     answer, are counted, have the activities in "Mitt schema" and are
     marked as present like the others; attendance records them with
     `guest = true` as today for guests);
   - are listed apart on the roster ("Gäster", with their own groups as a
     hint), are not counted against the group's capacity and never take a
     place from its waiting list (ADR 0043);
   - are not members of the group's default chat channel unless the
     group's owners turn on "Gäster i gruppens kanal" (default off: a
     guest's own team is where they talk);
   - get no rights in the group beyond taking part; their guardians see
     the group's activities for them as for any group.
   Adding and removing guests is a group membership change
   (`group.members.manage`, audit and history as for members). A guest
   membership can have an end date (a season), like any membership.
2. **Ad hoc guests on one activity.** A call-up may include any active
   member of the club, not only members of the activity's groups. A
   person called up who is not on the group roster is a participant of
   that activity only, marked as a guest everywhere the roster is shown.
   The picker lists the activity's groups first, then the club's other
   groups (searchable, ADR 0055 search as you type).
3. **Call-ups on a series.** A series can have a call-up of its own
   (`activity_series.invitees_only` and `activity_series_invitees`, the
   same shape as an activity's). Its sessions follow it: a session's
   call-up is the series' list plus the session's own additions minus its
   own removals (`activity_invitee_overrides`: per session and person,
   `added` or `removed`). Changing the series' list changes every session
   that has not started, except where a session has its own override for
   that person. Detaching a session (ADR 0034) copies the effective list
   onto the session. The effective list is materialised in
   `activity_invitees` for every session (one transaction, as the series
   rules do today), so the roster, "Mitt schema", the counts and the
   calendar feeds read one table as before.
4. **Per person per activity.** The leader's call-up view for a series is a
   grid: the series' sessions (the next eight, and more on request) by the
   people who may be called up; a cell toggles one person for one session
   (an override), a row header for the series. One tap saves (ADR 0055).
5. **When the call-up goes out.** A session's call-up goes out with its
   answer request (`activities.request_at`, ADR 0034/P1.14): those called
   up are told then, together with the request. An activity without an
   answer request has its call-up out as soon as it is saved. Until the
   call-up has gone out (`requested_at` is null and the time has not
   come), changes are silent: nobody is told about being added or removed.
6. **After it has gone out.**
   - Adding someone tells them at once (`callup.added`, as ADR 0036's
     event intended).
   - Removing someone is a **revocation**. It is allowed until the session
     starts. The leader is warned that the call-up has gone out and must
     write a reason (1–500 characters). The person (and their guardians
     with `view_schedule` or more) get a notification "Kallelsen har
     återkallats" with the activity, who revoked it and the reason. The
     revocation is kept (`activity_callup_revocations`: activity, person,
     reason, revoked by, revoked at; club-owned, history, retention as
     attendance) and shown on the person's own view of the activity until
     it has ended. Their answer is kept and not counted (ADR 0036).
   - After the start no one is added or removed; attendance takes over.
   - Removing someone through the series (a change of the series' list)
     revokes their call-up on every session whose call-up has gone out:
     one reason for all, one notification listing the sessions.
7. **Leaders and events.** Leaders are not called up (they take part
   through their group role, ADR 0035). Activities of an event with
   sign-up keep ADR 0038's rule (the call-up is the confirmed
   participants) and cannot have a series call-up.

**Consequences.**

- One new group template role, a `guest` flag on roles, two
  new tables (`activity_series_invitees`, `activity_invitee_overrides`)
  and one for revocations; `activity_invitees` stays the read model.
- The roster query widens from "members of the groups" to "members of the
  groups, plus the called-up guests"; its indexes start from the activity
  (`activity_invitees` by activity) so the cost does not grow with the
  club.
- Notifications: `callup.added` and `callup.revoked` (push, email per
  the person's settings), with the reason in the revocation only.
- The reason is free text written by a leader about a child's
  participation: it is personal data, visible only to the person, their
  guardians and the activity's leaders, never logged, erased with the
  person and deleted with the attendance retention.
- Cross-club call-ups (a player of another club) are not part of this:
  they need a guest membership in the other club and are left for later.

## Amendment (2026-11-28, before P2.10)

Checked against the code after P2.9 (details in the P2.10 prompt,
"Adjustments"):

- **Decision 5 replaced.** A call-up goes out with its answer request
  (`request_at`, or when `requested_at` is set). Without an answer request
  it goes out `CALLUP_DEFAULT_LEAD_HOURS` (72) before the start; an
  activity saved or a call-up changed inside that window goes out when
  saved. Changes by its leaders within `CALLUP_GRACE_MINUTES` (15) of it
  going out stay silent, so that correcting a call-up right after creating
  an activity is not a revocation. The previous rule ("out as soon as it is
  saved") would have made nearly every change a revocation.
- **ADR 0036 decision 7 amended**: changes are no longer notified at once;
  `callup.added` only after the call-up went out, `callup.revoked` for a
  removal after it; `callup.removed` stays in the API but is not sent.
- **Places**: guest memberships (`function = 'member'`, the guest role)
  are excluded from `app.group_places` and the waiting list (ADR 0043), and
  are not players for duty quotas (P2.6).
- **Series**: the series' call-up follows splits, extensions and restored
  dates; a skipped date drops its overrides.
- **Events**: an event's sessions refuse call-up changes (`event_session`).
- The guest flag is on `roles` and `club_type_roles`; the group setting is
  `groups.guests_in_channel`.

