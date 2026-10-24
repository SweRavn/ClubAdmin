# 0038 — Events with sign-up: a container linked to activities through call-ups

**Status:** Accepted (P1.6).

**Context.** Clubs run cups, camps, trips and parties that people sign up
for: a form to fill in, a deadline, a limited number of places and a
waiting list. Activities (ADR 0034) and answers (ADR 0035) cover one
session each with "coming / not coming"; they have no form, no capacity
and no queue. A cup has several sessions (matches), and only those with a
place should see them in their schedule and be on their rosters.

**Decision.**

- **A separate container.** `events` (club-owned) holds the sign-up: the
  audience (`groups` with `event_groups`, or the whole `club`), the period,
  the place, a price text (no payments before Phase 3), the sign-up window
  (`registration_opens_at`, `registration_closes_at`), the cancellation
  deadline, the capacity (null: unlimited), the waiting-list mode and the
  questions (JSONB, at most 20, validated with a Zod schema built from the
  questions). Events are drafts (organisers only), published or cancelled.
- **Activities through call-ups.** `event_activities` links an event to
  activities (an activity belongs to at most one event). A linked activity
  is called up (ADR 0036, `invitees_only`) to exactly the confirmed
  participants, kept in the same transaction as every change of a place;
  unlinking or deleting a draft lifts the call-up. Activities created with
  a group event belong to all its audience groups; a club event links
  existing activities. An activity that already has a call-up of its own
  cannot be linked (`activity_has_call_up`). The roster stays the groups'
  members who are called up, so for a club event only participants who are
  members of the activity's groups are on its roster.
- **Places under concurrency.** Every change of places locks the event row
  (`SELECT … FOR UPDATE`) and counts confirmed and offered registrations in
  the same transaction, so places are never given twice. One open
  registration (confirmed, waitlisted, offered) per event and person is
  enforced by a partial unique index.
- **Waiting list, per event.** `none` refuses when full; `auto` confirms
  the next in `queued_at` order when a place frees up (cancelled, declined,
  expired, removed, a higher capacity); `offer` offers it with a reply time
  (`offer_reply_hours`, default 24). Defaults: `offer` for group events,
  `auto` for club events. Offers past their time expire in the API's job
  runner (`events:expire_offers`, every minute, ADR 0033), which offers the
  place to the next. Organisers move someone up out of order or remove a
  registration only with a reason (`decision_reason`, audited).
- **Deadlines.** Sign-up and changes to answers until
  `registration_closes_at`; cancelling a place until the cancellation
  deadline (default: the sign-up deadline); leaving the queue or an offer
  at any time; accepting an offer until it expires, also after the sign-up
  closed. A cancelled event takes no registrations and keeps them.
- **Sensitive answers.** Questions marked sensitive (health, allergies,
  medication) are sealed together with field-level encryption (the club's
  key) and shown only to organisers, the participant and guardians with
  `see_medical`. Questions that have been answered keep their ID, type and
  sensitivity. Sealed answers are deleted 30 days after the event ends;
  registrations follow the club's attendance retention
  (`app.purge_expired_event_data`, run by `attendance:retention`). Erasure
  clears both answer columns and their history.
- **Permissions.** A resource kind `event` (club, audience, status,
  audience groups with ancestors). Group events are organised by those who
  manage every audience group; club events by club managers and the board.
  The audience signs up itself and wards (`sign_up`); leaders of the
  audience groups and registrars read the registrations.

**Consequences.**

- Events never touch answers (ADR 0035) of their activities: a confirmed
  participant still answers each session if the activity asks for answers.
- Notifications are one domain event `event.offer.made` (IDs only), sent by
  the worker's mail handler now; P1.7 adds preferences and push.
- Calendar data carries `eventId` on activity entries and never anything
  about registrations.
