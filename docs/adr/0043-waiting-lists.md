# 0043 — Waiting lists: capacity, offers, admission and positions

**Status:** Accepted (P1.10b; decisions with the maintainer on 2026-11-06,
all as recommended).

**Context.** ADR 0019 gave groups a capacity, an admission mode and a waiting
list table; P1.6b showed applicants their place, P1.10a added owners,
seasons, the effective capacity and archiving. Nothing let anyone apply,
offer, accept or admit. Waiting lists are about children, decided by
volunteers, and fairness matters: parents compare notes, and a club must be
able to show that nobody was skipped without a reason.

**Decision.**

- **Status machine** (service, plus checks on the pairs that need data):
  `waiting → offered → admitted`, or `→ accepted → admitted` while a club
  join request waits for approval; `offered → declined | expired`;
  `offered → waiting` when an owner withdraws an offer (back in line with the
  original `queued_at`); `waiting | offered | accepted → withdrawn`
  (applicant) or `removed` (owner, club; the reason is a code:
  `no_longer_eligible`, `duplicate`, `no_reply`, `removed_by_owner` for
  "other", `join_request_rejected`, `group_archived`). Closed entries carry
  `closed_reason` and `decided_at`. Declining closes the entry (decision 1);
  applying again starts at the back, and owners can restore fairness with a
  priority, which needs a reason (`sibling`, `returning_member`, `other`).
- **Places.** Occupied = open `member` functions + outstanding offers +
  `accepted` entries (`app.group_places`, one statement, security invoker);
  the capacity is this season's (club time zone) else the group's own; null
  is unlimited. A full group refuses offers and admissions unless the owner
  ticks "do it anyway" (audited as `over_capacity`).
- **Fair order.** The queue is `(priority DESC, queued_at, id)`. Offering or
  admitting anyone with somebody `waiting` ahead needs a reason
  (`out_of_order_reason`); adding a `member` directly to a group with people
  waiting needs one too (`group_memberships.queue_bypass_reason`). Both are
  audited and listed for club managers and registrars
  (`GET /clubs/{id}/waitlists`, `club.waitlists.read`).
- **Offers** expire at the end of the reply day in the club's time zone
  (`offer_reply_days` or the owner's choice). The applicant accepts or
  declines in one step; the server clock decides (`offer_expired`).
- **Auto-offers by job** (decision 7). `waitlists:offers` runs every five
  minutes as a system job: it finds the clubs with work
  (`app.waitlist_offer_clubs`: offers past expiry, auto-offer groups with
  people waiting), then per club in one transaction expires offers and, for
  groups with `waitlist_auto_offer`, offers each free place to the next in
  line (never out of order, `offered_by_person_id` null). Set-based and
  idempotent; it works from the current state, so it catches up after
  downtime. A place freed by a decline or an ended membership is offered at
  the next run (at most five minutes). Groups without a capacity get no
  auto-offers.
- **Admission across the club membership** (decision 2). An active or paused
  member is admitted at once (group membership `member`, entry `admitted`).
  Someone outside the club applies from the club search; the application
  creates (or reuses) a pending join request with the group as preference in
  the same transaction, linked from the entry (`join_request_id`). On
  admission, with `group_owners_admit_to_club` (the default) the join request
  is approved and the membership created in the same transaction; without it
  the entry becomes `accepted`, holds its place, and the joining service
  admits it when a manager or registrar approves the request (rejecting
  closes the person's entries in the club, `join_request_rejected`).
  Withdrawing, declining or losing the last open entry made with a join
  request withdraws the request: nobody becomes a member without a group.
  The joining module orchestrates; the groups module owns the table and
  exports the status changes (`GroupsService.waitlist`), each with its audit
  event and outbox event.
- **Positions without seeing others.** Applicants cannot read the club's
  entries under RLS. `app.waitlist_positions(entry_ids)` and
  `app.club_open_groups(club_id)` set `app.lookup` for their one query
  (`lookup_read` policies on clubs, groups, entries, memberships and seasons
  apply only then) and return counts and names only, for entries the caller
  may read (ADR 0032 pattern). `app.waitlist_group_club(group_id)` resolves
  the club of a group someone applies for: public waiting lists of listed
  clubs, or any group of a club where the caller or a ward is a member.
- **Visibility of applicants** (amends ADR 0022). Owners of the group or a
  parent group, club managers and registrars see an applicant on that
  group's list, a protected one with the crossed-camera icon; nobody else.
  Counts include protected applicants. Applicants see only their own entries,
  their position and the number waiting. Owners see the birth year and
  whether the person fits the group's birth years and gender category
  (computed), the requester, the notes and the waiting time; never contact
  details. Notices name no one (the people they are about are shown
  separately, ADR 0039).
- **Notifications** are catalogue types of the `waitlist` category:
  `waitlist.entry.created` (confirmation), `waitlist.offer.sent` (mandatory
  email, immediate; also the applicant's guardians who act for them),
  `waitlist.offer.expired`, `waitlist.admitted`, `waitlist.entry.closed`
  (the reason code, never the owner's note).
- **Retention.** Closed entries are deleted 12 months after they closed by
  `joining:retention`; erasure clears the notes (P1.8a).

**Consequences.** Three partial indexes serve the jobs and views
(`group_waitlist_entries_offers_idx`, `_closed_idx`, `_out_of_order_idx`)
besides the order index; query-plan tests guard them. Accepted places count
against the capacity until the club decides, so a club that is slow with
join requests fills its groups with accepted entries; the club view shows
them. Writes that change a queue cannot be measured twice on the same data,
so their statements are covered by the integration tests rather than the
request budgets.
