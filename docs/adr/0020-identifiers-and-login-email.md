# 0020 — Identifiers, login email and people without email

**Status:** Accepted

**Context.** Users must log in with their email, which must be unique per
user. Children must not be linked to a parent's email; they have no email
until they get their own login. Records need a stable identifier that is not
the email.

**Decision.**
- **Internal identifier:** a database-generated ID for every row, never the
  email. We use **UUIDv7** rather than an integer sequence:
  - it is time-ordered like a running number, so index performance is as good;
  - it cannot be guessed or enumerated from URLs and does not reveal how many
    members the service has;
  - rows created in different installations never collide, which makes
    moving a club between a self-hosted installation and the hosted service
    (export/import, data portability) safe.
- **Human-friendly running number:** each club gives its members a running
  **member number** (`club_profiles.member_number`, from
  `clubs.next_member_number`). This is what people see on lists, exports and
  membership cards.
- **Email** lives only on `accounts`, is unique system-wide
  (case-insensitive unique index on the normalised address), verified, and is
  the login identifier in Zitadel. `people` has no email column.
- People without accounts (children) have no email; contact goes through
  guardians.
- A guardian creates a child person without email; later a guardian or the club
  adds the child's **own** email, which sends an invitation; completing it
  creates the account and links it to the existing person.

**Consequences.** No shared "family email" logins: each guardian has their own
account. Imports from other systems that have a parent's email on a child must
move that email to a guardian record (the importer handles this).
