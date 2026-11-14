# 0053 — Announcements: one message, chosen channels, no text in push

**Status:** Accepted (decided 2026-11-14; amends ADR 0039)

**Context.** A club or a group needs to tell people something (the annual
meeting, a closed pitch, a newsletter) and reach them where they are: on a
board in the app, by push, by email. Notifications (ADR 0039) are a
catalogue of fixed texts; audiences (ADR 0049) already decide who reads a
document. An announcement is free text written by a person, which must not
reach lock screens, and which members must be able to turn off without
losing activity notices, except the notices a club is obliged to send.

**Decision.**

1. **One message, chosen channels.** An announcement has a title, a body
   in the shared Markdown subset (paragraphs, emphasis, lists, https and
   mailto links; `@clubadmin/shared/markdown`, rendered by the web and the
   app, sent as plain text by email) and any of the channels `board`,
   `push`, `email`.
2. **Audience** is an ADR 0049 audience (`announcements.audience_id`): the
   whole club, groups (or some roles in them), club roles; never `public`.
   Guardians are included when their link receives messages. A group's
   announcement stays within the group (`audience_outside_group`); the
   club's senders address anyone in the club.
3. **The board** ("Anslagstavlan") shows the sent, unwithdrawn, unexpired
   announcements of the person's clubs and groups (and their wards'),
   pinned ones on top, then newest first, keyset; read marks per person
   (`announcement_reads`). A group's board shows the group's. Reading is
   decided in SQL (`app.announcement_readable`, `app.my_announcements`).
4. **Delivery through ADR 0039.** Sending publishes `announcement.sent`;
   the worker resolves the audience (`app.audience_people`, the writer left
   out) into notices of the new category `announcements` (defaults: email
   `no_app`, push on), in batches, with only the chosen channels. The types
   are `announcement.sent` and `announcement.important`, both `immediate`;
   important ones are `mandatoryEmail`, so they are emailed whatever the
   person's settings, never to an unverified address. The email carries
   the title and body as written, the group or club it is from and the
   usual footer; unsubscribing turns off the category's email.
5. **Push carries no free text** (amending ADR 0039, as ADR 0047 does for
   chat): "Nytt anslag från {group or club}" ("Viktigt anslag …"); the
   title and body are shown only in the app.
6. **Read status is shared** with the inbox: marking an announcement read
   marks its notice read; a read notice counts as read on the board.
7. **Drafts and scheduling.** An announcement is a draft until sent; sent
   now, or at `scheduled_at` by the worker (`announcements:due`, every
   minute). Before sending everything can change; after sending only the
   title, body, pin and expiry (`edited_at`; emails already sent stay as
   they were). Withdrawing hides it and skips what is not yet delivered;
   deleting removes it. Every step is audited (`announcement.*`).
8. **Email volume.** `ANNOUNCEMENT_EMAILS_PER_CLUB_DAY` (0: no limit)
   refuses the email channel when the club's announcement emails in 24
   hours (counted when sent) plus the audience's addresses would pass it
   (`announcement_email_limit`).
9. **Permissions.** `club.announcements.send` (club managers, chairs,
   secretaries, communications) and `group.announcements.send` (head and
   assistant coaches, team managers, and the group's owners); the writer
   and those senders manage an announcement (`announcement.manage`); reading
   follows the audience (`announcement.read`, 404 outside it).

**Consequences.**

- Unsubscribing stays per account and category (no per-club settings); the
  email says which club sent it.
- The board orders pinned and newest, not unread first: unread ones are
  marked, so chronology survives paging.
- Recipient lists are counts only (recipients, reads, deliveries per
  channel): no names, so protected identity holds.
- Erasure keeps the person's row anonymised, so writers become anonymous;
  read marks follow the person on merges (`announcements.references.ts`).

## As implemented (P2.3, 2026-11-14)

- Migration 0044: `announcements`, `announcement_reads`, the functions
  above, `app.entries_people`/`app.entries_reach` (the composer's counts
  before anything is stored), the permissions in the role template and the
  category in the notifications' check.
- API: `GET /me/announcements`; `GET|POST /clubs/:clubId/groups/:groupId/announcements`
  (the board; write), `GET …/announcements/archive` and `POST …/preview`
  for the group's senders; `GET|POST /clubs/:clubId/announcements` (the
  club's archive; write) and `POST …/preview`; `GET|PATCH|DELETE
/clubs/:clubId/announcements/:id`, `POST …/read`, `POST …/withdraw`,
  `GET …/recipients`.
- Web: "Anslagstavlan", the club's archive, the composer (audience,
  channels, important, pin, expiry, sending time in the club's time zone),
  an announcement's page (counts per channel before and after sending, the
  push text), a group's board linked from the group. App: the board, an
  announcement (opening it marks it read), the group's board on the group
  screen; notices open the announcement. Writing happens on the web.
