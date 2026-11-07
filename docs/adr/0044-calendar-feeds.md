# 0044 — Calendar feeds: secret URLs served by the API, signed answer links behind a confirmation

**Status:** Accepted (P1.11; decisions with the maintainer on 2026-11-07,
all as recommended). Implements level 1 of ADR 0021 and amends it (club
scope, confirmation instead of one click).

**Context.** ADR 0021 promised subscribable iCalendar feeds with answer
links. Calendar apps poll a URL without logging in, often for years, from
servers we do not control (Google, Apple, Microsoft); the URL is the only
credential and ends up in places we cannot clean (calendar sync settings,
forwarded mail). What a feed shows must follow the same rules as "My
schedule" (ADR 0034, 0036) on every fetch, without one query per activity,
and must never name other people (ADR 0022).

**Decision.**

- **Feeds.** A global table `calendar_feeds` owned by a person (RLS: the
  owner and system jobs; the fetch reads one row through
  `app.find_calendar_feed(token_hash)` under `app.lookup='calendar_feed'`,
  ADR 0032). Scopes: `my_schedule` (empty `person_ids` = me and everyone
  whose schedule I may see, also later wards; a list for shared custody),
  `group` (`group.activities.read`) and `club` (`club.activities.read`, the
  club calendar of managers, registrars and the board). `club_public` stays
  reserved for public club pages (Phase 3). At most ten open feeds per
  person. The secret is 32 random bytes (base64url) shown once; only its
  SHA-256 is stored, redacted in the record history. Regenerating revokes
  the feed (`regenerated`) and creates a new one with the same settings.
- **URL and route.** `webcal://<APP_DOMAIN>/cal/<secret>.ics` (and the
  `https` form for Google). `/cal/*` is an unprefixed API route; Caddy sends
  it from the main host straight to the API (no web hop).
- **Serving.** The handler acts as the owner (`authorization.forPerson`, a
  relationship set without a request): `my_schedule` uses the same people
  rules as `GET /me/schedule` and one feed-specific schedule statement (up to
  3,000 entries, 30 days back and 370 ahead, inside the 400-day cap); group
  and club feeds check the permission and the club's `calendar_feeds`
  entitlement on every fetch and read `schedule_entries` by group or club.
  The rendered body is cached 60 seconds in Valkey; `ETag`/`304`,
  `Last-Modified` and `Cache-Control: private, max-age=300`;
  `last_fetched_at` is written at most hourly. A feed that lost its access
  answers an empty calendar with a note and is revoked after 30 days
  (`access_lost`); feeds unused for 12 months are revoked (`unused`) by the
  worker; both tell the owner (`calendar.feed.revoked`, mandatory email).
  Revoked feeds answer 404 and are deleted after 30 days.
- **Content.** One `VEVENT` per activity: `UID <activityId>@<host>`,
  `SEQUENCE` from the schedule (bumped on every change a calendar must
  show), times in UTC or `VALUE=DATE` for all-day activities, title prefixed
  with the family member's first name in `my_schedule` feeds (initials for a
  protected ward), place, address and coordinates of the location, meeting
  time and place, group names, the cancellation reason and
  `STATUS:CANCELLED`. Never attendee lists, counts, notes or anyone outside
  the owner's family. An in-house serialiser (`packages/shared`
  `calendar/ical.ts`: escaping, 75-octet folding, CRLF); no dependency.
- **Answer links.** For the owner's family members the owner may answer for
  (`sign_up` or full guardianship; leaders do not answer), in `my_schedule`
  and group feeds, never club feeds: `<web>/answer/<token>`, where the token
  is base64url of feed ID, activity ID, person ID, the answer and a 16-byte
  HMAC-SHA256 (`CALENDAR_TOKEN_KEY`), 87 characters so it fits Fastify's
  path parameter limit. `GET /api/v1/calendar-answers/<token>` only
  describes the answer; the web page shows it with one button, and
  `POST` answers through `AttendanceService.respond` as the feed's owner on
  behalf of the person (deadline, roster and call-up rules unchanged; audit
  `activity.response.set` plus `via_calendar_link`). A link stops working
  with its feed and after the activity has ended (410).
- **Secrets.** Feed and answer paths are redacted from logs and traces
  (`scrubUrl`); limits per IP on the routes, per feed (60/min), per answer
  token (10/min), unknown secrets count double per IP.

**Consequences.** Feeds work in every calendar app without an account or
a client library; Google refreshes only every few hours (said in the help
text). Rotating `CALENDAR_TOKEN_KEY` invalidates all answer links (feeds
keep working; the links come back on the next fetch). Merging duplicate
people moves the merged person's feeds to the kept person but not
`person_ids` (a feed shows only people the owner still sees); erasure
deletes the person's feeds and removes them from other feeds' lists. Email invitations (iMIP)
and CalDAV remain ADR 0021 levels 2 and 3.
