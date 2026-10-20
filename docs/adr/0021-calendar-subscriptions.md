# 0021 — Calendar subscriptions and answering from the phone's calendar

**Status:** Accepted

**Context.** Members want activities in their own calendar app (iOS, Android,
Google, Outlook) and ideally to answer there, instead of only in the app.
Calendar data must never expose members with protected identity.

**Decision.** Three levels, built in this order:

1. **Subscribable iCalendar feeds (Phase 1).**
   - Personal secret URLs (`webcal://…/cal/<token>.ics`) for "my schedule"
     (optionally including children), per group, and the club's public
     calendar. Tokens are random, stored hashed, revocable and regenerable.
   - Each event's description contains **one-click answer links** (signed,
     per-person and per-occurrence: "Attending" / "Not attending"), which work
     from any calendar app. For guardians the event title is prefixed with the
     child's name and the links answer for that child.
   - Feeds are rendered from a precomputed schedule, cached with ETag and
     `Last-Modified`; cheap to poll. Note: Google Calendar refreshes
     subscriptions only every few hours; Apple and DAVx⁵ can refresh often.
     Documented to users.
2. **Real calendar invitations by email (iMIP, Phase 2, opt-in per person).**
   - Each person (or guardian on behalf of a child) receives standard
     `METHOD:REQUEST` invitations; recurring trainings as one series with
     `RRULE` and exceptions; updates and cancellations via `SEQUENCE`.
   - Accept/Decline in the native calendar sends a `METHOD:REPLY` email to a
     per-invitation reply address; inbound mail processing maps it to the
     response (attending/not attending). Works with Apple, Google and Outlook.
   - The organizer is a club address (e.g. "SVK F2017 <calendar@…>"), never a
     leader's personal email.
3. **CalDAV (later, if demanded).** Two-way sync with scheduling; evaluated
   after levels 1–2 are in use.

**Privacy rules for all levels.**
- Calendar data contains only: title, time, place, group name, status,
  answer links. **No attendee lists, no other people's names**, so protected
  persons cannot leak through calendars.
- Invitations are sent individually; the ATTENDEE list holds only the
  recipient.
- Feed URLs are treated as secrets (not logged; rate limited).

**Consequences.** Needs inbound email handling for level 2 (provider webhook
in the hosted service, an IMAP/LMTP mailbox for self-hosters). Answer-link
tokens are bounded in time (valid until the activity has passed).
